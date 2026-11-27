import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Paths } from '../paths.js';

/**
 * The copies of the root folder that an update makes (chapter 7.4). The update itself is in the
 * maintenance program (`src/maintenance/update.ts`), which imports this module, so it uses only
 * builtins of Node.js.
 */

/** How many copies of the root folder the update keeps (placeholder, chapter 7.4). */
export const UPDATE_COPIES_KEPT = 2;
const COPY_NAME_RE = /-(\d{4}-\d{2}-\d{2}-\d{6})$/;

function stamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** The folder that holds the copies of the root folder: `backups/update/`. */
export function updateCopiesDir(paths: Pick<Paths, 'backupsDir'>): string {
  return join(paths.backupsDir, 'update');
}

/**
 * Copies the root folder to `backups/update/<old version>-<date>/`, without `backups/` itself.
 * Returns the copy's folder, or undefined when the root folder does not exist.
 */
export function copyRootFolder(paths: Pick<Paths, 'root' | 'backupsDir'>, oldVersion: string, now: Date): string | undefined {
  if (!existsSync(paths.root)) return undefined;
  const dest = join(updateCopiesDir(paths), `${oldVersion}-${stamp(now)}`);
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  try {
    for (const entry of readdirSync(paths.root)) {
      if (join(paths.root, entry) === paths.backupsDir) continue;
      cpSync(join(paths.root, entry), join(dest, entry), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    }
  } catch (err) {
    rmSync(dest, { recursive: true, force: true });
    throw err;
  }
  return dest;
}

/** Removes the oldest copies, so that `keep` copies are left. */
export function pruneRootCopies(paths: Pick<Paths, 'backupsDir'>, keep: number = UPDATE_COPIES_KEPT): void {
  const dir = updateCopiesDir(paths);
  if (!existsSync(dir)) return;
  const copies = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && COPY_NAME_RE.test(e.name))
    .map((e) => ({ name: e.name, at: (COPY_NAME_RE.exec(e.name) as RegExpExecArray)[1] as string }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const old of copies.slice(0, Math.max(0, copies.length - keep))) {
    rmSync(join(dir, old.name), { recursive: true, force: true });
  }
}

/** Puts a copy back: everything in the root folder except `backups/` is replaced by the copy. */
export function restoreRootFolder(paths: Pick<Paths, 'root' | 'backupsDir'>, copyDir: string): void {
  for (const entry of readdirSync(paths.root)) {
    if (join(paths.root, entry) === paths.backupsDir) continue;
    rmSync(join(paths.root, entry), { recursive: true, force: true });
  }
  for (const entry of readdirSync(copyDir)) {
    cpSync(join(copyDir, entry), join(paths.root, entry), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  }
}
