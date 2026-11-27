import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyMaintenance, hasMaintenanceProgram, maintenanceMatches, readInstallInfo, writeCommandFile, writeInstallInfo } from './files.js';
import { lockHolder } from './journal.js';
import { DEFAULT_REPO, homeOfProgram, layoutFor } from './layout.js';

/**
 * The self-heal of an installed program (chapter 7.5). An agent installed before the maintenance
 * program existed has a command file that sends every command to the program, and no copy of the
 * maintenance program. At each start of the harness, and before it forwards `update`, `repair` or
 * `uninstall`, the program writes both when they are missing or of another version. It does
 * nothing for a development copy, and nothing while a maintenance run holds the lock.
 */

export interface HealResult {
  /** The home folder, or undefined for a program that is not installed in `<home>/app`. */
  home?: string;
  /** What was written, in words. */
  changed: string[];
  /** Why nothing was done, when a maintenance run is in progress. */
  skipped?: string;
}

/** The URL of `origin` in the git configuration of a clone, read without running git. */
function originOfConfig(programDir: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(programDir, '.git', 'config'), 'utf8');
  } catch {
    return undefined;
  }
  const section = /\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/.exec(text)?.[1];
  return section === undefined ? undefined : /^\s*url\s*=\s*(.+?)\s*$/m.exec(section)?.[1];
}

export function selfHeal(programDir: string, version: string | undefined, home: string | undefined = homeOfProgram(programDir)): HealResult {
  if (home === undefined) return { changed: [] };
  const layout = layoutFor(home);
  const busy = lockHolder(layout);
  if (busy !== undefined && busy !== process.pid) return { home, changed: [], skipped: `a run of the maintenance program is in progress (process ${busy})` };
  const changed: string[] = [];
  if (version !== undefined && hasMaintenanceProgram(programDir) && !maintenanceMatches(layout, version)) {
    copyMaintenance(layout, programDir);
    changed.push(`the maintenance program of version ${version} in ${layout.maintenance}`);
  }
  if (writeCommandFile(layout)) changed.push(`the command ${layout.command}`);
  const info = readInstallInfo(layout);
  if (version !== undefined && info?.version !== version) {
    writeInstallInfo(layout, {
      repo: info?.repo ?? originOfConfig(programDir) ?? DEFAULT_REPO,
      version,
      installedAt: info?.installedAt || new Date().toISOString(),
      ...(info?.link !== undefined ? { link: info.link } : {}),
    });
    changed.push(`${layout.installInfo}`);
  }
  return { home, changed };
}
