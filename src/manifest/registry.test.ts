import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { defaultConfig } from '../config/defaults.js';
import { initRootFolder } from '../config/init-root.js';
import { pathsFor, type Paths } from '../paths.js';
import type { CodeCatalog, ManifestDraft } from '../types.js';
import { MISSION_ID_RE } from './ids.js';
import {
  createMissionRegistry,
  ManifestValidationError,
  MissionNotFoundError,
  SystemMissionError,
  type WatchingMissionRegistry,
} from './registry.js';
import { MISSION_ADMIN_MANIFEST } from './system.js';
import { EXAMPLE_YAML, fakeCatalog } from './test-helpers.js';

const EXAMPLE_ID = 'm_k7q3zp2xw9ha';

let root: string;
let paths: Paths;
let memory: Map<string, string>;
let registry: WatchingMissionRegistry;

function makeRegistry(catalog: CodeCatalog = fakeCatalog()): WatchingMissionRegistry {
  return createMissionRegistry({
    paths,
    catalog,
    config: () => defaultConfig('Ada'),
    codeManifests: [MISSION_ADMIN_MANIFEST],
    memory: { get: (k) => memory.get(k), set: (k, v) => void memory.set(k, v) },
    watchDebounceMs: 50,
  });
}

function writeMission(id: string, text: string): void {
  mkdirSync(paths.missionDir(id), { recursive: true });
  writeFileSync(paths.manifestFile(id), text);
}

const readManifestText = (id: string) => readFileSync(paths.manifestFile(id), 'utf8');
const versionInFile = (id: string) => (YAML.parse(readManifestText(id)) as { version: number }).version;

function draft(overrides: Partial<ManifestDraft> = {}): ManifestDraft {
  return {
    name: 'news-curator',
    description: 'Curates my news every morning',
    triggers: [{ use: 'trigger:cron', at: '0 7 * * *' }, { use: 'trigger:chat' }],
    tools: ['tool:web_search', 'tool:web_fetch'],
    context: { instructions: 'You curate my news.\nDone well means: five good links.\n' },
    signals: ['signal:message.rated'],
    gates: [],
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mission-agent-registry-'));
  paths = pathsFor(root);
  initRootFolder(paths);
  memory = new Map();
  registry = makeRegistry();
});
afterEach(() => {
  registry.stopWatching();
  rmSync(root, { recursive: true, force: true });
});

