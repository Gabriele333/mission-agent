import { execFile, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { isatty } from 'node:tty';
import { pathsFor } from '../paths.js';
import { isServerAlive, readServerFile, serverUrl } from '../server/server-file.js';
import { defaultLaunchAgentsDir, execLaunchctl } from '../service/service.js';
import type { CommandRunner } from '../update/command.js';
import type { Asker, HarnessFound, Maint } from './context.js';
import { processAlive } from './journal.js';
import { DEFAULT_KEYCHAIN_SERVICE, DEFAULT_REPO, layoutFor } from './layout.js';

/** The real outside world of the maintenance program: git, npm, node, launchctl, the harness and the terminal. */

/** The folders that hold git, npm and Homebrew on a Mac. */
const FIXED_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * The PATH of the commands that the maintenance program starts. launchd gives a service a short
 * PATH, so it starts with the folder of the node program that runs, then the fixed folders, then
 * the PATH that the maintenance program got.
 */
export function childPath(execPath: string, inherited: string | undefined): string {
  const out: string[] = [];
  for (const dir of [dirname(execPath), ...FIXED_PATH, ...(inherited ?? '').split(':')]) {
    if (dir !== '' && !out.includes(dir)) out.push(dir);
  }
  return out.join(':');
}

/**
 * Appends to the log. A log that cannot be written is not a reason to stop. It never makes the
 * home folder: after an uninstall removed it, nothing is written there again.
 */
function appendLog(file: string, text: string): void {
  try {
    appendFileSync(file, text);
  } catch {
    // The log is for reading later only.
  }
}

/** A runner that gives each command the PATH above and writes what it printed to the log. */
export function loggingRunner(logFile: string, env: NodeJS.ProcessEnv): CommandRunner {
  return (program, args, options) =>
    new Promise((resolvePromise) => {
      appendLog(logFile, `$ ${[program, ...args].join(' ')}   (in ${options.cwd})\n`);
      execFile(
        program,
        args,
        { cwd: options.cwd, timeout: options.timeoutMs ?? 60_000, maxBuffer: 64 * 1024 * 1024, env },
        (err, stdout, stderr) => {
          const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 1;
          const wroteNothing = String(stdout).trim() === '' && String(stderr).trim() === '';
          const errText = wroteNothing ? (err?.message ?? '') : String(stderr);
          appendLog(logFile, `${String(stdout)}${errText}${code === 0 ? '' : `(exit code ${code})\n`}`);
          resolvePromise({ code, stdout: String(stdout), stderr: errText });
        },
      );
    });
}

/** Reads one line from standard input, one byte at a time, so the rest stays for a command that runs after. */
function readLineSync(): string | undefined {
  const byte = Buffer.alloc(1);
  const bytes: number[] = [];
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let n: number;
    try {
      n = readSync(0, byte, 0, 1, null);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN') {
        Atomics.wait(wait, 0, 0, 50);
        continue;
      }
      if (code === 'EOF') n = 0;
      else throw err;
    }
    if (n === 0) return bytes.length === 0 ? undefined : Buffer.from(bytes).toString('utf8');
    if (byte[0] === 10) return Buffer.from(bytes).toString('utf8').replace(/\r$/, '');
    bytes.push(byte[0] as number);
  }
}

/**
 * The person at the terminal. Standard input must be a terminal. The tests set
 * MISSION_AGENT_STDIN_ANSWERS=1, so that answers written to standard input count as a person's.
 */
export function terminalAsker(env: NodeJS.ProcessEnv, write: (text: string) => void): Asker {
  let ended = false;
  return {
    canAsk: () => !ended && (isatty(0) || env.MISSION_AGENT_STDIN_ANSWERS === '1'),
    async line(question) {
      write(question);
      const line = readLineSync();
      if (line === undefined) {
        ended = true;
        write('\n');
      } else if (!isatty(0)) write('\n');
      return line;
    },
  };
}

/** The harness that answers for a root folder: `state/server`, a ping, and the version from its status. */
export async function findHarnessReal(root: string): Promise<HarnessFound | undefined> {
  const info = readServerFile(pathsFor(root));
  if (info === undefined || !(await isServerAlive(info))) return undefined;
  try {
    // The status route of the harness (§J.3). It is the route that `mission-agent status` reads.
    const res = await fetch(`${serverUrl(info)}/api/status`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const st = (await res.json()) as { version?: unknown };
    return typeof st.version === 'string' ? { pid: info.pid, version: st.version } : { pid: info.pid };
  } catch {
    return { pid: info.pid };
  }
}

export interface RealOptions {
  home: string;
  out: (line: string) => void;
  asker?: Asker;
}

/** The maintenance program's view of this computer. */
export function realMaint(options: RealOptions): Maint {
  const layout = layoutFor(options.home);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: childPath(process.execPath, process.env.PATH), GIT_TERMINAL_PROMPT: '0' };
  const log = (line: string) => appendLog(layout.log, `${line}\n`);
  const out = (line: string) => {
    options.out(line);
    log(line);
  };
  return {
    layout,
    repo: process.env.MISSION_AGENT_REPO || DEFAULT_REPO,
    launchAgents: defaultLaunchAgentsDir(),
    keychainService: process.env.MISSION_AGENT_KEYCHAIN_SERVICE || DEFAULT_KEYCHAIN_SERVICE,
    userHome: homedir(),
    uid: process.getuid?.() ?? 0,
    nodePath: process.execPath,
    envPath: process.env.PATH ?? '',
    run: loggingRunner(layout.log, env),
    runAttached: (program, args) =>
      new Promise((resolvePromise) => {
        log(`$ ${[program, ...args].join(' ')}   (with this terminal)`);
        const child = spawn(program, args, { stdio: 'inherit', env, cwd: layout.home });
        child.once('error', () => resolvePromise(127));
        child.once('exit', (code) => resolvePromise(code ?? 1));
      }),
    launchctl: execLaunchctl,
    findHarness: findHarnessReal,
    security: (args) =>
      new Promise((resolvePromise) => {
        execFile('/usr/bin/security', args, { timeout: 30_000 }, (err) => resolvePromise({ code: err === null ? 0 : 1 }));
      }),
    ask: options.asker ?? terminalAsker(process.env, (t) => process.stdout.write(t)),
    out,
    log,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pid: process.pid,
    alive: processAlive,
    checkpoint: async () => {},
    env: process.env,
    waits: { stopMs: 30_000, startMs: 90_000, pollMs: 500 },
  };
}
