import { mkdir, open, realpath, stat } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';

/**
 * Bots can download files of up to 20 MB (`getFile`). The surface refuses a larger file before
 * it downloads anything. 20 MB is read as 20 * 1000 * 1000 bytes, the lower of the two readings.
 */
export const MAX_DOWNLOAD_BYTES = 20_000_000;
/** Bots can send files of up to 50 MB (`sendDocument`), read the same way. */
export const MAX_UPLOAD_BYTES = 50_000_000;

/** Longest file name in bytes. APFS allows 255; this leaves room for the number added on a clash. */
const MAX_NAME_BYTES = 150;
const MAX_EXT_CHARS = 16;

/**
 * A file name that is safe to create inside a folder: no path separator, no control character,
 * no leading dot, no invisible character that changes the text direction, and at most 150 bytes.
 * Returns `fallback` when nothing is left.
 */
export function safeFileName(raw: string | undefined, fallback = 'file'): string {
  let name = (raw ?? '').normalize('NFC');
  // Characters that reverse the text direction can hide the real extension.
  name = name.replace(/[‎‏‪-‮⁦-⁩]/g, '');
  name = name.replace(/[/\\:\u0000-\u001f\u007f]/g, '_');
  name = name.trim().replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (name === '') name = fallback;

  let ext = extname(name);
  if (ext.length > MAX_EXT_CHARS || ext === name) ext = '';
  let stem = name.slice(0, name.length - ext.length);
  while (Buffer.byteLength(stem + ext) > MAX_NAME_BYTES && stem.length > 0) {
    stem = Array.from(stem).slice(0, -1).join('');
  }
  if (stem.trim() === '') stem = fallback;
  return stem + ext;
}

/**
 * Writes the bytes into `dir` under `name`, or under `name-1`, `name-2` and so on when the name is
 * taken. The file is created with the exclusive flag, so an existing file or link is never replaced
 * or followed. Returns the absolute path.
 */
export async function writeUniqueFile(dir: string, name: string, data: Uint8Array): Promise<string> {
  await mkdir(dir, { recursive: true });
  const ext = extname(name);
  const stem = ext === name ? name : name.slice(0, name.length - ext.length);
  for (let n = 0; n < 10_000; n++) {
    const candidate = join(dir, n === 0 ? name : `${stem}-${n}${ext}`);
    let handle;
    try {
      handle = await open(candidate, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    return candidate;
  }
  throw new Error(`No free file name for ${name} in ${dir}.`);
}

/**
 * Checks that a file to send lies inside the folder, after links are resolved, and is not too
 * large. Returns its resolved path. Throws a plain error otherwise.
 */
export async function checkOutgoingFile(filePath: string, dir: string): Promise<string> {
  let real: string;
  let realDir: string;
  try {
    real = await realpath(filePath);
    realDir = await realpath(dir);
  } catch {
    throw new Error(`The file ${filePath} does not exist.`);
  }
  if (!real.startsWith(realDir + sep)) {
    throw new Error(`The file ${filePath} is not inside the mission's data folder, so it was not sent.`);
  }
  const info = await stat(real);
  if (!info.isFile()) throw new Error(`${filePath} is not a file.`);
  if (info.size > MAX_UPLOAD_BYTES) {
    throw new Error(`The file ${filePath} is larger than 50 MB, the limit for a bot, so it was not sent.`);
  }
  return real;
}