describe('reload', () => {
  it('lists the general mission from its file and the mission admin from the code', () => {
    registry.reload();
    expect(registry.errors()).toEqual([]);
    expect(registry.list().map((m) => m.id)).toEqual(['sys-general', 'sys-mission-admin']);
    expect(registry.get('sys-mission-admin')?.tools).toEqual(['tool:mission_registry']);
    expect(registry.getByName('sys-general')?.id).toBe('sys-general');
    expect(registry.get('m_none')).toBeUndefined();
  });

  it('writes missions/INDEX.md with one line per mission', () => {
    writeMission(EXAMPLE_ID, EXAMPLE_YAML);
    registry.reload();
    const index = readFileSync(paths.missionsIndexFile, 'utf8');
    expect(index).toContain('sys-general → sys-general (active)\n');
    expect(index).toContain('sys-mission-admin → sys-mission-admin (active)\n');
    expect(index).toContain(`${EXAMPLE_ID} → inbox-curator (active)\n`);
  });

  it('does not load an invalid manifest and reports it with its file', () => {
    writeMission(EXAMPLE_ID, EXAMPLE_YAML.replace('tool:calendar', 'tool:fax'));
    registry.reload();
    expect(registry.get(EXAMPLE_ID)).toBeUndefined();
    expect(registry.errors()).toEqual([
      { source: `missions/${EXAMPLE_ID}/manifest.yaml`, message: 'tools[1] "tool:fax" does not exist in the harness.' },
    ]);
  });

  it('reports a manifest with too many YAML aliases as its own error and loads the other missions', () => {
    writeMission(EXAMPLE_ID, EXAMPLE_YAML);
    const bad = 'm_aaaaaaaaaaaa';
    writeMission(bad, `id: ${bad}\nname: &a bad-one\ny: [${Array.from({ length: 150 }, () => '*a').join(', ')}]\n`);
    expect(() => registry.reload()).not.toThrow();
    expect(registry.get(EXAMPLE_ID)?.name).toBe('inbox-curator');
    expect(registry.get(bad)).toBeUndefined();
    expect(registry.errors()).toEqual([
      {
        source: `missions/${bad}/manifest.yaml`,
        message: 'The file could not be read as a manifest: Excessive alias count indicates a resource exhaustion attack',
      },
    ]);
    // Creating and editing other missions still works, because both start with a scan.
    expect(() => registry.edit(EXAMPLE_ID, { description: 'Changed' })).not.toThrow();
    expect(registry.create(draft()).name).toBe('news-curator');
  });

  it('reports a manifest that cannot be read as its own error', () => {
    writeMission(EXAMPLE_ID, EXAMPLE_YAML);
    const bad = 'm_aaaaaaaaaaaa';
    // A folder in place of the file makes the read fail with EISDIR.
    mkdirSync(join(paths.missionDir(bad), 'manifest.yaml'), { recursive: true });
    expect(() => registry.reload()).not.toThrow();
    expect(registry.get(EXAMPLE_ID)).toBeDefined();
    expect(registry.errors()).toHaveLength(1);
    expect(registry.errors()[0]?.message).toMatch(/^The file could not be read: EISDIR/);
  });

  it('needs the folder name to equal the id', () => {
    writeMission('m_2vx8qm4rt6pc', EXAMPLE_YAML);
    registry.reload();
    expect(registry.list()).toHaveLength(2);
    expect(registry.errors()[0]?.message).toBe(`id "${EXAMPLE_ID}" must be the same as the folder name "m_2vx8qm4rt6pc".`);
  });

  it('ignores a manifest file for a system mission whose manifest is part of the code', () => {
    writeMission('sys-mission-admin', YAML.stringify({ ...MISSION_ADMIN_MANIFEST, description: 'Changed' }));
    registry.reload();
    expect(registry.get('sys-mission-admin')?.description).toBe(MISSION_ADMIN_MANIFEST.description);
    expect(registry.errors()[0]?.message).toContain('part of the harness code');
  });

  it('reports a mission folder without a manifest, but not the mission admin folder', () => {
    mkdirSync(paths.missionDir('m_2vx8qm4rt6pc'));
    registry.reload();
    expect(registry.errors()).toEqual([{ source: 'missions/m_2vx8qm4rt6pc', message: 'The folder has no manifest.yaml.' }]);
  });

  it('reports an invalid code manifest with the mission id as source', () => {
    const catalog = { ...fakeCatalog(), toolIds: () => ['tool:web_search', 'tool:web_fetch'] };
    registry = makeRegistry(catalog);
    registry.reload();
    expect(registry.get('sys-mission-admin')).toBeUndefined();
    expect(registry.errors()).toEqual([
      { source: 'sys-mission-admin', message: 'tools[0] "tool:mission_registry" does not exist in the harness.' },
    ]);
  });

  it('rejects a second manifest with a name already in use', () => {
    writeMission(EXAMPLE_ID, EXAMPLE_YAML);
    // On a first scan the files are taken in order of id, so m_k... comes before m_z...
    writeMission('m_zzzzzzzzzzzz', EXAMPLE_YAML.replace(EXAMPLE_ID, 'm_zzzzzzzzzzzz'));
    registry.reload();
    expect(registry.get(EXAMPLE_ID)).toBeDefined();
    expect(registry.get('m_zzzzzzzzzzzz')).toBeUndefined();
    expect(registry.errors()[0]?.message).toBe(`name "inbox-curator" is already used by mission ${EXAMPLE_ID}.`);
  });

  it('keeps the current owner of a name when another mission is renamed to it', () => {
    // m_0... sorts before m_k..., so without the rule it would take the name.
    const other = 'm_0000000000aa';
    writeMission(EXAMPLE_ID, EXAMPLE_YAML);
    writeMission(other, EXAMPLE_YAML.replace(EXAMPLE_ID, other).replace('name: inbox-curator', 'name: other'));
    registry.reload();
    writeMission(other, EXAMPLE_YAML.replace(EXAMPLE_ID, other));
    registry.reload();
    expect(registry.getByName('inbox-curator')?.id).toBe(EXAMPLE_ID);
    expect(registry.get(other)).toBeUndefined();
  });

  it('rejects a frozen general mission', () => {
    writeFileSync(paths.manifestFile('sys-general'), readManifestText('sys-general').replace('status: active', 'status: frozen'));
    registry.reload();
    expect(registry.get('sys-general')).toBeUndefined();
    expect(registry.errors()[0]?.message).toContain('cannot be frozen');
  });

  it('works when the missions folder does not exist', () => {
    rmSync(paths.missionsDir, { recursive: true });
    registry.reload();
    expect(registry.list().map((m) => m.id)).toEqual(['sys-mission-admin']);
  });
});

