import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathsFor, type Paths } from '../paths.js';
import type {
  AgentConfig,
  Gate,
  GateDecision,
  GateRule,
  Manifest,
  OperationDeclaration,
  ToolCatalog,
  ToolDefinition,
} from '../types.js';
import { createGate, FILE_TOOL_NAMES } from './gate.js';

const ID = 'm_abc';
const OTHER = 'm_abcd';

const config: AgentConfig = {
  agentName: 'Ada',
  defaultSurface: 'terminal',
  modelLogin: 'api_key',
  maxIndexLineChars: 200,
  maxNoteBytes: 4096,
  coreMemoryMaxLines: 50,
  coreMemoryMaxLineChars: 200,
  maxInstructionsChars: 4000,
  maxDescriptionChars: 200,
  runLimits: { maxSteps: 50, maxCostUsd: 2, maxMinutes: 30 },
  maxCostPerDayUsd: 20,
  approvalWaitHours: 24,
  triageSwitchConfidence: 0.8,
  retriesAfterFailure: 1,
  defaultModel: 'claude-opus-5-5',
  defaultEffort: 'high',
  triageModel: 'claude-haiku-5-5',
  triageEffort: 'low',
};

function tool(id: string | undefined, ops: [string, string, 'read' | 'change'][], reservedFor?: string[]): ToolDefinition {
  const operations: OperationDeclaration[] = ops.map(([sdkToolName, action, effect]) => ({ sdkToolName, action, effect }));
  return { id, operations, credentials: [], reservedFor, provide: () => ({}) };
}

const gmail = tool('tool:gmail', [
  ['mcp__gmail__search', 'action:email.search', 'read'],
  ['mcp__gmail__send', 'action:email.send', 'change'],
  ['mcp__gmail__archive', 'action:email.archive', 'change'],
  ['mcp__gmail__delete', 'action:email.delete', 'change'],
]);
const calendar = tool('tool:calendar', [['mcp__calendar__create', 'action:calendar.create', 'change']]);
const registry = tool(
  'tool:mission_registry',
  [
    ['mcp__registry__list', 'action:registry.list', 'read'],
    ['mcp__registry__create', 'action:registry.create', 'change'],
    ['mcp__registry__edit', 'action:registry.edit', 'change'],
    ['mcp__registry__freeze', 'action:registry.freeze', 'change'],
    ['mcp__registry__delete', 'action:registry.delete', 'change'],
  ],
  ['sys-mission-admin'],
);
const webSearch = tool('tool:web_search', [['WebSearch', 'action:web.search', 'read']]);
const shell = tool('tool:shell', [['Bash', 'action:shell.command', 'change']]);
const message = tool(undefined, [['mcp__harness__send_message', 'action:message.send', 'change']]);
const subagent = tool('tool:sneaky', [['Agent', 'action:agent.start', 'read']]);

function fakeCatalog(tools: ToolDefinition[], alwaysOn: ToolDefinition[]): ToolCatalog {
  return {
    toolIds: () => tools.flatMap((t) => (t.id ? [t.id] : [])),
    actionIds: () => tools.flatMap((t) => t.operations.map((o) => o.action)),
    toolReservedFor: (id) => tools.find((t) => t.id === id)?.reservedFor,
    get: (id) => tools.find((t) => t.id === id),
    alwaysOn: () => alwaysOn,
    findOperation: (name) => {
      for (const t of tools) {
        const operation = t.operations.find((o) => o.sdkToolName === name);
        if (operation) return { tool: t, operation };
      }
      return undefined;
    },
  };
}

const catalog = fakeCatalog([gmail, calendar, registry, webSearch, shell, message, subagent], [message]);

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    id: ID,
    name: 'inbox-curator',
    description: 'Sorts my inbox',
    version: 1,
    status: 'active',
    triggers: [],
    tools: ['tool:gmail', 'tool:web_search', 'tool:sneaky'],
    context: { instructions: 'Sort mail.' },
    signals: [],
    gates: [],
    ...over,
  };
}

let tmp: string;
let paths: Paths;
let gate: Gate;
let mission: string;
let other: string;

