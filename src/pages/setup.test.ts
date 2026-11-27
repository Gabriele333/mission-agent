import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { terminalClaudeCommand } from '../run/index.js';
import { MODEL_API_KEY, TELEGRAM_BOT_TOKEN } from '../secrets/index.js';
import { textUpdate, USER } from '../surfaces/telegram/test-helpers.js';
import { SYS_GENERAL, SYS_MISSION_ADMIN } from '../types.js';
import { pagesRig, until, type PagesRig, type RigOptions } from './test-helpers.js';

const API_KEY = 'sk-ant-api03-test-value-0123456789';
const BOT_TOKEN = '123456789:fake-bot-token-for-tests-only-000000';

let rigs: PagesRig[] = [];
afterEach(async () => {
  for (const r of rigs) await r.stop();
  rigs = [];
});

async function rig(options: RigOptions = {}): Promise<PagesRig> {
  const r = await pagesRig(options);
  rigs.push(r);
  return r;
}

type State = {
  agentName: string | null;
  harness: { paused: boolean; blockerKind: string | null; usesLastValidValues: boolean; pauseReason: string };
  config: {
    exists: boolean;
    values: Record<string, unknown>;
    defaults: Record<string, unknown>;
    error?: string;
    fieldErrors: Record<string, string[]>;
    generalErrors: string[];
  };
  texts: { corePrompt: string; corePromptIsDefault: boolean; noteParagraph: string };
  login: {
    modelLogin: string | null;
    state: string;
    reason: string;
    apiKeyPresent: boolean;
    signInCommand: string;
    signIn: { state: string; reason?: string; startedAt?: string; expiresAt?: string };
    signInAvailable: boolean;
  };
  telegram: { tokenPresent: boolean; userId: number | null; surfaceRunning: boolean; pairing: { state: string; code?: string; userId?: number; reason?: string } };
  credentials: { id: string; present: boolean }[];
};

async function state(r: PagesRig): Promise<State> {
  const res = await r.get('/api/setup/state');
  expect(res.status).toBe(200);
  return r.json<State>(res);
}

async function saveConfig(r: PagesRig, values: Record<string, unknown>) {
  const res = await r.post('/api/setup/config', { values });
  return { status: res.status, body: await r.json<{ ok: boolean; fieldErrors?: Record<string, string[]>; generalErrors?: string[] }>(res) };
}

const agentFile = (r: PagesRig) => readFileSync(join(r.root, 'agent.yaml'), 'utf8');

