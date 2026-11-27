import { randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homeProblem, PROGRAM_FOLDERS, type Layout } from './layout.js';

/** Files of the home folder (chapter 7.2). Only builtins of Node.js, because the maintenance program imports it. */

/** An expected refusal or failure of the maintenance program. The message is for the user. */
export class MaintenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaintenanceError';
  }
}

/** Writes a file under a temporary name, then renames it, so a reader never sees half a file. */
export function writeFileAtomic(path: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, text, { mode, flag: 'wx' });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temporary file was not created.
    }
    throw err;
  }
}

export function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** The version in the `package.json` of a program folder, or undefined. */
export function folderVersion(dir: string): string | undefined {
  const parsed = readJsonFile(join(dir, 'package.json'));
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const v = (parsed as Record<string, unknown>).version;
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * Removes one program folder of the home folder, and only that: `app`, `app.installing`,
 * `app.previous`, `app.broken` or a folder of the maintenance program. It refuses anything else.
 */
export function removeProgramFolder(layout: Layout, folder: string): void {
  const problem = homeProblem(layout.home);
  if (problem !== undefined) throw new MaintenanceError(`${problem} Nothing was removed.`);
  const dir = resolve(folder);
  if (dirname(dir) !== layout.home || !(PROGRAM_FOLDERS as readonly string[]).includes(basename(dir))) {
    throw new MaintenanceError(`${folder} is not a folder of the program. Nothing was removed.`);
  }
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- install.json

export interface InstallInfo {
  /** The repository the program was installed from. */
  repo: string;
  /** The installed version, such as `0.2.0`. */
  version: string;
  /** ISO time of the install or of the last update. */
  installedAt: string;
  /** The link to the command in a folder of the PATH, when the install made one. */
  link?: string;
}

export function readInstallInfo(layout: Layout): InstallInfo | undefined {
  const v = readJsonFile(layout.installInfo);
  if (v === null || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.repo !== 'string' || typeof r.version !== 'string') return undefined;
  const info: InstallInfo = { repo: r.repo, version: r.version, installedAt: typeof r.installedAt === 'string' ? r.installedAt : '' };
  if (typeof r.link === 'string' && r.link !== '') info.link = r.link;
  return info;
}

export function writeInstallInfo(layout: Layout, info: InstallInfo): void {
  writeFileAtomic(layout.installInfo, `${JSON.stringify(info, null, 2)}\n`);
}

// ---------------------------------------------------------------- the command file

/** The install script that the messages name when nothing else can help. */
export const INSTALL_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/Gabriele333/mission-agent/main/install.sh | bash';

/**
 * The text of `bin/mission-agent`. It sends `install`, `uninstall`, `update` and `repair` to the
 * maintenance program, and every other command to the program. The home folder must pass `homeProblem`.
 */
export function commandFileText(home: string): string {
  const problem = homeProblem(home);
  if (problem !== undefined) throw new MaintenanceError(problem);
  return `#!/bin/sh
# The mission-agent command. The install writes it, and the maintenance program writes it again.
# install, uninstall, update and repair go to the maintenance program. Every other command goes to the program.
home="${home}"
maintenance="$home/maintenance/dist/maintenance/main.js"
program="$home/app/dist/cli.js"
if ! command -v node >/dev/null 2>&1; then
  echo "mission-agent: Node.js was not found. The agent needs Node.js 24 or later." >&2
  echo "Install it from https://nodejs.org, or with Homebrew: brew install node. Then open a new terminal." >&2
  exit 1
fi
case "\${1:-}" in
  install | uninstall | update | repair)
    if [ -f "$maintenance" ]; then
      exec node "$maintenance" --home "$home" "$@"
    fi
    if [ ! -f "$program" ]; then
      echo "mission-agent: the program and the maintenance program are both missing in $home." >&2
      echo "Run the install script again: ${INSTALL_COMMAND}" >&2
      exit 1
    fi
    ;;
esac
if [ ! -f "$program" ]; then
  echo "mission-agent: the program in $home/app is missing or not built." >&2
  echo "Run: mission-agent repair" >&2
  exit 1
fi
exec node "$program" "$@"
`;
}

/** True when the command file holds exactly the text of this release. */
export function commandFileIsCurrent(layout: Layout): boolean {
  try {
    return readFileSync(layout.command, 'utf8') === commandFileText(layout.home);
  } catch {
    return false;
  }
}

/** Writes the command file in one step. Returns false when it already held this text. */
export function writeCommandFile(layout: Layout): boolean {
  if (commandFileIsCurrent(layout)) return false;
  writeFileAtomic(layout.command, commandFileText(layout.home), 0o755);
  return true;
}

// ---------------------------------------------------------------- the maintenance program

/** True when `maintenance/` holds the maintenance program of this version. */
export function maintenanceMatches(layout: Layout, version: string | undefined): boolean {
  return version !== undefined && existsSync(layout.maintenanceMain) && folderVersion(layout.maintenance) === version;
}

/** True when a program folder holds a maintenance program that can be copied. */
export function hasMaintenanceProgram(programDir: string): boolean {
  return existsSync(join(programDir, 'dist', 'maintenance', 'main.js')) && existsSync(join(programDir, 'package.json'));
}

/**
 * Copies the maintenance program of a program folder to `maintenance/`: its `package.json` and its
 * whole `dist/`, with no `node_modules`. The copy is made beside the old one, then renamed, so
 * `maintenance/` is never a half-written folder. Returns the version that was copied.
 */
export function copyMaintenance(layout: Layout, programDir: string): string {
  if (!hasMaintenanceProgram(programDir)) {
    throw new MaintenanceError(`${programDir} holds no maintenance program, so it cannot be copied.`);
  }
  removeProgramFolder(layout, layout.maintenanceNext);
  mkdirSync(layout.maintenanceNext, { recursive: true });
  cpSync(join(programDir, 'package.json'), join(layout.maintenanceNext, 'package.json'));
  cpSync(join(programDir, 'dist'), join(layout.maintenanceNext, 'dist'), { recursive: true });
  if (existsSync(layout.maintenance)) {
    removeProgramFolder(layout, layout.maintenanceOld);
    renameSync(layout.maintenance, layout.maintenanceOld);
  }
  renameSync(layout.maintenanceNext, layout.maintenance);
  removeProgramFolder(layout, layout.maintenanceOld);
  return folderVersion(layout.maintenance) ?? 'unknown';
}
