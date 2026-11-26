import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, DEFAULT_CORE_TEXT, initRootFolder } from '../config/index.js';
import { createMemoryStore } from '../db/index.js';
import { pathsFor, type Paths } from '../paths.js';
import { createMemorySecretStore, createRedactor, createSecretCache, MODEL_API_KEY, type SecretCache } from '../secrets/index.js';
import type {
  AgentConfig,
  ApprovalAnswer,
  ApprovalQueue,
  ApprovalRequest,
  Gate,
  GateDecision,
  LoadedConfig,
  Manifest,
  MissionRegistry,
  RunRequest,
  Store,
  ToolCall,
  ToolCatalog,
  ToolDefinition,
  ToolHost,
} from '../types.js';
import { createRunEngine, type RunEngineDeps } from './engine.js';
import { isNotLoggedIn } from './login.js';
import {
  errorAssistantMsg,
  fakeQuery,
  initMsg,
  resultMsg,
  textMsg,
  toolUseMsg,
  type Script,
  type ToolOutcome,
} from './test-helpers.js';

const ID = 'm_k7q3zp2xw9ha';
const TOKEN_ID = 'credential:gmail.token';
const TOKEN = 'gmail-token-value-123456';

let tmp: string;
let paths: Paths;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'run-engine-'));
  paths = pathsFor(join(tmp, 'root'));
  initRootFolder(paths);
  // initRootFolder creates only the system missions.
  for (const d of [paths.memoryDir(ID), paths.dataDir(ID), paths.skillsDir(ID)]) mkdirSync(d, { recursive: true });
  writeFileSync(paths.coreMemoryFile, 'The user is called Sam.\n');
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(tmp, { recursive: true, force: true });
});

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    id: ID,
    name: 'inbox-curator',
    description: 'Sorts my inbox',
    version: 4,
    status: 'active',
    triggers: [{ use: 'trigger:chat' }],
    tools: [],
    context: { instructions: 'You sort mail.' },
    signals: [],
    gates: [],
    ...over,
  };
}

function registryOf(m: Manifest | undefined): MissionRegistry & { current: Manifest | undefined } {
  const reg = {
    current: m,
    list: () => (reg.current ? [reg.current] : []),
    get: (id: string) => (reg.current?.id === id ? reg.current : undefined),
    getByName: () => undefined,
    errors: () => [],
    reload: () => {},
    onChange: () => {},
    watch: () => {},
    stopWatching: () => {},
    create: () => {
      throw new Error('not used');
    },
    edit: () => {
      throw new Error('not used');
    },
    setStatus: () => {
      throw new Error('not used');
    },
    remove: () => {},
  };
  return reg;
}

interface FakeApprovals extends ApprovalQueue {
  requests: Pick<ApprovalRequest, 'missionId' | 'action' | 'toolName' | 'input' | 'note'>[];
  cancelled: string[];
}

function approvalsWith(answer: (req: Pick<ApprovalRequest, 'action' | 'input'>) => Promise<ApprovalAnswer> | ApprovalAnswer): FakeApprovals {
  const q: FakeApprovals = {
    requests: [],
    cancelled: [],
    async request(req) {
      q.requests.push(req);
      return answer(req);
    },
    answer: () => false,
    cancelForMission(missionId) {
      q.cancelled.push(missionId);
    },
    cancelAll: () => {},
    pending: () => [],
  };
  return q;
}

function catalogOf(tools: ToolDefinition[], alwaysOn: ToolDefinition[] = []): ToolCatalog {
  const all = [...alwaysOn, ...tools];
  return {
    toolIds: () => tools.flatMap((t) => (t.id ? [t.id] : [])),
    actionIds: () => all.flatMap((t) => t.operations.map((o) => o.action)),
    toolReservedFor: () => undefined,
    get: (id) => tools.find((t) => t.id === id),
    alwaysOn: () => alwaysOn,
    findOperation: (name) => {
      for (const tool of all) {
        const operation = tool.operations.find((o) => o.sdkToolName === name);
        if (operation) return { tool, operation };
      }
      return undefined;
    },
  };
}

const toolHost: ToolHost = {
  sendMessage: async () => {},
  registry: registryOf(undefined),
  cleanUpDeletedMission: async () => {},
  missionChanged: async () => {},
};

interface Setup {
  scripts: Script[];
  manifest?: Manifest | undefined;
  gate?: (call: ToolCall, m: Manifest) => GateDecision;
  approvals?: FakeApprovals;
  tools?: ToolCatalog;
  secrets?: Record<string, string>;
  config?: Partial<AgentConfig>;
  sdkConfigDir?: string | null;
  store?: Store;
}

