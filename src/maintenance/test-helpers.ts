import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { serviceLabel, xmlEscape } from '../service/plist.js';
import type { LaunchctlResult } from '../service/service.js';
import type { CommandResult } from '../update/command.js';
import type { HarnessFound, Maint } from './context.js';
import { copyMaintenance, writeCommandFile, writeInstallInfo } from './files.js';
import { layoutFor, type Layout } from './layout.js';

/**
 * A fake computer for the tests of the maintenance program: real folders in a temporary folder,
 * and fakes for git, npm, node, launchctl and the harness. A program folder is "built" when its
 * `dist/cli.js` names its release. What a release does is set in `releases`.
 */

export const REPO = 'https://example.invalid/mission-agent.git';

export interface Release {
  version: string;
  notes?: string;
  /** The step of the build that fails. */
  fails?: 'clone' | 'npm-ci' | 'build';
  /** What `--version` prints. Default: the version. */
  reports?: string;
  /** The self-test fails. */
  selfTestFails?: boolean;
  /** Its harness never answers after a start. */
  silent?: boolean;
  /** The version its harness reports. Default: the version. */
  harnessReports?: string;
}

export interface World {
  tmp: string;
  home: string;
  layout: Layout;
  root: string;
  launchAgents: string;
  userHome: string;
  releases: Record<string, Release>;
  /** launchd: label to whether it is loaded, and the program and root folder of its file. */
  loaded: Set<string>;
  /** The harness that answers for each root folder. */
  harness: Map<string, HarnessFound>;
  /** A harness that runs in a terminal. */
  foreground?: { root: string; pid: number };
  dirty: boolean;
  lines: string[];
  commands: string[];
  hits: string[];
  clock: number;
  nextPid: number;
  alive: Set<number>;
  /** What the hook point does at a step: fail it, or stop the process there. */
  hook?: (step: string) => 'fail' | 'kill' | undefined;
  /** Resolves when a run was stopped at a hook point. */
  killed: Promise<void>;
  /** The answers of the person at the terminal, in order. Undefined: nobody can be asked. */
  answers?: string[];
  questions: string[];
}

export function makeWorld(): World {
  const tmp = mkdtempSync(join(tmpdir(), 'mission-agent-maintenance-'));
  const home = join(tmp, 'home', '.mission-agent');
  mkdirSync(home, { recursive: true });
  const w: World = {
    tmp,
    home,
    layout: layoutFor(home),
    root: join(tmp, 'agents', 'ada'),
    launchAgents: join(tmp, 'LaunchAgents'),
    userHome: join(tmp, 'home'),
    releases: {
      'v0.1.0': { version: '0.1.0', notes: 'The first release.' },
      'v0.2.0': { version: '0.2.0', notes: 'Adds the maintenance program.\nThe data format did not change.' },
    },
    loaded: new Set(),
    harness: new Map(),
    dirty: false,
    lines: [],
    commands: [],
    hits: [],
    clock: Date.parse('2026-03-04T05:06:07'),
    nextPid: 1000,
    alive: new Set(),
    killed: Promise.resolve(),
    questions: [],
  };
  mkdirSync(w.launchAgents, { recursive: true });
  // The agent's root folder, with data.
  mkdirSync(join(w.root, 'missions', 'm_aaaaaaaaaaaa', 'memory'), { recursive: true });
  mkdirSync(join(w.root, 'state'), { recursive: true });
  mkdirSync(join(w.root, 'backups', 'memory'), { recursive: true });
  writeFileSync(join(w.root, 'agent.yaml'), 'agent_name: Ada\n');
  writeFileSync(join(w.root, 'missions', 'm_aaaaaaaaaaaa', 'memory', 'note.md'), 'a note\n');
  writeFileSync(join(w.root, 'state', 'agent.db'), 'the database\n');
  writeFileSync(join(w.root, 'backups', 'memory', 'old.md'), 'an older copy\n');
  return w;
}

export function dropWorld(w: World): void {
  rmSync(w.tmp, { recursive: true, force: true });
}

/** Every file of the root folder except `backups/`, with its content. */
export function rootContent(w: World): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (p === join(w.root, 'backups')) continue;
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(w.root, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(w.root);
  return out;
}

