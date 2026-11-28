import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathsFor, type Paths } from '../paths.js';
import { isServerAlive, readServerFile } from '../server/index.js';
import { buildPlist, SERVICE_LABEL_PREFIX, serviceLabel, serviceLogPaths, xmlEscape } from './plist.js';

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

/**
 * The variables that replace the folders and names of a real install, so that a test install
 * touches none of them (chapter 7.2). The service file records the ones that are set, so the
 * harness that launchd starts uses the same ones.
 */
export const TEST_VARIABLES = ['MISSION_AGENT_LAUNCH_AGENTS', 'MISSION_AGENT_KEYCHAIN_SERVICE', 'MISSION_AGENT_TELEGRAM_API'] as const;

/** `MISSION_AGENT_LAUNCH_AGENTS`, else `~/Library/LaunchAgents`. */
export function defaultLaunchAgentsDir(env: NodeJS.ProcessEnv = process.env): string {
  const given = env.MISSION_AGENT_LAUNCH_AGENTS;
  return given !== undefined && given !== '' ? resolve(given) : join(homedir(), 'Library', 'LaunchAgents');
}

function testEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of TEST_VARIABLES) {
    const value = env[name];
    if (value !== undefined && value !== '') out[name] = value;
  }
  return out;
}

export interface ServiceOptions {
  /** The agent's root folder, as the user gave it. It is made absolute. */
  root: string;
  /** The built `cli.js`. Default: the one next to this module in `dist/`. */
  cliPath?: string;
  /** Default: the node program that runs now, by a path that stays valid after an upgrade of node. */
  nodePath?: string;
  /** Default: the PATH of the installing process. */
  envPath?: string;
  /** Default: the user id of this process. */
  uid?: number;
  /** Default: `MISSION_AGENT_LAUNCH_AGENTS`, else `~/Library/LaunchAgents`. */
  launchAgentsDir?: string;
  /** Variables besides PATH that the service file sets. Default: the test variables that are set. */
  environment?: Record<string, string>;
  launchctl?: LaunchctlRunner;
  /** How long to wait for launchd to remove a service after `bootout`. Default 40 seconds. */
  removalWaitMs?: number;
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
  /**
   * Set while launchd holds back a start of the service that nothing asked for, such as the
   * start at load or the start after a crash. The value is launchd's own word for the kind of start.
   */
  heldBack?: string;
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
  /**
   * launchd loaded the service and held back its start. Its log calls this state of a login
   * session "on-demand-only mode". The install asks for the start itself, so the harness runs,
   * but launchd does not start it again after a crash while the state lasts.
   */
  heldBack: boolean;
  /** Why the start that the install asked for failed. Undefined when it did not fail. */
  startError?: string;
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

/**
 * The path of the node program that the service file records. `process.execPath` is the real
 * file, and a package manager can put the version number in that path, so an upgrade of node
 * would remove it. A `node` in a folder of the PATH that leads to the same file stays valid
 * after an upgrade, so that one is recorded. Without one, the real file is recorded.
 */
export function stableNodePath(execPath: string = process.execPath, envPath: string | undefined = process.env.PATH): string {
  let real: string;
  try {
    real = realpathSync(execPath);
  } catch {
    return execPath;
  }
  for (const dir of (envPath ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, 'node');
    try {
      if (realpathSync(candidate) === real) return candidate;
    } catch {
      // No node program in this folder.
    }
  }
  return execPath;
}

function uidOf(options: ServiceOptions): number {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) throw new ServiceError('The user id of this account is not known, so the service cannot be installed.');
  return uid;
}

function runnerOf(options: Pick<ServiceOptions, 'launchctl'>): LaunchctlRunner {
  if (options.launchctl !== undefined) return options.launchctl;
  if (process.platform !== 'darwin') throw new ServiceError('The service works on macOS only.');
  return execLaunchctl;
}