async function setup(s: Setup) {
  const fake = fakeQuery(s.scripts);
  const store = s.store ?? createMemoryStore();
  const cache: SecretCache = createSecretCache(createMemorySecretStore(s.secrets ?? {}));
  await cache.load(Object.keys(s.secrets ?? {}));
  const config: AgentConfig = { ...defaultConfig('Ada'), modelLogin: 'subscription', ...s.config };
  const loaded: LoadedConfig = { config, coreText: DEFAULT_CORE_TEXT.replace('{agent name}', 'Ada'), noteParagraph: '' };
  const approvals = s.approvals ?? approvalsWith(() => ({ kind: 'approved' }));
  const gateCalls: ToolCall[] = [];
  const gateManifests: Manifest[] = [];
  const gate: Gate = {
    check: (call, m) => {
      gateCalls.push(call);
      gateManifests.push(m);
      return (s.gate ?? (() => ({ decision: 'allow' })))(call, m);
    },
  };
  const registry = registryOf('manifest' in s ? s.manifest : manifest());
  const deps: RunEngineDeps = {
    paths,
    config: () => loaded,
    registry,
    store,
    gate,
    approvals,
    tools: s.tools ?? catalogOf([]),
    toolHost,
    secrets: cache,
    redactor: createRedactor(() => cache.valuesForRedaction()),
    queryFn: fake.queryFn,
    timeZone: 'UTC',
    hostEnv: { PATH: '/usr/bin', HOME: '/Users/sam', USER: 'sam' },
  };
  if ('sdkConfigDir' in s) deps.sdkConfigDir = s.sdkConfigDir;
  const engine = createRunEngine(deps);
  return { engine, store, calls: fake.calls, approvals, gateCalls, gateManifests, registry };
}

const chat = (text = 'Hello'): RunRequest => ({ missionId: ID, input: { kind: 'chat', text, surface: 'surface:terminal' }, notices: [] });

function ok(text = 'All done', sessionId = 's1', extra: Partial<Parameters<typeof resultMsg>[0]> = {}): Script {
  return async function* () {
    yield initMsg(sessionId);
    yield textMsg(text, 'msg_1', sessionId);
    yield resultMsg({ result: text, sessionId, ...extra });
  };
}

function only(...msgs: SDKMessage[]): Script {
  return async function* () {
    for (const m of msgs) yield m;
  };
}

const failing = (msg = 'API Error: 500') => only(initMsg('s1'), resultMsg({ subtype: 'success', isError: true, result: msg }));

/** A run that waits for interrupt(), then ends as the SDK does after one. */
const waitsForInterrupt: Script = async function* (ctx) {
  yield initMsg('s1');
  await ctx.interrupted;
  yield resultMsg({ subtype: 'error_during_execution', errors: ['aborted'], terminalReason: 'aborted_streaming' });
};

describe('a chat run', () => {
  it('answers, saves the session and writes one logbook row', async () => {
    const t = await setup({
      scripts: [
        only(
          initMsg('s1'),
          toolUseMsg('Read', { file_path: 'memory/MEMORY.md' }),
          textMsg('All '),
          textMsg('done'),
          resultMsg({ result: 'All done', cost: 0.02, turns: 2, inputTokens: 300, outputTokens: 40 }),
        ),
      ],
    });
    const r = await t.engine.run(chat('Sort my mail'));
    expect(r).toMatchObject({
      status: 'success',
      finalText: 'All done',
      costUsd: 0.02,
      inputTokens: 300,
      outputTokens: 40,
      steps: 2,
      toolsCalled: ['Read'],
      sessionId: 's1',
      retried: false,
    });
    expect(r.error).toBeUndefined();
    expect(t.store.getSession(ID)).toBe('s1');
    const rows = t.store.listRuns({ missionId: ID });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      missionId: ID,
      manifestVersion: 4,
      input: 'Sort my mail',
      toolsCalled: ['Read'],
      inputTokens: 300,
      outputTokens: 40,
      costUsd: 0.02,
      status: 'success',
      finalText: 'All done',
    });
    expect(t.calls[0]?.prompt).toContain('Chat message from the user (surface:terminal):\nSort my mail');
  });

  it('runs in the real mission folder with the mission memory folder', async () => {
    const t = await setup({ scripts: [ok()] });
    await t.engine.run(chat());
    const o = t.calls[0]!.options;
    const real = pathsFor(realpathSync(paths.root));
    expect(o.cwd).toBe(real.missionDir(ID));
    expect(o.additionalDirectories).toEqual([real.coreDir]);
    expect((o.settings as { autoMemoryDirectory: string }).autoMemoryDirectory).toBe(real.memoryDir(ID));
    expect((o.systemPrompt as { append: string }).append).toContain('# Core memory\n\nThe user is called Sam.');
  });

  it('logs the event summaries as the input of a run started by events', async () => {
    const t = await setup({ scripts: [ok()] });
    await t.engine.run({
      missionId: ID,
      input: {
        kind: 'events',
        events: [
          { triggerId: 'trigger:cron', time: '2026-11-25T07:00:00Z', key: 'k1', summary: 'Morning timer', data: {} },
          { triggerId: 'trigger:cron', time: '2026-11-25T07:00:01Z', key: 'k2', summary: 'Second timer', data: {} },
        ],
      },
      notices: ['A notice'],
    });
    expect(t.store.listRuns()[0]?.input).toBe('trigger:cron: Morning timer\ntrigger:cron: Second timer');
    expect(t.calls[0]?.prompt).toContain('Events (2) that started this run:');
    expect(t.calls[0]?.prompt).toContain('Notices from the harness:\n- A notice');
  });
});

