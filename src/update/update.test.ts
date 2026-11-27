import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathsFor, type Paths } from '../paths.js';
import type { CommandResult } from './command.js';
import { copyRootFolder, pruneRootCopies, restoreRootFolder, runUpdate, updateCopiesDir, UpdateError, type UpdateDeps } from './update.js';

/**
 * A program folder and a root folder on disk, with fake `git`, `npm`, `node` and a fake service.
 * `world` is what the fakes read and change.
 */
interface World {
  /** The release tags that the repository has. */
  tags: string[];
  notes: Record<string, string>;
  /** The tag or commit that the program folder is at. */
  head: string;
  dirty: boolean;
  /** Commands that fail, by a word of the command line. */
  failing: Set<string>;
  service: { installed: boolean; loaded: boolean; pid?: number };
  /** A harness that runs outside the service. */
  foregroundPid?: number;
  others: string[];
  /** The version that each tag or commit reports once it is built. */
  versionOf: Record<string, string>;
  /** Versions whose harness never answers after a start. */
  silent: Set<string>;
  /** What the harness of a version does to the root folder when it starts. */
  onStart?: (version: string) => void;
  answer: boolean;
}

let tmp: string;
let programDir: string;
let paths: Paths;
let world: World;
let commands: string[];
let lines: string[];
let questions: string[];
let clock: number;

const OK: CommandResult = { code: 0, stdout: '', stderr: '' };
const text = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string): CommandResult => ({ code: 1, stdout: '', stderr });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mission-agent-update-'));
  programDir = join(tmp, 'app');
  mkdirSync(join(programDir, '.git'), { recursive: true });
  mkdirSync(join(programDir, 'dist'));
  writeFileSync(join(programDir, 'dist', 'cli.js'), '// old\n');
  writeFileSync(join(programDir, 'dist', 'removed-in-the-new-release.js'), '// old\n');

  paths = pathsFor(join(tmp, 'root'));
  mkdirSync(join(paths.root, 'missions', 'm_aaaaaaaaaaaa', 'memory'), { recursive: true });
  mkdirSync(paths.stateDir);
  mkdirSync(join(paths.backupsDir, 'memory'), { recursive: true });
  writeFileSync(paths.agentYaml, 'agent_name: Ada\n');
  writeFileSync(join(paths.root, 'missions', 'm_aaaaaaaaaaaa', 'memory', 'note.md'), 'a note\n');
  writeFileSync(paths.dbFile, 'the database\n');
  writeFileSync(join(paths.backupsDir, 'memory', 'old.md'), 'an older copy\n');

  world = {
    tags: ['v0.1.0', 'v0.2.0'],
    notes: { 'v0.2.0': 'Adds the mission library.\nThe data format did not change.\n' },
    head: 'v0.1.0',
    dirty: false,
    failing: new Set(),
    service: { installed: true, loaded: true, pid: 4242 },
    others: [],
    versionOf: { 'v0.1.0': '0.1.0', 'v0.2.0': '0.2.0', commit1: '0.1.0' },
    silent: new Set(),
    answer: true,
  };
  commands = [];
  lines = [];
  questions = [];
  clock = Date.parse('2026-03-04T05:06:07');
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function deps(extra: Partial<UpdateDeps> = {}): UpdateDeps {
  return {
    programDir,
    paths,
    nodePath: '/fake/node',
    async run(program, args) {
      const line = `${program} ${args.join(' ')}`;
      commands.push(line);
      for (const word of world.failing) if (line.includes(word)) return fail(`${word} failed`);
      if (program === 'git') {
        if (args[0] === 'status') return text(world.dirty ? ' M src/cli.ts\n' : '');
        if (args[0] === 'describe') return world.tags.includes(world.head) ? text(`${world.head}\n`) : fail('fatal: no tag exactly matches');
        if (args[0] === 'rev-parse') return text('commit1\n');
        if (args[0] === 'fetch') return OK;
        if (args[0] === 'tag' && args.length === 3 && args[2] === 'v*') return text(world.tags.join('\n') + '\n');
        if (args[0] === 'tag') return text(world.notes[args[3] as string] ?? '');
        if (args.includes('checkout')) {
          world.head = args[args.length - 1] as string;
          return OK;
        }
      }
      if (program === 'npm' && args[0] === 'ci') return OK;
      if (program === 'npm' && args[1] === 'build') {
        mkdirSync(join(programDir, 'dist'), { recursive: true });
        writeFileSync(join(programDir, 'dist', 'cli.js'), `// ${world.head}\n`);
        return OK;
      }
      if (program === '/fake/node') return text(`${world.versionOf[world.head]}\n`);
      return fail(`unexpected command: ${line}`);
    },
    service: {
      status: async () => ({ ...world.service }),
      install: async () => {
        commands.push('service install');
        const version = world.versionOf[world.head] as string;
        world.onStart?.(version);
        world.service = world.silent.has(version) ? { installed: true, loaded: true } : { installed: true, loaded: true, pid: 5000 };
      },
      uninstall: async () => {
        commands.push('service uninstall');
        world.service = { installed: false, loaded: false };
      },
      others: () => world.others,
    },
    async findHarness() {
      if (world.foregroundPid !== undefined) return { pid: world.foregroundPid, version: '0.1.0' };
      if (world.service.pid === undefined) return undefined;
      return { pid: world.service.pid, version: world.versionOf[world.head] as string };
    },
    async confirm(question) {
      questions.push(question);
      return world.answer;
    },
    out: (line) => lines.push(line),
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
    stopWaitMs: 2_000,
    startWaitMs: 2_000,
    ...extra,
  };
}

