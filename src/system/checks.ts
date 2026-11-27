import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, sep } from 'node:path';
import type { Paths } from '../paths.js';
import {
  installedProgram,
  serviceStatus,
  sessionState,
  type ServiceOptions,
  type ServiceStatus,
  type SessionState,
} from '../service/index.js';
import { shellQuote } from '../shell.js';
import { execCommand, type CommandRunner } from '../update/index.js';

/**
 * The checks of the computer that the agent runs on (§H). They only read: each one asks macOS
 * for one setting and says what it found. The `check` command, the install script and the setup
 * page all show the same list.
 */

/**
 * `needed` is what every agent needs. `unattended` is what a computer needs to run the agent
 * with nobody at it, such as a computer with no screen. On a computer that its user sits at,
 * the `unattended` settings are a choice, not a fault.
 */
export type CheckGroup = 'needed' | 'unattended';

export interface SystemCheck {
  id: string;
  group: CheckGroup;
  title: string;
  /** `unknown` when macOS did not answer. */
  state: 'ok' | 'not_ok' | 'unknown';
  /** What was found. */
  detail: string;
  /** What the user does about it. Set when the state is not ok. */
  fix?: string;
  /** A command that the user can run in a terminal. Nothing here runs it. */
  command?: string;
  /** The place in System Settings, as an address that the `open` command accepts. */
  settings?: string;
}

export interface SystemCheckDeps {
  paths: Pick<Paths, 'root'>;
  /** How the service is read. The root is the agent's. */
  service: ServiceOptions;
  /** Resolves when the Keychain answers, and rejects with the reason when it does not. */
  keychain: () => Promise<unknown>;
  /** Runs `defaults`, `pmset`, `sysadminctl`, `fdesetup` and `git`. Default: the real programs. */
  run?: CommandRunner;
  /** Defaults: the account that runs this program. */
  user?: string;
  home?: string;
  /** Replaces the two reads of the service module. For tests. */
  readService?: () => Promise<ServiceStatus>;
  readSession?: () => Promise<SessionState>;
}

/** The places in System Settings that a check can point to. */
export const SETTINGS = {
  loginItems: 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension',
  users: 'x-apple.systempreferences:com.apple.Users-Groups-Settings.extension',
  lockScreen: 'x-apple.systempreferences:com.apple.Lock-Screen-Settings.extension',
  battery: 'x-apple.systempreferences:com.apple.Battery-Settings.extension',
  energy: 'x-apple.systempreferences:com.apple.Energy-Settings.extension',
} as const;

/** Folders that macOS protects: a background program needs the user's permission to read them. */
const PROTECTED_FOLDERS = ['Desktop', 'Documents', 'Downloads', join('Library', 'Mobile Documents'), join('Library', 'CloudStorage')];

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isInside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder + sep);
}