describe('environment and login', () => {
  it('uses the state/claude folder by default', async () => {
    const t = await setup({ scripts: [ok()] });
    await t.engine.run(chat());
    expect(t.calls[0]?.options.env).toEqual({ PATH: '/usr/bin', HOME: '/Users/sam', USER: 'sam', CLAUDE_CONFIG_DIR: paths.sdkConfigDir });
  });

  it('leaves CLAUDE_CONFIG_DIR out with sdkConfigDir null', async () => {
    const t = await setup({ scripts: [ok()], sdkConfigDir: null });
    await t.engine.run(chat());
    expect(t.calls[0]?.options.env).toEqual({ PATH: '/usr/bin', HOME: '/Users/sam', USER: 'sam' });
  });

  it('passes the model key with the api_key login', async () => {
    const t = await setup({ scripts: [ok()], config: { modelLogin: 'api_key' }, secrets: { [MODEL_API_KEY]: 'sk-ant-key-0123456789' } });
    await t.engine.run(chat());
    expect(t.calls[0]?.options.env?.ANTHROPIC_API_KEY).toBe('sk-ant-key-0123456789');
  });

  it('does not start without the model key, and says "Not logged in"', async () => {
    const t = await setup({ scripts: [ok()], config: { modelLogin: 'api_key' } });
    const r = await t.engine.run(chat());
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/^Not logged in: the model key credential:model\.api_key has no value\./);
    expect(isNotLoggedIn(r)).toBe(true);
    expect(t.calls).toHaveLength(0);
    expect(t.store.listRuns()).toHaveLength(1);
  });

  it('reports a refused sign-in as "Not logged in" and does not retry', async () => {
    const t = await setup({
      scripts: [
        only(
          initMsg('s1'),
          errorAssistantMsg('authentication_failed', 'Not logged in · Please run /login'),
          resultMsg({ subtype: 'success', isError: true, result: 'Not logged in · Please run /login', cost: 0 }),
        ),
      ],
    });
    const r = await t.engine.run(chat());
    expect(r.status).toBe('failed');
    expect(r.error).toContain('Not logged in: Claude Code is not signed in');
    expect(r.error).toContain(`CLAUDE_CONFIG_DIR="${paths.sdkConfigDir}" claude auth login`);
    expect(r.finalText).toBe('');
    expect(r.retried).toBe(false);
    expect(t.calls).toHaveLength(1);
  });
});

