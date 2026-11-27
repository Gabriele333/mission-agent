import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, type HarnessOptions } from '../harness/index.js';
import { scriptedQuery, simpleAnswers } from '../harness/test-helpers.js';
import { createMemorySecretStore, MODEL_API_KEY, TELEGRAM_BOT_TOKEN } from '../secrets/index.js';
import type { SecretStore } from '../types.js';
import { main, type CliIo } from './main.js';

let tmp: string;
let root: string;
let secrets: SecretStore;
let harnesses: Harness[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mission-agent-cli-'));
  root = join(tmp, 'root');
  secrets = createMemorySecretStore();
  harnesses = [];
});

afterEach(async () => {
  for (const h of harnesses) await h.stop();
  rmSync(tmp, { recursive: true, force: true });
});

interface Run {
  code: number;
  out: string;
  err: string;
}

function capture(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let text = '';
  stream.on('data', (d: Buffer) => (text += d.toString()));
  return { stream, text: () => text };
}

function makeHarness(options: HarnessOptions): Harness {
  const h = createHarness({ ...options, secretStore: secrets, queryFn: scriptedQuery(simpleAnswers()).queryFn, log: () => {} });
  harnesses.push(h);
  return h;
}

async function run(args: string[], extra: Partial<CliIo> & { input?: string } = {}): Promise<Run> {
  const out = capture();
  const err = capture();
  const stdin = new PassThrough();
  if (extra.input !== undefined) stdin.end(extra.input);
  const code = await main(args, {
    stdout: out.stream,
    stderr: err.stream,
    stdin,
    secretStore: () => secrets,
    createHarness: makeHarness,
    // A test never asks the real repository for its releases.
    releaseCheck: async () => ({ ok: true, current: '0.1.0', latest: '0.1.0', newer: false }),
    ...extra,
  });
  return { code, out: out.text(), err: err.text() };
}

/** Waits until the condition holds, for at most five seconds. */
async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('The condition did not hold within five seconds.');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('help and wrong input', () => {
  it('prints the help with exit code 0', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: mission-agent <command>');
    expect(r.out).toContain('secret set <id>');
  });

  it('fails with a plain message and no stack trace for an unknown command or option', async () => {
    const a = await run(['fly']);
    expect(a.code).toBe(2);
    expect(a.err).toBe('Unknown command "fly". Run "mission-agent --help" to see the commands.\n');
    const b = await run(['status', '--color']);
    expect(b.code).toBe(2);
    expect(b.err).toContain("Unknown option '--color'");
    expect(b.err).not.toContain('    at ');
    const c = await run(['status', '--name', 'x', '--root', root]);
    expect(c.code).toBe(2);
    expect(c.err).toContain('The option --name is not used by the status command.');
  });
});

