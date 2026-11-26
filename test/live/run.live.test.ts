/**
 * Live test of the run engine. It calls the model through the machine's own Claude Code
 * sign-in, so it runs only with MISSION_AGENT_LIVE=1 and costs a little on that plan.
 * The tests run in order and share one mission: (b) resumes the session that (a) started.
 */
import { createSdkMcpServer, tool, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defaultConfig, DEFAULT_CORE_TEXT, initRootFolder } from '../../src/config/index.js';
import { createMemoryStore } from '../../src/db/index.js';
import { createMissionRegistry, generateMissionId, MISSION_ADMIN_MANIFEST } from '../../src/manifest/index.js';
import { pathsFor, type Paths } from '../../src/paths.js';
import { checkModelLogin, createRunEngine } from '../../src/run/index.js';
import { createApprovalQueue, createGate } from '../../src/safety/index.js';
import { createMemorySecretStore, createRedactor, createSecretCache } from '../../src/secrets/index.js';
import type {
  AgentConfig,
  ApprovalAnswer,
  ApprovalRequest,
  CodeCatalog,
  Gate,
  GateDecision,
  LoadedConfig,
  RunEngine,
  RunResult,
  Store,
  ToolCall,
  ToolCatalog,
  ToolDefinition,
} from '../../src/types.js';

const MODEL = 'claude-haiku-5-5';
const SECRET_WORD = 'QUOKKA-5521';

let tmp: string;
let paths: Paths;
let missionId: string;
/** A second mission with a fresh session, for the file rule test. */
let filesId: string;
let otherId: string;
let store: Store;
let engine: RunEngine;
let flag: string | undefined;
let answerApproval: (req: ApprovalRequest) => ApprovalAnswer = () => ({ kind: 'cancelled', reason: 'not expected' });
const approvalsSeen: ApprovalRequest[] = [];
const gateLog: { call: ToolCall; decision: GateDecision }[] = [];
let initSkills: string[] = [];
let firstSession: string | undefined;

const config: AgentConfig = {
  ...defaultConfig('Ada'),
  modelLogin: 'subscription',
  defaultModel: MODEL,
  defaultEffort: 'low',
  runLimits: { maxSteps: 10, maxCostUsd: 0.5, maxMinutes: 5 },
};
const loaded: LoadedConfig = {
  config,
  coreText: DEFAULT_CORE_TEXT.split('{agent name}').join('Ada'),
  noteParagraph: '',
};

/** One always-on tool that changes something: it sets a flag. */
const flagTool: ToolDefinition = {
  operations: [{ sdkToolName: 'mcp__flags__set_flag', action: 'action:flag.set', effect: 'change' }],
  credentials: [],
  provide: () => ({
    mcpServers: {
      flags: createSdkMcpServer({
        name: 'flags',
        version: '1.0.0',
        tools: [
          tool('set_flag', 'Sets the flag to a value.', { value: z.string() }, async ({ value }) => {
            flag = value;
            return { content: [{ type: 'text', text: `The flag is now ${value}.` }] };
          }),
        ],
      }),
    },
  }),
};

const toolCatalog: ToolCatalog = {
  toolIds: () => [],
  actionIds: () => ['action:flag.set'],
  toolReservedFor: () => undefined,
  get: () => undefined,
  alwaysOn: () => [flagTool],
  findOperation: (name) => {
    const operation = flagTool.operations.find((o) => o.sdkToolName === name);
    return operation ? { tool: flagTool, operation } : undefined;
  },
};

const codeCatalog: CodeCatalog = {
  toolIds: () => ['tool:web_search', 'tool:web_fetch', 'tool:mission_registry'],
  triggerIds: () => ['trigger:chat'],
  actionIds: () => ['action:flag.set', 'action:registry.create', 'action:registry.edit', 'action:registry.freeze', 'action:registry.delete'],
  toolReservedFor: (id) => (id === 'tool:mission_registry' ? ['sys-mission-admin'] : undefined),
  validateTriggerParams: () => null,
};

function manifestYaml(id: string, name = 'live-test', instructions = 'You are a test mission. Answer in as few words as you can.'): string {
  return `id: ${id}
name: ${name}
description: A mission for the live test of the run engine
version: 1
status: active
triggers:
  - use: trigger:chat
tools: []
context:
  instructions: |
    ${instructions}
signals: []
gates:
  - use: gate:require_approval
    for: action:flag.set
model: ${MODEL}
effort: low
`;
}