/** The path with links resolved, or the path itself when it does not exist. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// ---------------------------------------------------------------- needed

function rootFolderCheck(deps: SystemCheckDeps, home: string): SystemCheck {
  const base = { id: 'root-folder', group: 'needed', title: 'Root folder' } as const;
  const root = deps.paths.root;
  const resolved = real(root);
  const protectedIn = PROTECTED_FOLDERS.find((f) => isInside(resolved, real(join(home, f))));
  if (protectedIn !== undefined) {
    return {
      ...base,
      state: 'not_ok',
      detail: `${root} is inside ~/${protectedIn}. macOS asks for permission before a background program reads that folder, and it can refuse the service.`,
      fix: 'Move the root folder outside it, for example to ~/mission-agent. Then install the service again with the new path.',
    };
  }
  if (!existsSync(root)) return { ...base, state: 'ok', detail: `${root} does not exist yet. The harness creates it at its first start.` };
  try {
    accessSync(root, constants.R_OK | constants.W_OK);
  } catch (err) {
    return {
      ...base,
      state: 'not_ok',
      detail: `This program cannot read and write ${root}: ${errorText(err)}`,
      fix: 'Give your account the right to read and write the folder.',
    };
  }
  return { ...base, state: 'ok', detail: `This program can read and write ${root}.` };
}

async function keychainCheck(deps: SystemCheckDeps): Promise<SystemCheck> {
  const base = { id: 'keychain', group: 'needed', title: 'Keychain' } as const;
  try {
    await deps.keychain();
    return { ...base, state: 'ok', detail: 'The login Keychain answers, so the agent can read its secrets.' };
  } catch (err) {
    return {
      ...base,
      state: 'not_ok',
      detail: `The login Keychain does not answer: ${errorText(err)}`,
      fix: 'The Keychain is unlocked when you log in to macOS at the screen. Log in there, then check again.',
    };
  }
}

async function gitCheck(run: CommandRunner, cwd: string): Promise<SystemCheck> {
  const base = { id: 'git', group: 'needed', title: 'git' } as const;
  const r = await run('git', ['--version'], { cwd, timeoutMs: 15_000 });
  if (r.code === 0) return { ...base, state: 'ok', detail: `${r.stdout.trim() || 'git'} is on the PATH of this program.` };
  return {
    ...base,
    state: 'not_ok',
    detail: 'git was not found on the PATH of this program, so the agent cannot look for a newer release or install one.',
    fix: 'Install git. On macOS it comes with the command line tools.',
    command: 'xcode-select --install',
  };
}

function serviceCheck(deps: SystemCheckDeps, status: ServiceStatus | Error, session: SessionState | undefined): SystemCheck {
  const base = { id: 'service', group: 'needed', title: 'Service' } as const;
  const install = `mission-agent service install --root ${shellQuote(deps.paths.root)}`;
  if (status instanceof Error) return { ...base, state: 'unknown', detail: `The state of the service could not be read: ${status.message}` };
  if (session?.serviceDisabled === true) {
    return {
      ...base,
      state: 'not_ok',
      detail: 'macOS has the service switched off, so it does not start the agent.',
      fix: 'Switch it on in System Settings, under General, Login Items. Then install the service again.',
      settings: SETTINGS.loginItems,
      command: install,
    };
  }
  if (!status.installed || !status.loaded) {
    return {
      ...base,
      state: 'not_ok',
      detail: status.installed
        ? 'The service file is present, but launchd has not loaded it. The agent does not start at login or after a crash.'
        : 'The service is not installed. The agent does not start at login or after a crash.',
      fix: 'Install the service.',
      command: install,
    };
  }
  const program = installedProgram(deps.service);
  const gone = program === undefined ? undefined : [program.nodePath, program.cliPath].find((p) => !existsSync(p));
  if (gone !== undefined) {
    return {
      ...base,
      state: 'not_ok',
      detail: `The service file names a program that no longer exists: ${gone}. The service cannot start the agent.`,
      fix: 'Install the service again. It then records the programs that exist now.',
      command: install,
    };
  }
  if (status.pid === undefined) {
    return {
      ...base,
      state: 'not_ok',
      detail:
        `The service is loaded, but the agent does not run (launchd reports: ${status.state ?? 'no state'}` +
        `${status.heldBack !== undefined ? `, start held back: ${status.heldBack}` : ''}).`,
      fix: 'Install the service again, which also starts it. If the agent stopped by itself, read its log first, in state/logs/ of the root folder.',
      command: install,
    };
  }
  return { ...base, state: 'ok', detail: `The service is loaded, and the agent runs as process ${status.pid}.` };
}

function launchdCheck(session: SessionState | undefined): SystemCheck {
  const base = { id: 'launchd', group: 'needed', title: 'Restart after a crash' } as const;
  const count = session?.onDemandCount;
  if (count === undefined) return { ...base, state: 'unknown', detail: 'launchd did not say whether it starts services by itself in your login session.' };
  if (count === 0) return { ...base, state: 'ok', detail: 'launchd starts services by itself in your login session, so it starts the agent again after a crash.' };
  return {
    ...base,
    state: 'not_ok',
    detail:
      `launchd reports "on-demand count = ${count}" for your login session. In this state it starts no service by itself, ` +
      'so it does not start the agent again after a crash.',
    fix: 'Log out of macOS and log in again, then check again.',
  };
}

// ---------------------------------------------------------------- unattended

/** The settings of one power source in the output of `pmset -g custom`. */
function pmsetSection(output: string, name: string): Map<string, string> | undefined {
  const values = new Map<string, string>();
  let inside = false;
  let found = false;
  for (const line of output.split('\n')) {
    if (/^\S.*:\s*$/.test(line)) {
      inside = line.trim() === `${name}:`;
      found = found || inside;
      continue;
    }
    if (!inside) continue;
    const m = /^\s+(.+?)\s+(\S+)\s*$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) values.set(m[1], m[2]);
  }
  return found ? values : undefined;
}

