import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, DEFAULT_CORE_TEXT } from '../config/index.js';
import { pathsFor, type Paths } from '../paths.js';
import { MODEL_API_KEY } from '../secrets/index.js';
import type { AgentConfig, LoadedConfig } from '../types.js';
import { checkModelLogin, createModelCaller, ModelCallError, type ModelLoginDeps } from './login.js';
import { errorAssistantMsg, fakeQuery, initMsg, resultMsg, type Script } from './test-helpers.js';

let tmp: string;
let paths: Paths;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'run-login-'));
  paths = pathsFor(tmp);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function deps(login: AgentConfig['modelLogin'], key: string | undefined, scripts: Script[], account: AccountInfo = {}) {
  const fake = fakeQuery(scripts, account);
  const loaded: LoadedConfig = { config: { ...defaultConfig('Ada'), modelLogin: login }, coreText: DEFAULT_CORE_TEXT, noteParagraph: '' };
  const d: ModelLoginDeps = {
    paths,
    config: () => loaded,
    secrets: { get: (id) => (id === MODEL_API_KEY ? key : undefined) },
    queryFn: fake.queryFn,
    hostEnv: { PATH: '/usr/bin', HOME: '/h', USER: 'u' },
  };
  return { d, calls: fake.calls };
}

const nothing: Script = async function* () {};

describe('checkModelLogin', () => {
  it('is ready with a Claude plan sign-in', async () => {
    const { d, calls } = deps('subscription', undefined, [nothing], { subscriptionType: 'pro', apiProvider: 'firstParty' });
    expect(await checkModelLogin(d)).toEqual({ ok: true });
    expect(calls[0]?.options.env).toEqual({ PATH: '/usr/bin', HOME: '/h', USER: 'u', CLAUDE_CONFIG_DIR: paths.sdkConfigDir });
    expect(calls[0]?.options.tools).toEqual([]);
    expect(calls[0]?.closed).toBe(true);
  });

  it('says "Not logged in" with the sign-in command when there is no sign-in', async () => {
    const { d } = deps('subscription', undefined, [nothing], { tokenSource: 'none', apiProvider: 'firstParty' });
    const r = await checkModelLogin(d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/^Not logged in: /);
      expect(r.reason).toContain(`CLAUDE_CONFIG_DIR="${paths.sdkConfigDir}" claude auth login`);
    }
  });

  it('gives the plain command when the configuration folder is left out', async () => {
    const { d } = deps('subscription', undefined, [nothing], { tokenSource: 'none' });
    d.sdkConfigDir = null;
    const r = await checkModelLogin(d);
    expect(r.ok ? '' : r.reason).toContain('Sign in to Claude Code with: claude auth login');
  });

  it('does not start Claude Code when the model key has no value', async () => {
    const { d, calls } = deps('api_key', undefined, [nothing]);
    const r = await checkModelLogin(d);
    expect(r.ok ? '' : r.reason).toContain('Not logged in: the model key credential:model.api_key has no value.');
    expect(calls).toHaveLength(0);
  });

  it('is ready when Claude Code sees the key', async () => {
    const { d, calls } = deps('api_key', 'sk-ant-0123456789', [nothing], { apiKeySource: 'ANTHROPIC_API_KEY', tokenSource: 'none' });
    expect(await checkModelLogin(d)).toEqual({ ok: true });
    expect(calls[0]?.options.env?.ANTHROPIC_API_KEY).toBe('sk-ant-0123456789');
  });
});

describe('createModelCaller', () => {
  it('makes one call with no tools, one step and no saved session, and returns the text', async () => {
    const { d, calls } = deps('subscription', undefined, [async function* () {
      yield initMsg('s');
      yield resultMsg({ result: '{"mission":"sys-general","confidence":0.9}' });
    }]);
    const call = createModelCaller(d);
    const text = await call('Which mission?', { model: 'claude-haiku-5-5', effort: 'low', system: 'You classify.' });
    expect(text).toBe('{"mission":"sys-general","confidence":0.9}');
    const o = calls[0]!.options;
    expect(calls[0]?.prompt).toBe('Which mission?');
    expect(o).toMatchObject({ tools: [], maxTurns: 1, persistSession: false, model: 'claude-haiku-5-5', effort: 'low', systemPrompt: 'You classify.', settingSources: [] });
    expect(o.env).toEqual({ PATH: '/usr/bin', HOME: '/h', USER: 'u', CLAUDE_CONFIG_DIR: paths.sdkConfigDir });
  });

  it('throws a "Not logged in" error that says so', async () => {
    const { d } = deps('subscription', undefined, [async function* () {
      yield initMsg('s');
      yield errorAssistantMsg('authentication_failed', 'Not logged in · Please run /login');
      yield resultMsg({ isError: true, result: 'Not logged in · Please run /login' });
      throw new Error('Claude Code returned an error result: Not logged in · Please run /login');
    }]);
    const err = await createModelCaller(d)('x', { model: 'm', effort: 'low' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelCallError);
    expect((err as ModelCallError).notLoggedIn).toBe(true);
    expect((err as ModelCallError).message).toMatch(/^Not logged in: /);
  });

  it('throws on another failure', async () => {
    const { d } = deps('subscription', undefined, [async function* () {
      yield resultMsg({ subtype: 'error_during_execution', errors: ['overloaded'] });
    }]);
    const err = await createModelCaller(d)('x', { model: 'm', effort: 'low' }).catch((e: unknown) => e);
    expect((err as ModelCallError).notLoggedIn).toBe(false);
    expect((err as ModelCallError).message).toBe('The model call failed: overloaded.');
  });
});
