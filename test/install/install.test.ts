/**
 * The real install test (chapter 7.6). The installer is one of the most critical parts, so this
 * test runs the real install.sh, the real maintenance program, real git and real npm against a
 * repository that it makes with `git init`. It never installs a service, never opens a browser,
 * and writes only in a temporary folder. Its releases:
 *
 *   v0.2.0, v0.2.1, v0.2.5   good releases of the code in this working tree
 *   v0.2.2                   the build fails
 *   v0.2.3                   the program says it is version 0.2.9
 *   v0.2.4                   the self-test of the program fails
 *
 * The steps run in order and share one installation. Run it with: npm run test:install
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STEP_MS = 240_000;
const SELF_TEST_LINE = 'The mission-agent maintenance program runs.';

let tmp: string;
let home: string;
let root: string;
let bare: string;
let env: NodeJS.ProcessEnv;
const started = Date.now();

interface Ran {
  code: number;
  out: string;
}

/**
 * Runs a command in its own session, so it has no terminal: /dev/tty cannot be opened, and
 * nothing can wait for a person. The answers, when given, come on standard input.
 */
function run(program: string, args: string[], options: { answers?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Ran> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(program, args, {
      cwd: tmp,
      detached: true,
      env: { ...env, ...(options.answers !== undefined ? { MISSION_AGENT_STDIN_ANSWERS: '1' } : {}), ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolveRun({ code: code ?? 1, out }));
    child.stdin.end(options.answers ?? '');
  });
}

const installSh = (args: string[], options: { answers?: string } = {}) => run('bash', [join(REPO_DIR, 'install.sh'), ...args], options);
const command = (args: string[], options: { answers?: string } = {}) => run(join(home, 'bin', 'mission-agent'), args, options);
const base = ['--no-service', '--no-open', '--no-link', '--root'];

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

function setVersion(work: string, version: string): void {
  for (const file of ['package.json', 'package-lock.json']) {
    const p = join(work, file);
    const text = readFileSync(p, 'utf8');
    // The first two "version" fields of the lock file are those of the package itself.
    let n = 0;
    writeFileSync(p, text.replace(/"version": "[^"]+"/g, (m) => (n++ < (file === 'package.json' ? 1 : 2) ? `"version": "${version}"` : m)));
  }
}

function release(work: string, tag: string, notes: string): void {
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', notes);
  git(work, 'tag', '-a', tag, '-m', notes);
}

/** The version that the installed program reports, or undefined when it does not start. */
function versionOf(dir: string): string | undefined {
  const r = spawnSync(process.execPath, [join(dir, 'dist', 'cli.js'), '--version'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/** The program in app/ works: it reports its version, passes its self-test, and install.json and maintenance/ agree. */
function expectWorking(version?: string): void {
  const v = versionOf(join(home, 'app'));
  expect(v, 'app/dist/cli.js reports its version').toBeDefined();
  if (version !== undefined) expect(v).toBe(version);
  expect(spawnSync(process.execPath, [join(home, 'app', 'dist', 'cli.js'), 'self-test']).status).toBe(0);
  const m = spawnSync(process.execPath, [join(home, 'maintenance', 'dist', 'maintenance', 'main.js'), 'self-test'], { encoding: 'utf8' });
  expect(m.stdout.split('\n')[0]).toBe(SELF_TEST_LINE);
  expect(JSON.parse(readFileSync(join(home, 'maintenance', 'package.json'), 'utf8')).version).toBe(v);
  expect(JSON.parse(readFileSync(join(home, 'install.json'), 'utf8')).version).toBe(v);
  expect(existsSync(join(home, 'app.installing')), 'no app.installing is left').toBe(false);
  expect(existsSync(join(home, 'maintenance.json')), 'no journal is left').toBe(false);
  expect(existsSync(join(home, 'maintenance.lock')), 'no lock is left').toBe(false);
}

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mission-agent-install-')));
  home = join(tmp, 'home', '.mission-agent');
  root = join(tmp, 'agents', 'ada');
  bare = join(tmp, 'repo.git');
  mkdirSync(join(tmp, 'home'), { recursive: true });
  env = {
    PATH: process.env.PATH,
    HOME: join(tmp, 'home'),
    TMPDIR: tmpdir(),
    LANG: 'en_US.UTF-8',
    MISSION_AGENT_HOME: home,
    MISSION_AGENT_REPO: bare,
    MISSION_AGENT_LAUNCH_AGENTS: join(tmp, 'LaunchAgents'),
    MISSION_AGENT_KEYCHAIN_SERVICE: `mission-agent-install-test-${process.pid}`,
    // The packages come from the cache of this account when they are there.
    npm_config_cache: process.env.npm_config_cache ?? join(homedir(), '.npm'),
    npm_config_prefer_offline: 'true',
    npm_config_update_notifier: 'false',
    GIT_TERMINAL_PROMPT: '0',
  };

  // The repository: the code of this working tree, without what is built or installed.
  const work = join(tmp, 'work');
  cpSync(REPO_DIR, work, {
    recursive: true,
    filter: (src) => !/[/](node_modules|dist|\.git|\.DS_Store)$/.test(src),
  });
  git(work, 'init', '-q', '-b', 'main');
  setVersion(work, '0.2.0');
  release(work, 'v0.2.0', 'Release 0.2.0.');
  setVersion(work, '0.2.1');
  release(work, 'v0.2.1', 'Release 0.2.1.\nIt changes nothing.');
  setVersion(work, '0.2.2');
  writeFileSync(join(work, 'src', 'broken-on-purpose.ts'), "export const broken: number = 'not a number';\n");
  release(work, 'v0.2.2', 'Release 0.2.2, whose build fails.');
  rmSync(join(work, 'src', 'broken-on-purpose.ts'));
  setVersion(work, '0.2.9');
  release(work, 'v0.2.3', 'Release 0.2.3, which says it is 0.2.9.');
  setVersion(work, '0.2.4');
  const cli = join(work, 'src', 'cli', 'main.ts');
  const good = readFileSync(cli, 'utf8');
  writeFileSync(cli, good.replace('const problems: string[] = [];', "const problems: string[] = ['This release fails its self-test on purpose.'];"));
  release(work, 'v0.2.4', 'Release 0.2.4, whose self-test fails.');
  writeFileSync(cli, good);
  setVersion(work, '0.2.5');
  release(work, 'v0.2.5', 'Release 0.2.5.');
  git(tmp, 'clone', '-q', '--bare', work, bare);
}, STEP_MS);

afterAll(() => {
  // How long the whole test took, for the release rule.
  process.stdout.write(`The real install test took ${Math.round((Date.now() - started) / 1000)} s.\n`);
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
});

describe('the real install', () => {
  it('installs a release from scratch', async () => {
    const r = await installSh(['--version', 'v0.2.0', '--yes', ...base, root]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Getting release v0.2.0.');
    expect(r.out).toContain(`Installed release v0.2.0 in ${join(home, 'app')}.`);
    expectWorking('0.2.0');
    // The command sends the maintenance commands to the maintenance program, and the rest to the program.
    expect((await command(['--version'])).out.trim()).toBe('0.2.0');
    expect((await command(['repair', '--help'])).out).toContain('The commands of the maintenance program:');
    const init = await command(['init', '--name', 'Ada', '--root', root]);
    expect(init.code, init.out).toBe(0);
    expect(existsSync(join(root, 'agent.yaml'))).toBe(true);
  }, STEP_MS);

  it('continues a past install when asked, and leaves the program as it is', async () => {
    writeFileSync(join(home, 'app', 'marker'), 'kept\n');
    const r = await installSh([...base, root], { answers: '1\n' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('A past install was found');
    expect(r.out).toContain('It is left as it is.');
    expect(existsSync(join(home, 'app', 'marker'))).toBe(true);
    expectWorking('0.2.0');
  }, STEP_MS);

  it('installs the program again from scratch with answer 2, and with --reinstall', async () => {
    const r = await installSh(['--version', 'v0.2.0', ...base, root], { answers: '2\n' });
    expect(r.code, r.out).toBe(0);
    expect(existsSync(join(home, 'app', 'marker'))).toBe(false);
    expectWorking('0.2.0');

    writeFileSync(join(home, 'app', 'marker'), 'kept\n');
    const again = await installSh(['--version', 'v0.2.0', '--reinstall', '--yes', ...base, root]);
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain('is removed and installed again');
    expect(existsSync(join(home, 'app', 'marker'))).toBe(false);
    expect(readFileSync(join(root, 'agent.yaml'), 'utf8')).toContain('Ada');
    expectWorking('0.2.0');
  }, STEP_MS);

  it('updates to a newer release, keeps the old program and a copy of the root folder', async () => {
    const r = await command(['update', '--root', root, '--yes', '--version', 'v0.2.1']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Release 0.2.1.');
    expectWorking('0.2.1');
    expect(versionOf(join(home, 'app.previous'))).toBe('0.2.0');
    expect(existsSync(join(root, 'backups', 'update'))).toBe(true);
  }, STEP_MS);

  for (const [tag, what] of [
    ['v0.2.2', 'the build fails'],
    ['v0.2.3', 'the program reports another version'],
    ['v0.2.4', 'the self-test fails'],
  ] as const) {
    it(`keeps the installed program when ${what} (${tag})`, async () => {
      const r = await command(['update', '--root', root, '--yes', '--version', tag]);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('The agent was not stopped');
      expectWorking('0.2.1');
    }, STEP_MS);
  }

  it('recovers with repair after the update was killed', async () => {
    const child = spawn(process.execPath, [join(home, 'maintenance', 'dist', 'maintenance', 'main.js'), 'update', '--root', root, '--yes', '--version', 'v0.2.5'], {
      cwd: tmp,
      detached: true,
      env,
      stdio: 'ignore',
    });
    const gone = new Promise((r) => child.on('close', r));
    // Wait until it builds, then kill it and every process it started, as a power loss would.
    const deadline = Date.now() + 120_000;
    while (!existsSync(join(home, 'app.installing', 'package.json'))) {
      if (Date.now() > deadline) throw new Error('The update did not start to build.');
      await new Promise((r) => setTimeout(r, 50));
    }
    process.kill(-(child.pid as number), 'SIGKILL');
    await gone;
    expect(JSON.parse(readFileSync(join(home, 'maintenance.json'), 'utf8')).stage).toBe('building');

    const r = await command(['repair', '--yes']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Everything is in order.');
    expectWorking('0.2.1');
  }, STEP_MS);

  for (const [what, remove] of [
    ['dist/', () => rmSync(join(home, 'app', 'dist'), { recursive: true })],
    ['node_modules/', () => rmSync(join(home, 'app', 'node_modules'), { recursive: true })],
    ['the whole program folder', () => rmSync(join(home, 'app'), { recursive: true })],
  ] as const) {
    it(`gives a working program with repair after ${what} is deleted`, async () => {
      remove();
      const r = await command(['repair', '--yes']);
      expect(r.code, r.out).toBe(0);
      expectWorking();
    }, STEP_MS);
  }

  it('takes the fresh path when the installed maintenance program is broken', async () => {
    writeFileSync(join(home, 'maintenance', 'dist', 'maintenance', 'main.js'), 'process.exit(3);\n');
    const r = await installSh(['--version', 'v0.2.1', '--yes', ...base, root]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('does not run. A new release is built to replace it.');
    expectWorking();
  }, STEP_MS);

  it('refuses to delete the data when nobody can answer, and with --yes', async () => {
    const r = await installSh(['--uninstall', '--wipe-data']);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('needs a person to answer two questions, and nobody can be asked');
    const yes = await installSh(['--uninstall', '--wipe-data', '--yes'], { answers: 'y\ndelete\n' });
    expect(yes.code, yes.out).toBe(1);
    expect(yes.out).toContain("--yes does not cover the deletion of the agent's data");
    expectWorking();
    expect(existsSync(root)).toBe(true);
  }, STEP_MS);

  it('uninstalls with answer 3 and keeps the data', async () => {
    const r = await installSh([...base, root], { answers: '3\ny\n' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Removed the program.');
    expect(existsSync(home)).toBe(false);
    expect(readFileSync(join(root, 'agent.yaml'), 'utf8')).toContain('Ada');
  }, STEP_MS);

  it('uninstalls with answer 4 and deletes the data after two answers', async () => {
    const r = await installSh(['--version', 'v0.2.0', '--yes', ...base, root]);
    expect(r.code, r.out).toBe(0);
    mkdirSync(join(root, 'missions'), { recursive: true });
    mkdirSync(join(root, 'state'), { recursive: true });
    const wipe = await installSh([...base, root], { answers: '4\ny\ndelete\n' });
    expect(wipe.code, wipe.out).toBe(0);
    expect(existsSync(home)).toBe(false);
    expect(existsSync(root)).toBe(false);
  }, STEP_MS);
});
