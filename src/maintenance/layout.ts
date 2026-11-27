import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * The folders and files of an installation (chapter 7.2). They are all in one home folder,
 * `~/.mission-agent` by default. This module uses only builtins of Node.js, because the
 * maintenance program imports it (chapter 7.5).
 */

export const DEFAULT_REPO = 'https://github.com/Gabriele333/mission-agent.git';
export const DEFAULT_KEYCHAIN_SERVICE = 'mission-agent';

export interface Layout {
  home: string;
  /** The program: a git clone at a release tag, built. */
  app: string;
  /** A release that is being fetched and built. */
  installing: string;
  /** The program that `app` replaced in the last update. */
  previous: string;
  /** A program that repair moved aside, removed once its replacement is in place. */
  broken: string;
  /** The maintenance program: the release's `package.json` and its built `dist/`. */
  maintenance: string;
  /** A new copy of the maintenance program while it is written. */
  maintenanceNext: string;
  /** The copy that a new one replaced, removed at once. */
  maintenanceOld: string;
  /** The entry of the maintenance program. */
  maintenanceMain: string;
  bin: string;
  /** The command file, `bin/mission-agent`. */
  command: string;
  /** What is installed: `install.json`. */
  installInfo: string;
  /** The journal of the operation in progress: `maintenance.json`. */
  journal: string;
  /** One maintenance run at a time: `maintenance.lock`. */
  lock: string;
  /** What git and npm printed, and each step: `maintenance.log`. */
  log: string;
  /** Where the progress page of the maintenance program answers: `maintenance.server`. */
  server: string;
  /** The log of the install script of releases before 0.2.0. */
  oldLog: string;
}

/** The program folders that may be removed. Nothing else in the home folder is ever removed by a program. */
export const PROGRAM_FOLDERS = ['app', 'app.installing', 'app.previous', 'app.broken', 'maintenance', 'maintenance.installing', 'maintenance.old'] as const;

export function layoutFor(home: string): Layout {
  const h = resolve(home);
  const maintenance = join(h, 'maintenance');
  return {
    home: h,
    app: join(h, 'app'),
    installing: join(h, 'app.installing'),
    previous: join(h, 'app.previous'),
    broken: join(h, 'app.broken'),
    maintenance,
    maintenanceNext: join(h, 'maintenance.installing'),
    maintenanceOld: join(h, 'maintenance.old'),
    maintenanceMain: join(maintenance, 'dist', 'maintenance', 'main.js'),
    bin: join(h, 'bin'),
    command: join(h, 'bin', 'mission-agent'),
    installInfo: join(h, 'install.json'),
    journal: join(h, 'maintenance.json'),
    lock: join(h, 'maintenance.lock'),
    log: join(h, 'maintenance.log'),
    server: join(h, 'maintenance.server'),
    oldLog: join(h, 'install.log'),
  };
}

/** The home folder: `MISSION_AGENT_HOME`, else `~/.mission-agent`. A relative path starts at the current folder. */
export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  const given = env.MISSION_AGENT_HOME;
  if (given === undefined || given === '') return join(homedir(), '.mission-agent');
  return isAbsolute(given) ? given : resolve(given);
}

/** The reason why a home folder cannot be used, or undefined. The command file quotes the path, so a few characters cannot be in it. */
export function homeProblem(home: string): string | undefined {
  if (!isAbsolute(home) || resolve(home) === '/') return `The program folder "${home}" must be an absolute path other than /.`;
  if (/["$`\\\n]/.test(home)) return `The folder ${home} holds a character that the command file cannot quote.`;
  return undefined;
}

/**
 * The home folder of an installed program: the parent of `<home>/app`. Undefined for any other
 * folder, such as a development copy. A home folder holds `install.json` or the command file.
 */
export function homeOfProgram(programDir: string): string | undefined {
  const dir = resolve(programDir);
  if (basename(dir) !== 'app') return undefined;
  const home = dirname(dir);
  if (existsSync(join(home, 'install.json')) || existsSync(join(home, 'bin', 'mission-agent'))) return home;
  return undefined;
}