async function powerChecks(run: CommandRunner, cwd: string): Promise<SystemCheck[]> {
  const sleepBase = { id: 'sleep', group: 'unattended', title: 'Sleep' } as const;
  const r = await run('/usr/bin/pmset', ['-g', 'custom'], { cwd, timeoutMs: 15_000 });
  const mains = r.code === 0 ? pmsetSection(r.stdout, 'AC Power') : undefined;
  if (mains === undefined) return [{ ...sleepBase, state: 'unknown', detail: 'macOS did not report its power settings.' }];
  const hasBattery = pmsetSection(r.stdout, 'Battery Power') !== undefined;
  const settings = hasBattery ? SETTINGS.battery : SETTINGS.energy;
  const where = hasBattery ? 'System Settings, under Battery, Options' : 'System Settings, under Energy';
  const out: SystemCheck[] = [];

  const sleep = mains.get('sleep');
  if (sleep === undefined) out.push({ ...sleepBase, state: 'unknown', detail: 'macOS did not report when the computer goes to sleep.' });
  else if (sleep === '0') out.push({ ...sleepBase, state: 'ok', detail: 'On mains power the computer does not go to sleep by itself.' });
  else {
    out.push({
      ...sleepBase,
      state: 'not_ok',
      detail: `On mains power the computer goes to sleep by itself when nobody uses it (pmset reports sleep = ${sleep}). A sleeping computer runs no mission and answers no message.`,
      fix: `Turn on "Prevent automatic sleeping when the display is off" in ${where}.`,
      command: 'sudo pmset -c sleep 0',
      settings,
    });
  }

  // A computer with a battery has no such setting, so it gets no such check.
  const restart = mains.get('autorestart');
  if (restart !== undefined) {
    const base = { id: 'power-failure', group: 'unattended', title: 'Start after a power cut' } as const;
    if (restart === '1') out.push({ ...base, state: 'ok', detail: 'The computer starts by itself when the power comes back.' });
    else {
      out.push({
        ...base,
        state: 'not_ok',
        detail: 'After a power cut the computer stays off until someone presses its button.',
        fix: `Turn on "Start up automatically after a power failure" in ${where}.`,
        command: 'sudo pmset -a autorestart 1',
        settings,
      });
    }
  }
  return out;
}