const output = () => lines.join('\n');
const copies = () => (existsSync(updateCopiesDir(paths)) ? readdirSync(updateCopiesDir(paths)).sort() : []);

describe('the update command', () => {
  it('stops the harness, copies the root folder, installs the release, starts the harness and checks its version', async () => {
    expect(await runUpdate(deps())).toBe(0);

    expect(output()).toContain('Version 0.2.0 is available. You have 0.1.0.');
    expect(output()).toContain('  Adds the mission library.');
    expect(questions).toEqual(['Install version 0.2.0? [y/N] ']);
    // The order of the steps of chapter 7.4.
    const steps = commands.filter((c) => /^service|checkout|^npm/.test(c));
    expect(steps).toEqual([
      'service uninstall',
      'git -c advice.detachedHead=false checkout --detach v0.2.0',
      'npm ci',
      'npm run build',
      'service install',
    ]);
    expect(readFileSync(join(programDir, 'dist', 'cli.js'), 'utf8')).toBe('// v0.2.0\n');
    expect(existsSync(join(programDir, 'dist', 'removed-in-the-new-release.js'))).toBe(false);

    // The copy holds everything except backups/.
    expect(copies()).toEqual(['0.1.0-2026-03-04-050607']);
    const copy = join(updateCopiesDir(paths), '0.1.0-2026-03-04-050607');
    expect(readdirSync(copy).sort()).toEqual(['agent.yaml', 'missions', 'state']);
    expect(readFileSync(join(copy, 'state', 'agent.db'), 'utf8')).toBe('the database\n');
    expect(readFileSync(join(copy, 'missions', 'm_aaaaaaaaaaaa', 'memory', 'note.md'), 'utf8')).toBe('a note\n');
    expect(output()).toContain('Version 0.2.0 is installed. The harness runs.');
    expect(output()).toContain(copy);
  });

  it('changes nothing when the installed release is the newest', async () => {
    world.head = 'v0.2.0';
    expect(await runUpdate(deps())).toBe(0);
    expect(output()).toBe('You have the newest release, 0.2.0. Nothing was changed.');
    expect(commands.some((c) => /checkout|service|npm/.test(c))).toBe(false);
    expect(copies()).toEqual([]);
  });

  it('changes nothing when the user does not confirm', async () => {
    world.answer = false;
    expect(await runUpdate(deps())).toBe(0);
    expect(output()).toContain('Nothing was changed.');
    expect(commands.some((c) => /checkout|service|npm/.test(c))).toBe(false);
    expect(world.service.loaded).toBe(true);
    expect(copies()).toEqual([]);
  });

  it('refuses a program folder that is not an installed release', async () => {
    world.dirty = true;
    await expect(runUpdate(deps())).rejects.toThrow(/development copy/);
    world.dirty = false;
    world.head = 'some-branch-commit';
    await expect(runUpdate(deps())).rejects.toThrow(/is not at a release/);
    rmSync(join(programDir, '.git'), { recursive: true });
    await expect(runUpdate(deps())).rejects.toThrow(UpdateError);
    expect(commands.some((c) => /checkout|service|npm|fetch/.test(c))).toBe(false);
  });

  it('refuses while a harness runs in the foreground, and while another agent runs the same program', async () => {
    world.foregroundPid = 77;
    await expect(runUpdate(deps())).rejects.toThrow(/runs in the foreground \(process 77\)/);
    delete world.foregroundPid;
    world.others = ['/Library/LaunchAgents/local.mission-agent.other.plist'];
    await expect(runUpdate(deps())).rejects.toThrow(/Other agents run this same program/);
    expect(questions).toEqual([]);
    expect(world.service.loaded).toBe(true);
  });

  it('installs the old release again when the new one cannot be installed', async () => {
    world.failing.add('checkout --detach v0.2.0');
    expect(await runUpdate(deps())).toBe(1);
    expect(output()).toContain('The update failed: git could not switch to version 0.2.0');
    expect(output()).toContain('Version 0.1.0 is installed again. The harness runs.');
    expect(commands.filter((c) => /^service|checkout|^npm/.test(c))).toEqual([
      'service uninstall',
      'git -c advice.detachedHead=false checkout --detach v0.2.0',
      'git -c advice.detachedHead=false checkout --detach commit1',
      'npm ci',
      'npm run build',
      'service install',
    ]);
    expect(world.head).toBe('commit1');
    expect(world.service.pid).toBe(5000);
    // The harness of the new release never ran, so the root folder is as it was.
    expect(readFileSync(paths.dbFile, 'utf8')).toBe('the database\n');
  });

  it('puts the copy of the root folder back when the new harness started and did not answer', async () => {
    world.silent.add('0.2.0');
    world.onStart = (version) => {
      if (version !== '0.2.0') return;
      writeFileSync(paths.dbFile, 'migrated by 0.2.0\n');
      writeFileSync(join(paths.root, 'new-file'), 'x');
    };
    expect(await runUpdate(deps())).toBe(1);
    expect(output()).toContain('The update failed: The harness did not answer after its start.');
    expect(output()).toContain('Version 0.1.0 is installed again. The harness runs.');
    expect(readFileSync(paths.dbFile, 'utf8')).toBe('the database\n');
    expect(existsSync(join(paths.root, 'new-file'))).toBe(false);
    expect(readFileSync(join(paths.backupsDir, 'memory', 'old.md'), 'utf8')).toBe('an older copy\n');
    expect(world.head).toBe('commit1');
    expect(world.service).toEqual({ installed: true, loaded: true, pid: 5000 });
  });

  it('goes back when the harness answers with another version', async () => {
    world.versionOf['v0.2.0'] = '0.1.9';
    expect(await runUpdate(deps())).toBe(1);
    expect(output()).toContain('it reports version 0.1.9 and not 0.2.0');
    expect(world.head).toBe('commit1');
  });

  it('without a service, installs the release and checks that the new program starts', async () => {
    world.service = { installed: false, loaded: false };
    expect(await runUpdate(deps())).toBe(0);
    expect(commands.some((c) => c.startsWith('service'))).toBe(false);
    expect(commands).toContain(`/fake/node ${join(programDir, 'dist', 'cli.js')} --version`);
    expect(output()).toContain('Version 0.2.0 is installed.');
    expect(output()).not.toContain('The harness runs.');
    expect(copies()).toHaveLength(1);
  });

  it('says what to do by hand when going back fails too', async () => {
    world.failing.add('npm ci');
    expect(await runUpdate(deps())).toBe(1);
    expect(output()).toContain('Going back failed too: npm could not install the packages of version 0.1.0');
    expect(output()).toContain('The version before the update is the commit commit1.');
    expect(output()).toContain('Follow "Go back to the old version" in docs/update.md.');
  });

  it('starts the harness again when the root folder cannot be copied', async () => {
    const broken = deps();
    const failingCopy: UpdateDeps = {
      ...broken,
      service: {
        ...broken.service,
        uninstall: async () => {
          await broken.service.uninstall();
          // A file where the folder of the copies must be makes the copy fail.
          writeFileSync(join(paths.backupsDir, 'update'), 'in the way');
        },
      },
    };
    expect(await runUpdate(failingCopy)).toBe(1);
    expect(output()).toContain('The update failed:');
    expect(commands.some((c) => c.includes('checkout'))).toBe(false);
    expect(world.service.pid).toBe(5000);
    expect(world.head).toBe('v0.1.0');
  });
});

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
