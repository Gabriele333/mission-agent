import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathsFor, type Paths } from '../paths.js';
import { isServerAlive, readServerFile } from '../server/index.js';
import { buildPlist, serviceLabel, serviceLogPaths } from './plist.js';

/**
 * Installs the harness as a LaunchAgent of the user's account (§H "Keeping the harness running").
 * Every call to `launchctl` goes through the runner, with an argument array and no shell.
 */

export interface LaunchctlResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type LaunchctlRunner = (args: string[]) => Promise<LaunchctlResult>;

/** The real runner. It never rejects: a failed command gives its exit code. */
export const execLaunchctl: LaunchctlRunner = (args) =>
  new Promise((resolvePromise) => {
    execFile('/bin/launchctl', args, { timeout: 30_000 }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 1;
      resolvePromise({ code, stdout: String(stdout), stderr: String(stderr || (err?.message ?? '')) });
    });
  });

/** The PATH given to the service when the installing process has none. */
const FALLBACK_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

export interface ServiceOptions {
  /** The agent's root folder, as the user gave it. It is made absolute. */
  root: string;
  /** The built `cli.js`. Default: the one next to this module in `dist/`. */
  cliPath?: string;
  /** Default: the node program that runs now. */
  nodePath?: string;
  /** Default: the PATH of the installing process. */
  envPath?: string;
  /** Default: the user id of this process. */
  uid?: number;
  /** Default: `~/Library/LaunchAgents`. */
  launchAgentsDir?: string;
  launchctl?: LaunchctlRunner;
  /** Finds a harness that answers on the local server of the root. Default: `state/server` and a ping. */
  findHarness?: (paths: Paths) => Promise<{ pid: number } | undefined>;
}

export interface ServicePlan {
  root: string;
  label: string;
  /** `gui/<uid>`, the launchd domain of the user's login session. */
  domain: string;
  plistPath: string;
  programArguments: string[];
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  envPath: string;
  /** The text that `installService` writes. */
  plistText: string;
}

export interface ServiceStatus {
  label: string;
  plistPath: string;
  /** The plist file exists. */
  installed: boolean;
  /** launchd knows the service. */
  loaded: boolean;
  /** The process id of the running service, when it runs. */
  pid?: number;
  /** The state that launchd reports, such as `running` or `not running`. */
  state?: string;
}

export interface InstallResult {
  plan: ServicePlan;
  /** A service with the same label was loaded before, and was replaced. */
  replaced: boolean;
  /**
   * The harness that asked for the install runs in the foreground. The service starts the
   * harness only after that one stops.
   */
  handover: boolean;
}

export interface UninstallResult {
  plan: Pick<ServicePlan, 'label' | 'plistPath' | 'domain'>;
  wasLoaded: boolean;
  removedFile: boolean;
}

/** An expected refusal or failure. The message is for the user. */
export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceError';
  }
}

/** The built `cli.js` next to this module: `dist/service/service.js` gives `dist/cli.js`. */
export function builtCliPath(): string {
  return fileURLToPath(new URL('../cli.js', import.meta.url));
}

function uidOf(options: ServiceOptions): number {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) throw new ServiceError('The user id of this account is not known, so the service cannot be installed.');
  return uid;
}

function runnerOf(options: ServiceOptions): LaunchctlRunner {
  if (options.launchctl !== undefined) return options.launchctl;
  if (process.platform !== 'darwin') throw new ServiceError('The service works on macOS only.');
  return execLaunchctl;
}

/** What `installService` would write, computed without touching anything. */
export function servicePlan(options: ServiceOptions): ServicePlan {
  const root = resolve(options.root);
  const uid = uidOf(options);
  const label = serviceLabel(root);
  const dir = options.launchAgentsDir ?? join(homedir(), 'Library', 'LaunchAgents');
  const logs = serviceLogPaths(root);
  const cliPath = resolve(options.cliPath ?? builtCliPath());
  const nodePath = options.nodePath ?? process.execPath;
  const programArguments = [nodePath, cliPath, 'start', '--root', root];
  const envPath = options.envPath ?? process.env.PATH ?? FALLBACK_PATH;
  const plistText = buildPlist({
    label,
    programArguments,
    workingDirectory: root,
    stdoutPath: logs.stdout,
    stderrPath: logs.stderr,
    envPath: envPath === '' ? FALLBACK_PATH : envPath,
  });
  return {
    root,
    label,
    domain: `gui/${uid}`,
    plistPath: join(dir, `${label}.plist`),
    programArguments,
    workingDirectory: root,
    stdoutPath: logs.stdout,
    stderrPath: logs.stderr,
    envPath: envPath === '' ? FALLBACK_PATH : envPath,
    plistText,
  };
}

