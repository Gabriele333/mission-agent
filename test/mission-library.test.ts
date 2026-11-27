import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { readMissionsFromFiles } from '../src/cli/offline.js';
import { defaultConfig } from '../src/config/index.js';
import { readLibrary } from '../src/library/index.js';
import { createMissionRegistry, MISSION_ADMIN_MANIFEST, parseManifest, validateManifest } from '../src/manifest/index.js';
import { pathsFor } from '../src/paths.js';
import { builtinTools, createCodeCatalog, createToolCatalog } from '../src/tools/index.js';
import { chatTrigger, createTriggerCatalog, cronTrigger } from '../src/triggers/index.js';
import type { Manifest, ToolCatalog } from '../src/types.js';

/**
 * The rules of mission-library/README.md, checked for every published mission.
 * A mission must also load in a real registry after it is added to an agent.
 */

const LIBRARY = join(dirname(fileURLToPath(import.meta.url)), '..', 'mission-library');
const USER_MISSION_ID = /^m_[0-9a-hjkmnp-tv-z]{12}$/;

const folders = readdirSync(LIBRARY, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

const root = mkdtempSync(join(tmpdir(), 'mission-library-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const paths = pathsFor(root);
const config = defaultConfig('Test');
// The tools and triggers that come with the harness, built the same way as in the harness.
const triggerDefs = [cronTrigger, chatTrigger];
const tools: ToolCatalog = createToolCatalog(
  builtinTools({ paths, config: () => config, catalog: () => tools, triggers: () => triggerDefs }),
);
const catalog = createCodeCatalog(tools, createTriggerCatalog(triggerDefs));

function read(folder: string): Manifest {
  const file = join(LIBRARY, folder, 'manifest.yaml');
  expect(existsSync(file), `mission-library/${folder} needs a manifest.yaml`).toBe(true);
  const parsed = parseManifest(readFileSync(file, 'utf8'), `mission-library/${folder}/manifest.yaml`);
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return parsed.manifest;
}

/** Every link under a folder. A link is not copied into an agent, so a published mission holds none. */
function linksIn(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) found.push(path);
    else if (stat.isDirectory()) found.push(...linksIn(path));
  }
  return found;
}

describe('mission library', () => {
  it('holds at least one mission', () => {
    expect(folders.length).toBeGreaterThan(0);
  });

  it.each(folders)('%s follows the rules for a published mission', (folder) => {
    const m = read(folder);
    expect(m.name, 'the folder name must be the name in the manifest').toBe(folder);
    expect(m.id, 'the id must be "m_" plus 12 base32 characters').toMatch(USER_MISSION_ID);
    expect(m.version).toBe(1);
    expect(m.status).toBe('active');
    expect(validateManifest(m, { catalog, config })).toEqual([]);
    expect(m.gates.filter((g) => g.use === 'gate:allow'), 'a published mission has no gate:allow').toEqual([]);
    expect(existsSync(join(LIBRARY, folder, 'memory')), 'no memory/ folder').toBe(false);
    expect(existsSync(join(LIBRARY, folder, 'data')), 'no data/ folder').toBe(false);
    expect(existsSync(join(LIBRARY, folder, 'README.md')), 'a README.md is required').toBe(true);
    expect(linksIn(join(LIBRARY, folder)), 'no link to another file or folder').toEqual([]);
  });

  it('gives every mission its own id', () => {
    const ids = folders.map((f) => read(f).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('adds every mission to an agent the way the library commands and the mission admin do', () => {
    mkdirSync(paths.missionsDir, { recursive: true });
    const memory = new Map<string, string>();
    const registry = createMissionRegistry({
      paths,
      catalog,
      config: () => config,
      codeManifests: [MISSION_ADMIN_MANIFEST],
      memory: { get: (k) => memory.get(k), set: (k, v) => void memory.set(k, v) },
    });
    const library = readLibrary(LIBRARY);
    expect(library.problems).toEqual([]);
    expect(library.missions.map((m) => m.folder)).toEqual(folders);
    for (const mission of library.missions) {
      const added = registry.install(mission.dir);
      expect(added.id).toBe(mission.manifest.id);
      expect(existsSync(paths.memoryIndexFile(added.id))).toBe(true);
    }
    expect(registry.errors()).toEqual([]);
    expect(readMissionsFromFiles(paths).problems).toEqual([]);
    const loaded = registry.list().map((x) => x.name);
    for (const folder of folders) expect(loaded).toContain(folder);
  });
});
