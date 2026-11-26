import { describe, expect, it } from 'vitest';
import { defaultConfig, DEFAULT_CORE_TEXT } from '../config/index.js';
import { pathsFor } from '../paths.js';
import type { LoadedConfig, Manifest, ToolProvision } from '../types.js';
import {
  buildInputText,
  buildRunEnv,
  buildRunOptions,
  buildSystemAppend,
  builtInTools,
  coreMemoryLines,
  formatLocalTime,
  mcpServersOf,
  resolveEffort,
  resolveLimits,
  resolveModel,
  type BuildRunOptionsInput,
} from './options.js';

const paths = pathsFor('/agent');
const ID = 'm_k7q3zp2xw9ha';

function loaded(over: Partial<LoadedConfig> = {}): LoadedConfig {
  return {
    config: defaultConfig('Ada'),
    coreText: DEFAULT_CORE_TEXT.replace('{agent name}', 'Ada'),
    noteParagraph: '',
    ...over,
  };
}

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    id: ID,
    name: 'inbox-curator',
    description: 'Sorts my inbox',
    version: 3,
    status: 'active',
    triggers: [{ use: 'trigger:chat' }],
    tools: [],
    context: { instructions: 'You sort mail.\n' },
    signals: [],
    gates: [],
    ...over,
  };
}

const hooks = { preToolUse: async () => ({}), canUseTool: async () => ({ behavior: 'deny' as const, message: 'no' }) };
const NOW = new Date('2026-11-25T13:03:00Z');

function input(over: Partial<BuildRunOptionsInput> = {}): BuildRunOptionsInput {
  return {
    manifest: manifest(),
    loaded: loaded(),
    paths,
    provisions: [],
    sdkConfigDir: paths.sdkConfigDir,
    coreMemoryText: 'The user is called Sam.\n',
    hostEnv: { PATH: '/usr/bin', HOME: '/Users/sam', USER: 'sam' },
    hooks,
    input: { kind: 'chat', text: 'Hello', surface: 'surface:terminal' },
    notices: [],
    now: NOW,
    timeZone: 'Europe/Rome',
    ...over,
  };
}

describe('system prompt', () => {
  it('appends the core text, core memory, the instructions and the note paragraph, in this order', () => {
    const text = buildSystemAppend(loaded({ noteParagraph: 'Save notes like this.' }), manifest(), 'Fact one\nFact two\n');
    const core = text.indexOf('You are Ada');
    const memory = text.indexOf('# Core memory\n\nFact one\nFact two');
    const mission = text.indexOf('# Mission: inbox-curator\n\nYou sort mail.');
    const note = text.indexOf('Save notes like this.');
    expect(core).toBe(0);
    expect(memory).toBeGreaterThan(core);
    expect(mission).toBeGreaterThan(memory);
    expect(note).toBeGreaterThan(mission);
    expect(text.endsWith('Save notes like this.')).toBe(true);
  });

  it('leaves out an empty note paragraph and an empty core memory', () => {
    const text = buildSystemAppend(loaded(), manifest(), '');
    expect(text).not.toContain('# Core memory');
    expect(text.endsWith('You sort mail.')).toBe(true);
  });

  it('keeps only the first coreMemoryMaxLines lines of core memory', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `fact ${i + 1}`).join('\n');
    expect(coreMemoryLines(lines, 50).split('\n')).toHaveLength(50);
    const cfg = { ...defaultConfig('Ada'), coreMemoryMaxLines: 2 };
    const text = buildSystemAppend(loaded({ config: cfg }), manifest(), 'a\nb\nc\n');
    expect(text).toContain('# Core memory\n\na\nb\n\n# Mission');
    expect(text).not.toContain('\nc\n');
  });

  it('holds no per-run value: two runs at other times with other inputs give the same prompt and tools', () => {
    const a = buildRunOptions(input());
    const b = buildRunOptions(
      input({
        now: new Date('2027-01-01T00:00:00Z'),
        input: { kind: 'chat', text: 'Something else', surface: 'surface:telegram' },
        notices: ['A notice'],
        resume: 'session-2',
      }),
    );
    expect(JSON.stringify(a.options.systemPrompt)).toBe(JSON.stringify(b.options.systemPrompt));
    expect(JSON.stringify(a.options.tools)).toBe(JSON.stringify(b.options.tools));
    expect(Object.keys(a.options.mcpServers ?? {})).toEqual(Object.keys(b.options.mcpServers ?? {}));
    expect(a.systemAppend).not.toContain('2026');
  });

  it('passes the append with snapshot false on the claude_code preset', () => {
    const built = buildRunOptions(input());
    expect(built.options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: built.systemAppend,
      snapshot: false,
    });
  });
});

