import { spawn as nodeSpawn } from 'node:child_process';
import { accessSync, constants, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { shellQuote } from '../shell.js';
import type { LoginCheck } from './login.js';
import { buildRunEnv, hostEnvFromProcess, type HostEnv } from './options.js';

/**
 * The sign-in with a Claude plan from the setup page (§A.5 "The sign-in with a Claude plan").
 * It starts Anthropic's own sign-in program, unmodified, and watches only whether it ended
 * well. It never reads what the program prints and never writes to it: the program's output
 * holds the values of the sign-in. Its standard input, output and error are all closed.
 */

/** The arguments of the sign-in program. `--claudeai` chooses the sign-in with a Claude plan. */
export const SIGN_IN_ARGS: readonly string[] = ['auth', 'login', '--claudeai'];

/** A sign-in that is not finished after this time is stopped. */
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/** The time between SIGTERM and SIGKILL when the program does not stop. */
const KILL_WAIT_MS = 5000;

export type SignInState =
  | { state: 'idle' }
  | { state: 'waiting'; startedAt: string; expiresAt: string }
  | { state: 'done'; endedAt: string }
  | { state: 'failed'; reason: string }
  | { state: 'cancelled'; reason: string };

/** The options given to the spawner. They are always the same: no shell, and no stream open. */
export interface SignInSpawnOptions {
  env: Record<string, string>;
  stdio: ['ignore', 'ignore', 'ignore'];
  shell: false;
}

/** The part of a child process that the sign-in uses: its end, and a way to stop it. */
export interface SignInChild {
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SignInSpawn = (command: string, args: readonly string[], options: SignInSpawnOptions) => SignInChild;

export interface SignInDeps {
  /** The SDK configuration folder of the harness. Null means it has none of its own. */
  configDir: () => string | null;
  /** The harness's login check. It ends the pause when the login was what kept it. */
  checkLogin: () => Promise<LoginCheck>;
  hostEnv?: () => HostEnv;
  /** Replaces the start of a process, for tests. */
  spawn?: SignInSpawn;
  /** The sign-in program, from the PATH of the run. Default: `signInProgram`. */
  program?: (path: string | undefined) => string | undefined;
  /** Default 10 minutes. */
  timeoutMs?: number;
  now?: () => Date;
  log?: (text: string) => void;
}

export interface SignIn {
  /** Starts the sign-in. While one waits, it returns that one and starts nothing. */
  start(): SignInState;
  state(): SignInState;
  /** True when a sign-in program was found, so `start()` can start one. */
  available(): boolean;
  /** Stops a sign-in that waits. */
  cancel(): void;
  /** Stops a sign-in that waits, and starts none after it. The harness calls it when it stops. */
  stop(): void;
}

let shipped: { path: string | undefined } | undefined;

/** The Claude Code program that the SDK ships for this processor, or undefined when it is missing. */
export function shippedClaudeBinary(): string | undefined {
  if (shipped !== undefined) return shipped.path;
  let path: string | undefined;
  try {
    // The SDK finds its program the same way: from its own package, by platform and processor.
    const sdkMain = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
    const found = createRequire(sdkMain).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
    path = isExecutable(found) ? found : undefined;
  } catch {
    path = undefined;
  }
  shipped = { path };
  return path;
}

/** The path of a `claude` program in one of the folders of `path`, or undefined. */
export function claudeOnPath(path: string | undefined): string | undefined {
  for (const dir of (path ?? '').split(':')) {
    if (dir === '' || !dir.startsWith('/')) continue;
    const candidate = join(dir, 'claude');
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/** The program the setup page starts: the one the SDK ships, so the sign-in and the runs use the same one. */
export function signInProgram(path: string | undefined): string | undefined {
  return shippedClaudeBinary() ?? claudeOnPath(path);
}

/** The program name in the terminal command: `claude` when it is on the PATH, else the shipped program's path. */
export function terminalClaudeCommand(path: string | undefined = process.env.PATH): string {
  if (claudeOnPath(path) !== undefined) return 'claude';
  const binary = shippedClaudeBinary();
  return binary === undefined ? 'claude' : shellQuote(binary);
}

/** The environment of the sign-in program: exactly that of a run with the plan, with `/usr/bin` on the PATH for `open`. */
export function signInEnv(host: HostEnv, configDir: string): Record<string, string> {
  const env = buildRunEnv('subscription', host, configDir, undefined);
  const dirs = (env.PATH ?? '').split(':').filter((d) => d !== '');
  if (!dirs.includes('/usr/bin')) env.PATH = [...dirs, '/usr/bin'].join(':');
  return env;
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const defaultSpawn: SignInSpawn = (command, args, options) => nodeSpawn(command, [...args], options);

interface ActiveRun {
  child: SignInChild;
  /** True once the state no longer follows this run. */
  ended: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export function createSignIn(deps: SignInDeps): SignIn {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const timeoutMs = deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS;
  let current: SignInState = { state: 'idle' };
  let active: ActiveRun | undefined;
  let stopped = false;

  function failed(reason: string): SignInState {
    current = { state: 'failed', reason };
    log(`The sign-in with a Claude plan failed: ${reason}`);
    return current;
  }

  /** Ends the run in the state given, and stops its program. */
  function end(run: ActiveRun, next: SignInState): void {
    if (run.ended) return;
    run.ended = true;
    clearTimeout(run.timer);
    if (active === run) active = undefined;
    current = next;
    try {
      run.child.kill('SIGTERM');
    } catch {
      // The program has already ended.
    }
    const hard = setTimeout(() => {
      try {
        run.child.kill('SIGKILL');
      } catch {
        // The program has already ended.
      }
    }, KILL_WAIT_MS);
    hard.unref?.();
    run.child.once('exit', () => clearTimeout(hard));
  }

  async function exited(run: ActiveRun, code: number | null): Promise<void> {
    if (run.ended) return;
    clearTimeout(run.timer);
    if (code !== 0) {
      run.ended = true;
      if (active === run) active = undefined;
      const how = code === null ? 'was stopped' : `ended with exit code ${code}`;
      failed(`The sign-in program ${how} before the sign-in was finished. Try again, or sign in from a terminal.`);
      return;
    }
    // The program says the sign-in is done. The harness checks it the same way as every login.
    let check: LoginCheck;
    try {
      check = await deps.checkLogin();
    } catch (err) {
      check = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (run.ended) return;
    run.ended = true;
    if (active === run) active = undefined;
    if (check.ok) {
      current = { state: 'done', endedAt: now().toISOString() };
      log('The sign-in with a Claude plan is done.');
    } else {
      failed(`The sign-in program ended, but the login is still not ready. ${check.reason}`);
    }
  }

  function start(): SignInState {
    if (active !== undefined) return current;
    if (stopped) return failed('The harness is stopping.');
    const configDir = deps.configDir();
    if (configDir === null) return failed('This harness has no folder of its own for Claude Code, so the page cannot start the sign-in.');
    const host = (deps.hostEnv ?? hostEnvFromProcess)();
    const program = (deps.program ?? signInProgram)(host.PATH);
    if (program === undefined) {
      return failed('Claude Code was not found on this computer, so the page cannot start the sign-in. Sign in from a terminal instead.');
    }
    try {
      mkdirSync(configDir, { recursive: true });
    } catch {
      // Claude Code reports the folder problem itself.
    }
    let child: SignInChild;
    try {
      // An argument array and no shell. No stream is open: the harness reads nothing and writes nothing.
      child = (deps.spawn ?? defaultSpawn)(program, SIGN_IN_ARGS, {
        env: signInEnv(host, configDir),
        stdio: ['ignore', 'ignore', 'ignore'],
        shell: false,
      });
    } catch (err) {
      return failed(`The sign-in program could not start: ${err instanceof Error ? err.message : String(err)}`);
    }
    const started = now();
    const run: ActiveRun = {
      child,
      ended: false,
      timer: setTimeout(() => {
        end(run, { state: 'failed', reason: `No sign-in was finished within ${Math.round(timeoutMs / 60_000)} minutes, so the sign-in was stopped. Try again.` });
        log('The sign-in with a Claude plan ran out of time.');
      }, timeoutMs),
    };
    run.timer.unref?.();
    active = run;
    current = { state: 'waiting', startedAt: started.toISOString(), expiresAt: new Date(started.getTime() + timeoutMs).toISOString() };
    child.once('error', (err) => {
      if (run.ended) return;
      run.ended = true;
      clearTimeout(run.timer);
      if (active === run) active = undefined;
      failed(`The sign-in program could not start: ${err.message}`);
    });
    child.once('exit', (code) => void exited(run, code));
    log('The sign-in with a Claude plan started. Anthropic\'s sign-in page opens in the browser.');
    return current;
  }

  return {
    start,
    state: () => current,
    available: () => (deps.program ?? signInProgram)((deps.hostEnv ?? hostEnvFromProcess)().PATH) !== undefined,
    cancel() {
      if (active !== undefined) end(active, { state: 'cancelled', reason: 'The sign-in was stopped.' });
    },
    stop() {
      stopped = true;
      if (active !== undefined) end(active, { state: 'cancelled', reason: 'The harness stopped.' });
    },
  };
}