describe('init', () => {
  it('creates agent.yaml and the folders, and refuses to overwrite it', async () => {
    const r = await run(['init', '--name', 'Ada', '--root', root]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Created ${join(root, 'agent.yaml')} for the agent "Ada".`);
    // The default model login is the user's own Claude plan.
    expect(r.out).toContain(`CLAUDE_CONFIG_DIR="${join(root, 'state', 'claude')}"`);
    expect(r.out).not.toContain(`secret set ${MODEL_API_KEY}`);
    expect(readFileSync(join(root, 'agent.yaml'), 'utf8')).toContain('agent_name: Ada');
    expect(readFileSync(join(root, 'agent.yaml'), 'utf8')).toContain('model_login: subscription');
    expect(existsSync(join(root, 'missions', 'sys-general', 'manifest.yaml'))).toBe(true);

    const again = await run(['init', '--name', 'Bob', '--root', root]);
    expect(again.code).toBe(1);
    expect(again.err).toContain('already exists. Nothing was changed.');
    expect(readFileSync(join(root, 'agent.yaml'), 'utf8')).toContain('agent_name: Ada');
  });

  it('needs the Telegram user id for the Telegram surface', async () => {
    const r = await run(['init', '--name', 'Ada', '--surface', 'telegram', '--root', root]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--telegram-user-id');
    expect(existsSync(join(root, 'agent.yaml'))).toBe(false);
    const ok = await run(['init', '--name', 'Ada', '--surface', 'telegram', '--telegram-user-id', '4242', '--login', 'subscription', '--root', root]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain(`mission-agent secret set ${TELEGRAM_BOT_TOKEN}`);
    expect(ok.out).toContain('CLAUDE_CONFIG_DIR');
  });

  it('writes the api_key login when asked, and says how to store the key', async () => {
    const r = await run(['init', '--name', 'Ada', '--login', 'api_key', '--root', root]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`mission-agent secret set ${MODEL_API_KEY} --root "${root}"`);
    expect(readFileSync(join(root, 'agent.yaml'), 'utf8')).toContain('model_login: api_key');
    const wrong = await run(['init', '--name', 'Ada', '--login', 'plan', '--root', join(root, 'other')]);
    expect(wrong.code).toBe(2);
    expect(wrong.err).toContain('--login must be subscription or api_key');
  });

  it('needs a name', async () => {
    const r = await run(['init', '--root', root]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('init needs the agent name');
  });
});

describe('status', () => {
  it('works when the harness is stopped', async () => {
    await run(['init', '--name', 'Ada', '--root', root]);
    const r = await run(['status', '--root', root]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('The harness is not running');
    expect(r.out).toMatch(/sys-general\s+active\s+version 1/);
  });

  it('asks the running harness', async () => {
    await run(['init', '--name', 'Ada', '--login', 'subscription', '--root', root]);
    const h = makeHarness({ root });
    await h.start();
    const r = await run(['status', '--root', root]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`The harness is running for ${root} (process ${process.pid}`);
    expect(r.out).toContain('It is not paused.');
    expect(r.out).toContain('sys-mission-admin');
  });
});

describe('secret', () => {
  it('sets, lists and deletes a value without printing it, with the harness stopped', async () => {
    await run(['init', '--name', 'Ada', '--login', 'api_key', '--root', root]);
    const set = await run(['secret', 'set', MODEL_API_KEY, '--root', root], { input: 'sk-test-value\n' });
    expect(set.code).toBe(0);
    expect(set.out).toBe(`Stored a value for ${MODEL_API_KEY}.\n`);
    expect(await secrets.get(MODEL_API_KEY)).toBe('sk-test-value');

    const list = await run(['secret', 'list', '--root', root]);
    expect(list.code).toBe(0);
    expect(list.out).toContain(MODEL_API_KEY);
    expect(list.out).not.toContain('sk-test-value');

    const del = await run(['secret', 'delete', MODEL_API_KEY, '--root', root]);
    expect(del.code).toBe(0);
    expect(await secrets.has(MODEL_API_KEY)).toBe(false);
  });

  it('tells a running harness to read the value again, and lists what it requires', async () => {
    await run(['init', '--name', 'Ada', '--login', 'api_key', '--root', root]);
    const h = makeHarness({ root });
    await h.start();
    // The api_key login has no key yet, so the harness is paused.
    expect(h.status().paused).toBe(true);
    const set = await run(['secret', 'set', MODEL_API_KEY, '--root', root], { input: 'sk-test-value\n' });
    expect(set.code).toBe(0);
    expect(set.out).toContain('The running harness has read the credential again.');
    expect(set.out).not.toContain('sk-test-value');
    const list = await run(['secret', 'list', '--root', root]);
    expect(list.out).toContain(MODEL_API_KEY);
  });

  it('refuses a wrong id with a plain message', async () => {
    const r = await run(['secret', 'set', 'nope', '--root', root], { input: 'x\n' });
    expect(r.code).toBe(1);
    expect(r.err).not.toContain('    at ');
    expect(r.err.length).toBeGreaterThan(0);
  });
});

describe('start', () => {
  it('starts, says how to chat, and stops on the signal', async () => {
    await run(['init', '--name', 'Ada', '--login', 'subscription', '--root', root]);
    let release: (s: string) => void = () => {};
    const signal = new Promise<string>((r) => (release = r));
    const pending = run(['start', '--root', root], { waitForSignal: () => signal });
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(join(root, 'state', 'server'))).toBe(true);
    // The harness that start runs serves the two pages.
    const info = JSON.parse(readFileSync(join(root, 'state', 'server'), 'utf8')) as { port: number; token: string };
    for (const path of ['/setup', '/dashboard']) {
      const page = await fetch(`http://127.0.0.1:${info.port}${path}`, { headers: { authorization: `Bearer ${info.token}` } });
      expect(page.status).toBe(200);
      expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    }
    release('SIGINT');
    const r = await pending;
    expect(r.code).toBe(0);
    expect(r.out).toContain('It is not paused.');
    expect(r.out).toContain(`mission-agent chat --root "${root}"`);
    expect(r.out).toContain('The harness has stopped.');
    expect(existsSync(join(root, 'state', 'server'))).toBe(false);
  });

  it('refuses when another harness runs for the root', async () => {
    await run(['init', '--name', 'Ada', '--login', 'subscription', '--root', root]);
    const h = makeHarness({ root });
    await h.start();
    const r = await run(['start', '--root', root], { waitForSignal: () => Promise.resolve('SIGINT') });
    expect(r.code).toBe(1);
    expect(r.err).toContain('Another harness is already running');
  });
});

describe('other commands', () => {
  it('login-help shows the sign-in command with the real folder and the API key way', async () => {
    const r = await run(['login-help', '--root', root]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`CLAUDE_CONFIG_DIR="${join(root, 'state', 'claude')}"`);
    expect(r.out).toContain(`mission-agent secret set ${MODEL_API_KEY}`);
  });

  it('chat says that the harness is not running', async () => {
    const r = await run(['chat', '--root', root]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('The harness is not running.');
  });
});

describe('setup and dashboard', () => {
  it('say that the harness is not running, and tell the user to start it', async () => {
    for (const cmd of ['setup', 'dashboard']) {
      const opened: string[] = [];
      const r = await run([cmd, '--root', root], { openUrl: async (u) => void opened.push(u) });
      expect(r.code).toBe(1);
      expect(r.out).toContain(`The harness is not running for ${root}`);
      expect(r.out).toContain(`mission-agent start --root "${root}"`);
      expect(opened).toEqual([]);
    }
  });

  it('open the page of the running harness with the token, or print the address with --no-open', async () => {
    const h = makeHarness({ root });
    await h.start();
    const info = JSON.parse(readFileSync(join(root, 'state', 'server'), 'utf8')) as { port: number; token: string };
    for (const [cmd, path] of [
      ['setup', '/setup'],
      ['dashboard', '/dashboard'],
    ] as const) {
      const opened: string[] = [];
      const r = await run([cmd, '--root', root], { openUrl: async (u) => void opened.push(u) });
      expect(r.code).toBe(0);
      expect(opened).toEqual([`http://127.0.0.1:${info.port}${path}?token=${info.token}`]);
      expect(r.out).not.toContain(info.token);
      const printed = await run([cmd, '--no-open', '--root', root], {
        openUrl: async () => {
          throw new Error('must not open');
        },
      });
      expect(printed.code).toBe(0);
      expect(printed.out).toContain(`http://127.0.0.1:${info.port}${path}?token=${info.token}`);
    }
    const wrong = await run(['status', '--no-open', '--root', root]);
    expect(wrong.code).toBe(2);
  });
});

describe('service', () => {
  function fakeService(calls: string[][], extra: Partial<NonNullable<CliIo['serviceOptions']>> = {}): NonNullable<CliIo['serviceOptions']> {
    const cli = join(tmp, 'dist', 'cli.js');
    mkdirSync(join(tmp, 'dist'), { recursive: true });
    writeFileSync(cli, '// built\n');
    return {
      cliPath: cli,
      uid: 501,
      envPath: '/usr/bin:/bin',
      launchAgentsDir: join(tmp, 'LaunchAgents'),
      launchctl: async (args) => {
        calls.push(args);
        return args[0] === 'print' ? { code: 113, stdout: '', stderr: 'Could not find service' } : { code: 0, stdout: '', stderr: '' };
      },
      ...extra,
    };
  }

  it('needs --root, because the root folder is never assumed', async () => {
    for (const sub of ['install', 'uninstall', 'status']) {
      const calls: string[][] = [];
      const r = await run(['service', sub], { serviceOptions: fakeService(calls) });
      expect(r.code).toBe(2);
      expect(r.err).toContain(`service ${sub} needs the agent's root folder`);
      expect(calls).toEqual([]);
    }
  });

  it('install prints what it writes before it writes it, then loads it', async () => {
    const calls: string[][] = [];
    const options = fakeService(calls);
    const r = await run(['service', 'install', '--root', root], { serviceOptions: options });
    expect(r.code).toBe(0);
    const plist = readdirSync(join(tmp, 'LaunchAgents'))[0] ?? '';
    const plistPath = join(tmp, 'LaunchAgents', plist);
    expect(r.out).toContain(`The service for the root folder ${root}:`);
    expect(r.out).toContain(`File:     ${plistPath}`);
    expect(r.out.indexOf('File:')).toBeLessThan(r.out.indexOf('The service is installed and loaded.'));
    expect(calls).toEqual([
      ['print', `gui/501/${plist.replace(/\.plist$/, '')}`],
      ['bootstrap', 'gui/501', plistPath],
      ['print', `gui/501/${plist.replace(/\.plist$/, '')}`],
      ['kickstart', `gui/501/${plist.replace(/\.plist$/, '')}`],
    ]);
    expect(readFileSync(plistPath, 'utf8')).toContain(`<string>${root}</string>`);

    const status = await run(['service', 'status', '--root', root], { serviceOptions: options });
    expect(status.out).toContain('(present)');
    expect(status.out).toContain('launchd:  not loaded');

    const removed = await run(['service', 'uninstall', '--root', root], { serviceOptions: options });
    expect(removed.code).toBe(0);
    expect(removed.out).toContain('The service is removed.');
    expect(existsSync(plistPath)).toBe(false);
  });

  it('install refuses while a harness for the root runs in the foreground, and when cli.js is missing', async () => {
    const h = makeHarness({ root });
    await h.start();
    const calls: string[][] = [];
    const r = await run(['service', 'install', '--root', root], { serviceOptions: fakeService(calls) });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`A harness for ${root} runs in the foreground (process ${process.pid}). Stop it first`);
    expect(calls.some((c) => c[0] === 'bootstrap')).toBe(false);
    await h.stop();

    const missing = await run(['service', 'install', '--root', root], { serviceOptions: fakeService([], { cliPath: join(tmp, 'nope', 'cli.js') }) });
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('cannot be found. Build it first with: npm run build');
  });
});

describe('--version', () => {
  it('prints the version of the program folder', async () => {
    const dir = join(tmp, 'app');
    mkdirSync(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '3.4.5' }));
    expect(await run(['--version'], { programDir: dir })).toEqual({ code: 0, out: '3.4.5\n', err: '' });
    const real = await run(['--version']);
    expect(real.out).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
});

describe('library', () => {
  const ID = 'm_4t8kx2n7w9qd';
  let library: string;

  beforeEach(() => {
    library = join(tmp, 'library');
    mkdirSync(join(library, 'morning-news'), { recursive: true });
    writeFileSync(
      join(library, 'morning-news', 'manifest.yaml'),
      [
        `id: ${ID}`,
        'name: morning-news',
        'description: Sends a short summary of the news every morning',
        'version: 1',
        'status: active',
        'triggers:',
        '  - use: trigger:cron',
        '    at: "0 7 * * *"',
        'tools:',
        '  - tool:web_search',
        'context:',
        '  instructions: |',
        '    You are my news editor.',
        '    Done well means: five links.',
        'signals: []',
        'gates: []',
        '',
      ].join('\n'),
    );
    writeFileSync(join(library, 'morning-news', 'README.md'), '# Morning news\n');
  });

  const lib = () => ({ libraryDir: library });

  it('lists the published missions and says which ones the agent has', async () => {
    await run(['init', '--name', 'Ada', '--root', root]);
    const before = await run(['library', 'list', '--root', root], lib());
    expect(before.code).toBe(0);
    expect(before.out).toContain('morning-news  no    Sends a short summary of the news every morning');
    expect(before.out).toContain(`Add one with: mission-agent library add <name> --root "${root}"`);
    await run(['library', 'add', 'morning-news', '--yes', '--root', root], lib());
    expect((await run(['library', 'list', '--root', root], lib())).out).toContain('morning-news  yes   Sends');
  });

  it('shows the mission, asks, and copies it only after a yes', async () => {
    await run(['init', '--name', 'Ada', '--root', root]);
    const no = await run(['library', 'add', 'morning-news', '--root', root], { ...lib(), input: 'n\n' });
    expect(no.code).toBe(0);
    expect(no.out).toContain(`Mission morning-news (${ID}): Sends a short summary of the news every morning`);
    expect(no.out).toContain('    You are my news editor.');
    expect(no.out).toContain('    Done well means: five links.');
    expect(no.out).toContain('tool:web_search');
    expect(no.err).toBe('Add this mission? [y/N] ');
    expect(no.out).toContain('Nothing was changed.');
    expect(existsSync(join(root, 'missions', ID))).toBe(false);

    // Input that ends without an answer is a no.
    const silent = await run(['library', 'add', 'morning-news', '--root', root], { ...lib(), input: '' });
    expect(silent.out).toContain('Nothing was changed.');

    const yes = await run(['library', 'add', 'morning-news', '--root', root], { ...lib(), input: 'y\n' });
    expect(yes.code).toBe(0);
    expect(yes.out).toContain('Added the mission morning-news.');
    expect(yes.out).toContain('The harness loads it at its next start.');
    expect(readFileSync(join(root, 'missions', ID, 'manifest.yaml'), 'utf8')).toContain('name: morning-news');
    expect(existsSync(join(root, 'missions', ID, 'memory', 'MEMORY.md'))).toBe(true);
    expect(existsSync(join(root, 'missions', ID, 'README.md'))).toBe(true);
    const status = await run(['status', '--root', root]);
    expect(status.out).toContain('morning-news');
    expect(status.out).not.toContain('Manifests that are not loaded');
  });

  it('refuses a second copy, an unknown name, a root folder that is no agent, and a missing library', async () => {
    const noAgent = await run(['library', 'add', 'morning-news', '--yes', '--root', root], lib());
    expect(noAgent.code).toBe(1);
    expect(noAgent.err).toContain('is not the root folder of an agent yet');

    await run(['init', '--name', 'Ada', '--root', root]);
    expect((await run(['library', 'add', 'morning-news', '--yes', '--root', root], lib())).code).toBe(0);
    const twice = await run(['library', 'add', 'morning-news', '--yes', '--root', root], lib());
    expect(twice.code).toBe(1);
    expect(twice.err).toContain(`This agent already has a mission with the id ${ID}`);
    expect(twice.err).not.toContain('    at ');

    const unknown = await run(['library', 'add', 'nope', '--root', root], lib());
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('The mission library has no mission "nope".');
    expect((await run(['library', 'add', '--root', root], lib())).code).toBe(2);
    expect((await run(['library', 'remove', 'x', '--root', root], lib())).code).toBe(2);

    const missing = await run(['library', 'list', '--root', root], { libraryDir: join(tmp, 'none') });
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('does not exist');
  });

  it('is loaded by a running harness without a restart', async () => {
    await run(['init', '--name', 'Ada', '--login', 'subscription', '--root', root]);
    let stop: (signal: string) => void = () => {};
    const started = run(['start', '--root', root], { waitForSignal: () => new Promise((r) => (stop = r)) });
    try {
      await waitUntil(() => harnesses.length === 1 && harnesses[0]?.status().running === true);
      const added = await run(['library', 'add', 'morning-news', '--yes', '--root', root], lib());
      expect(added.out).toContain('The running harness loads it within a few seconds.');
      await waitUntil(() => harnesses[0]?.registry.get(ID) !== undefined);
    } finally {
      stop('SIGINT');
      await started;
    }
  });
});

describe('update', () => {
  it('needs the root folder, and takes no argument', async () => {
    const noRoot = await run(['update']);
    expect(noRoot.code).toBe(2);
    expect(noRoot.err).toBe("update needs the agent's root folder: mission-agent update --root <path>\n");
    expect((await run(['update', 'now', '--root', root])).code).toBe(2);
    expect((await run(['status', '--yes', '--root', root])).err).toContain('The option --yes is not used by the status command.');
  });

  it('refuses a program folder that was not installed with git, with a plain message', async () => {
    const dir = join(tmp, 'app');
    mkdirSync(dir);
    const r = await run(['update', '--yes', '--root', root], { programDir: dir });
    expect(r.code).toBe(1);
    expect(r.err).toContain('was not installed with git');
    expect(r.err).not.toContain('    at ');
  });

  it('runs the steps with the service of the root folder, and reports the new version', async () => {
    const dir = join(tmp, 'app');
    mkdirSync(join(dir, '.git'), { recursive: true });
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'cli.js'), '');
    await run(['init', '--name', 'Ada', '--root', root]);
    let head = 'v0.1.0';
    const ran: string[] = [];
    const r = await run(['update', '--root', root], {
      programDir: dir,
      input: 'yes\n',
      serviceOptions: {
        cliPath: join(dir, 'dist', 'cli.js'),
        nodePath: process.execPath,
        uid: 501,
        launchAgentsDir: join(tmp, 'LaunchAgents'),
        findHarness: async () => undefined,
        launchctl: async (args) => (args[0] === 'print' ? { code: 113, stdout: '', stderr: 'not found' } : { code: 0, stdout: '', stderr: '' }),
      },
      runCommand: async (program, args) => {
        ran.push(`${program === process.execPath ? 'node' : program} ${args.join(' ')}`);
        const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
        if (args[0] === 'describe') return ok(`${head}\n`);
        if (args[0] === 'rev-parse') return ok('abc\n');
        if (args[0] === 'tag' && args[2] === 'v*') return ok('v0.1.0\nv0.2.0\n');
        if (args[0] === 'tag') return ok('The first update.\n');
        if (args.includes('checkout')) head = args[args.length - 1] as string;
        if (args[1] === 'build') {
          mkdirSync(join(dir, 'dist'), { recursive: true });
          writeFileSync(join(dir, 'dist', 'cli.js'), '');
        }
        if (args[1] === '--version') return ok('0.2.0\n');
        return ok();
      },
    });
    expect(r.err).toBe('Install version 0.2.0? [y/N] ');
    expect(r.code).toBe(0);
    expect(r.out).toContain('  The first update.');
    expect(r.out).toContain('Version 0.2.0 is installed.');
    expect(ran).toContain('git -c advice.detachedHead=false checkout --detach v0.2.0');
    expect(ran).toContain(`node ${join(dir, 'dist', 'cli.js')} --version`);
    const copies = readdirSync(join(root, 'backups', 'update'));
    expect(copies).toHaveLength(1);
    expect(existsSync(join(root, 'backups', 'update', copies[0] as string, 'agent.yaml'))).toBe(true);
  });
});