describe('version rule', () => {
  it('leaves the version as written the first time a file is seen', () => {
    writeMission(EXAMPLE_ID, EXAMPLE_YAML);
    registry.reload();
    expect(registry.get(EXAMPLE_ID)?.version).toBe(3);
    expect(readManifestText(EXAMPLE_ID)).toBe(EXAMPLE_YAML);
    registry.reload();
    expect(readManifestText(EXAMPLE_ID)).toBe(EXAMPLE_YAML);
  });

  it('raises the version by one after a manual edit and keeps comments and formatting', () => {
    writeMission(EXAMPLE_ID, EXAMPLE_YAML);
    registry.reload();
    const edited = EXAMPLE_YAML.replace('  - tool:calendar\n', '');
    writeFileSync(paths.manifestFile(EXAMPLE_ID), edited);
    registry.reload();
    expect(registry.get(EXAMPLE_ID)?.version).toBe(4);
    expect(readManifestText(EXAMPLE_ID)).toBe(
      edited.replace('version: 3                             #', 'version: 4                             #'),
    );
    registry.reload();
    expect(versionInFile(EXAMPLE_ID)).toBe(4);
  });

  it('remembers the hash in the given memory, so a new registry does not raise the version again', () => {
    writeMission(EXAMPLE_ID, EXAMPLE_YAML);
    registry.reload();
    writeFileSync(paths.manifestFile(EXAMPLE_ID), EXAMPLE_YAML.replace('status: active', 'status: frozen'));
    registry.reload();
    expect(versionInFile(EXAMPLE_ID)).toBe(4);
    const second = makeRegistry();
    second.reload();
    expect(second.get(EXAMPLE_ID)?.version).toBe(4);
    expect([...memory.keys()]).toContain(`manifest_hash:${EXAMPLE_ID}`);
  });

  it('counts an invalid intermediate state as no version', () => {
    writeMission(EXAMPLE_ID, EXAMPLE_YAML);
    registry.reload();
    writeFileSync(paths.manifestFile(EXAMPLE_ID), EXAMPLE_YAML.replace('tool:calendar', 'tool:fax'));
    registry.reload();
    expect(registry.get(EXAMPLE_ID)).toBeUndefined();
    expect(versionInFile(EXAMPLE_ID)).toBe(3);
    writeFileSync(paths.manifestFile(EXAMPLE_ID), EXAMPLE_YAML.replace('tool:calendar', 'tool:web_search'));
    registry.reload();
    expect(registry.get(EXAMPLE_ID)?.version).toBe(4);
  });

  it('raises the version once for a programmatic edit, and again for a later manual edit', () => {
    writeMission(EXAMPLE_ID, EXAMPLE_YAML);
    registry.reload();
    expect(registry.edit(EXAMPLE_ID, { description: 'Sorts my inbox' }).version).toBe(4);
    registry.reload();
    registry.reload();
    expect(versionInFile(EXAMPLE_ID)).toBe(4);
    writeFileSync(paths.manifestFile(EXAMPLE_ID), readManifestText(EXAMPLE_ID).replace('effort: low', 'effort: medium'));
    registry.reload();
    expect(versionInFile(EXAMPLE_ID)).toBe(5);
  });

  it('counts a manual edit and a programmatic edit made before the next scan as two edits', () => {
    writeMission(EXAMPLE_ID, EXAMPLE_YAML);
    registry.reload();
    writeFileSync(paths.manifestFile(EXAMPLE_ID), EXAMPLE_YAML.replace('effort: low', 'effort: medium'));
    const m = registry.edit(EXAMPLE_ID, { description: 'Sorts my inbox' });
    expect(m.version).toBe(5);
    expect(m.effort).toBe('medium');
  });
});

describe('onChange', () => {
  it('fires when the valid list or a manifest changes, and not otherwise', () => {
    let calls = 0;
    registry.onChange(() => calls++);
    registry.reload();
    expect(calls).toBe(1);
    registry.reload();
    expect(calls).toBe(1);
    writeMission(EXAMPLE_ID, EXAMPLE_YAML);
    registry.reload();
    expect(calls).toBe(2);
    writeFileSync(paths.manifestFile(EXAMPLE_ID), EXAMPLE_YAML.replace('effort: low', 'effort: high'));
    registry.reload();
    expect(calls).toBe(3);
    registry.reload();
    expect(calls).toBe(3);
  });

  it('fires when the list of errors changes', () => {
    registry.reload();
    let calls = 0;
    registry.onChange(() => calls++);
    writeMission(EXAMPLE_ID, 'id: [broken\n');
    registry.reload();
    expect(calls).toBe(1);
  });
});