/** Writes a built program folder of a release. */
export function writeProgram(w: World, dir: string, tag: string, parts: { built?: boolean; modules?: boolean } = {}): void {
  const r = w.releases[tag];
  if (r === undefined) throw new Error(`no release ${tag}`);
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'tag'), tag);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mission-agent', version: r.version, type: 'module' }));
  if (parts.modules !== false) mkdirSync(join(dir, 'node_modules'), { recursive: true });
  if (parts.built !== false) {
    mkdirSync(join(dir, 'dist', 'maintenance'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'cli.js'), JSON.stringify({ tag }));
    writeFileSync(join(dir, 'dist', 'maintenance', 'main.js'), `// the maintenance program of ${tag}\n`);
  }
}

/** The release of a built program folder. */
function releaseOf(w: World, cli: string): { tag: string; release: Release } | undefined {
  try {
    const tag = (JSON.parse(readFileSync(cli, 'utf8')) as { tag: string }).tag;
    const release = w.releases[tag];
    return release === undefined ? undefined : { tag, release };
  } catch {
    return undefined;
  }
}

function plistText(cli: string, root: string, label: string): string {
  return `<plist><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/fake/node</string><string>${xmlEscape(cli)}</string><string>start</string><string>--root</string><string>${xmlEscape(root)}</string></array></dict></plist>\n`;
}

/** What `service install` of a program does: writes the file, loads it, and starts the harness. */
export function serviceInstall(w: World, cli: string, root: string): void {
  const label = serviceLabel(root);
  writeFileSync(join(w.launchAgents, `${label}.plist`), plistText(cli, root, label));
  w.loaded.add(label);
  const found = releaseOf(w, cli);
  if (found === undefined || found.release.silent === true) {
    w.harness.delete(root);
    return;
  }
  const version = found.release.harnessReports ?? found.release.version;
  // A harness of a newer version changes the data at its start, as a migration would.
  if (version !== '0.1.0') writeFileSync(join(root, 'state', 'agent.db'), `migrated by ${version}\n`);
  w.harness.set(root, { pid: w.nextPid++, version });
}

/** An installed agent: release `tag` in `app`, with the maintenance program, the command file and a running service. */
export function installed(w: World, tag = 'v0.1.0', options: { service?: boolean } = {}): void {
  writeProgram(w, w.layout.app, tag);
  copyMaintenance(w.layout, w.layout.app);
  writeCommandFile(w.layout);
  writeInstallInfo(w.layout, { repo: REPO, version: (w.releases[tag] as Release).version, installedAt: '2026-01-01T00:00:00.000Z' });
  if (options.service !== false) serviceInstall(w, join(w.layout.app, 'dist', 'cli.js'), w.root);
}

const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
const bad = (stderr: string, code = 1): CommandResult => ({ code, stdout: '', stderr });

/** The fake git, npm and node. */
async function run(w: World, program: string, args: string[], cwd: string): Promise<CommandResult> {
  const line = `${program} ${args.join(' ')}`;
  w.commands.push(line);
  if (program === 'git') {
    const sub = args.includes('clone') ? 'clone' : args[0];
    switch (sub) {
      case '--version':
        return ok('git version 2.0.0\n');
      case 'ls-remote':
        return ok(Object.keys(w.releases).map((t) => `${'a'.repeat(40)}\trefs/tags/${t}`).join('\n') + '\n');
      case 'status':
        return ok(w.dirty ? ' M src/cli.ts\n' : '');
      case 'describe': {
        const tagFile = join(cwd, '.git', 'tag');
        return existsSync(tagFile) ? ok(`${readFileSync(tagFile, 'utf8')}\n`) : bad('fatal: no tag exactly matches', 128);
      }
      case 'remote':
        return existsSync(join(cwd, '.git')) ? ok(`${REPO}\n`) : bad('fatal: not a git repository', 128);
      case 'fetch':
        return ok();
      case 'for-each-ref': {
        const tag = (args[2] as string).replace('refs/tags/', '');
        return ok(`${w.releases[tag]?.notes ?? ''}\n`);
      }
      case 'clone': {
        const tag = args[args.indexOf('--branch') + 1] as string;
        const target = args[args.length - 1] as string;
        const r = w.releases[tag];
        if (r === undefined) return bad(`fatal: Remote branch ${tag} not found`, 128);
        if (r.fails === 'clone') return bad('fatal: unable to access the repository', 128);
        writeProgram(w, target, tag, { built: false, modules: false });
        return ok();
      }
    }
  }
  if (program === 'npm') {
    if (args[0] === '--version') return ok('11.0.0\n');
    const tag = readFileSync(join(cwd, '.git', 'tag'), 'utf8');
    const r = w.releases[tag] as Release;
    if (args[0] === 'ci') {
      if (r.fails === 'npm-ci') return bad('npm error network');
      mkdirSync(join(cwd, 'node_modules'), { recursive: true });
      return ok();
    }
    if (args[0] === 'run' && args[1] === 'build') {
      if (r.fails === 'build') return bad('src/cli.ts(1,1): error TS1005');
      writeProgram(w, cwd, tag, { built: true, modules: true });
      return ok();
    }
  }
  if (program === '/fake/node') {
    const cli = args[0] as string;
    const found = releaseOf(w, cli);
    const dir = join(cli, '..', '..');
    if (found === undefined) return bad(`Error: Cannot find module '${cli}'`);
    if (!existsSync(join(dir, 'node_modules'))) return bad("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'yaml'");
    const r = found.release;
    if (args[1] === '--version') return ok(`${r.reports ?? r.version}\n`);
    if (args[1] === 'self-test') return r.selfTestFails === true ? bad('The database does not open.') : ok('The self-test passed.\n');
    if (args[1] === 'service' && args[2] === 'install') {
      serviceInstall(w, cli, args[4] as string);
      return ok('  File:     the file\n');
    }
    if (args[1] === 'service' && args[2] === 'status') return ok();
  }
  return bad(`unexpected command: ${line}`, 127);
}

