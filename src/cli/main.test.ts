import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
    ...extra,
  });
  return { code, out: out.text(), err: err.text() };
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
    expect(r.out).toContain(`mission-agent secret set ${MODEL_API_KEY} --root "${root}"`);
    expect(readFileSync(join(root, 'agent.yaml'), 'utf8')).toContain('agent_name: Ada');
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
    await run(['init', '--name', 'Ada', '--root', root]);
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
    await run(['init', '--name', 'Ada', '--root', root]);
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