describe('first setup (§5.1)', () => {
  it('saves the name with the default login, a Claude plan, then an API key, and the harness ends its pause by itself', async () => {
    const r = await rig({ account: { apiKeySource: 'ANTHROPIC_API_KEY' } as AccountInfo });
    let s = await state(r);
    expect(s.config.exists).toBe(false);
    expect(s.harness).toMatchObject({ paused: true, blockerKind: 'config' });
    expect(s.harness.pauseReason).toContain('mission-agent setup');
    expect(s.config.values['run_limits.max_steps']).toBe(50);

    // Step 1. The name is saved at once, with the defaults of §A.1 for every other key.
    expect((await saveConfig(r, { agent_name: 'Ada' })).status).toBe(200);
    expect(agentFile(r)).toContain('agent_name: Ada');
    expect(agentFile(r)).toContain('model_login: subscription');
    s = await state(r);
    expect(s.agentName).toBe('Ada');
    // The default login is a Claude plan with no sign-in yet, so the harness stays paused and says why.
    expect(s.harness).toMatchObject({ paused: true, blockerKind: 'login' });
    expect(s.harness.pauseReason).toContain('Claude Code is not signed in with a Claude plan for this agent');
    expect(s.login).toMatchObject({ modelLogin: 'subscription', state: 'not_ready', apiKeyPresent: false });

    // The user chooses an API key instead.
    expect((await saveConfig(r, { model_login: 'api_key' })).status).toBe(200);
    expect(agentFile(r)).toContain('model_login: api_key');
    s = await state(r);
    expect(s.harness).toMatchObject({ paused: true, blockerKind: 'login' });
    expect(s.login).toMatchObject({ modelLogin: 'api_key', state: 'not_ready', apiKeyPresent: false });

    // Step 2. The key goes to the secret store, and the answer says only that a value is present.
    const res = await r.post('/api/setup/secret', { id: MODEL_API_KEY, value: API_KEY });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ok: true, id: MODEL_API_KEY, present: true });
    expect(text).not.toContain(API_KEY);
    expect(await r.secrets.get(MODEL_API_KEY)).toBe(API_KEY);
    expect(r.harness.status().paused).toBe(false);
    s = await state(r);
    expect(s.login).toMatchObject({ state: 'ready', apiKeyPresent: true });
    for (const file of ['agent.yaml', 'core-prompt.md', 'note-paragraph.md']) {
      const p = join(r.root, file);
      if (existsSync(p)) expect(readFileSync(p, 'utf8')).not.toContain(API_KEY);
    }
    expect(r.logs.join('\n')).not.toContain(API_KEY);
  });

  it('shows the sign-in command with the real path, and "check again" ends the pause after the sign-in', async () => {
    // An account object with no sign-in. The test signs in by filling it.
    const account: AccountInfo = {};
    const r = await rig({ agentYaml: 'agent_name: Ada\n', account });
    expect((await saveConfig(r, { model_login: 'subscription' })).status).toBe(200);
    let s = await state(r);
    expect(s.login.signInCommand).toBe(`CLAUDE_CONFIG_DIR=${join(r.root, 'state', 'claude')} ${terminalClaudeCommand()} auth login`);
    expect(s.login.state).toBe('not_ready');
    expect(r.harness.status().paused).toBe(true);

    const before = await r.post('/api/setup/login/check');
    expect(await r.json(before)).toMatchObject({ ok: false });

    account.email = 'user@example.com';
    account.subscriptionType = 'pro';
    const after = await r.post('/api/setup/login/check');
    expect(await r.json(after)).toEqual({ ok: true });
    expect(r.harness.status().paused).toBe(false);
    s = await state(r);
    expect(s.login.state).toBe('ready');
  });

  it('quotes a root path with a space or a quote in the sign-in command', async () => {
    const { signInCommand } = await import('./setup-routes.js');
    expect(signInCommand("/Users/a b/it's/state/claude", 'claude')).toBe(`CLAUDE_CONFIG_DIR='/Users/a b/it'\\''s/state/claude' claude auth login`);
    // Without claude on the PATH, the command names the program of the SDK by its path.
    expect(signInCommand('/x/state/claude', '/app/node_modules/sdk/claude')).toBe('CLAUDE_CONFIG_DIR=/x/state/claude /app/node_modules/sdk/claude auth login');
  });

  it('keeps each answer, so a new page and a new harness continue where the user stopped', async () => {
    const first = await rig({ account: { apiKeySource: 'ANTHROPIC_API_KEY' } as AccountInfo });
    await saveConfig(first, { agent_name: 'Ada' });
    await saveConfig(first, { 'run_limits.max_steps': 12, default_effort: 'medium' });
    const root = first.root;
    await first.harness.stop();

    // No sign-in with a Claude plan exists yet, so the login is still what keeps the pause.
    const second = await rig({ account: {}, before: (r) => writeFileSync(join(r, 'agent.yaml'), readFileSync(join(root, 'agent.yaml'))) });
    const s = await state(second);
    expect(s.agentName).toBe('Ada');
    expect(s.config.values['run_limits.max_steps']).toBe(12);
    expect(s.config.values.default_effort).toBe('medium');
    expect(s.harness.blockerKind).toBe('login');
  });

  it('refuses the login check before the name is saved', async () => {
    const r = await rig();
    const res = await r.post('/api/setup/login/check');
    expect(res.status).toBe(409);
  });
});