async function loginChecks(run: CommandRunner, cwd: string, user: string): Promise<SystemCheck[]> {
  const base = { id: 'auto-login', group: 'unattended', title: 'Automatic login' } as const;
  const r = await run('/usr/bin/defaults', ['read', '/Library/Preferences/com.apple.loginwindow', 'autoLoginUser'], { cwd, timeoutMs: 15_000 });
  const account = r.code === 0 ? r.stdout.trim() : '';
  const missing = r.code !== 0 && /could not find key|does not exist/i.test(`${r.stdout}\n${r.stderr}`);
  if (r.code !== 0 && !missing) return [{ ...base, state: 'unknown', detail: 'macOS did not say whether automatic login is on.' }];

  if (account !== user) {
    const vault = await run('/usr/bin/fdesetup', ['status'], { cwd, timeoutMs: 15_000 });
    const vaultOn = vault.code === 0 && /FileVault is On/i.test(vault.stdout);
    return [
      {
        ...base,
        state: 'not_ok',
        detail:
          (account === '' ? 'Automatic login is off.' : `Automatic login is on for another account, ${account}.`) +
          ' The service starts at login, so after a restart the agent stays stopped until you log in.',
        fix:
          'Choose your account at "Automatically log in as" in System Settings, under Users & Groups.' +
          (vaultOn
            ? ' macOS offers this only with FileVault off, and FileVault is on. With FileVault off, the disk is not encrypted. Decide which of the two matters more for this computer.'
            : ''),
        settings: SETTINGS.users,
      },
    ];
  }

  const out: SystemCheck[] = [{ ...base, state: 'ok', detail: 'macOS logs in to your account by itself after a restart.' }];
  // With automatic login, the session is open to anyone at the computer, so the screen lock matters.
  const lockBase = { id: 'screen-lock', group: 'unattended', title: 'Screen lock' } as const;
  const lock = await run('/usr/sbin/sysadminctl', ['-screenLock', 'status'], { cwd, timeoutMs: 15_000 });
  const delay = /screenLock delay is (immediate|off|\d+ seconds?)/i.exec(`${lock.stdout}\n${lock.stderr}`)?.[1]?.toLowerCase();
  if (delay === undefined) out.push({ ...lockBase, state: 'unknown', detail: 'macOS did not say when the screen locks.' });
  else if (delay === 'immediate') out.push({ ...lockBase, state: 'ok', detail: 'The screen asks for the password as soon as it turns off.' });
  else {
    out.push({
      ...lockBase,
      state: 'not_ok',
      detail:
        (delay === 'off' ? 'The screen never asks for the password.' : `The screen asks for the password only ${delay} after it turns off.`) +
        ' With automatic login, anyone at the computer reaches your session.',
      fix: 'Set "Require password after screen saver begins or display is turned off" to "Immediately" in System Settings, under Lock Screen.',
      settings: SETTINGS.lockScreen,
    });
  }
  return out;
}

// ---------------------------------------------------------------- all checks

/** Runs every check. A check that fails to run becomes one with the state `unknown`. */
export async function runSystemChecks(deps: SystemCheckDeps): Promise<SystemCheck[]> {
  const run = deps.run ?? execCommand;
  const home = deps.home ?? homedir();
  const user = deps.user ?? userInfo().username;
  // The commands need a folder that exists, and the root folder may not exist yet.
  const cwd = home;

  const status = await (deps.readService ?? (() => serviceStatus(deps.service)))().catch((err: unknown) => new Error(errorText(err)));
  const session = await (deps.readSession ?? (() => sessionState(deps.service)))().catch(() => undefined);

  const guarded = async (id: string, group: CheckGroup, title: string, check: () => Promise<SystemCheck[]> | SystemCheck[]): Promise<SystemCheck[]> => {
    try {
      return await check();
    } catch (err) {
      return [{ id, group, title, state: 'unknown', detail: `The check could not run: ${errorText(err)}` }];
    }
  };

  const groups = await Promise.all([
    guarded('root-folder', 'needed', 'Root folder', () => [rootFolderCheck(deps, home)]),
    guarded('keychain', 'needed', 'Keychain', async () => [await keychainCheck(deps)]),
    guarded('git', 'needed', 'git', async () => [await gitCheck(run, cwd)]),
    guarded('service', 'needed', 'Service', () => [serviceCheck(deps, status, session)]),
    guarded('launchd', 'needed', 'Restart after a crash', () => [launchdCheck(session)]),
    guarded('auto-login', 'unattended', 'Automatic login', () => loginChecks(run, cwd, user)),
    guarded('sleep', 'unattended', 'Sleep', () => powerChecks(run, cwd)),
  ]);
  return groups.flat();
}

/** The checks that are not ok, of the needed group, and of the unattended group when it is wanted. */
export function openChecks(checks: SystemCheck[], unattended: boolean): SystemCheck[] {
  return checks.filter((c) => c.state === 'not_ok' && (c.group === 'needed' || unattended));
}

export const GROUP_TITLES: Record<CheckGroup, string> = {
  needed: 'What every agent needs',
  unattended: 'What a computer needs to run the agent with nobody at it',
};
