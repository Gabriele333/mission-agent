import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

  it('setup and dashboard say they are not part of this version', async () => {
    for (const cmd of ['setup', 'dashboard']) {
      const r = await run([cmd, '--root', root]);
      expect(r.code).toBe(1);
      expect(r.out).toContain('not part of this version yet');
    }
  });

  it('chat says that the harness is not running', async () => {
    const r = await run(['chat', '--root', root]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('The harness is not running.');
  });
});