describe('the sign-in with a Claude plan (§A.5, §5.1 step 2)', () => {
  it("starts Anthropic's sign-in program once, and ends the pause when it ends well", async () => {
    const account: AccountInfo = {};
    const r = await rig({ agentYaml: 'agent_name: Ada\n', account });
    let s = await state(r);
    expect(s.login).toMatchObject({ modelLogin: 'subscription', state: 'not_ready', signIn: { state: 'idle' }, signInAvailable: true });
    expect(r.harness.status().paused).toBe(true);

    const res = await r.post('/api/setup/login/start');
    expect(res.status).toBe(200);
    const started = await r.json<{ ok: boolean; signIn: { state: string } }>(res);
    expect(started).toMatchObject({ ok: true, signIn: { state: 'waiting' } });
    expect(r.signIns).toHaveLength(1);
    const child = r.signIns[0]!;
    expect(child.command).toBe('/fake/claude');
    expect(child.args).toEqual(['auth', 'login', '--claudeai']);
    expect(child.options).toEqual({
      env: { PATH: '/usr/local/bin:/bin:/usr/bin', HOME: '/Users/ada', USER: 'ada', CLAUDE_CONFIG_DIR: join(r.root, 'state', 'claude') },
      stdio: ['ignore', 'ignore', 'ignore'],
      shell: false,
    });

    // A second press starts nothing new.
    expect(await r.json(await r.post('/api/setup/login/start'))).toMatchObject({ signIn: { state: 'waiting' } });
    expect(r.signIns).toHaveLength(1);
    expect(await r.json(await r.get('/api/setup/login/sign-in'))).toMatchObject({ ok: true, signIn: { state: 'waiting' } });

    // The user approves on Anthropic's page. Claude Code then holds a sign-in, and the program ends well.
    account.email = 'user@example.com';
    account.subscriptionType = 'pro';
    child.exit(0);
    await until(async () => (await state(r)).login.signIn.state === 'done', 'the end of the sign-in');
    expect(r.harness.status().paused).toBe(false);
    s = await state(r);
    expect(s.login.state).toBe('ready');
    expect(r.logs.join('\n')).not.toContain('secret-oauth-value');
  });

  it('stops the program when the user stops waiting, and when the harness stops', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\n', account: {} });
    await r.post('/api/setup/login/start');
    const cancel = await r.json(await r.post('/api/setup/login/cancel'));
    expect(cancel).toMatchObject({ ok: true, signIn: { state: 'cancelled' } });
    expect(r.signIns[0]!.signals).toEqual(['SIGTERM']);
    expect(r.harness.status().paused).toBe(true);

    await r.post('/api/setup/login/start');
    expect(r.signIns).toHaveLength(2);
    await r.harness.stop();
    expect(r.signIns[1]!.signals).toEqual(['SIGTERM']);
  });

  it('reports a program that ended without a sign-in, and one that ran out of time', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\n', account: {}, signInTimeoutMs: 200 });
    await r.post('/api/setup/login/start');
    r.signIns[0]!.exit(1);
    await until(async () => (await state(r)).login.signIn.state === 'failed', 'the failed sign-in');
    expect((await state(r)).login.signIn.reason).toContain('exit code 1');

    await r.post('/api/setup/login/start');
    await until(async () => (await state(r)).login.signIn.state === 'failed', 'the end of the time');
    expect((await state(r)).login.signIn.reason).toContain('No sign-in was finished');
    expect(r.signIns[1]!.signals).toEqual(['SIGTERM']);
  });

  it('says so when no sign-in program is found, and starts nothing', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\n', account: {}, signInProgram: null });
    expect((await state(r)).login.signInAvailable).toBe(false);
    const started = await r.json<{ signIn: { state: string; reason: string } }>(await r.post('/api/setup/login/start'));
    expect(started.signIn).toMatchObject({ state: 'failed', reason: expect.stringContaining('Sign in from a terminal instead') });
    expect(r.signIns).toHaveLength(0);
  });

  it('refuses to start before the name is saved, and with the api_key login', async () => {
    const empty = await rig();
    expect((await empty.post('/api/setup/login/start')).status).toBe(409);
    const key = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: api_key\n' });
    expect((await key.post('/api/setup/login/start')).status).toBe(409);
    expect(key.signIns).toHaveLength(0);
  });
});