describe('create', () => {
  it('creates the folder, the manifest at version 1 and an empty index', () => {
    let calls = 0;
    registry.onChange(() => calls++);
    const m = registry.create(draft());
    expect(m.id).toMatch(MISSION_ID_RE);
    expect(m.version).toBe(1);
    expect(m.status).toBe('active');
    expect(readFileSync(paths.memoryIndexFile(m.id), 'utf8')).toBe('');
    expect(statSync(paths.dataDir(m.id)).isDirectory()).toBe(true);
    expect(statSync(paths.skillsDir(m.id)).isDirectory()).toBe(true);
    const text = readManifestText(m.id);
    expect(Object.keys(YAML.parse(text) as object)).toEqual([
      'id', 'name', 'description', 'version', 'status', 'triggers', 'tools', 'context', 'signals', 'gates',
    ]);
    expect(registry.get(m.id)).toEqual(m);
    expect(calls).toBeGreaterThan(0);
    expect(readFileSync(paths.missionsIndexFile, 'utf8')).toContain(`${m.id} → news-curator (active)`);
    registry.reload();
    expect(versionInFile(m.id)).toBe(1);
  });

  it('keeps a given status', () => {
    expect(registry.create(draft({ status: 'frozen' })).status).toBe('frozen');
  });

  it('throws a ManifestValidationError with every problem and writes nothing', () => {
    registry.reload();
    const before = readdirSync(paths.missionsDir).sort();
    let error: unknown;
    try {
      registry.create(draft({ name: 'News Curator', tools: ['tool:fax'], gates: [{ use: 'gate:deny', for: 'action:x.y' }] }));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ManifestValidationError);
    expect((error as ManifestValidationError).problems).toEqual([
      'name must be short and lowercase, with words joined by hyphens, such as "inbox-curator".',
    ]);
    try {
      registry.create(draft({ tools: ['tool:fax'], gates: [{ use: 'gate:deny', for: 'action:x.y' }] }));
    } catch (e) {
      error = e;
    }
    expect((error as ManifestValidationError).problems).toEqual([
      'tools[0] "tool:fax" does not exist in the harness.',
      'gates[0].for "action:x.y" is not an action of any tool in the harness.',
    ]);
    expect(readdirSync(paths.missionsDir).sort()).toEqual(before);
  });

  it('rejects a name already in use and a sys- name', () => {
    registry.create(draft());
    expect(() => registry.create(draft())).toThrow(/name "news-curator" is already used by mission m_/);
    expect(() => registry.create(draft({ name: 'sys-news' }))).toThrow(ManifestValidationError);
    expect(() => registry.create(draft({ name: 'sys-general' }))).toThrow(ManifestValidationError);
  });

  it('rejects unknown fields given at run time', () => {
    const bad = { ...draft(), owner: 'me' } as ManifestDraft;
    expect(() => registry.create(bad)).toThrow(/Unknown key "owner"/);
  });
});

describe('edit and setStatus', () => {
  it('applies a patch, raises the version once and writes the file', () => {
    const m = registry.create(draft({ model: 'claude-haiku-5-5' }));
    const edited = registry.edit(m.id, { tools: ['tool:web_search'], model: undefined });
    expect(edited.version).toBe(2);
    expect(edited.tools).toEqual(['tool:web_search']);
    expect(edited.model).toBeUndefined();
    const file = YAML.parse(readManifestText(m.id)) as Record<string, unknown>;
    expect(file.version).toBe(2);
    expect(file).not.toHaveProperty('model');
    expect(registry.get(m.id)).toEqual(edited);
  });

  it('does not raise the version when the patch changes nothing', () => {
    const m = registry.create(draft());
    expect(registry.edit(m.id, { name: 'news-curator' }).version).toBe(1);
    expect(registry.setStatus(m.id, 'active').version).toBe(1);
  });

  it('keeps comments of a hand-written file on a status change', () => {
    writeMission(EXAMPLE_ID, EXAMPLE_YAML);
    registry.reload();
    const frozen = registry.setStatus(EXAMPLE_ID, 'frozen');
    expect(frozen.status).toBe('frozen');
    expect(frozen.version).toBe(4);
    expect(readManifestText(EXAMPLE_ID)).toBe(
      EXAMPLE_YAML.replace('version: 3 ', 'version: 4 ').replace('status: active', 'status: frozen'),
    );
    expect(readFileSync(paths.missionsIndexFile, 'utf8')).toContain(`${EXAMPLE_ID} → inbox-curator (frozen)`);
    expect(registry.setStatus(EXAMPLE_ID, 'active').version).toBe(5);
  });

  it('validates the result and writes nothing on an error', () => {
    const m = registry.create(draft());
    const before = readManifestText(m.id);
    expect(() => registry.edit(m.id, { limits: { max_steps: 500 } })).toThrow(ManifestValidationError);
    expect(() => registry.edit(m.id, { description: 'x'.repeat(201) })).toThrow(/description has 201 characters/);
    expect(readManifestText(m.id)).toBe(before);
    expect(registry.get(m.id)?.version).toBe(1);
  });

  it('rejects a rename to a name in use', () => {
    const a = registry.create(draft());
    registry.create(draft({ name: 'other' }));
    expect(() => registry.edit(a.id, { name: 'other' })).toThrow(/already used/);
  });

  it('throws MissionNotFoundError for an unknown or invalid mission', () => {
    expect(() => registry.edit('m_2vx8qm4rt6pc', { description: 'x' })).toThrow(MissionNotFoundError);
    writeMission(EXAMPLE_ID, EXAMPLE_YAML.replace('tool:calendar', 'tool:fax'));
    expect(() => registry.edit(EXAMPLE_ID, { description: 'x' })).toThrow(/manifest is invalid.*tool:fax.*Fix the file first/);
  });
});