/** Reads the state of the service with `launchctl print`. */
export async function serviceStatus(options: ServiceOptions): Promise<ServiceStatus> {
  const root = resolve(options.root);
  const uid = uidOf(options);
  const label = serviceLabel(root);
  const dir = options.launchAgentsDir ?? join(homedir(), 'Library', 'LaunchAgents');
  const plistPath = join(dir, `${label}.plist`);
  const run = runnerOf(options);
  const status: ServiceStatus = { label, plistPath, installed: existsSync(plistPath), loaded: false };
  const printed = await run(['print', `gui/${uid}/${label}`]);
  if (printed.code !== 0) return status;
  status.loaded = true;
  const pid = /^\s*pid = (\d+)\s*$/m.exec(printed.stdout);
  if (pid?.[1] !== undefined) status.pid = Number(pid[1]);
  const state = /^\s*state = (.+?)\s*$/m.exec(printed.stdout);
  if (state?.[1] !== undefined) status.state = state[1];
  return status;
}

async function defaultFindHarness(paths: Paths): Promise<{ pid: number } | undefined> {
  const info = readServerFile(paths);
  if (info === undefined) return undefined;
  return (await isServerAlive(info)) ? { pid: info.pid } : undefined;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Writes the plist and loads it with `launchctl bootstrap`. It refuses when the built program
 * cannot be found, and when a harness for the root runs in the foreground. `callerPid` is the
 * harness that serves the setup page: that one may ask, and the service then starts the harness
 * once the foreground one stops.
 */
export async function installService(options: ServiceOptions & { callerPid?: number }): Promise<InstallResult> {
  const plan = servicePlan(options);
  const run = runnerOf(options);
  const cliPath = plan.programArguments[1] as string;
  const nodePath = plan.programArguments[0] as string;
  if (!isFile(cliPath)) {
    throw new ServiceError(`The built program ${cliPath} cannot be found. Build it first with: npm run build`);
  }
  if (!isAbsolute(nodePath) || !isFile(nodePath)) {
    throw new ServiceError(`The node program ${nodePath} cannot be found.`);
  }

  const status = await serviceStatus(options);
  const harness = await (options.findHarness ?? defaultFindHarness)(pathsFor(plan.root));
  let handover = false;
  if (harness !== undefined) {
    const isService = status.pid !== undefined && status.pid === harness.pid;
    if (isService && options.callerPid === harness.pid) {
      throw new ServiceError(
        'This harness already runs as the service. Installing it again would stop it. ' +
          `To install it again, run in a terminal: mission-agent service install --root "${plan.root}"`,
      );
    }
    if (!isService) {
      if (options.callerPid !== harness.pid) {
        throw new ServiceError(
          `A harness for ${plan.root} runs in the foreground (process ${harness.pid}). Stop it first, then install the service.`,
        );
      }
      handover = true;
    }
  }

  if (status.loaded) {
    const out = await run(['bootout', `${plan.domain}/${plan.label}`]);
    if (out.code !== 0) throw new ServiceError(`launchctl could not remove the old service: ${out.stderr.trim() || `exit code ${out.code}`}`);
  }

  mkdirSync(serviceLogPaths(plan.root).dir, { recursive: true, mode: 0o700 });
  const dir = resolve(plan.plistPath, '..');
  mkdirSync(dir, { recursive: true });
  const tmp = `${plan.plistPath}.${process.pid}.tmp`;
  writeFileSync(tmp, plan.plistText, { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, plan.plistPath);

  const loaded = await run(['bootstrap', plan.domain, plan.plistPath]);
  if (loaded.code !== 0) {
    // A plist that launchd refused is removed, so that nothing is half installed.
    try {
      unlinkSync(plan.plistPath);
    } catch {
      // Already gone.
    }
    throw new ServiceError(`launchctl could not load the service: ${loaded.stderr.trim() || `exit code ${loaded.code}`}`);
  }
  return { plan, replaced: status.loaded, handover };
}

/** Stops and removes the service with `launchctl bootout`, then removes the plist. */
export async function uninstallService(options: ServiceOptions): Promise<UninstallResult> {
  const plan = servicePlan(options);
  const run = runnerOf(options);
  const status = await serviceStatus(options);
  if (status.loaded) {
    const out = await run(['bootout', `${plan.domain}/${plan.label}`]);
    if (out.code !== 0) throw new ServiceError(`launchctl could not remove the service: ${out.stderr.trim() || `exit code ${out.code}`}`);
  }
  let removedFile = false;
  if (existsSync(plan.plistPath)) {
    unlinkSync(plan.plistPath);
    removedFile = true;
  }
  return { plan: { label: plan.label, plistPath: plan.plistPath, domain: plan.domain }, wasLoaded: status.loaded, removedFile };
}