function caseInsensitiveDisk(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'case-probe-'));
  try {
    return existsSync(probe.toUpperCase()) || existsSync(probe.replace(/case-probe-/, 'CASE-PROBE-'));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

function write(p: string, content = 'x'): void {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}

beforeAll(() => {
  // os.tmpdir() on macOS is a link (/var to /private/var), which tests the real path of the root.
  tmp = mkdtempSync(join(tmpdir(), 'gate-test-'));
  paths = pathsFor(join(tmp, 'root'));
  mission = paths.missionDir(ID);
  other = paths.missionDir(OTHER);
  write(paths.agentYaml, 'agent_name: Ada');
  write(paths.coreMemoryFile, 'The user is called Sam.');
  write(join(paths.coreSkillsDir, 'tidy', 'SKILL.md'));
  write(paths.dbFile);
  mkdirSync(paths.backupsDir, { recursive: true });
  write(paths.missionsIndexFile);
  for (const id of [ID, OTHER]) {
    write(paths.manifestFile(id), `id: ${id}`);
    write(paths.memoryIndexFile(id), '- [note](note.md) a note\n');
    write(join(paths.memoryDir(id), 'note.md'), 'hello world');
    write(join(paths.dataDir(id), 'file.txt'));
    write(join(paths.skillsDir(id), 's', 'SKILL.md'));
  }
  const data = paths.dataDir(ID);
  symlinkSync(other, join(data, 'link-other'));
  symlinkSync('/etc', join(data, 'link-etc'));
  symlinkSync(join(paths.dataDir(OTHER), 'new.txt'), join(data, 'dangling'));
  symlinkSync('../manifest.yaml', join(data, 'link-manifest'));
  symlinkSync('loop2', join(data, 'loop1'));
  symlinkSync('loop1', join(data, 'loop2'));
  symlinkSync('../../m_abcd/memory', join(paths.memoryDir(ID), 'sub-other'));
  gate = createGate({ paths, config: () => config, catalog });
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function check(toolName: string, input: Record<string, unknown>, m: Manifest = manifest()): GateDecision {
  return gate.check({ toolName, input, toolUseId: 't1' }, m);
}

function expectAllow(d: GateDecision): void {
  expect(d).toEqual({ decision: 'allow' });
}

function expectDeny(d: GateDecision, text?: RegExp): void {
  expect(d.decision).toBe('deny');
  if (text && d.decision === 'deny') expect(d.message).toMatch(text);
}

describe('file tools: reading', () => {
  it('allows the mission folder and core, by relative and absolute path', () => {
    expectAllow(check('Read', { file_path: 'memory/note.md' }));
    expectAllow(check('Read', { file_path: './data/file.txt' }));
    expectAllow(check('Read', { file_path: join(mission, 'skills', 's', 'SKILL.md') }));
    expectAllow(check('Read', { file_path: paths.coreMemoryFile }));
    expectAllow(check('Read', { file_path: '../../core/skills/tidy/SKILL.md' }));
  });

  it('allows the real path of the root when the root was given through a link', () => {
    const real = realpathSync(paths.memoryIndexFile(ID));
    expectAllow(check('Read', { file_path: real }));
  });

  it('refuses manifest.yaml by every route', () => {
    expectDeny(check('Read', { file_path: 'manifest.yaml' }), /manifest\.yaml/);
    expectDeny(check('Read', { file_path: './memory/../manifest.yaml' }));
    expectDeny(check('Read', { file_path: paths.manifestFile(ID) }));
    expectDeny(check('Read', { file_path: 'data/link-manifest' }));
    expectDeny(check('Read', { file_path: 'MANIFEST.YAML' }));
  });

  it('refuses other missions, including one whose id starts with this id', () => {
    expectDeny(check('Read', { file_path: join(other, 'memory', 'note.md') }), /only its own folder/);
    expectDeny(check('Read', { file_path: '../m_abcd/memory/note.md' }));
    expectDeny(check('Read', { file_path: `${mission}d/memory/note.md` }));
    expectDeny(check('Read', { file_path: '../m_abc/../m_abcd/data/file.txt' }));
  });

  it('refuses state, backups, agent.yaml, the missions index and paths outside the root', () => {
    expectDeny(check('Read', { file_path: paths.dbFile }));
    expectDeny(check('Read', { file_path: '../../state/agent.db' }));
    expectDeny(check('Read', { file_path: paths.backupsDir }));
    expectDeny(check('Read', { file_path: '../../agent.yaml' }));
    expectDeny(check('Read', { file_path: '../INDEX.md' }));
    expectDeny(check('Read', { file_path: '/etc/passwd' }));
    expectDeny(check('Read', { file_path: '~/.ssh/id_rsa' }));
    expectDeny(check('Read', { file_path: '~root/.profile' }));
  });

  it('refuses symbolic links that lead out of the mission', () => {
    expectDeny(check('Read', { file_path: 'data/link-other/memory/note.md' }), /leads to/);
    expectDeny(check('Read', { file_path: 'data/link-etc/passwd' }));
    expectDeny(check('Read', { file_path: 'memory/sub-other/note.md' }));
    // The OS follows the link before "..", so this climbs from m_abcd, not from data/.
    expectDeny(check('Read', { file_path: 'data/link-other/../m_abcd/memory/note.md' }));
    expectDeny(check('Read', { file_path: 'data/loop1' }), /could not be checked/);
  });

  it('refuses a call with no path and a path with a null character', () => {
    expectDeny(check('Read', {}));
    expectDeny(check('Read', { file_path: 'memory/note.md\0' }));
  });

  it('checks Glob and Grep paths, defaulting to the mission folder', () => {
    expectAllow(check('Glob', { pattern: '**/*.md' }));
    expectAllow(check('Glob', { pattern: '*.md', path: 'memory' }));
    expectAllow(check('Glob', { pattern: '*.md', path: paths.coreDir }));
    expectDeny(check('Glob', { pattern: '*', path: other }));
    expectDeny(check('Glob', { pattern: '*', path: '..' }));
    expectDeny(check('Glob', { pattern: '*', path: 'data/link-etc' }));
    expectAllow(check('Grep', { pattern: 'hello', path: 'memory' }));
    expectDeny(check('Grep', { pattern: 'hello', path: '../m_abcd' }));
    expectDeny(check('Grep', { pattern: 'id', path: 'manifest.yaml' }));
  });

  it('refuses a Glob pattern or Grep glob that is absolute or climbs out', () => {
    expectDeny(check('Glob', { pattern: '/etc/*' }), /absolute/);
    expectDeny(check('Glob', { pattern: '~/*' }), /absolute/);
    expectDeny(check('Glob', { pattern: '{/etc,data}/*' }), /absolute/);
    expectDeny(check('Glob', { pattern: '../m_abcd/**' }), /\.\./);
    expectDeny(check('Glob', { pattern: 'data/../../m_abcd/*' }), /\.\./);
    expectDeny(check('Glob', { pattern: '{..,data}/*' }), /\.\./);
    expectDeny(check('Grep', { pattern: 'x', path: 'memory', glob: '../*.md' }));
    expectDeny(check('Grep', { pattern: 'x', path: 'memory', glob: '/etc/*' }));
    // A regular expression with dots is not a path.
    expectAllow(check('Grep', { pattern: 'a..b', path: 'memory' }));
  });

  it('refuses a Grep of the whole mission folder unless the glob leaves out manifest.yaml', () => {
    expectDeny(check('Grep', { pattern: 'gate' }), /manifest\.yaml/);
    expectDeny(check('Grep', { pattern: 'gate', path: '.' }));
    expectDeny(check('Grep', { pattern: 'gate', glob: '*.yaml' }));
    expectDeny(check('Grep', { pattern: 'gate', glob: '*.md,*.yaml' }));
    expectDeny(check('Grep', { pattern: 'gate', glob: '*.md *.yaml' }));
    expectDeny(check('Grep', { pattern: 'gate', glob: '!*.md' }));
    expectDeny(check('Grep', { pattern: 'gate', glob: '{*.md,*.yaml}' }));
    expectAllow(check('Grep', { pattern: 'gate', glob: '*.md' }));
    expectAllow(check('Grep', { pattern: 'gate', glob: '*.{md,txt}' }));
  });
});

describe('file tools: writing', () => {
  it('allows memory and data only', () => {
    expectAllow(check('Write', { file_path: 'memory/new.md', content: 'a fact' }));
    expectAllow(check('Write', { file_path: 'data/sub/new.txt', content: 'x' }));
    expectAllow(check('Write', { file_path: join(paths.dataDir(ID), 'report.pdf'), content: 'x' }));
    expectAllow(check('Edit', { file_path: 'data/file.txt', old_string: 'x', new_string: 'y' }));
    expectAllow(check('NotebookEdit', { notebook_path: 'data/n.ipynb', new_source: 'print(1)' }));
  });

  it('refuses the manifest, skills, core, the mission folder and other missions', () => {
    expectDeny(check('Write', { file_path: 'manifest.yaml', content: 'x' }), /memory\/ and data\//);
    expectDeny(check('Edit', { file_path: './manifest.yaml', old_string: 'a', new_string: 'b' }));
    expectDeny(check('Write', { file_path: 'skills/s/SKILL.md', content: 'x' }));
    expectDeny(check('Write', { file_path: paths.coreMemoryFile, content: 'x' }));
    expectDeny(check('Write', { file_path: '../../core/memory.md', content: 'x' }));
    expectDeny(check('Write', { file_path: 'notes.md', content: 'x' }));
    expectDeny(check('Write', { file_path: 'memory', content: 'x' }));
    expectDeny(check('Write', { file_path: 'data/', content: 'x' }));
    expectDeny(check('Write', { file_path: join(other, 'memory', 'x.md'), content: 'x' }));
    expectDeny(check('Write', { file_path: `${mission}d/data/x`, content: 'x' }));
    expectDeny(check('Write', { file_path: 'data/../../m_abcd/data/x', content: 'x' }));
    expectDeny(check('NotebookEdit', { notebook_path: 'skills/n.ipynb', new_source: 'x' }));
    expectDeny(check('NotebookEdit', { file_path: 'data/n.ipynb', new_source: 'x' }), /no path/);
  });

  it('refuses writes through links that lead out, including a link whose target does not exist', () => {
    expectDeny(check('Write', { file_path: 'data/link-other/memory/x.md', content: 'x' }));
    expectDeny(check('Write', { file_path: 'data/link-etc/hosts', content: 'x' }));
    expectDeny(check('Write', { file_path: 'data/dangling', content: 'x' }), /m_abcd/);
    expectDeny(check('Write', { file_path: 'data/link-manifest', content: 'x' }));
    expectDeny(check('Write', { file_path: 'memory/sub-other/x.md', content: 'x' }));
  });

  it('refuses a wrong-case name of a folder that cannot be written', () => {
    expectDeny(check('Write', { file_path: 'Skills/s/SKILL.md', content: 'x' }));
  });

  it.runIf(caseInsensitiveDisk())(
    'on a case-insensitive disk, reads the case from the disk',
    () => {
      expectAllow(check('Write', { file_path: 'MEMORY/note.md', content: 'x' }));
      expectAllow(check('Write', { file_path: '../M_ABC/DATA/file.txt', content: 'x' }));
      expectDeny(check('Write', { file_path: '../M_ABCD/data/file.txt', content: 'x' }));
      expectDeny(check('Read', { file_path: '../M_ABC/Manifest.Yaml' }));
    },
  );
});

describe('file tools: memory limits', () => {
  it('refuses a note over the byte limit and says both sizes', () => {
    const d = check('Write', { file_path: 'memory/big.md', content: 'é'.repeat(2049) });
    expectDeny(d, /at most 4096 bytes.*4098 bytes/);
    expectAllow(check('Write', { file_path: 'memory/ok.md', content: 'a'.repeat(4096) }));
    // data/ has no size limit.
    expectAllow(check('Write', { file_path: 'data/big.txt', content: 'a'.repeat(10_000) }));
  });

  it('refuses an index line over the line limit and says both sizes', () => {
    const d = check('Write', { file_path: 'memory/MEMORY.md', content: `ok\n${'a'.repeat(201)}\n` });
    expectDeny(d, /at most 200 characters, and line 2 would hold 201 characters/);
    // The index is not a note, so it can be larger than 4096 bytes.
    expectAllow(check('Write', { file_path: 'memory/MEMORY.md', content: `${'a'.repeat(200)}\n`.repeat(30) }));
  });

  it('applies the index line limit to a wrong-case memory.md', () => {
    expectDeny(check('Write', { file_path: 'memory/memory.md', content: 'a'.repeat(201) }), /line 1/);
  });

  it('applies an Edit to the current file before it checks the limits', () => {
    const big = 'b'.repeat(4091);
    expectDeny(check('Edit', { file_path: 'memory/note.md', old_string: 'hello', new_string: big }), /4096 bytes/);
    expectAllow(check('Edit', { file_path: 'memory/note.md', old_string: 'hello', new_string: 'hi' }));
    expectDeny(
      check('Edit', { file_path: 'memory/MEMORY.md', old_string: 'a note', new_string: 'x'.repeat(200) }),
      /line 1/,
    );
  });

  it('counts every replacement when replace_all is set', () => {
    write(join(paths.memoryDir(ID), 'many.md'), 'z '.repeat(1500));
    const input = { file_path: 'memory/many.md', old_string: 'z', new_string: 'zzz' };
    expectAllow(check('Edit', input));
    expectDeny(check('Edit', { ...input, replace_all: true }), /bytes/);
  });

  it('lets the path rule decide when the file does not exist or the text is not in it', () => {
    expectAllow(check('Edit', { file_path: 'memory/missing.md', old_string: 'a', new_string: 'b'.repeat(9000) }));
    expectAllow(check('Edit', { file_path: 'memory/note.md', old_string: 'not there', new_string: 'b'.repeat(9000) }));
  });

  it('checks an Edit that creates a missing file with an empty old_string', () => {
    expectDeny(check('Edit', { file_path: 'memory/created.md', old_string: '', new_string: 'b'.repeat(5000) }));
  });

  it('refuses NotebookEdit in memory and a Write with no content', () => {
    expectDeny(check('NotebookEdit', { notebook_path: 'memory/n.ipynb', new_source: 'x' }), /data folder/);
    expectDeny(check('Write', { file_path: 'memory/x.md' }), /no content/);
  });
});

describe('skills', () => {
  it('allows the mission and core skills only', () => {
    expectAllow(check('Skill', { skill: `${ID}:s` }));
    expectAllow(check('Skill', { skill: 'core:tidy' }));
    expectDeny(check('Skill', { skill: 'deep-research' }), /only this mission's own skills/);
    expectDeny(check('Skill', { skill: 'code-review' }));
    expectDeny(check('Skill', { skill: `${OTHER}:s` }));
    expectDeny(check('Skill', { skill: 'm_ab:s' }));
    expectDeny(check('Skill', { skill: 'core' }));
    expectDeny(check('Skill', {}));
  });
});

describe('shell', () => {
  it('denies without tool:shell', () => {
    expectDeny(check('Bash', { command: 'ls' }), /does not have the shell tool/);
  });

  it('always asks with tool:shell and shows the full command, whatever the gates say', () => {
    const command = `rm -rf data/old && echo ${'x'.repeat(3000)}`;
    const m = manifest({
      tools: ['tool:shell'],
      gates: [{ use: 'gate:allow', for: 'action:shell.command' }],
    });
    expect(check('Bash', { command }, m)).toEqual({ decision: 'ask', action: 'action:shell.command', note: command });
    expectDeny(check('Bash', {}, m));
  });

  it('denies PowerShell even when the catalog does not mention it', () => {
    expectDeny(check('PowerShell', { command: 'ls' }, manifest({ tools: ['tool:shell'] })));
  });
});

describe('declared tools and gates', () => {
  it('applies the default rule: read allows, change asks', () => {
    expectAllow(check('mcp__gmail__search', {}));
    expectAllow(check('WebSearch', { query: 'x' }));
    expect(check('mcp__gmail__send', {})).toEqual({ decision: 'ask', action: 'action:email.send' });
  });

  it('denies an undeclared tool, an undeclared MCP tool and SDK tools nobody declared', () => {
    expectDeny(check('mcp__evil__exfiltrate', {}), /no declaration lists this operation/);
    expectDeny(check('mcp__gmail__forward', {}), /no declaration/);
    expectDeny(check('WebFetch', { url: 'https://example.com' }), /no declaration/);
    expectDeny(check('TodoWrite', {}));
  });

  it('denies a declared tool that the manifest does not list', () => {
    expectDeny(check('mcp__calendar__create', {}), /tool:calendar, which this mission does not list/);
  });

  it('denies a reserved tool even when the manifest lists it', () => {
    const m = manifest({ tools: ['tool:mission_registry'] });
    expectDeny(check('mcp__registry__list', {}, m), /reserved/);
  });

  it('follows each kind of gate and passes the note', () => {
    const gates: GateRule[] = [
      { use: 'gate:allow', for: 'action:email.archive' },
      { use: 'gate:require_approval', for: 'action:email.send', note: 'ask before sending any reply' },
      { use: 'gate:deny', for: 'action:email.delete' },
      { use: 'gate:deny', for: 'action:email.search' },
    ];
    const m = manifest({ gates });
    expectAllow(check('mcp__gmail__archive', {}, m));
    expect(check('mcp__gmail__send', {}, m)).toEqual({
      decision: 'ask',
      action: 'action:email.send',
      note: 'ask before sending any reply',
    });
    expectDeny(check('mcp__gmail__delete', {}, m), /forbid/);
    expectDeny(check('mcp__gmail__search', {}, m));
  });

  it('lets the most restrictive gate win when several name the same action', () => {
    const allowAndAsk = manifest({
      gates: [
        { use: 'gate:allow', for: 'action:email.send' },
        { use: 'gate:require_approval', for: 'action:email.send', note: 'check it' },
      ],
    });
    expect(check('mcp__gmail__send', {}, allowAndAsk)).toEqual({ decision: 'ask', action: 'action:email.send', note: 'check it' });
    const askAndDeny = manifest({
      gates: [
        { use: 'gate:deny', for: 'action:email.send' },
        { use: 'gate:require_approval', for: 'action:email.send' },
        { use: 'gate:allow', for: 'action:email.send' },
      ],
    });
    expectDeny(check('mcp__gmail__send', {}, askAndDeny));
  });

  it('always asks for the four registry actions, even with gate:allow', () => {
    const m = manifest({
      id: 'sys-mission-admin',
      tools: ['tool:mission_registry'],
      gates: ['create', 'edit', 'freeze', 'delete'].map((v) => ({ use: 'gate:allow' as const, for: `action:registry.${v}` })),
    });
    for (const v of ['create', 'edit', 'freeze', 'delete']) {
      expect(check(`mcp__registry__${v}`, {}, m)).toEqual({ decision: 'ask', action: `action:registry.${v}` });
    }
    expectAllow(check('mcp__registry__list', {}, m));
  });

  it('allows an always-on tool without a listing and without asking', () => {
    expectAllow(check('mcp__harness__send_message', { text: 'hi' }, manifest({ tools: [] })));
  });

  it('denies the subagent tool even when a declaration lists it', () => {
    expectDeny(check('Agent', { prompt: 'x', description: 'y' }));
    expectDeny(check('Task', { prompt: 'x' }));
  });
});

describe('the mission itself', () => {
  it('denies every call of a frozen mission', () => {
    expectDeny(check('Read', { file_path: 'memory/note.md' }, manifest({ status: 'frozen' })), /frozen/);
  });

  it('denies every call when the mission id could leave the missions folder', () => {
    expectDeny(check('Read', { file_path: 'x' }, manifest({ id: '../m_abcd' })), /not valid/);
  });
});

describe('FILE_TOOL_NAMES', () => {
  it('lists the SDK file tools', () => {
    expect([...FILE_TOOL_NAMES].sort()).toEqual(['Edit', 'Glob', 'Grep', 'NotebookEdit', 'Read', 'Write']);
  });
});