describe('tools and credentials', () => {
  const gmail: ToolDefinition = {
    id: 'tool:gmail',
    operations: [{ sdkToolName: 'mcp__gmail__send', action: 'action:email.send', effect: 'change' }],
    credentials: [TOKEN_ID],
    provide: vi.fn((ctx) => ({ mcpServers: { gmail: { type: 'stdio', command: 'gmail', args: [Object.keys(ctx.credentials).join(',')] } } })),
  };
  const web: ToolDefinition = {
    id: 'tool:web_search',
    operations: [{ sdkToolName: 'WebSearch', action: 'action:web.search', effect: 'read' }],
    credentials: [],
    provide: () => ({ sdkTools: ['WebSearch'] }),
  };
  const message: ToolDefinition = {
    operations: [{ sdkToolName: 'mcp__harness__send_message', action: 'action:message.send', effect: 'change' }],
    credentials: [],
    provide: () => ({ mcpServers: { harness: { type: 'stdio', command: 'h' } } }),
  };

  it('provides the always-on tools and the listed tools, each with only its own credentials', async () => {
    const t = await setup({
      scripts: [ok()],
      manifest: manifest({ tools: ['tool:gmail', 'tool:web_search'] }),
      tools: catalogOf([gmail, web], [message]),
      secrets: { [TOKEN_ID]: TOKEN, 'credential:other.key': 'other-value-123456' },
    });
    await t.engine.run(chat());
    const o = t.calls[0]!.options;
    expect(o.tools).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'Skill', 'WebSearch']);
    expect(Object.keys(o.mcpServers ?? {})).toEqual(['gmail', 'harness']);
    expect(gmail.provide).toHaveBeenCalledWith(expect.objectContaining({ missionId: ID, credentials: { [TOKEN_ID]: TOKEN } }));
  });

  it('does not start when a credential is missing, and names it', async () => {
    const t = await setup({ scripts: [ok()], manifest: manifest({ tools: ['tool:gmail'] }), tools: catalogOf([gmail]) });
    const r = await t.engine.run(chat());
    expect(r.status).toBe('failed');
    expect(r.error).toContain(TOKEN_ID);
    expect(r.error).toContain('secret set');
    expect(t.calls).toHaveLength(0);
    expect(t.store.listRuns()[0]?.status).toBe('failed');
  });
});

describe('refused runs', () => {
  it('refuses a frozen mission', async () => {
    const t = await setup({ scripts: [ok()], manifest: manifest({ status: 'frozen' }) });
    const r = await t.engine.run(chat());
    expect(r.status).toBe('failed');
    expect(r.error).toContain('frozen');
    expect(t.calls).toHaveLength(0);
  });

  it('refuses a mission that does not exist, with no logbook row', async () => {
    const t = await setup({ scripts: [ok()], manifest: undefined });
    const r = await t.engine.run(chat());
    expect(r.status).toBe('failed');
    expect(r.error).toContain('does not exist');
    expect(t.store.listRuns()).toHaveLength(0);
  });

  it('refuses a second run of a mission that already has one in progress', async () => {
    const t = await setup({ scripts: [waitsForInterrupt] });
    const first = t.engine.run(chat());
    const second = await t.engine.run(chat());
    expect(second.status).toBe('failed');
    expect(second.error).toContain('already in progress');
    expect(t.engine.running()).toEqual([ID]);
    await t.engine.stop(ID);
    expect((await first).status).toBe('stopped');
    expect(t.calls).toHaveLength(1);
  });
});

describe('sessions', () => {
  it('resumes the saved session', async () => {
    const store = createMemoryStore();
    store.setSession(ID, 'old');
    const t = await setup({ scripts: [ok('hi', 'old')], store });
    await t.engine.run(chat());
    expect(t.calls[0]?.options.resume).toBe('old');
    expect(store.getSession(ID)).toBe('old');
  });

  it('starts a new session once when the saved one is not found', async () => {
    const store = createMemoryStore();
    store.setSession(ID, 'gone');
    const notFound = only(resultMsg({ subtype: 'error_during_execution', errors: ['No conversation found with session ID: gone'], sessionId: 'gone', cost: 0 }));
    const t = await setup({ scripts: [notFound, ok('hi', 'fresh')], store });
    const r = await t.engine.run(chat());
    expect(t.calls.map((c) => c.options.resume)).toEqual(['gone', undefined]);
    expect(t.calls[1]?.prompt).toContain('could not be found. This is a new conversation.');
    expect(r.status).toBe('success');
    expect(r.error).toBeUndefined();
    expect(r.retried).toBe(false);
    expect(store.getSession(ID)).toBe('fresh');
  });

  it('notes the new session in the error only when the run then fails too', async () => {
    const store = createMemoryStore();
    store.setSession(ID, 'gone');
    const notFound = only(resultMsg({ subtype: 'error_during_execution', errors: ['No conversation found with session ID: gone'], sessionId: 'gone' }));
    const t = await setup({ scripts: [notFound, failing(), failing()], store });
    const r = await t.engine.run(chat());
    expect(t.calls).toHaveLength(3);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('API Error: 500');
    expect(r.error).toContain('Note: The saved session gone was not found, so a new session was started.');
  });

  it('counts only this run when the SDK reports session totals', async () => {
    const store = createMemoryStore();
    const t = await setup({
      scripts: [ok('a', 's1', { cost: 0.01, inputTokens: 100, outputTokens: 20 }), ok('b', 's1', { cost: 0.025, inputTokens: 250, outputTokens: 50 })],
      store,
    });
    const r1 = await t.engine.run(chat());
    const r2 = await t.engine.run(chat());
    expect(r1).toMatchObject({ costUsd: 0.01, inputTokens: 100, outputTokens: 20 });
    expect(r2.costUsd).toBeCloseTo(0.015, 10);
    expect(r2).toMatchObject({ inputTokens: 150, outputTokens: 30 });
    expect(t.calls[1]?.options.resume).toBe('s1');
  });
});