describe('changes after setup (§5.2)', () => {
  it('shows the errors of the configuration module next to each field, and writes nothing', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: subscription\n' });
    const before = agentFile(r);
    const { status, body } = await saveConfig(r, {
      'run_limits.max_steps': 1.5,
      default_effort: 'huge',
      triage_switch_confidence: 2,
      max_note_bytes: 'lots',
    });
    expect(status).toBe(400);
    expect(body.fieldErrors).toEqual({
      'run_limits.max_steps': ['run_limits.max_steps must be a whole number, but it is 1.5.'],
      default_effort: ['default_effort must be one of "low", "medium", "high", "xhigh", "max", but it is "huge".'],
      triage_switch_confidence: ['triage_switch_confidence must be at most 1.'],
      max_note_bytes: ['max_note_bytes must be a number, but it is "lots".'],
    });
    expect(agentFile(r)).toBe(before);

    const empty = await saveConfig(r, { agent_name: '' });
    expect(empty.body.fieldErrors).toEqual({ agent_name: ['agent_name must not be empty.'] });
    const unknown = await saveConfig(r, { api_key: 'x' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.generalErrors).toEqual(['The page cannot change the key "api_key".']);
    const surface = await saveConfig(r, { default_surface: 'telegram' });
    expect(surface.body.fieldErrors).toEqual({ default_surface: ['default_surface is telegram, but telegram_user_id is not set.'] });
  });

  it('changes a limit and a model, and a null value goes back to the default', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: subscription\n' });
    expect((await saveConfig(r, { 'run_limits.max_cost_usd': 0.5, triage_model: 'claude-haiku-9' })).status).toBe(200);
    expect(r.harness.config()?.config.runLimits.maxCostUsd).toBe(0.5);
    expect(r.harness.config()?.config.triageModel).toBe('claude-haiku-9');
    expect((await saveConfig(r, { triage_model: null })).status).toBe(200);
    expect(r.harness.config()?.config.triageModel).toBe('claude-haiku-5-5');
  });

  it('writes the core system prompt and the paragraph about saving notes, and an empty value removes the file', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: subscription\n' });
    let res = await r.post('/api/setup/texts', { corePrompt: 'You are {agent name}. Be brief.', noteParagraph: 'Save a note when corrected.' });
    expect(res.status).toBe(200);
    expect(readFileSync(join(r.root, 'core-prompt.md'), 'utf8')).toBe('You are {agent name}. Be brief.\n');
    expect(r.harness.config()?.coreText).toBe('You are Ada. Be brief.');
    expect(r.harness.config()?.noteParagraph).toBe('Save a note when corrected.');
    let s = await state(r);
    expect(s.texts).toEqual({ corePrompt: 'You are {agent name}. Be brief.', corePromptIsDefault: false, noteParagraph: 'Save a note when corrected.' });

    res = await r.post('/api/setup/texts', { noteParagraph: '', corePrompt: '' });
    expect(res.status).toBe(200);
    expect(existsSync(join(r.root, 'note-paragraph.md'))).toBe(false);
    expect(existsSync(join(r.root, 'core-prompt.md'))).toBe(false);
    s = await state(r);
    expect(s.texts.corePromptIsDefault).toBe(true);
    expect(r.harness.config()?.noteParagraph).toBe('');

    const bad = await r.post('/api/setup/texts', { corePrompt: 5 });
    expect(bad.status).toBe(400);
  });

  it('shows the error of an agent.yaml edited by hand, keeps the last valid values, and can fix it', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: subscription\n' });
    writeFileSync(join(r.root, 'agent.yaml'), 'agent_name: Ada\nmodel_login: subscription\ndefault_effort: huge\n');
    await until(() => r.harness.configError() !== undefined, 'the harness to see the invalid file');
    const s = await state(r);
    expect(s.config.error).toContain('default_effort must be one of');
    expect(s.config.fieldErrors.default_effort?.[0]).toContain('but it is "huge"');
    expect(s.config.values.default_effort).toBe('huge');
    expect(s.harness.usesLastValidValues).toBe(true);
    expect(r.harness.config()?.config.defaultEffort).toBe('high');

    expect((await saveConfig(r, { default_effort: 'low' })).status).toBe(200);
    expect(r.harness.configError()).toBeUndefined();
    expect(r.harness.config()?.config.defaultEffort).toBe('low');
    expect((await state(r)).config.error).toBeUndefined();
  });

  it('refuses to change a file that is not valid YAML, and says why', async () => {
    const r = await rig({ agentYaml: 'agent_name: [Ada\n' });
    const s = await state(r);
    expect(s.config.error).toContain('not valid YAML');
    const res = await saveConfig(r, { agent_name: 'Ada' });
    expect(res.status).toBe(400);
    expect(res.body.generalErrors?.[0]).toContain('not valid YAML, so the page cannot change it');
    expect(agentFile(r)).toBe('agent_name: [Ada\n');
  });
});

