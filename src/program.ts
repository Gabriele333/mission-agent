import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The installed program, as opposed to the agent's root folder (chapter 7).
 * The program folder holds `package.json`, the built `dist/` and the mission library.
 */

/** The program folder: the parent of the folder that holds this module (`dist/` or `src/`). */
export function programDir(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** The version number of the program, from `package.json`. Undefined when the file cannot be read. */
export function programVersion(dir: string = programDir()): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** The mission library that comes with the program. The harness only reads it. */
export function libraryDir(dir: string = programDir()): string {
  return join(dir, 'mission-library');
}