/** The fake launchctl. `print` answers for a loaded label, `bootout` stops the harness of its root folder. */
async function launchctl(w: World, args: string[]): Promise<LaunchctlResult> {
  const label = (args[1] ?? '').split('/').pop() as string;
  if (args[0] === 'print') {
    if (!w.loaded.has(label)) return { code: 113, stdout: '', stderr: 'Could not find service' };
    const h = w.harness.get(w.root);
    return { code: 0, stdout: h !== undefined && serviceLabel(w.root) === label ? `\tpid = ${h.pid}\n\tstate = running\n` : '\tstate = not running\n', stderr: '' };
  }
  if (args[0] === 'bootout') {
    w.loaded.delete(label);
    if (serviceLabel(w.root) === label) w.harness.delete(w.root);
    return { code: 0, stdout: '', stderr: '' };
  }
  return { code: 0, stdout: '', stderr: '' };
}

/** A maintenance run on the fake computer. Each run is a new process, with its own process id. */
export function maint(w: World): Maint {
  const pid = w.nextPid++;
  w.alive.add(pid);
  let resolveKilled: () => void = () => {};
  w.killed = new Promise((r) => (resolveKilled = r));
  return {
    layout: w.layout,
    repo: REPO,
    launchAgents: w.launchAgents,
    keychainService: 'mission-agent-test',
    userHome: w.userHome,
    uid: 501,
    nodePath: '/fake/node',
    envPath: '',
    run: (program, args, options) => run(w, program, args, options.cwd),
    runAttached: async (program, args) => (await run(w, program, args, w.home)).code,
    launchctl: (args) => launchctl(w, args),
    async findHarness(root) {
      if (w.foreground?.root === root) return { pid: w.foreground.pid, version: '0.1.0' };
      return w.harness.get(root);
    },
    security: async () => ({ code: 44 }),
    ask: {
      canAsk: () => w.answers !== undefined && w.answers.length > 0,
      async line(question) {
        w.questions.push(question);
        return w.answers?.shift();
      },
    },
    out: (line) => w.lines.push(line),
    log: () => {},
    now: () => new Date(w.clock),
    sleep: async (ms) => {
      w.clock += ms;
    },
    pid,
    alive: (p) => w.alive.has(p),
    async checkpoint(step) {
      w.hits.push(step);
      const action = w.hook?.(step);
      if (action === 'fail') throw new Error(`injected failure at ${step}`);
      if (action === 'kill') {
        // The process is gone: nothing after this point runs, not even a finally block.
        w.alive.delete(pid);
        resolveKilled();
        await new Promise(() => {});
      }
    },
    env: {},
    waits: { stopMs: 30_000, startMs: 90_000, pollMs: 500 },
  };
}

/** Runs an operation that a hook point may stop. Resolves with its exit code, or with "killed". */
export async function runOrKilled(w: World, op: Promise<number>): Promise<number | 'killed'> {
  const killed = w.killed.then(() => 'killed' as const);
  return Promise.race([op, killed]);
}

/** What the program in a folder reports, through the fake node, or undefined when it does not start. */
export async function versionIn(w: World, dir: string): Promise<string | undefined> {
  const r = await run(w, '/fake/node', [join(dir, 'dist', 'cli.js'), '--version'], dir);
  return r.code === 0 ? r.stdout.trim() : undefined;
}
