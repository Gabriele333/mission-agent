import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathsFor, type Paths } from '../paths.js';
import { copyRootFolder, pruneRootCopies, restoreRootFolder, updateCopiesDir } from './update.js';

/** The update itself is tested in src/maintenance/update.test.ts. */

let tmp: string;
let paths: Paths;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mission-agent-update-'));
  paths = pathsFor(join(tmp, 'root'));
  mkdirSync(join(paths.root, 'missions', 'm_aaaaaaaaaaaa', 'memory'), { recursive: true });
  mkdirSync(paths.stateDir);
  mkdirSync(join(paths.backupsDir, 'memory'), { recursive: true });
  writeFileSync(paths.agentYaml, 'agent_name: Ada\n');
  writeFileSync(join(paths.root, 'missions', 'm_aaaaaaaaaaaa', 'memory', 'note.md'), 'a note\n');
  writeFileSync(paths.dbFile, 'the database\n');
  writeFileSync(join(paths.backupsDir, 'memory', 'old.md'), 'an older copy\n');
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('the copies of the root folder', () => {
  it('keeps the two newest copies', () => {
    const made: string[] = [];
    for (const [version, day] of [
      ['0.3.0', 3],
      ['0.1.0', 1],
      ['0.2.0', 2],
    ] as const) {
      made.push(copyRootFolder(paths, version, new Date(2026, 0, day, 10, 0, 0)) as string);
    }
    mkdirSync(join(updateCopiesDir(paths), 'made-by-hand'));
    pruneRootCopies(paths);
    expect(readdirSync(updateCopiesDir(paths)).sort()).toEqual(['0.2.0-2026-01-02-100000', '0.3.0-2026-01-03-100000', 'made-by-hand']);
    expect(made).toHaveLength(3);
  });

  it('copies everything except backups/', () => {
    const copy = copyRootFolder(paths, '0.1.0', new Date(2026, 2, 4, 5, 6, 7)) as string;
    expect(copy).toBe(join(updateCopiesDir(paths), '0.1.0-2026-03-04-050607'));
    expect(readdirSync(copy).sort()).toEqual(['agent.yaml', 'missions', 'state']);
    expect(readFileSync(join(copy, 'state', 'agent.db'), 'utf8')).toBe('the database\n');
    expect(existsSync(join(copy, 'backups'))).toBe(false);
  });

  it('copies nothing when the root folder does not exist', () => {
    expect(copyRootFolder(pathsFor(join(tmp, 'missing')), '0.1.0', new Date())).toBeUndefined();
    expect(existsSync(join(tmp, 'missing'))).toBe(false);
  });

  it('puts a copy back and leaves backups/ as it is', () => {
    const copy = copyRootFolder(paths, '0.1.0', new Date()) as string;
    rmSync(paths.agentYaml);
    writeFileSync(paths.dbFile, 'changed\n');
    mkdirSync(join(paths.root, 'tools'));
    restoreRootFolder(paths, copy);
    expect(readdirSync(paths.root).sort()).toEqual(['agent.yaml', 'backups', 'missions', 'state']);
    expect(readFileSync(paths.dbFile, 'utf8')).toBe('the database\n');
    expect(existsSync(copy)).toBe(true);
  });
});
