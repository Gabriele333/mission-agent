import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseManifest } from '../manifest/schema.js';
import { pathsFor, type Paths } from '../paths.js';
import { initRootFolder } from './init-root.js';

let root: string;
let paths: Paths;

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), 'mission-agent-init-')), 'agent');
  paths = pathsFor(root);
});
afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }));

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

describe('initRootFolder', () => {
  it('creates the folder tree of §E.2.3', () => {
    initRootFolder(paths);
    for (const dir of [
      paths.coreDir,
      paths.coreSkillsDir,
      paths.missionsDir,
      paths.stateDir,
      paths.backupsDir,
      paths.memoryDir('sys-general'),
      paths.dataDir('sys-general'),
      paths.skillsDir('sys-general'),
      paths.memoryDir('sys-mission-admin'),
      paths.dataDir('sys-mission-admin'),
      paths.skillsDir('sys-mission-admin'),
    ]) {
      expect(isDir(dir), dir).toBe(true);
    }
    expect(readFileSync(paths.coreMemoryFile, 'utf8')).toBe('');
    expect(readFileSync(paths.memoryIndexFile('sys-general'), 'utf8')).toBe('');
    expect(readFileSync(paths.memoryIndexFile('sys-mission-admin'), 'utf8')).toBe('');
    expect(existsSync(paths.manifestFile('sys-mission-admin'))).toBe(false);
  });

  it('writes the general manifest of §4.1 without the staging tool', () => {
    initRootFolder(paths);
    const text = readFileSync(paths.manifestFile('sys-general'), 'utf8');
    const result = parseManifest(text, 'missions/sys-general/manifest.yaml');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest).toMatchObject({
      id: 'sys-general',
      name: 'sys-general',
      version: 1,
      status: 'active',
      triggers: [{ use: 'trigger:chat' }],
      tools: ['tool:web_search', 'tool:web_fetch'],
      signals: [],
      gates: [],
      model: 'default',
    });
    expect(text).not.toContain('promotion_stage');
    expect(result.manifest.context.instructions).not.toContain('stage');
    expect(text).toContain('# search the web; it only reads (§A.5)');
  });

  it('never overwrites a file and can run twice', () => {
    initRootFolder(paths);
    writeFileSync(paths.coreMemoryFile, 'The user lives in Paris.\n');
    writeFileSync(paths.manifestFile('sys-general'), 'changed by hand\n');
    writeFileSync(paths.memoryIndexFile('sys-general'), '- note\n');
    initRootFolder(paths);
    expect(readFileSync(paths.coreMemoryFile, 'utf8')).toBe('The user lives in Paris.\n');
    expect(readFileSync(paths.manifestFile('sys-general'), 'utf8')).toBe('changed by hand\n');
    expect(readFileSync(paths.memoryIndexFile('sys-general'), 'utf8')).toBe('- note\n');
  });
});
