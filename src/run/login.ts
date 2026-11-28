import type { AccountInfo, HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync } from 'node:fs';
import type { Paths } from '../paths.js';
import { MODEL_API_KEY, type SecretCache } from '../secrets/index.js';
import type { AgentConfig, Effort, LoadedConfig, RunResult } from '../types.js';
import { MessageCollector, errorText } from './messages.js';
import { buildRunEnv, hostEnvFromProcess, type HostEnv } from './options.js';
import { sdkQuery, type QueryFn } from './sdk.js';
import { terminalClaudeCommand } from './sign-in.js';

/** The model login (§A.5 "Model login", "A missing or refused credential") and the plain model call of §B.3. */

/** Every error text about a missing or refused model login starts with these words. */
export const NOT_LOGGED_IN = 'Not logged in';

export interface ModelLoginDeps {
  paths: Paths;
  config: () => LoadedConfig;
  secrets: Pick<SecretCache, 'get'>;
  /** Undefined uses `state/claude`. Null leaves `CLAUDE_CONFIG_DIR` out (live tests only). */
  sdkConfigDir?: string | null;
  queryFn?: QueryFn;
  hostEnv?: HostEnv;
  /** How long a check or a call may take. Default 60 seconds for the check, 120 for a call. A call can set its own. */
  timeoutMs?: number;
}

/** The SDK configuration folder to pass, from the engine option. */
export function configDirFor(paths: Paths, option: string | null | undefined): string | null {
  return option === undefined ? paths.sdkConfigDir : option;
}

/**
 * What the user must do to sign in. The command names `claude` when it is on the PATH, and
 * otherwise the Claude Code program that comes with the SDK, so no other install is needed.
 */
export function loginHelp(
  login: AgentConfig['modelLogin'],
  sdkConfigDir: string | null,
  program: string = terminalClaudeCommand(),
): string {
  if (login === 'api_key') return `Enter a key from the Claude Console with: mission-agent secret set ${MODEL_API_KEY}`;
  return sdkConfigDir === null
    ? `Sign in to Claude Code with: ${program} auth login`
    : `Sign in to Claude Code for this agent with: CLAUDE_CONFIG_DIR="${sdkConfigDir}" ${program} auth login`;
}

/**
 * The plain-words error for a missing or refused login. `sdkText` is what Claude Code said,
 * such as "Not logged in · Please run /login" or "Invalid API key · Fix external API key".
 */
export function notLoggedInText(
  login: AgentConfig['modelLogin'],
  sdkConfigDir: string | null,
  sdkText?: string,
): string {
  const said = sdkText ? ` Claude Code said: "${sdkText}".` : '';
  const what =
    login === 'api_key'
      ? sdkText
        ? `the model key ${MODEL_API_KEY} was refused.`
        : `the model key ${MODEL_API_KEY} has no value.`
      : 'Claude Code is not signed in with a Claude plan for this agent, or the sign-in has ended.';
  return `${NOT_LOGGED_IN}: ${what}${said} ${loginHelp(login, sdkConfigDir)}`;
}

/** True when a run failed because the model login is missing or refused. The harness should pause. */
export function isNotLoggedIn(result: Pick<RunResult, 'status' | 'error'>): boolean {
  return result.status === 'failed' && typeof result.error === 'string' && result.error.startsWith(NOT_LOGGED_IN);
}

export type LoginCheck = { ok: true } | { ok: false; reason: string };

/**
 * Checks the model login without a model call. It starts Claude Code with the run's
 * environment, asks for the account information and closes it. This costs no tokens and
 * takes about 0.2 to 3 seconds. With the `api_key` login it checks that the key has a value
 * and reaches Claude Code; it cannot tell whether the service will accept the key.
 */