describe('check', () => {
  /** A fake computer: the service runs, and the system commands answer from `answers`. */
  let answers: Record<string, { code: number; stdout: string; stderr: string }>;
  let session: string;
  let opened: string[];

  beforeEach(() => {
    answers = {
      git: { code: 0, stdout: 'git version 2.50.0\n', stderr: '' },
      defaults: { code: 0, stdout: `${userInfo().username}\n`, stderr: '' },
      pmset: { code: 0, stdout: 'AC Power:\n sleep                0\n autorestart          1\n', stderr: '' },
      sysadminctl: { code: 0, stdout: '', stderr: 'screenLock delay is immediate\n' },
      fdesetup: { code: 0, stdout: 'FileVault is Off.\n', stderr: '' },
    };
    session = '\ton-demand count = 0\n';
    opened = [];
  });

  function computer(): Partial<CliIo> {
    mkdirSync(join(tmp, 'dist'), { recursive: true });
    writeFileSync(join(tmp, 'dist', 'cli.js'), '');
    mkdirSync(join(tmp, 'LaunchAgents'), { recursive: true });
    return {
      openUrl: async (url) => void opened.push(url),
      runCommand: async (program) => answers[program.split('/').pop() as string] ?? { code: 127, stdout: '', stderr: 'not found' },
      serviceOptions: {
        cliPath: join(tmp, 'dist', 'cli.js'),
        nodePath: process.execPath,
        uid: 501,
        envPath: '/usr/bin:/bin',
        launchAgentsDir: join(tmp, 'LaunchAgents'),
        findHarness: async () => undefined,
        launchctl: async (args) => {
          if (args[0] === 'print' && args[1] === 'gui/501') return { code: 0, stdout: session, stderr: '' };
          if (args[0] === 'print-disabled') return { code: 0, stdout: '', stderr: '' };
          // Once the service file exists, launchd knows the service and it runs.
          if (args[0] === 'print') {
            return readdirSync(join(tmp, 'LaunchAgents')).length > 0
              ? { code: 0, stdout: '\tstate = running\n\tpid = 4242\n', stderr: '' }
              : { code: 113, stdout: '', stderr: 'Could not find service' };
          }
          return { code: 0, stdout: '', stderr: '' };
        },
      },
    };
  }

  /** Writes the service file, as `service install` does. */
  async function installTheService(io: Partial<CliIo>): Promise<void> {
    const { servicePlan } = await import('../service/index.js');
    const plan = servicePlan({ ...io.serviceOptions, root });
    writeFileSync(plan.plistPath, plan.plistText);
  }

  it('prints every check and ends with exit code 0 when all that every agent needs is in order', async () => {
    const io = computer();
    await installTheService(io);
    answers.pmset = { code: 0, stdout: 'Battery Power:\n sleep 1\nAC Power:\n sleep                10\n', stderr: '' };
    const r = await run(['check', '--root', root], io);
    expect(r.code).toBe(0);
    expect(r.out).toContain('What every agent needs:');
    expect(r.out).toContain('  ok       Service: The service is loaded, and the agent runs as process 4242.');
    expect(r.out).toContain('  ok       Keychain: The login Keychain answers');
    expect(r.out).toContain('What a computer needs to run the agent with nobody at it:');
    // On a computer that its user sits at, sleep is a choice.
    expect(r.out).toContain('  not set  Sleep: On mains power the computer goes to sleep by itself');
    expect(r.out).toContain('           Command: sudo pmset -c sleep 0');
    expect(r.out).toContain('Everything that every agent needs is in order.');

    const strict = await run(['check', '--unattended', '--root', root], io);
    expect(strict.code).toBe(1);
    expect(strict.out).toContain('  PROBLEM  Sleep:');
    expect(strict.out).toContain('One setting is not in order: Sleep.');
  });

  it('ends with exit code 1 and says what to do when the service is missing or launchd holds back starts', async () => {
    session = '\ton-demand count = 1\n';
    const r = await run(['check', '--root', root], computer());
    expect(r.code).toBe(1);
    expect(r.out).toContain('  PROBLEM  Service: The service is not installed.');
    expect(r.out).toContain(`           Command: mission-agent service install --root ${root}`);
    expect(r.out).toContain('  PROBLEM  Restart after a crash: launchd reports "on-demand count = 1"');
    expect(r.out).toContain('2 settings are not in order: Service, Restart after a crash.');
    expect((await run(['check', 'now', '--root', root], computer())).code).toBe(2);
    expect((await run(['status', '--guide', '--root', root])).err).toContain('The option --guide is not used by the status command.');
  });

  it('with --guide, asks about each open setting, opens System Settings and checks again until it is in order', async () => {
    const io = computer();
    await installTheService(io);
    answers.pmset = { code: 0, stdout: 'AC Power:\n sleep                10\n autorestart          0\n', stderr: '' };
    // The user fixes sleep after opening System Settings, and skips the start after a power cut.
    const original = io.openUrl as (url: string) => Promise<void>;
    io.openUrl = async (url) => {
      await original(url);
      answers.pmset = { code: 0, stdout: 'AC Power:\n sleep                0\n autorestart          0\n', stderr: '' };
    };
    // Answers: yes to "nobody at it", o to open, Enter to check again, s to skip.
    const r = await run(['check', '--guide', '--root', root], { ...io, input: 'y\no\n\ns\n' });
    expect(r.err).toContain('Will this computer run the agent with nobody at it, such as a computer with no screen? [y/N] ');
    expect(opened).toEqual(['x-apple.systempreferences:com.apple.Energy-Settings.extension']);
    expect(r.out).toContain('Sleep: in order now.');
    expect(r.out).toContain('Start after a power cut: After a power cut the computer stays off');
    expect(r.out).toContain('One setting is not in order: Start after a power cut.');
    expect(r.code).toBe(1);
  });

  it('with --guide, treats the unattended settings as a choice after a no, and stops asking when the input ends', async () => {
    const io = computer();
    await installTheService(io);
    answers.pmset = { code: 0, stdout: 'AC Power:\n sleep                10\n autorestart          1\n', stderr: '' };
    const no = await run(['check', '--guide', '--root', root], { ...io, input: 'n\n' });
    expect(no.code).toBe(0);
    expect(no.out).toContain('  not set  Sleep:');
    expect(no.out).toContain('Everything that every agent needs is in order.');

    // A setting that stays as it is: the question comes again, and the end of the input ends the guide.
    const ended = await run(['check', '--guide', '--unattended', '--root', root], { ...io, input: '\n' });
    expect(ended.err).not.toContain('Will this computer');
    expect(ended.err.split('Press Enter after the change')).toHaveLength(3);
    expect(ended.code).toBe(1);
  });
});
