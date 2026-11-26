import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Paths } from '../paths.js';

/** The content of `state/server` (§J.3). */
export interface ServerInfo {
  port: number;
  token: string;
  pid: number;
  /** ISO time at which the server started. */
  startedAt: string;
}

/**
 * Writes `state/server` with mode 0600. The file is written under a temporary name and then renamed,
 * so an existing file is replaced in one step and a reader never sees half a file.
 */
export function writeServerFile(paths: Pick<Paths, 'stateDir' | 'serverFile'>, info: ServerInfo): void {
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const tmp = `${paths.serverFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(info)}\n`, { mode: 0o600, flag: 'wx' });
    // The umask can only remove bits, so this makes the mode exact.
    chmodSync(tmp, 0o600);
    renameSync(tmp, paths.serverFile);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temporary file was not created.
    }
    throw err;
  }
}

/** Reads `state/server`. Returns undefined when the file is missing or its content is not valid. */
export function readServerFile(paths: Pick<Paths, 'serverFile'>): ServerInfo | undefined {
  let raw: string;
  try {
    raw = readFileSync(paths.serverFile, 'utf8');
  } catch {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const { port, token, pid, startedAt } = v;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (typeof token !== 'string' || token === '') return undefined;
  if (typeof pid !== 'number' || !Number.isInteger(pid)) return undefined;
  return { port, token, pid, startedAt: typeof startedAt === 'string' ? startedAt : '' };
}

/** Removes `state/server`, but only when it still holds this token, so a newer server's file stays. */
export function removeServerFile(paths: Pick<Paths, 'serverFile'>, token: string): void {
  const current = readServerFile(paths);
  if (current !== undefined && current.token !== token) return;
  try {
    unlinkSync(paths.serverFile);
  } catch {
    // Already removed.
  }
}

/** The base address of the server. */
export function serverUrl(info: Pick<ServerInfo, 'port'>): string {
  return `http://127.0.0.1:${info.port}`;
}

/**
 * The address that the `setup` and `dashboard` commands open in the browser (§J.3).
 * The server answers it with the cookie and a redirect to the same path without the token.
 */
export function pageUrl(info: Pick<ServerInfo, 'port' | 'token'>, path = '/'): string {
  const url = new URL(path, serverUrl(info));
  url.searchParams.set('token', info.token);
  return url.toString();
}

/** True when a server answers `GET /api/ping` with this token. */
export async function isServerAlive(
  info: Pick<ServerInfo, 'port' | 'token'>,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl(info)}/api/ping`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 2000),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}