export async function checkModelLogin(deps: ModelLoginDeps): Promise<LoginCheck> {
  const cfg = deps.config().config;
  const login = cfg.modelLogin;
  const configDir = configDirFor(deps.paths, deps.sdkConfigDir);
  let apiKey: string | undefined;
  if (login === 'api_key') {
    apiKey = deps.secrets.get(MODEL_API_KEY);
    if (!apiKey) return { ok: false, reason: notLoggedInText(login, configDir) };
  }
  if (configDir !== null) ensureDir(configDir);
  const env = buildRunEnv(login, deps.hostEnv ?? hostEnvFromProcess(), configDir, apiKey);

  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // A stream that sends no message: Claude Code starts and answers control requests only.
  async function* noPrompt(): AsyncGenerator<never> {
    await held;
  }

  const queryFn = deps.queryFn ?? sdkQuery;
  let info: AccountInfo;
  let q: ReturnType<QueryFn> | undefined;
  try {
    q = queryFn({
      prompt: noPrompt(),
      options: {
        env,
        cwd: deps.paths.root,
        settingSources: [],
        tools: [],
        strictMcpConfig: true,
        persistSession: false,
        settings: { autoMemoryEnabled: false, autoDreamEnabled: false },
        permissionMode: 'default',
        canUseTool: async () => ({ behavior: 'deny', message: 'No tool is available.' }),
      },
    });
    info = await withTimeout(q.accountInfo(), deps.timeoutMs ?? 60_000, 'the login check');
  } catch (err) {
    return { ok: false, reason: `The model login could not be checked: ${errorText(err)}` };
  } finally {
    try {
      q?.close();
    } catch {
      // The process is already gone.
    }
    release();
  }

  const ok =
    login === 'api_key'
      ? info.apiKeySource === 'ANTHROPIC_API_KEY'
      : Boolean(info.email || info.subscriptionType || (info.tokenSource && info.tokenSource !== 'none'));
  return ok ? { ok: true } : { ok: false, reason: notLoggedInText(login, configDir) };
}

/** A model call failed. `notLoggedIn` is true when the login is missing or refused. */
export class ModelCallError extends Error {
  readonly notLoggedIn: boolean;
  constructor(message: string, notLoggedIn: boolean) {
    super(message);
    this.name = 'ModelCallError';
    this.notLoggedIn = notLoggedIn;
  }
}

export type ModelCaller = (
  prompt: string,
  opts: { model: string; effort: Effort; system?: string; timeoutMs?: number },
) => Promise<string>;

/**
 * One SDK call with no tools, one step and no saved session, with the same environment and
 * login as a run (§B.3). Triage uses it. Throws a ModelCallError.
 */
export function createModelCaller(deps: ModelLoginDeps): ModelCaller {
  const queryFn = deps.queryFn ?? sdkQuery;
  const denyAll: HookCallback = async () => ({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'No tool is available in this call.',
    },
  });

  return async (prompt, opts) => {
    const login = deps.config().config.modelLogin;
    const configDir = configDirFor(deps.paths, deps.sdkConfigDir);
    let apiKey: string | undefined;
    if (login === 'api_key') {
      apiKey = deps.secrets.get(MODEL_API_KEY);
      if (!apiKey) throw new ModelCallError(notLoggedInText(login, configDir), true);
    }
    if (configDir !== null) ensureDir(configDir);
    const abort = new AbortController();
    const timeoutMs = opts.timeoutMs ?? deps.timeoutMs ?? 120_000;
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const options: Options = {
      env: buildRunEnv(login, deps.hostEnv ?? hostEnvFromProcess(), configDir, apiKey),
      cwd: deps.paths.root,
      settingSources: [],
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: false,
      maxTurns: 1,
      model: opts.model,
      effort: opts.effort,
      settings: { autoMemoryEnabled: false, autoDreamEnabled: false },
      permissionMode: 'default',
      hooks: { PreToolUse: [{ onFailure: 'block', hooks: [denyAll] }] },
      canUseTool: async () => ({ behavior: 'deny', message: 'No tool is available in this call.' }),
      abortController: abort,
    };
    if (opts.system !== undefined) options.systemPrompt = opts.system;

    const collector = new MessageCollector();
    try {
      for await (const msg of queryFn({ prompt, options })) collector.add(msg);
    } catch (err) {
      // After an error result the SDK also throws. The result is already read.
      collector.thrown = err;
    } finally {
      clearTimeout(timer);
    }

    if (collector.loginError !== undefined) {
      throw new ModelCallError(notLoggedInText(login, configDir, collector.loginError), true);
    }
    const r = collector.result;
    if (r !== undefined && r.subtype === 'success' && !r.isError && typeof r.result === 'string') return r.result;
    if (abort.signal.aborted) {
      throw new ModelCallError(`The model call took longer than ${Math.round(timeoutMs / 1000)} seconds.`, false);
    }
    const detail = r?.errors.join('; ') || (r?.isError ? r.result : undefined) || errorText(collector.thrown);
    throw new ModelCallError(`The model call failed: ${detail || 'it ended without a result'}.`, false);
  };
}

function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Claude Code reports the folder problem itself.
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} seconds`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