describe('credentials (§5.2, §J.3)', () => {
  it('lists each required credential with whether a value is present, and sets and deletes one', async () => {
    // With the default login, a Claude plan, no credential is required.
    const plan = await rig({ agentYaml: 'agent_name: Ada\n' });
    expect((await state(plan)).credentials).toEqual([]);

    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: api_key\n' });
    let s = await state(r);
    expect(s.credentials).toEqual([{ id: MODEL_API_KEY, present: false }]);
    await r.post('/api/setup/secret', { id: MODEL_API_KEY, value: API_KEY });
    s = await state(r);
    expect(s.credentials).toEqual([{ id: MODEL_API_KEY, present: true }]);
    const del = await r.post('/api/setup/secret/delete', { id: MODEL_API_KEY });
    expect(await r.json(del)).toEqual({ ok: true, id: MODEL_API_KEY, present: false });
    expect(await r.secrets.has(MODEL_API_KEY)).toBe(false);
  });

  it('refuses a wrong id and an empty value, without repeating what was sent', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\n' });
    const wrongId = await r.post('/api/setup/secret', { id: API_KEY, value: API_KEY });
    expect(wrongId.status).toBe(400);
    expect(await wrongId.text()).not.toContain(API_KEY);
    const empty = await r.post('/api/setup/secret', { id: MODEL_API_KEY, value: '   ' });
    expect(empty.status).toBe(400);
    expect(await r.secrets.has(MODEL_API_KEY)).toBe(false);
  });

  it('sends no value that was set in the answer of any route', async () => {
    const other = 'credential:gmail.app_password';
    const otherValue = 'gmail-app-password-very-secret';
    const r = await rig({ agentYaml: 'agent_name: Ada\ntelegram_user_id: 4242\ndefault_surface: terminal\n' });
    const sent: string[] = [];
    for (const [id, value] of [
      [MODEL_API_KEY, API_KEY],
      [TELEGRAM_BOT_TOKEN, BOT_TOKEN],
      [other, otherValue],
    ] as const) {
      const res = await r.post('/api/setup/secret', { id, value });
      sent.push(await res.text());
    }
    await r.post('/api/setup/telegram/check').then(async (res) => sent.push(await res.text()));
    for (const route of r.pages.routes.filter((x) => x.method === 'GET')) {
      const res = await r.get(route.path);
      sent.push(`${route.path} ${res.status} ${JSON.stringify([...res.headers])} ${await res.text()}`);
    }
    const all = sent.join('\n');
    expect(all).toContain('/api/setup/state 200');
    for (const value of [API_KEY, BOT_TOKEN, otherValue]) expect(all).not.toContain(value);
    expect(r.logs.join('\n')).not.toContain(BOT_TOKEN);
  });
});

