import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LoginCheck } from './login.js';
import {
  claudeOnPath,
  createSignIn,
  shippedClaudeBinary,
  SIGN_IN_ARGS,
  signInEnv,
  terminalClaudeCommand,
  type SignInDeps,
} from './sign-in.js';
import { fakeSignInSpawn } from './test-helpers.js';

let tmp: string[] = [];
afterEach(() => {
  for (const t of tmp) rmSync(t, { recursive: true, force: true });
  tmp = [];
});

function folder(): string {
  const t = mkdtempSync(join(tmpdir(), 'mission-agent-sign-in-'));
  tmp.push(t);
  return t;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

const HOST = { PATH: '/opt/homebrew/bin:/bin', HOME: '/Users/ada', USER: 'ada' };

function setup(over: Partial<SignInDeps> & { check?: LoginCheck } = {}) {
  const fake = fakeSignInSpawn();
  const configDir = join(folder(), 'state', 'claude');
  const checks: number[] = [];
  const logs: string[] = [];
  const signIn = createSignIn({
    configDir: () => configDir,
    checkLogin: async () => {
      checks.push(1);
      return over.check ?? { ok: true };
    },
    hostEnv: () => HOST,
    spawn: fake.spawn,
    program: () => '/sdk/claude',
    log: (t) => logs.push(t),
    ...over,
  });
  return { signIn, fake, configDir, checks, logs };
}

describe('the sign-in with a Claude plan (§A.5)', () => {
  it('starts the program once, with an argument array, no shell, no open stream and the environment of a run', () => {
    const { signIn, fake, configDir } = setup();
    expect(signIn.state()).toEqual({ state: 'idle' });
    const s = signIn.start();
    expect(s.state).toBe('waiting');
    expect(fake.children).toHaveLength(1);
    const child = fake.children[0]!;
    expect(child.command).toBe('/sdk/claude');
    expect(child.args).toEqual(['auth', 'login', '--claudeai']);
    expect(child.args).toEqual(SIGN_IN_ARGS);
    expect(child.options).toEqual({
      env: { PATH: '/opt/homebrew/bin:/bin:/usr/bin', HOME: '/Users/ada', USER: 'ada', CLAUDE_CONFIG_DIR: configDir },
      stdio: ['ignore', 'ignore', 'ignore'],
      shell: false,
    });
    expect(existsSync(configDir)).toBe(true);
  });

  it('starts no second program while one waits', () => {
    const { signIn, fake } = setup();
    const first = signIn.start();
    expect(signIn.start()).toBe(first);
    expect(fake.children).toHaveLength(1);
  });

  it('checks the login when the program ends well, and is done', async () => {
    const { signIn, fake, checks } = setup();
    signIn.start();
    fake.children[0]!.exit(0);
    await settle();
    expect(checks).toHaveLength(1);
    expect(signIn.state().state).toBe('done');
    // A new sign-in can start after it.
    signIn.start();
    expect(fake.children).toHaveLength(2);
  });

  it('fails when the program ends well but the login check does not pass', async () => {
    const { signIn, fake } = setup({ check: { ok: false, reason: 'Not logged in: no plan.' } });
    signIn.start();
    fake.children[0]!.exit(0);
    await settle();
    const s = signIn.state();
    expect(s).toMatchObject({ state: 'failed' });
    expect(s.state === 'failed' ? s.reason : '').toContain('Not logged in: no plan.');
  });

  it('fails, and checks nothing, when the program ends with an error', async () => {
    const { signIn, fake, checks } = setup();
    signIn.start();
    fake.children[0]!.exit(1);
    await settle();
    expect(checks).toHaveLength(0);
    expect(signIn.state()).toMatchObject({ state: 'failed', reason: expect.stringContaining('exit code 1') });
  });

  it('fails when the program cannot start', async () => {
    const { signIn, fake } = setup();
    signIn.start();
    fake.children[0]!.fail(new Error('spawn /sdk/claude ENOENT'));
    await settle();
    expect(signIn.state()).toMatchObject({ state: 'failed', reason: expect.stringContaining('could not start') });
  });

  it('fails with a clear text when no program is found, and starts nothing', () => {
    const { signIn, fake } = setup({ program: () => undefined });
    expect(signIn.available()).toBe(false);
    expect(signIn.start()).toMatchObject({ state: 'failed', reason: expect.stringContaining('Sign in from a terminal instead') });
    expect(fake.children).toHaveLength(0);
  });

  it('stops the program when cancelled, and checks nothing', async () => {
    const { signIn, fake, checks } = setup();
    signIn.start();
    signIn.cancel();
    expect(fake.children[0]!.signals).toEqual(['SIGTERM']);
    await settle();
    expect(signIn.state()).toEqual({ state: 'cancelled', reason: 'The sign-in was stopped.' });
    expect(checks).toHaveLength(0);
  });

  it('stops the program after the time limit', async () => {
    const { signIn, fake } = setup({ timeoutMs: 30 });
    signIn.start();
    await new Promise((r) => setTimeout(r, 80));
    expect(fake.children[0]!.signals).toEqual(['SIGTERM']);
    expect(signIn.state()).toMatchObject({ state: 'failed', reason: expect.stringContaining('No sign-in was finished') });
  });

  it('stops the program when the harness stops, and starts none after it', async () => {
    const { signIn, fake } = setup();
    signIn.start();
    signIn.stop();
    expect(fake.children[0]!.signals).toEqual(['SIGTERM']);
    expect(signIn.start().state).toBe('failed');
    expect(fake.children).toHaveLength(1);
  });

  it('keeps nothing of what the program prints', async () => {
    const { signIn, fake, logs } = setup();
    signIn.start();
    const child = fake.children[0]!;
    expect(child.outputListeners()).toBe(0);
    // The fake prints a value of a sign-in when it ends. Nothing of it reaches the state or the log.
    child.exit(0);
    await settle();
    expect(JSON.stringify(signIn.state())).not.toContain('secret-oauth-value');
    expect(logs.join('\n')).not.toContain('secret-oauth-value');
  });

  it('refuses a harness with no folder of its own for Claude Code', () => {
    const { signIn, fake } = setup({ configDir: () => null });
    expect(signIn.start().state).toBe('failed');
    expect(fake.children).toHaveLength(0);
  });
});

describe('the program and its environment', () => {
  it('adds /usr/bin to the PATH only when it is missing, and passes nothing else', () => {
    expect(signInEnv({ PATH: '/bin:/usr/bin', HOME: '/h', USER: 'u' }, '/c')).toEqual({ PATH: '/bin:/usr/bin', HOME: '/h', USER: 'u', CLAUDE_CONFIG_DIR: '/c' });
    expect(signInEnv({}, '/c')).toEqual({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/c' });
  });

  it('finds the program that the SDK ships for this processor', () => {
    const binary = shippedClaudeBinary();
    expect(binary).toContain(`claude-agent-sdk-${process.platform}-${process.arch}`);
    expect(binary?.endsWith('/claude')).toBe(true);
  });

  it('finds claude on the PATH, and names the shipped program in the terminal command when there is none', () => {
    const dir = folder();
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\n');
    chmodSync(join(bin, 'claude'), 0o755);
    expect(claudeOnPath(`/nowhere:${bin}`)).toBe(join(bin, 'claude'));
    expect(terminalClaudeCommand(bin)).toBe('claude');
    expect(claudeOnPath('/nowhere')).toBeUndefined();
    expect(terminalClaudeCommand('/nowhere')).toBe(shippedClaudeBinary());
  });
});