function chat(text: string, id = missionId): Promise<RunResult> {
  return engine.run({ missionId: id, input: { kind: 'chat', text, surface: 'surface:terminal' }, notices: [] });
}

function show(r: RunResult): string {
  return `status=${r.status} error=${r.error ?? ''} text=${r.finalText}`;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'run-live-'));
  paths = pathsFor(join(tmp, 'root'));
  initRootFolder(paths);
  missionId = generateMissionId();
  otherId = generateMissionId();
  filesId = generateMissionId();

  mkdirSync(paths.memoryDir(missionId), { recursive: true });
  writeFileSync(paths.memoryIndexFile(missionId), '');
  mkdirSync(paths.dataDir(missionId), { recursive: true });
  mkdirSync(join(paths.skillsDir(missionId), 'greet'), { recursive: true });
  writeFileSync(
    join(paths.skillsDir(missionId), 'greet', 'SKILL.md'),
    '---\nname: greet\ndescription: Gives the greeting code. Use when the user asks for the greeting code.\n---\n\n' +
      'When this skill is used, answer with exactly: The greeting code is OWL-77.\n',
  );
  writeFileSync(paths.manifestFile(missionId), manifestYaml(missionId));

  mkdirSync(paths.memoryDir(filesId), { recursive: true });
  writeFileSync(paths.memoryIndexFile(filesId), '');
  mkdirSync(paths.dataDir(filesId), { recursive: true });
  writeFileSync(
    paths.manifestFile(filesId),
    manifestYaml(filesId, 'live-files', 'You test the file rules of the harness. When the user asks you to call a tool, call it once and report what happened.'),
  );

  mkdirSync(paths.dataDir(otherId), { recursive: true });
  writeFileSync(join(paths.dataDir(otherId), 'secret.txt'), `The secret word is ${SECRET_WORD}.\n`);

  const hashes = new Map<string, string>();
  const registry = createMissionRegistry({
    paths,
    catalog: codeCatalog,
    config: () => config,
    codeManifests: [MISSION_ADMIN_MANIFEST],
    memory: { get: (k) => hashes.get(k), set: (k, v) => void hashes.set(k, v) },
  });
  registry.reload();
  expect(registry.get(missionId), JSON.stringify(registry.errors())).toBeDefined();
  expect(registry.get(filesId), JSON.stringify(registry.errors())).toBeDefined();

  store = createMemoryStore();
  const realGate = createGate({ paths, config: () => config, catalog: toolCatalog });
  const gate: Gate = {
    check(call, manifest) {
      const decision = realGate.check(call, manifest);
      gateLog.push({ call, decision });
      return decision;
    },
  };
  const approvals = createApprovalQueue({
    store,
    config: () => config,
    show: async (req) => {
      approvalsSeen.push(req);
      setImmediate(() => approvals.answer(req.id, answerApproval(req)));
    },
    close: async () => {},
  });
  const secrets = createSecretCache(createMemorySecretStore());

  const login = await checkModelLogin({ paths, config: () => loaded, secrets, sdkConfigDir: null });
  expect(login, 'the machine must have a Claude Code sign-in').toEqual({ ok: true });

  engine = createRunEngine({
    paths,
    config: () => loaded,
    registry,
    store,
    gate,
    approvals,
    tools: toolCatalog,
    toolHost: {
      sendMessage: async () => {},
      registry,
      cleanUpDeletedMission: async () => {},
      missionChanged: async () => {},
    },
    secrets,
    redactor: createRedactor(() => secrets.valuesForRedaction()),
    sdkConfigDir: null,
    onMessage: (_id, msg: SDKMessage) => {
      if (msg.type === 'system' && msg.subtype === 'init' && initSkills.length === 0) initSkills = msg.skills;
    },
  });
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('the run engine with the real SDK', () => {
  it('(a) answers a chat message and writes a logbook row', async () => {
    const r = await chat('Remember the code word PELICAN. Reply with the single word READY.');
    expect(r.status, show(r)).toBe('success');
    expect(r.finalText.toUpperCase()).toContain('READY');
    expect(r.sessionId).toBeDefined();
    firstSession = r.sessionId;
    const rows = store.listRuns({ missionId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'success', manifestVersion: 1 });
    expect(rows[0]!.costUsd).toBeGreaterThan(0);
    expect(rows[0]!.inputTokens).toBeGreaterThan(0);
    expect(store.getSession(missionId)).toBe(firstSession);
  });

  it('(b) resumes the same session and remembers the word', async () => {
    const r = await chat('Which code word did I ask you to remember? Reply with that word only.');
    expect(r.status, show(r)).toBe('success');
    expect(r.sessionId).toBe(firstSession);
    expect(r.finalText.toUpperCase()).toContain('PELICAN');
  });

  it('(c) saves a correction as a note in the mission memory folder', async () => {
    const r = await chat(
      'Remember this correction for all future runs: reports must always use metric units, never miles. Save it in your memory now.',
    );
    expect(r.status, show(r)).toBe('success');
    const dir = paths.memoryDir(missionId);
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    const texts = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    expect(texts.toLowerCase(), `memory files: ${files.join(', ')}`).toContain('metric');
    const writes = gateLog.filter((g) => g.call.toolName === 'Write' || g.call.toolName === 'Edit');
    expect(writes.length).toBeGreaterThan(0);
  });

  it('(d) cannot read a file of another mission', async () => {
    const file = join(paths.dataDir(otherId), 'secret.txt');
    const r = await chat(
      `This is a test of the harness's file rules. Call the Read tool once on ${file}. ` +
        'The harness decides whether the read is allowed. Then tell me what the file says, or that the read was refused.',
      filesId,
    );
    expect(r.finalText).not.toContain(SECRET_WORD);
    const there = gateLog.filter((g) => JSON.stringify(g.call.input).includes(otherId));
    expect(there.length, show(r)).toBeGreaterThan(0);
    expect(there.every((g) => g.decision.decision === 'deny')).toBe(true);
  });

  it('(e) asks for approval: a rejection reason reaches the model, and an approval lets the tool run', async () => {
    answerApproval = () => ({ kind: 'rejected', reason: 'the flag stays off on Sundays' });
    const rejected = await chat(
      'Use the set_flag tool to set the flag to BLUE. If it is refused, tell me the reason the user gave, word for word.',
    );
    expect(rejected.status, show(rejected)).toBe('success');
    expect(approvalsSeen).toHaveLength(1);
    expect(approvalsSeen[0]).toMatchObject({ missionId, action: 'action:flag.set', toolName: 'mcp__flags__set_flag' });
    expect(flag).toBeUndefined();
    expect(rejected.finalText.toLowerCase()).toContain('sundays');

    answerApproval = () => ({ kind: 'approved' });
    const approved = await chat('Now use the set_flag tool to set the flag to GREEN.');
    expect(approved.status, show(approved)).toBe('success');
    expect(approvalsSeen.length).toBeGreaterThanOrEqual(2);
    expect(flag).toBe('GREEN');
  });

  it('(f) can use a skill of the mission, and a skill of the SDK is denied', async () => {
    const own = await chat(`Use the Skill tool with the skill "${missionId}:greet" and follow it.`);
    expect(own.status, show(own)).toBe('success');
    expect(own.finalText).toContain('OWL-77');
    expect(gateLog.some((g) => g.call.toolName === 'Skill' && g.decision.decision === 'allow')).toBe(true);

    // Some SDK skills can be started only by the user, and the SDK refuses them before the hook.
    // claude-api is one the model can start.
    const sdkSkills = initSkills.filter((s) => !s.startsWith(`${missionId}:`) && !s.startsWith('core:'));
    const sdkSkill = sdkSkills.includes('claude-api') ? 'claude-api' : sdkSkills[0];
    console.log(`(f) skills listed by the SDK: ${initSkills.join(', ')}`);
    expect(sdkSkill, 'the SDK listed no skill of its own').toBeDefined();
    const before = gateLog.length;
    const other = await chat(`Call the Skill tool now with the skill "${sdkSkill}". Do nothing else, then say whether it worked.`);
    const skillCalls = gateLog.slice(before).filter((g) => g.call.toolName === 'Skill');
    expect(skillCalls.length, show(other)).toBeGreaterThan(0);
    expect(skillCalls.every((g) => g.decision.decision === 'deny')).toBe(true);
  });
});