describe('Telegram (§5.1 step 3)', () => {
  it('checks the bot and says whether topic mode is on', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: subscription\n' });
    expect(await r.json(await r.post('/api/setup/telegram/check'))).toMatchObject({ ok: false, error: expect.stringContaining('No bot token') });
    await r.post('/api/setup/secret', { id: TELEGRAM_BOT_TOKEN, value: BOT_TOKEN });
    expect(await r.json(await r.post('/api/setup/telegram/check'))).toEqual({ ok: true, username: 'ada_bot', topicsEnabled: true });
    r.telegram.script('getMe', () => ({ ok: true, result: { id: 1, is_bot: true, first_name: 'A', username: 'ada_bot' } }));
    expect(await r.json(await r.post('/api/setup/telegram/check'))).toEqual({ ok: true, username: 'ada_bot', topicsEnabled: false });
    r.telegram.script('getMe', () => ({ ok: false, error_code: 401, description: 'Unauthorized' }));
    const refused = await r.json<{ ok: boolean; error: string }>(await r.post('/api/setup/telegram/check'));
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('refused the bot token');
  });

  it('pairs the sender of the code, records it as telegram_user_id, and starts Telegram with the threads', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: subscription\n' });
    expect((await r.post('/api/setup/telegram/pair')).status).toBe(409);
    await r.post('/api/setup/secret', { id: TELEGRAM_BOT_TOKEN, value: BOT_TOKEN });

    const started = await r.json<{ pairing: { state: string; code: string } }>(await r.post('/api/setup/telegram/pair'));
    expect(started.pairing.state).toBe('waiting');
    expect(started.pairing.code).toMatch(/^\d{6}$/);
    await until(() => r.telegram.calls('getUpdates').length > 0, 'the pairing to poll');
    expect(r.harness.telegram.running()).toBe(false);

    r.telegram.push(textUpdate(r.telegram, 'hello'), textUpdate(r.telegram, started.pairing.code));
    await until(async () => (await state(r)).telegram.pairing.state === 'paired', 'the pairing');
    const s = await state(r);
    expect(s.telegram).toMatchObject({ userId: USER, tokenPresent: true, pairing: { state: 'paired', userId: USER } });
    expect(agentFile(r)).toContain(`telegram_user_id: ${USER}`);
    expect(agentFile(r)).toContain('default_surface: telegram');
    await until(() => r.harness.telegram.running(), 'the Telegram surface to start');
    const created = r.surface.threads.filter((t) => t.op === 'create').map((t) => t.missionId);
    expect(created.sort()).toEqual([SYS_GENERAL, SYS_MISSION_ADMIN].sort());

    // The account can be removed again. The terminal becomes the default surface.
    expect((await r.post('/api/setup/telegram/forget')).status).toBe(200);
    expect(agentFile(r)).not.toContain('telegram_user_id');
    expect(r.harness.telegram.running()).toBe(false);
  });

  it('stops waiting for the code when asked, and starts nothing', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: subscription\n' });
    await r.post('/api/setup/secret', { id: TELEGRAM_BOT_TOKEN, value: BOT_TOKEN });
    await r.post('/api/setup/telegram/pair');
    await until(() => r.telegram.calls('getUpdates').length > 0, 'the pairing to poll');
    expect((await r.post('/api/setup/telegram/pair/cancel')).status).toBe(200);
    await until(async () => (await state(r)).telegram.pairing.state === 'cancelled', 'the end of the pairing');
    expect(agentFile(r)).not.toContain('telegram_user_id');
  });

  it('reports a pairing that ran out of time', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: subscription\n', pairTimeoutMs: 300 });
    await r.post('/api/setup/secret', { id: TELEGRAM_BOT_TOKEN, value: BOT_TOKEN });
    await r.post('/api/setup/telegram/pair');
    r.telegram.push();
    await until(async () => (await state(r)).telegram.pairing.state === 'failed', 'the end of the pairing');
    expect((await state(r)).telegram.pairing.reason).toContain('No message with the code reached the bot');
  });
});

describe('the service (§5.1 step 5)', () => {
  it('shows what it will write, then installs it for the root of this harness', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: subscription\n' });
    const view = await r.json<{
      ok: boolean;
      plan: { root: string; plistPath: string; label: string; programArguments: string[]; plistText: string };
      cliFound: boolean;
      status: { installed: boolean; loaded: boolean };
      isThisHarness: boolean;
    }>(await r.get('/api/setup/service'));
    expect(view.ok).toBe(true);
    expect(view.plan.root).toBe(r.root);
    expect(view.plan.plistPath).toBe(join(r.launchAgentsDir, `${view.plan.label}.plist`));
    expect(view.plan.programArguments.slice(2)).toEqual(['start', '--root', r.root]);
    expect(view.cliFound).toBe(true);
    expect(view.status).toMatchObject({ installed: false, loaded: false });
    expect(existsSync(view.plan.plistPath)).toBe(false);

    const res = await r.post('/api/setup/service/install');
    const body = await r.json<{ ok: boolean; handover: boolean; plistPath: string }>(res);
    expect(res.status).toBe(200);
    // This harness runs in the foreground, so the service takes over when it stops.
    expect(body).toMatchObject({ ok: true, handover: true, plistPath: view.plan.plistPath });
    expect(readFileSync(view.plan.plistPath, 'utf8')).toBe(view.plan.plistText);
    expect(r.launchctlCalls.slice(-3)).toEqual([
      ['bootstrap', 'gui/501', view.plan.plistPath],
      ['print', `gui/501/${view.plan.label}`],
      ['kickstart', `gui/501/${view.plan.label}`],
    ]);
  });

  it('refuses to install again from a harness that runs as the service', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: subscription\n' });
    r.printAnswer = { code: 0, stdout: `\tstate = running\n\tpid = ${process.pid}\n`, stderr: '' };
    const view = await r.json<{ isThisHarness: boolean }>(await r.get('/api/setup/service'));
    expect(view.isThisHarness).toBe(true);
    const res = await r.post('/api/setup/service/install');
    expect(res.status).toBe(400);
    expect((await r.json<{ error: string }>(res)).error).toContain('already runs as the service');
    expect(r.launchctlCalls.some((c) => c[0] === 'bootout' || c[0] === 'bootstrap')).toBe(false);
  });
});

