import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

/** The size limits of §C for files in a mission's `memory/` folder, checked by the gate (§E.2.1). */

export interface MemoryLimits {
  maxNoteBytes: number;
  maxIndexLineChars: number;
}

export type MemoryFileKind = 'index' | 'note' | 'index-or-note';

/**
 * `MEMORY.md` directly in `memory/` is the index. A name that differs from it only by case
 * is the index on a case-insensitive file system and a note on another one, so both limits apply.
 */
export function memoryFileKind(realPath: string, memoryDir: string): MemoryFileKind {
  if (dirname(realPath) !== memoryDir) return 'note';
  const name = basename(realPath);
  if (name === 'MEMORY.md') return 'index';
  if (name.toLowerCase() === 'memory.md') return 'index-or-note';
  return 'note';
}

/** Returns a message for the model when the content breaks a limit, or null when it fits. */
export function checkMemoryContent(
  content: string,
  kind: MemoryFileKind,
  limits: MemoryLimits,
  displayPath: string,
): string | null {
  if (kind !== 'index') {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > limits.maxNoteBytes) {
      return (
        `Writing "${displayPath}" is refused: a note file can hold at most ${limits.maxNoteBytes} bytes, ` +
        `and this one would hold ${bytes} bytes. Shorten the note and try again.`
      );
    }
  }
  if (kind !== 'note') {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] as string).replace(/\r$/, '');
      const chars = [...line].length;
      if (chars > limits.maxIndexLineChars) {
        return (
          `Writing "${displayPath}" is refused: a line of the memory index can hold at most ` +
          `${limits.maxIndexLineChars} characters, and line ${i + 1} would hold ${chars} characters. ` +
          `Shorten that line and try again.`
        );
      }
    }
  }
  return null;
}

/**
 * Reads the file and applies the replacement as the Edit tool does.
 * Returns undefined when the file cannot be read, or when the text to replace is not in it
 * (the tool then fails on its own).
 * A missing file with an empty `old_string` gives `new_string`, since the tool then creates the file.
 */
export function contentAfterEdit(
  realPath: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string | undefined {
  let current: string;
  try {
    current = readFileSync(realPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && oldString === '') return newString;
    return undefined;
  }
  return applyReplacement(current, oldString, newString, replaceAll);
}

/**
 * Replaces exact matches. When there is none, it tries again with curly quotes read as straight
 * quotes, because the Edit tool accepts such a match too. Both quote forms are one UTF-16 unit,
 * so the positions found in the normalised text are valid in the original.
 */
export function applyReplacement(
  current: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string | undefined {
  if (oldString === '') return newString + current;
  let found = positions(current, oldString, replaceAll);
  if (found.length === 0) found = positions(straightQuotes(current), straightQuotes(oldString), replaceAll);
  if (found.length === 0) return undefined;
  let out = '';
  let last = 0;
  for (const at of found) {
    out += current.slice(last, at) + newString;
    last = at + oldString.length;
  }
  return out + current.slice(last);
}

function positions(text: string, search: string, all: boolean): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(search, from);
    if (at < 0) return out;
    out.push(at);
    if (!all) return out;
    from = at + search.length;
  }
}

function straightQuotes(s: string): string {
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}