/** What `installService` would write, computed without touching anything. */
export function servicePlan(options: ServiceOptions): ServicePlan {
  const root = resolve(options.root);
  const uid = uidOf(options);
  const label = serviceLabel(root);
  const dir = options.launchAgentsDir ?? defaultLaunchAgentsDir();
  const logs = serviceLogPaths(root);
  const cliPath = resolve(options.cliPath ?? builtCliPath());
  const envPath = options.envPath ?? process.env.PATH ?? FALLBACK_PATH;
  const nodePath = options.nodePath ?? stableNodePath(process.execPath, envPath);
  const programArguments = [nodePath, cliPath, 'start', '--root', root];
  const plistText = buildPlist({
    label,
    programArguments,
    workingDirectory: root,
    stdoutPath: logs.stdout,
    stderrPath: logs.stderr,
    envPath: envPath === '' ? FALLBACK_PATH : envPath,
    environment: options.environment ?? testEnvironment(),
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

/**
 * The service files of other root folders that run the same built program. An update replaces
 * the program under every one of them (chapter 7.4).
 */
export function otherServiceFiles(options: ServiceOptions): string[] {
  const plan = servicePlan(options);
  const dir = resolve(plan.plistPath, '..');
  if (!existsSync(dir)) return [];
  const program = `<string>${xmlEscape(plan.programArguments[1] as string)}</string>`;
  const found: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.startsWith(`${SERVICE_LABEL_PREFIX}.`) || !name.endsWith('.plist')) continue;
    const file = join(dir, name);
    if (file === plan.plistPath) continue;
    try {
      if (readFileSync(file, 'utf8').includes(program)) found.push(file);
    } catch {
      // A file that cannot be read is not counted.
    }
  }
  return found;
}

/** Reads the state of the service with `launchctl print`. */
export async function serviceStatus(options: ServiceOptions): Promise<ServiceStatus> {
  const root = resolve(options.root);
  const uid = uidOf(options);
  const label = serviceLabel(root);
  const dir = options.launchAgentsDir ?? defaultLaunchAgentsDir();
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
  const held = /^\s*pended nondemand spawn = (.+?)\s*$/m.exec(printed.stdout);
  if (held?.[1] !== undefined && status.pid === undefined) status.heldBack = held[1];
  return status;
}

/** What launchd reports about the user's login session and about this service in it. */
export interface SessionState {
  /**
   * launchd's `on-demand count` of the login session. Above zero, the session is in the state
   * that launchd's log calls "on-demand-only mode": launchd starts no service by itself, neither
   * at load nor after a crash. Undefined when it could not be read.
   */
  onDemandCount?: number;
  /** launchd has the service marked as disabled, so it does not load at login. */
  serviceDisabled: boolean;
}

/** Reads the login session with `launchctl print` and `launchctl print-disabled`. It changes nothing. */
export async function sessionState(options: ServiceOptions): Promise<SessionState> {
  const domain = `gui/${uidOf(options)}`;
  const label = serviceLabel(resolve(options.root));
  const run = runnerOf(options);
  const state: SessionState = { serviceDisabled: false };
  const printed = await run(['print', domain]);
  if (printed.code === 0) {
    const count = /^\s*on-demand count = (\d+)\s*$/m.exec(printed.stdout);
    if (count?.[1] !== undefined) state.onDemandCount = Number(count[1]);
  }
  const disabled = await run(['print-disabled', domain]);
  if (disabled.code === 0) {
    state.serviceDisabled = disabled.stdout.split('\n').some((line) => line.includes(`"${label}"`) && /=>\s*(disabled|true)\s*$/.test(line));
  }
  return state;
}

/** The programs that an installed service file names: node, then the built program. Undefined when the file cannot be read. */
export function installedProgram(options: ServiceOptions): { nodePath: string; cliPath: string } | undefined {
  const plan = servicePlan(options);
  let text: string;
  try {
    text = readFileSync(plan.plistPath, 'utf8');
  } catch {
    return undefined;
  }
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1];
  if (args === undefined) return undefined;
  const values = [...args.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => xmlUnescape(m[1] as string));
  const [nodePath, cliPath] = values;
  return nodePath === undefined || cliPath === undefined ? undefined : { nodePath, cliPath };
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Removes a loaded service with `launchctl bootout`, and waits until launchd no longer knows it.
 * `bootout` returns while the harness still stops, and a `bootstrap` in that time fails.
 * The maintenance program uses it to stop a service whose program is broken (chapter 7.5).
 */
export async function bootoutAndWait(options: Pick<ServiceOptions, 'launchctl' | 'removalWaitMs'>, plan: Pick<ServicePlan, 'domain' | 'label'>, what: string): Promise<void> {
  const run = runnerOf(options);
  const target = `${plan.domain}/${plan.label}`;
  const out = await run(['bootout', target]);
  if (out.code !== 0) throw new ServiceError(`launchctl could not remove ${what}: ${out.stderr.trim() || `exit code ${out.code}`}`);
  const deadline = Date.now() + (options.removalWaitMs ?? 40_000);
  for (;;) {
    if ((await run(['print', target])).code !== 0) return;
    if (Date.now() >= deadline) throw new ServiceError(`launchd did not remove ${what} in time. Run the command again.`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
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
 * Writes the plist, loads it with `launchctl bootstrap` and starts it with `launchctl kickstart`. It refuses when the built program
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

  if (status.loaded) await bootoutAndWait(options, plan, 'the old service');

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

  // launchd starts a loaded service by itself, except while it holds such starts back. A start
  // that is asked for always runs, and does nothing when the service already runs.
  const heldBack = (await serviceStatus(options)).heldBack !== undefined;
  const kicked = await run(['kickstart', `${plan.domain}/${plan.label}`]);
  const result: InstallResult = { plan, replaced: status.loaded, handover, heldBack };
  if (kicked.code !== 0) result.startError = kicked.stderr.trim() || `exit code ${kicked.code}`;
  return result;
}

/** Stops and removes the service with `launchctl bootout`, then removes the plist. */
export async function uninstallService(options: ServiceOptions): Promise<UninstallResult> {
  const plan = servicePlan(options);
  const run = runnerOf(options);
  const status = await serviceStatus(options);
  if (status.loaded) await bootoutAndWait(options, plan, 'the service');
  let removedFile = false;
  if (existsSync(plan.plistPath)) {
    unlinkSync(plan.plistPath);
    removedFile = true;
  }
  return { plan: { label: plan.label, plistPath: plan.plistPath, domain: plan.domain }, wasLoaded: status.loaded, removedFile };
}