describe('the gate hook and the approval callback', () => {
  const gateRules = (call: ToolCall): GateDecision => {
    if (call.toolName === 'mcp__gmail__delete') return { decision: 'deny', message: 'Deleting mail is forbidden.' };
    if (call.toolName === 'mcp__gmail__send') return { decision: 'ask', action: 'action:email.send', note: 'ask before sending' };
    return { decision: 'allow' };
  };

  function using(outcomes: ToolOutcome[], tools: [string, Record<string, unknown>][]): Script {
    return async function* (ctx) {
      yield initMsg('s1');
      for (const [name, input] of tools) outcomes.push(await ctx.useTool(name, input));
      yield resultMsg();
    };
  }

  it('allows, denies with the message, or asks', async () => {
    const outcomes: ToolOutcome[] = [];
    const t = await setup({
      scripts: [using(outcomes, [['Read', { file_path: 'a' }], ['mcp__gmail__delete', { id: 1 }], ['mcp__gmail__send', { to: 'bo' }]])],
      gate: gateRules,
    });
    await t.engine.run(chat());
    expect(outcomes[0]).toMatchObject({ hook: 'allow', ran: true });
    expect(outcomes[1]).toMatchObject({ hook: 'deny', hookReason: 'Deleting mail is forbidden.', ran: false });
    expect(outcomes[2]).toMatchObject({ hook: 'ask', hookReason: 'ask before sending', ran: true });
    expect(outcomes[2]?.permission).toEqual({ behavior: 'allow', updatedInput: { to: 'bo' } });
    expect(t.approvals.requests).toEqual([
      { missionId: ID, action: 'action:email.send', toolName: 'mcp__gmail__send', input: { to: 'bo' }, note: 'ask before sending' },
    ]);
    expect(t.gateCalls[0]).toMatchObject({ toolName: 'Read', input: { file_path: 'a' } });
  });

  it('passes a rejection with the user reason to the model', async () => {
    const outcomes: ToolOutcome[] = [];
    const t = await setup({
      scripts: [using(outcomes, [['mcp__gmail__send', { to: 'bo' }], ['mcp__gmail__send', { to: 'cy' }]])],
      gate: gateRules,
      approvals: approvalsWith((req) =>
        (req.input as { to: string }).to === 'bo' ? { kind: 'rejected', reason: 'Bo is on holiday' } : { kind: 'rejected' },
      ),
    });
    await t.engine.run(chat());
    expect(outcomes[0]?.permission).toEqual({
      behavior: 'deny',
      message: "The user rejected this action (action:email.send), so it did not run. The user's reason: Bo is on holiday",
    });
    expect(outcomes[1]?.permission?.behavior).toBe('deny');
    expect((outcomes[1]?.permission as { message: string }).message).toContain('The user gave no reason.');
  });

  it('passes a cancellation with its reason to the model', async () => {
    const outcomes: ToolOutcome[] = [];
    const t = await setup({
      scripts: [using(outcomes, [['mcp__gmail__send', { to: 'bo' }]])],
      gate: gateRules,
      approvals: approvalsWith(() => ({ kind: 'cancelled', reason: 'no answer in 24 hours' })),
    });
    await t.engine.run(chat());
    expect(outcomes[0]?.permission).toEqual({
      behavior: 'deny',
      message: 'The approval request for action:email.send was cancelled (no answer in 24 hours), so the action did not run.',
    });
  });

  it('runs the gate again when canUseTool comes for a call the hook did not mark as ask', async () => {
    const results: unknown[] = [];
    const script: Script = async function* (ctx) {
      yield initMsg('s1');
      results.push(await ctx.askDirectly('Read', { file_path: 'a' }, 'x1'));
      results.push(await ctx.askDirectly('mcp__gmail__delete', {}, 'x2'));
      results.push(await ctx.askDirectly('mcp__gmail__send', { to: 'bo' }, 'x3'));
      yield resultMsg();
    };
    const t = await setup({ scripts: [script], gate: gateRules });
    await t.engine.run(chat());
    expect(results).toEqual([
      { behavior: 'allow', updatedInput: { file_path: 'a' } },
      { behavior: 'deny', message: 'Deleting mail is forbidden.' },
      { behavior: 'allow', updatedInput: { to: 'bo' } },
    ]);
    expect(t.approvals.requests).toHaveLength(1);
    expect(t.gateCalls.map((c) => c.toolName)).toEqual(['Read', 'mcp__gmail__delete', 'mcp__gmail__send']);
  });

  it('checks the gate again when the input changed after the hook asked', async () => {
    let result: unknown;
    const script: Script = async function* (ctx) {
      yield initMsg('s1');
      // The hook asks for one input, then canUseTool comes with another one.
      await ctx.call.options.hooks!.PreToolUse![0]!.hooks[0]!(
        { hook_event_name: 'PreToolUse', tool_name: 'mcp__gmail__send', tool_input: { to: 'bo' }, tool_use_id: 'u1', session_id: 's', transcript_path: '', cwd: '' },
        'u1',
        { signal: new AbortController().signal },
      );
      result = await ctx.askDirectly('mcp__gmail__delete', { id: 9 }, 'u1');
      yield resultMsg();
    };
    const t = await setup({ scripts: [script], gate: gateRules });
    await t.engine.run(chat());
    expect(result).toEqual({ behavior: 'deny', message: 'Deleting mail is forbidden.' });
    expect(t.approvals.requests).toHaveLength(0);
  });

  it('denies when the gate throws, and when the approval step throws', async () => {
    const outcomes: ToolOutcome[] = [];
    const t = await setup({
      scripts: [using(outcomes, [['Boom', {}], ['mcp__gmail__send', { to: 'bo' }]])],
      gate: (call) => {
        if (call.toolName === 'Boom') throw new Error('gate broke');
        return gateRules(call);
      },
      approvals: approvalsWith(() => {
        throw new Error('queue broke');
      }),
    });
    await t.engine.run(chat());
    expect(outcomes[0]).toMatchObject({ hook: 'deny', ran: false });
    expect(outcomes[0]?.hookReason).toContain('gate broke');
    expect(outcomes[1]?.permission?.behavior).toBe('deny');
    expect((outcomes[1]?.permission as { message: string }).message).toContain('queue broke');
  });

  it('passes the current manifest to the gate, so a freeze during the run takes effect at once', async () => {
    let t: Awaited<ReturnType<typeof setup>> | undefined;
    const script: Script = async function* (ctx) {
      yield initMsg('s1');
      await ctx.useTool('Read', { file_path: 'a' });
      t!.registry.current = manifest({ status: 'frozen' });
      await ctx.useTool('Read', { file_path: 'b' });
      yield resultMsg();
    };
    t = await setup({ scripts: [script] });
    await t.engine.run(chat());
    expect(t.gateManifests.map((m) => m.status)).toEqual(['active', 'frozen']);
  });
});

