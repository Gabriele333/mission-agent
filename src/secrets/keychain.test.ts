import { describe, expect, it } from 'vitest';
import {
  MAX_COMMAND_LINE,
  SECURITY_PATH,
  createKeychainStore,
  parsePasswordLine,
  type SecurityResult,
  type SecurityRunner,
} from './keychain.js';

interface Call {
  file: string;
  args: readonly string[];
  input?: string;
}

function fakeRunner(results: Partial<SecurityResult>[]): { run: SecurityRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: SecurityRunner = async (file, args, input) => {
    calls.push({ file, args, input });
    const r = results.shift() ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { run, calls };
}

const ID = 'credential:model.api_key';
const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex');

describe('createKeychainStore', () => {
  it('sets a value through security -i with the value in hex on standard input', async () => {
    const { run, calls } = fakeRunner([{ code: 0 }]);
    const store = createKeychainStore({ run, platform: 'darwin' });
    const value = 'a b "c" \\d\nnext';
    await store.set(ID, value);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe(SECURITY_PATH);
    expect(calls[0]!.args).toEqual(['-i']);
    expect(calls[0]!.input).toBe(`add-generic-password -U -s mission-agent -a ${ID} -X ${hex(value)}\n`);
    // The value is never an argument.
    expect(calls[0]!.args.join(' ')).not.toContain('a b');
  });

  it('uses the service given in the options', async () => {
    const { run, calls } = fakeRunner([{ code: 0 }, { code: 0 }]);
    const store = createKeychainStore({ service: 'mission-agent-test', run, platform: 'darwin' });
    await store.set(ID, 'value-12345');
    await store.has(ID);
    expect(calls[0]!.input).toContain('-s mission-agent-test -a');
    expect(calls[1]!.args).toEqual(['find-generic-password', '-s', 'mission-agent-test', '-a', ID]);
  });

  it('refuses a service name that could break the command line', () => {
    expect(() => createKeychainStore({ service: 'a b', platform: 'darwin' })).toThrow(/service name/);
  });

  it('refuses an empty value and a value that is too long, without calling security', async () => {
    const { run, calls } = fakeRunner([]);
    const store = createKeychainStore({ run, platform: 'darwin' });
    await expect(store.set(ID, '')).rejects.toThrow(/cannot be empty/);
    const long = 'k'.repeat(MAX_COMMAND_LINE);
    const error = await store.set(ID, long).catch((e: Error) => e);
    expect(String(error)).toMatch(/too long.*at most \d+ bytes/);
    expect(String(error)).not.toContain('kkkkkkkk');
    expect(calls).toHaveLength(0);
  });

  it('accepts the longest value that fits in one command line', async () => {
    const { run, calls } = fakeRunner([{ code: 0 }]);
    const store = createKeychainStore({ run, platform: 'darwin' });
    const prefix = `add-generic-password -U -s mission-agent -a ${ID} -X `;
    const maxBytes = Math.floor((MAX_COMMAND_LINE - prefix.length) / 2);
    await store.set(ID, 'k'.repeat(maxBytes));
    expect(calls[0]!.input!.length - 1).toBeLessThanOrEqual(MAX_COMMAND_LINE);
    await expect(store.set(ID, 'k'.repeat(maxBytes + 1))).rejects.toThrow(`at most ${maxBytes} bytes`);
  });

  it('reports a failed write without the value or its hex form', async () => {
    const value = 'sk-secret-value-123';
    const { run } = fakeRunner([
      { code: 45, stderr: `security: something about ${value} and ${hex(value)}\nadd-generic-password: returned -25299\n` },
    ]);
    const store = createKeychainStore({ run, platform: 'darwin' });
    const error = (await store.set(ID, value).catch((e: Error) => e)) as Error;
    expect(error.message).toContain('Could not write credential:model.api_key');
    expect(error.message).toContain('exit code 45');
    expect(error.message).not.toContain(value);
    expect(error.message).not.toContain(hex(value));
  });

  it('gets a value in text form', async () => {
    const { run, calls } = fakeRunner([{ code: 0, stdout: 'keychain: "x"\n', stderr: 'password: "sk-ant-abc 123"\n' }]);
    const store = createKeychainStore({ run, platform: 'darwin' });
    expect(await store.get(ID)).toBe('sk-ant-abc 123');
    expect(calls[0]!.args).toEqual(['find-generic-password', '-s', 'mission-agent', '-a', ID, '-g']);
    expect(calls[0]!.input).toBeUndefined();
  });

  it('gets a value in hex form', async () => {
    const value = 'a "b" \\c\nhéllo';
    const stderr = `password: 0x${hex(value).toUpperCase()}  "a \\"b\\" ..."\n`;
    const { run } = fakeRunner([{ code: 0, stderr }]);
    const store = createKeychainStore({ run, platform: 'darwin' });
    expect(await store.get(ID)).toBe(value);
  });

  it('returns undefined when the item does not exist (exit code 44)', async () => {
    const { run } = fakeRunner([{ code: 44, stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n' }]);
    const store = createKeychainStore({ run, platform: 'darwin' });
    expect(await store.get(ID)).toBeUndefined();
  });

  it('throws a clear error on another exit code', async () => {
    const { run } = fakeRunner([{ code: 51, stderr: 'security: User interaction is not allowed.\n' }]);
    const store = createKeychainStore({ run, platform: 'darwin' });
    await expect(store.get(ID)).rejects.toThrow(
      'Could not read credential:model.api_key in the Keychain (security exit code 51): security: User interaction is not allowed.',
    );
  });

  it('throws when the output has no password line', async () => {
    const { run } = fakeRunner([{ code: 0, stderr: 'something else\n' }]);
    const store = createKeychainStore({ run, platform: 'darwin' });
    await expect(store.get(ID)).rejects.toThrow(/no password line/);
  });

  it('deletes: true when removed, false when absent, error otherwise', async () => {
    const { run, calls } = fakeRunner([{ code: 0 }, { code: 44 }, { code: 1, stderr: 'bad\n' }]);
    const store = createKeychainStore({ run, platform: 'darwin' });
    expect(await store.delete(ID)).toBe(true);
    expect(await store.delete(ID)).toBe(false);
    await expect(store.delete(ID)).rejects.toThrow('Could not delete credential:model.api_key in the Keychain (security exit code 1): bad');
    expect(calls[0]!.args).toEqual(['delete-generic-password', '-s', 'mission-agent', '-a', ID]);
  });

  it('has: true, false, or error, and never asks for the value', async () => {
    const { run, calls } = fakeRunner([{ code: 0 }, { code: 44 }, { code: 2 }]);
    const store = createKeychainStore({ run, platform: 'darwin' });
    expect(await store.has(ID)).toBe(true);
    expect(await store.has(ID)).toBe(false);
    await expect(store.has(ID)).rejects.toThrow(/exit code 2/);
    expect(calls[0]!.args).not.toContain('-g');
    expect(calls[0]!.args).not.toContain('-w');
  });

  it('validates the credential id before any call', async () => {
    const { run, calls } = fakeRunner([]);
    const store = createKeychainStore({ run, platform: 'darwin' });
    const bad = ['model.api_key', 'credential:Model.api_key', 'credential:model', 'credential:model.api-key', 'credential:a.b.c', 'credential:a.b x'];
    for (const id of bad) {
      await expect(store.get(id)).rejects.toThrow(/not valid/);
      await expect(store.set(id, 'value-123')).rejects.toThrow(/not valid/);
      await expect(store.delete(id)).rejects.toThrow(/not valid/);
      await expect(store.has(id)).rejects.toThrow(/not valid/);
    }
    expect(calls).toHaveLength(0);
  });

  it('does not repeat an invalid id, which could be a value typed in the wrong place', async () => {
    const store = createKeychainStore({ run: fakeRunner([]).run, platform: 'darwin' });
    const error = (await store.get('sk-ant-api03-secret').catch((e: Error) => e)) as Error;
    expect(error.message).not.toContain('sk-ant-api03-secret');
  });

  it('throws on a platform other than macOS for every method', async () => {
    const { run, calls } = fakeRunner([]);
    const store = createKeychainStore({ run, platform: 'linux' });
    const message = /only available on macOS/;
    await expect(store.get(ID)).rejects.toThrow(message);
    await expect(store.set(ID, 'value-123')).rejects.toThrow(message);
    await expect(store.delete(ID)).rejects.toThrow(message);
    await expect(store.has(ID)).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });

  it('passes on an error of the runner itself', async () => {
    const run: SecurityRunner = async () => {
      throw new Error('Could not run /usr/bin/security: ENOENT.');
    };
    const store = createKeychainStore({ run, platform: 'darwin' });
    await expect(store.get(ID)).rejects.toThrow('ENOENT');
  });
});

describe('parsePasswordLine', () => {
  it('reads the text form, the hex form and an empty value', () => {
    expect(parsePasswordLine('keychain: "x"\npassword: "abc"\n')).toBe('abc');
    expect(parsePasswordLine(`password: 0x${hex('x\ty').toUpperCase()}  "x\\011y"\n`)).toBe('x\ty');
    expect(parsePasswordLine('password: \n')).toBe('');
    expect(parsePasswordLine('nothing\n')).toBeUndefined();
  });

  it('keeps a value made of hex digits as text', () => {
    expect(parsePasswordLine('password: "414243"\n')).toBe('414243');
  });
});