describe('the computer (§H)', () => {
  interface View {
    ok: boolean;
    checkedAt: string;
    groups: Record<string, string>;
    checks: { id: string; group: string; state: string; detail: string; settings?: string; command?: string }[];
  }

  it('lists the checks of the computer with the service of this root folder', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: subscription\n' });
    const view = await r.json<View>(await r.get('/api/setup/system'));
    expect(view.ok).toBe(true);
    expect(Date.parse(view.checkedAt)).not.toBeNaN();
    expect(Object.keys(view.groups)).toEqual(['needed', 'unattended']);
    const state = (id: string) => view.checks.find((c) => c.id === id)?.state;
    expect(state('root-folder')).toBe('ok');
    expect(state('keychain')).toBe('ok');
    expect(state('auto-login')).toBe('ok');
    expect(state('sleep')).toBe('ok');
    // The fake launchctl knows no service.
    const service = view.checks.find((c) => c.id === 'service');
    expect(service).toMatchObject({ state: 'not_ok', command: `mission-agent service install --root ${r.root}` });
    // The checks read launchd and never change it.
    expect(r.launchctlCalls.every((c) => c[0] === 'print' || c[0] === 'print-disabled')).toBe(true);
  });

  it('opens the place in System Settings that the check named, and no other address', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: subscription\n' });
    r.commandAnswers.pmset = { code: 0, stdout: 'AC Power:\n sleep                10\n autorestart          1\n', stderr: '' };
    const view = await r.json<View>(await r.get('/api/setup/system'));
    const sleep = view.checks.find((c) => c.id === 'sleep');
    expect(sleep).toMatchObject({ state: 'not_ok', command: 'sudo pmset -c sleep 0' });

    expect((await r.post('/api/setup/system/open', { id: 'sleep' })).status).toBe(200);
    expect(r.opened).toEqual([sleep?.settings]);

    // A check with no place in System Settings, an unknown check, and an address in the request.
    for (const body of [{ id: 'keychain' }, { id: 'nope' }, { id: 'sleep', settings: 'https://example.com' }, {}]) {
      const res = await r.post('/api/setup/system/open', body);
      if (body.id === 'sleep') expect(res.status).toBe(200);
      else expect(res.status).toBe(400);
    }
    expect(r.opened).toEqual([sleep?.settings, sleep?.settings]);
  });

  it('reports a start that launchd held back when the page installs the service', async () => {
    const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: subscription\n' });
    let prints = 0;
    r.printAnswer = { code: 113, stdout: '', stderr: 'Could not find service' };
    const original = r.launchctlCalls.push.bind(r.launchctlCalls);
    // After the bootstrap, launchctl prints a service whose start is held back.
    r.launchctlCalls.push = (...calls: string[][]) => {
      for (const c of calls) {
        if (c[0] === 'bootstrap') r.printAnswer = { code: 0, stdout: '\tstate = not running\n\tpended nondemand spawn = speculative\n', stderr: '' };
        if (c[0] === 'print') prints += 1;
      }
      return original(...calls);
    };
    const body = await r.json<{ ok: boolean; heldBack: boolean }>(await r.post('/api/setup/service/install'));
    expect(body).toMatchObject({ ok: true, heldBack: true });
    expect(prints).toBeGreaterThan(1);
  });
});