describe('status mapping and retry', () => {
  it('maps the step limit and the cost limit to limit, with no retry', async () => {
    const steps = await setup({ scripts: [only(initMsg('s1'), resultMsg({ subtype: 'error_max_turns' }))] });
    const r1 = await steps.engine.run(chat());
    expect(r1.status).toBe('limit');
    expect(r1.error).toBe('The run reached its limit of 50 steps.');
    expect(steps.calls).toHaveLength(1);

    const cost = await setup({ scripts: [only(initMsg('s1'), resultMsg({ subtype: 'error_max_budget_usd' }))] });
    const r2 = await cost.engine.run(chat());
    expect(r2.status).toBe('limit');
    expect(r2.error).toBe('The run reached its cost limit of 2 dollars.');
    expect(cost.calls).toHaveLength(1);
  });

  it('maps a refusal of the model to declined, with no retry', async () => {
    const a = await setup({
      scripts: [only(initMsg('s1'), { type: 'system', subtype: 'model_refusal_no_fallback', session_id: 's1' } as unknown as SDKMessage, resultMsg({ subtype: 'success', isError: true, result: 'refused' }))],
    });
    const r1 = await a.engine.run(chat());
    expect(r1.status).toBe('declined');
    expect(a.calls).toHaveLength(1);

    const b = await setup({ scripts: [only(initMsg('s1'), resultMsg({ stopReason: 'refusal' }))] });
    expect((await b.engine.run(chat())).status).toBe('declined');
  });

  it('retries a failed run once in the same session', async () => {
    const t = await setup({ scripts: [failing('API Error: 529 overloaded'), ok('second time', 's1')] });
    const r = await t.engine.run(chat());
    expect(r.status).toBe('success');
    expect(r.retried).toBe(true);
    expect(r.finalText).toBe('second time');
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]?.options.resume).toBe('s1');
    expect(t.calls[1]?.prompt).toContain('the previous attempt failed: The run failed: API Error: 529 overloaded');
    expect(t.store.listRuns()).toHaveLength(1);
  });

  it('reports the failure when the retry fails too', async () => {
    const t = await setup({ scripts: [failing(), failing('API Error: 502')] });
    const r = await t.engine.run(chat());
    expect(r.status).toBe('failed');
    expect(r.retried).toBe(true);
    expect(r.error).toBe('The run failed: API Error: 502');
    expect(t.calls).toHaveLength(2);
  });

  const failingAfter = (cost: number, turns: number) =>
    only(initMsg('s1'), resultMsg({ subtype: 'error_during_execution', errors: ['a tool crashed'], cost, turns, sessionId: 's1' }));

  it('gives the retry only what is left of the step limit and the cost limit', async () => {
    // The SDK's cost for a resumed session includes the earlier attempt (1.5 + 0.25).
    const t = await setup({ scripts: [failingAfter(1.5, 45), ok('done', 's1', { cost: 1.75, turns: 3 })] });
    const r = await t.engine.run(chat());
    expect(t.calls.map((c) => c.options.maxTurns)).toEqual([50, 5]);
    expect(t.calls[0]?.options.maxBudgetUsd).toBe(2);
    expect(t.calls[1]?.options.maxBudgetUsd).toBeCloseTo(0.5);
    expect(r.status).toBe('success');
    expect(r.retried).toBe(true);
    expect(r.costUsd).toBeCloseTo(1.75);
  });

  it('does not retry when the failed attempt used up the steps, and ends with limit', async () => {
    const t = await setup({ scripts: [failingAfter(0.1, 50), ok()] });
    const r = await t.engine.run(chat());
    expect(t.calls).toHaveLength(1);
    expect(r.status).toBe('limit');
    expect(r.retried).toBe(false);
    expect(r.error).toBe('The run failed: a tool crashed The harness did not try the run again, because the run used all of its 50 steps.');
    expect(t.store.listRuns()[0]?.status).toBe('limit');
  });

  it('does not retry when the failed attempt used up the cost limit, and ends with limit', async () => {
    const t = await setup({ scripts: [failingAfter(2.4, 10), ok()] });
    const r = await t.engine.run(chat());
    expect(t.calls).toHaveLength(1);
    expect(r.status).toBe('limit');
    expect(r.error).toContain('because the run used all of its cost limit of 2 dollars.');
  });

  it('counts the limits over every attempt when there are several retries', async () => {
    const t = await setup({
      scripts: [failingAfter(0.5, 20), failingAfter(1.0, 20), failingAfter(1.5, 5), ok()],
      config: { retriesAfterFailure: 3 },
    });
    const r = await t.engine.run(chat());
    expect(t.calls.map((c) => c.options.maxTurns)).toEqual([50, 30, 10, 5]);
    expect(t.calls.map((c) => Number(c.options.maxBudgetUsd?.toFixed(2)))).toEqual([2, 1.5, 1, 0.5]);
    expect(r.status).toBe('success');
  });

  it('follows retriesAfterFailure', async () => {
    const none = await setup({ scripts: [failing(), ok()], config: { retriesAfterFailure: 0 } });
    expect((await none.engine.run(chat())).status).toBe('failed');
    expect(none.calls).toHaveLength(1);

    const two = await setup({ scripts: [failing(), failing(), ok()], config: { retriesAfterFailure: 2 } });
    expect((await two.engine.run(chat())).status).toBe('success');
    expect(two.calls).toHaveLength(3);
  });

  it('fails when the SDK throws before any result', async () => {
    const t = await setup({
      scripts: [
        async function* () {
          yield initMsg('s1');
          throw new Error('process exited with code 1');
        },
      ],
      config: { retriesAfterFailure: 0 },
    });
    const r = await t.engine.run(chat());
    expect(r.status).toBe('failed');
    expect(r.error).toBe('The run failed: process exited with code 1');
  });
});