describe('tool list', () => {
  const p1: ToolProvision = { sdkTools: ['WebSearch'], mcpServers: { zeta: { type: 'stdio', command: 'z' } } };
  const p2: ToolProvision = { sdkTools: ['WebFetch', 'Agent', 'Read'], mcpServers: { alpha: { type: 'stdio', command: 'a' } } };

  it('has the file tools and the skill tool, then the added tools in sorted order, never a subagent tool', () => {
    expect(builtInTools([])).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'Skill']);
    expect(builtInTools([p1, p2])).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'Skill', 'WebFetch', 'WebSearch']);
    expect(builtInTools([p2, p1])).toEqual(builtInTools([p1, p2]));
  });

  it('orders MCP servers by name, whatever the order of the provisions', () => {
    expect(Object.keys(mcpServersOf([p1, p2]))).toEqual(['alpha', 'zeta']);
    expect(JSON.stringify(mcpServersOf([p2, p1]))).toBe(JSON.stringify(mcpServersOf([p1, p2])));
  });

  it('refuses two MCP servers with the same name', () => {
    expect(() => mcpServersOf([p1, { mcpServers: { zeta: {} } }])).toThrow(/two tools provide an MCP server named "zeta"/);
  });

  it('denies the subagent tools by name as well', () => {
    expect(buildRunOptions(input()).options.disallowedTools).toEqual(['Task', 'Agent', 'PowerShell']);
  });
});

describe('folders, plugins, settings', () => {
  it('uses the mission folder as working directory and plugin, with core as an extra folder and plugin', () => {
    const o = buildRunOptions(input()).options;
    expect(o.cwd).toBe(paths.missionDir(ID));
    expect(o.additionalDirectories).toEqual([paths.coreDir]);
    expect(o.plugins).toEqual([
      { type: 'local', path: paths.missionDir(ID), skipMcpDiscovery: true },
      { type: 'local', path: paths.coreDir, skipMcpDiscovery: true },
    ]);
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.permissionMode).toBe('default');
    expect(o.settings).toEqual({
      autoMemoryEnabled: true,
      autoMemoryDirectory: paths.memoryDir(ID),
      autoDreamEnabled: false,
      permissions: { blockReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true },
    });
  });

  it('wires the hook with onFailure block and the approval callback', () => {
    const o = buildRunOptions(input()).options;
    expect(o.hooks?.PreToolUse).toEqual([{ onFailure: 'block', hooks: [hooks.preToolUse] }]);
    expect(o.canUseTool).toBe(hooks.canUseTool);
  });

  it('resumes the given session only', () => {
    expect(buildRunOptions(input()).options.resume).toBeUndefined();
    expect(buildRunOptions(input({ resume: 'abc' })).options.resume).toBe('abc');
  });
});

describe('model, effort and limits', () => {
  const cfg = defaultConfig('Ada');

  it('takes the manifest values, or the defaults when absent or "default"', () => {
    expect(resolveModel(cfg, manifest())).toBe('claude-opus-5-5');
    expect(resolveModel(cfg, manifest({ model: 'default' }))).toBe('claude-opus-5-5');
    expect(resolveModel(cfg, manifest({ model: 'claude-haiku-5-5' }))).toBe('claude-haiku-5-5');
    expect(resolveEffort(cfg, manifest())).toBe('high');
    expect(resolveEffort(cfg, manifest({ effort: 'default' as never }))).toBe('high');
    expect(resolveEffort(cfg, manifest({ effort: 'low' }))).toBe('low');
  });

  it('lowers a limit only when the manifest value is lower', () => {
    const d = cfg.runLimits;
    expect(resolveLimits(d, manifest())).toEqual(d);
    expect(resolveLimits(d, manifest({ limits: { max_steps: 20, max_cost_usd: 0.5, max_minutes: 10 } }))).toEqual({
      maxSteps: 20,
      maxCostUsd: 0.5,
      maxMinutes: 10,
    });
    expect(resolveLimits(d, manifest({ limits: { max_steps: 500, max_cost_usd: 9, max_minutes: 99 } }))).toEqual(d);
    expect(resolveLimits(d, manifest({ limits: { max_steps: -1, max_cost_usd: Number.NaN } }))).toEqual(d);
  });

  it('passes model, effort, steps and cost to the SDK', () => {
    const o = buildRunOptions(input({ manifest: manifest({ model: 'claude-haiku-5-5', effort: 'low', limits: { max_steps: 7, max_cost_usd: 0.25 } }) })).options;
    expect(o.model).toBe('claude-haiku-5-5');
    expect(o.effort).toBe('low');
    expect(o.maxTurns).toBe(7);
    expect(o.maxBudgetUsd).toBe(0.25);
  });
});