describe('remove', () => {
  it('deletes the mission folder and drops it from the list', () => {
    const m = registry.create(draft());
    writeFileSync(join(paths.dataDir(m.id), 'doc.txt'), 'x');
    registry.remove(m.id);
    expect(existsSync(paths.missionDir(m.id))).toBe(false);
    expect(registry.get(m.id)).toBeUndefined();
    expect(readFileSync(paths.missionsIndexFile, 'utf8')).not.toContain(m.id);
    expect(() => registry.remove(m.id)).toThrow(MissionNotFoundError);
  });

  it('can delete a mission whose manifest is invalid', () => {
    writeMission(EXAMPLE_ID, 'broken: [\n');
    registry.remove(EXAMPLE_ID);
    expect(existsSync(paths.missionDir(EXAMPLE_ID))).toBe(false);
  });

  it('refuses an id that is not a mission id', () => {
    expect(() => registry.remove('../state')).toThrow(MissionNotFoundError);
    expect(existsSync(paths.stateDir)).toBe(true);
  });
});

describe('system missions', () => {
  it('cannot be edited, frozen or removed through the four operations', () => {
    registry.reload();
    for (const id of ['sys-general', 'sys-mission-admin', 'sys-self-improve']) {
      expect(() => registry.edit(id, { description: 'x' })).toThrow(SystemMissionError);
      expect(() => registry.setStatus(id, 'frozen')).toThrow(SystemMissionError);
      expect(() => registry.remove(id)).toThrow(SystemMissionError);
    }
    expect(() => registry.setStatus('sys-general', 'frozen')).toThrow('sys-general is a system mission and cannot be frozen.');
    expect(existsSync(paths.manifestFile('sys-general'))).toBe(true);
    expect(registry.get('sys-general')?.status).toBe('active');
  });

  it('cannot be created', () => {
    expect(() => registry.create(draft({ name: 'sys-self-improve' }))).toThrow(ManifestValidationError);
  });
});

describe('watch', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(condition: () => boolean, what: string): Promise<void> {
    for (let waited = 0; !condition(); waited += 20) {
      if (waited > 3000) throw new Error(`timed out waiting for ${what}`);
      await sleep(20);
    }
  }

  it('picks up a change made right after watching starts', async () => {
    registry.reload();
    let calls = 0;
    registry.onChange(() => calls++);
    registry.watch();
    writeMission(EXAMPLE_ID, EXAMPLE_YAML);
    await until(() => calls > 0, 'the first change');
    expect(registry.get(EXAMPLE_ID)?.name).toBe('inbox-curator');
  });

  it('scans again after a file is added and after a manual edit', async () => {
    registry.reload();
    let calls = 0;
    registry.onChange(() => calls++);
    registry.watch();
    await sleep(500);
    writeMission(EXAMPLE_ID, EXAMPLE_YAML);
    await until(() => registry.get(EXAMPLE_ID) !== undefined, 'the new mission');
    writeFileSync(paths.manifestFile(EXAMPLE_ID), EXAMPLE_YAML.replace('effort: low', 'effort: high'));
    await until(() => registry.get(EXAMPLE_ID)?.effort === 'high', 'the edit');
    expect(registry.get(EXAMPLE_ID)?.version).toBe(4);
    expect(calls).toBe(2);
    registry.stopWatching();
  });
});