describe('stop and the time limit', () => {
  it('stops the run in progress with interrupt(), cancels its approvals and does not retry', async () => {
    const t = await setup({ scripts: [waitsForInterrupt, ok()] });
    expect(await t.engine.stop(ID)).toBe(false);
    const running = t.engine.run(chat());
    await vi.waitFor(() => expect(t.calls[0]).toBeDefined());
    expect(await t.engine.stop(ID)).toBe(true);
    const r = await running;
    expect(r.status).toBe('stopped');
    expect(r.error).toBe('The run was stopped by the user.');
    expect(t.calls[0]?.interrupted).toBe(true);
    expect(t.calls).toHaveLength(1);
    expect(t.approvals.cancelled).toEqual([ID]);
    expect(t.engine.running()).toEqual([]);
    expect(t.store.listRuns()[0]?.status).toBe('stopped');
  });

  it('stops a run at the time limit', async () => {
    vi.useFakeTimers();
    const t = await setup({ scripts: [waitsForInterrupt, ok()], manifest: manifest({ limits: { max_minutes: 10 } }) });
    const running = t.engine.run(chat());
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(t.calls[0]?.interrupted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const r = await running;
    expect(t.calls[0]?.interrupted).toBe(true);
    expect(r.status).toBe('limit');
    expect(r.error).toBe('The run reached its time limit of 10 minutes.');
    expect(t.calls).toHaveLength(1);
  });

  it('does not count the time spent waiting for an approval', async () => {
    vi.useFakeTimers();
    let approve: (a: ApprovalAnswer) => void = () => {};
    const approvals = approvalsWith(() => new Promise<ApprovalAnswer>((resolve) => (approve = resolve)));
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const script: Script = async function* (ctx) {
      yield initMsg('s1');
      await sleep(6 * 60_000);
      await ctx.useTool('mcp__gmail__send', { to: 'bo' });
      const stopped = await Promise.race([sleep(6 * 60_000).then(() => false), ctx.interrupted.then(() => true)]);
      yield stopped ? resultMsg({ subtype: 'error_during_execution', errors: ['aborted'] }) : resultMsg();
    };
    const t = await setup({
      scripts: [script],
      manifest: manifest({ limits: { max_minutes: 10 } }),
      approvals,
      gate: () => ({ decision: 'ask', action: 'action:email.send' }),
    });
    const running = t.engine.run(chat());
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(t.approvals.requests).toHaveLength(1);
    // Two hours of waiting for the user.
    await vi.advanceTimersByTimeAsync(120 * 60_000);
    expect(t.calls[0]?.interrupted).toBe(false);
    approve({ kind: 'approved' });
    // 6 minutes before and 4 after the approval reach the 10 minute limit.
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 1);
    const r = await running;
    expect(t.calls[0]?.interrupted).toBe(true);
    expect(r.status).toBe('limit');
  });

  it('lets a run finish when its active time stays under the limit', async () => {
    vi.useFakeTimers();
    let approve: (a: ApprovalAnswer) => void = () => {};
    const approvals = approvalsWith(() => new Promise<ApprovalAnswer>((resolve) => (approve = resolve)));
    const script: Script = async function* (ctx) {
      yield initMsg('s1');
      await ctx.useTool('mcp__gmail__send', { to: 'bo' });
      yield resultMsg();
    };
    const t = await setup({ scripts: [script], manifest: manifest({ limits: { max_minutes: 10 } }), approvals, gate: () => ({ decision: 'ask', action: 'action:email.send' }) });
    const running = t.engine.run(chat());
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    approve({ kind: 'approved' });
    const r = await running;
    expect(r.status).toBe('success');
  });
});

describe('redaction', () => {
  it('replaces stored secret values in the error, the input and the final text', async () => {
    const t = await setup({
      scripts: [failing(`token ${TOKEN} was rejected`), only(initMsg('s1'), textMsg(`Your token is ${TOKEN}`), resultMsg({ result: `Your token is ${TOKEN}` }))],
      secrets: { [TOKEN_ID]: TOKEN },
      config: { retriesAfterFailure: 0 },
    });
    const failed = await t.engine.run(chat(`here is ${TOKEN}`));
    const done = await t.engine.run(chat('again'));
    const [row1, row2] = t.store.listRuns({ missionId: ID }).sort((x, y) => (x.id ?? 0) - (y.id ?? 0));
    expect(JSON.stringify(t.store.listRuns())).not.toContain(TOKEN);
    expect(row1?.input).toBe(`here is [${TOKEN_ID}]`);
    expect(row1?.error).toBe(`The run failed: token [${TOKEN_ID}] was rejected`);
    expect(row2?.finalText).toBe(`Your token is [${TOKEN_ID}]`);
    expect(JSON.stringify([failed, done])).not.toContain(TOKEN);
    expect(done.finalText).toBe(`Your token is [${TOKEN_ID}]`);
  });
});