describe('environment', () => {
  const host = { PATH: '/usr/bin', HOME: '/Users/sam', USER: 'sam' };

  it('passes the key with the api_key login', () => {
    expect(buildRunEnv('api_key', host, '/agent/state/claude', 'sk-secret')).toEqual({
      ...host,
      CLAUDE_CONFIG_DIR: '/agent/state/claude',
      ANTHROPIC_API_KEY: 'sk-secret',
    });
  });

  it('passes no key with the subscription login', () => {
    expect(buildRunEnv('subscription', host, '/agent/state/claude', 'sk-secret')).toEqual({
      ...host,
      CLAUDE_CONFIG_DIR: '/agent/state/claude',
    });
  });

  it('leaves out CLAUDE_CONFIG_DIR when the folder is null', () => {
    expect(buildRunEnv('subscription', host, null, undefined)).toEqual(host);
  });

  it('is the whole environment of the run, with nothing from the harness process', () => {
    process.env.MISSION_AGENT_TEST_LEAK = 'leak';
    try {
      const env = buildRunOptions(input()).options.env ?? {};
      expect(Object.keys(env).sort()).toEqual(['CLAUDE_CONFIG_DIR', 'HOME', 'PATH', 'USER']);
      const withKey = buildRunOptions(input({ modelApiKey: 'sk-1' })).options.env ?? {};
      expect(Object.keys(withKey).sort()).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'HOME', 'PATH', 'USER']);
    } finally {
      delete process.env.MISSION_AGENT_TEST_LEAK;
    }
  });
});

describe('input text', () => {
  it('writes the local date and time with the zone', () => {
    expect(formatLocalTime(NOW, 'Europe/Rome')).toBe('2026-11-25 14:03, Wednesday, time zone Europe/Rome (UTC+01:00)');
    expect(formatLocalTime(NOW, 'UTC')).toBe('2026-11-25 13:03, Wednesday, time zone UTC (UTC+00:00)');
  });

  it('puts the date first, then the chat message, then the notices', () => {
    const text = buildInputText({ kind: 'chat', text: 'Sort my mail', surface: 'surface:telegram' }, ['An approval was cancelled.'], NOW, 'Europe/Rome');
    expect(text).toBe(
      'Date and time: 2026-11-25 14:03, Wednesday, time zone Europe/Rome (UTC+01:00)\n\n' +
        'Chat message from the user (surface:telegram):\nSort my mail\n\n' +
        'Notices from the harness:\n- An approval was cancelled.',
    );
  });

  it('lists every waiting event record', () => {
    const text = buildInputText(
      {
        kind: 'events',
        events: [
          { triggerId: 'trigger:email.received', time: '2026-11-25T07:00:00Z', key: 'a', summary: 'Mail from Bo', data: { id: 1 } },
          { triggerId: 'trigger:email.received', time: '2026-11-25T07:01:00Z', key: 'b', summary: 'Mail from Cy', data: {} },
        ],
      },
      [],
      NOW,
      'UTC',
    );
    expect(text).toBe(
      'Date and time: 2026-11-25 13:03, Wednesday, time zone UTC (UTC+00:00)\n\n' +
        'Events (2) that started this run:\n' +
        '1. trigger:email.received, at 2026-11-25T07:00:00Z: Mail from Bo\nData: {"id":1}\n' +
        '2. trigger:email.received, at 2026-11-25T07:01:00Z: Mail from Cy',
    );
    expect(text).not.toContain('Notices');
  });

  it('is the prompt of the built run', () => {
    expect(buildRunOptions(input()).prompt).toBe(buildInputText({ kind: 'chat', text: 'Hello', surface: 'surface:terminal' }, [], NOW, 'Europe/Rome'));
  });
});
