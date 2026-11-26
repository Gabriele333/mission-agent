import { execFile } from 'node:child_process';
import type { SecretStore } from '../types.js';
import { assertCredentialId, assertStorableValue } from './ids.js';

/**
 * The one place that reads and writes the Keychain (§A.5 "How a value is read").
 * Every operation runs the macOS `security` command. The item's service is
 * `mission-agent` and its account is the credential id.
 *
 * How a value reaches `security` on a write:
 * the store runs `security -i`, which reads commands from standard input, and sends one line:
 * `add-generic-password -U -s <service> -a <id> -X <value as hexadecimal>`.
 * The value is never an argument of a process, so it does not appear in the process list.
 * Hexadecimal needs no quoting, so any value works: spaces, quotes, backslashes,
 * newlines and non-ASCII text.
 *
 * Limit: `security -i` reads at most 4,094 characters per line, and splits a longer
 * line into several commands. The store refuses a line longer than MAX_COMMAND_LINE,
 * which allows a value of about 1,900 bytes.
 *
 * How a value is read: `find-generic-password -g` writes `password: "<text>"` to
 * standard error, or `password: 0x<hex>  "<escaped>"` when the value contains a byte that is
 * not printable ASCII, a quote or a backslash. The store parses that line.
 * `-w` is not used: it prints a value made of hex digits the same way as a hex-encoded value.
 */

export const SECURITY_PATH = '/usr/bin/security';
export const DEFAULT_SERVICE = 'mission-agent';

/** Exit code of `security` when the item does not exist. */
export const ITEM_NOT_FOUND = 44;

/** Below the 4,094 characters that `security -i` accepts, to keep a margin. */
export const MAX_COMMAND_LINE = 4000;

const SERVICE_PATTERN = /^[A-Za-z0-9._-]+$/;
const RUN_TIMEOUT_MS = 60_000;

export interface SecurityResult {
  /** The exit code of the command. */
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a program with an argument array and an optional standard input.
 * Resolves with the exit code, also when it is not 0. Rejects only when the program
 * could not run or was stopped.
 */
export type SecurityRunner = (file: string, args: readonly string[], input?: string) => Promise<SecurityResult>;

export interface KeychainStoreOptions {
  service?: string;
  /** Replaces the call to `security`, for tests. */
  run?: SecurityRunner;
  /** Replaces `process.platform`, for tests. */
  platform?: NodeJS.Platform;
}

export class KeychainUnavailableError extends Error {
  constructor(platform: string) {
    super(`The Keychain is only available on macOS. This system is ${platform}.`);
    this.name = 'KeychainUnavailableError';
  }
}

/** The default runner: `child_process.execFile`, never a shell. */
export const execFileRunner: SecurityRunner = (file, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      { encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) return resolve({ code: 0, stdout, stderr });
        if (typeof error.code === 'number') return resolve({ code: error.code, stdout, stderr });
        // error.message is not used: for a failed command it contains the output.
        if (error.killed) return reject(new Error(`${file} was stopped after ${RUN_TIMEOUT_MS / 1000} seconds.`));
        reject(new Error(`Could not run ${file}: ${error.code ?? error.signal ?? 'unknown error'}.`));
      },
    );
    // A write error here means the program exited early. The exit code reports it.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });

export function createKeychainStore(options: KeychainStoreOptions = {}): SecretStore {
  const service = options.service ?? DEFAULT_SERVICE;
  const run = options.run ?? execFileRunner;
  const platform = options.platform ?? process.platform;

  // The service name goes into a command line of `security -i` without quotes.
  if (!SERVICE_PATTERN.test(service)) {
    throw new Error('The Keychain service name may contain only letters, digits, dots, hyphens and underscores.');
  }

  function check(id: string): void {
    if (platform !== 'darwin') throw new KeychainUnavailableError(platform);
    assertCredentialId(id);
  }

  return {
    async get(id) {
      check(id);
      const r = await run(SECURITY_PATH, ['find-generic-password', '-s', service, '-a', id, '-g']);
      if (r.code === ITEM_NOT_FOUND) return undefined;
      if (r.code !== 0) throw failure('read', id, r);
      const value = parsePasswordLine(r.stderr);
      if (value === undefined) throw new Error(`Could not read ${id} from the Keychain: the output of security has no password line.`);
      return value;
    },

    async set(id, value) {
      check(id);
      assertStorableValue(value);
      const hex = Buffer.from(value, 'utf8').toString('hex');
      const line = `add-generic-password -U -s ${service} -a ${id} -X ${hex}`;
      if (line.length > MAX_COMMAND_LINE) {
        const maxBytes = Math.floor((MAX_COMMAND_LINE - (line.length - hex.length)) / 2);
        throw new Error(`The value for ${id} is too long for the Keychain command: at most ${maxBytes} bytes.`);
      }
      const r = await run(SECURITY_PATH, ['-i'], `${line}\n`);
      if (r.code !== 0) throw failure('write', id, r, [hex, value]);
    },

    async delete(id) {
      check(id);
      const r = await run(SECURITY_PATH, ['delete-generic-password', '-s', service, '-a', id]);
      if (r.code === 0) return true;
      if (r.code === ITEM_NOT_FOUND) return false;
      throw failure('delete', id, r);
    },

    async has(id) {
      check(id);
      // Without -g or -w, `security` prints the attributes only, never the value.
      const r = await run(SECURITY_PATH, ['find-generic-password', '-s', service, '-a', id]);
      if (r.code === 0) return true;
      if (r.code === ITEM_NOT_FOUND) return false;
      throw failure('check', id, r);
    },
  };
}

/** Returns the value from the `password:` line that `find-generic-password -g` writes. */
export function parsePasswordLine(stderr: string): string | undefined {
  const line = stderr.split('\n').find((l) => l.startsWith('password:'));
  if (line === undefined) return undefined;
  const rest = line.slice('password:'.length).trimStart();
  if (rest === '') return '';
  const hex = /^0x([0-9A-Fa-f]*)(\s|$)/.exec(rest);
  if (hex) return Buffer.from(hex[1] ?? '', 'hex').toString('utf8');
  // The text form never holds a quote or a backslash: `security` uses hex for those.
  const text = /^"(.*)"$/.exec(rest);
  if (text) return text[1];
  return undefined;
}

/** Builds an error from a failed command. It drops anything that could hold the value. */
function failure(action: string, id: string, r: SecurityResult, secrets: string[] = []): Error {
  let detail = r.stderr
    .split('\n')
    .filter((l) => !l.startsWith('password:'))
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(0, 2)
    .join(' ');
  for (const s of secrets) if (s !== '') detail = detail.split(s).join('[value]');
  // A long run of hex digits could be part of the value.
  detail = detail.replace(/[0-9A-Fa-f]{16,}/g, '[hex]');
  if (detail.length > 300) detail = `${detail.slice(0, 300)}...`;
  const suffix = detail === '' ? '' : `: ${detail}`;
  return new Error(`Could not ${action} ${id} in the Keychain (security exit code ${r.code})${suffix}`);
}
