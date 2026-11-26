import { StringDecoder } from 'node:string_decoder';
import type { SecretStore } from '../types.js';
import { assertCredentialId } from './ids.js';

/** What the `secret` commands need from the terminal (§A.5 "How the user enters a value"). */
export interface SecretIo {
  /** Asks a question and reads one line without showing what the user types. */
  promptHidden(question: string): Promise<string>;
  print(line: string): void;
}

/**
 * `secret set <id>`: asks for the value with hidden input and stores it.
 * It replaces a value that exists. It refuses an empty value.
 */
export async function secretSet(store: SecretStore, id: string, io: SecretIo): Promise<void> {
  assertCredentialId(id);
  // Checked before the prompt, so a Keychain error shows before the user types a value.
  const existed = await store.has(id);
  const value = await io.promptHidden(`Value for ${id}: `);
  if (value.trim() === '') throw new Error(`The value is empty. Nothing was stored for ${id}.`);
  await store.set(id, value);
  io.print(existed ? `Replaced the value of ${id}.` : `Stored a value for ${id}.`);
}

/** `secret delete <id>`: removes the value. */
export async function secretDelete(store: SecretStore, id: string, io: SecretIo): Promise<void> {
  assertCredentialId(id);
  const deleted = await store.delete(id);
  io.print(deleted ? `Deleted the value of ${id}.` : `${id} has no value. Nothing was deleted.`);
}

/**
 * `secret list`: prints each required id and whether a value is present. It never prints a value.
 * Returns the ids that have no value, so the caller can set the exit code.
 */
export async function secretList(store: SecretStore, requiredIds: string[], io: SecretIo): Promise<string[]> {
  const ids = [...new Set(requiredIds)];
  if (ids.length === 0) {
    io.print('No credential is required.');
    return [];
  }
  const width = Math.max(...ids.map((id) => id.length));
  const missing: string[] = [];
  for (const id of ids) {
    const present = await store.has(id);
    if (!present) missing.push(id);
    io.print(`${id.padEnd(width)}  ${present ? 'present' : 'missing'}`);
  }
  return missing;
}

/** A readable stream that may be a terminal, as `process.stdin` is. */
export interface TerminalInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
}

export interface TerminalStreams {
  input: TerminalInput;
  /** Where `print` writes. */
  output: NodeJS.WritableStream;
  /** Where questions are written, so that `output` holds only results. */
  prompt: NodeJS.WritableStream;
}

/**
 * The real `io` for a terminal. On a terminal it reads with no echo.
 * When standard input is not a terminal, it reads one line from it.
 */
export function terminalIo(streams?: Partial<TerminalStreams>): SecretIo {
  const input = streams?.input ?? (process.stdin as TerminalInput);
  const output = streams?.output ?? process.stdout;
  const prompt = streams?.prompt ?? process.stderr;
  return {
    promptHidden(question) {
      if (input.isTTY && typeof input.setRawMode === 'function') return readHidden(input, prompt, question);
      return readLine(input);
    },
    print(line) {
      output.write(`${line}\n`);
    },
  };
}

function readHidden(input: TerminalInput, prompt: NodeJS.WritableStream, question: string): Promise<string> {
  prompt.write(question);
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    const wasRaw = input.isRaw ?? false;
    let value = '';

    const finish = (error?: Error) => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.setRawMode?.(wasRaw);
      input.pause();
      // The user's Enter key was not echoed, so end the prompt line here.
      prompt.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onEnd = () => finish();
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      // Arrow keys and other special keys send an escape sequence. It is not part of a value.
      if (text.startsWith('\u001b')) return;
      for (const ch of text) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish();
        if (ch === '\u0003') return finish(new Error('Cancelled. Nothing was stored.'));
        if (ch === '\u007f' || ch === '\b') {
          value = Array.from(value).slice(0, -1).join('');
          continue;
        }
        if (ch < ' ') continue;
        value += ch;
      }
    };

    input.setRawMode?.(true);
    input.on('data', onData);
    input.on('end', onEnd);
    input.resume();
  });
}

function readLine(input: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let buffer = '';

    const cleanup = () => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      input.pause();
    };
    const done = (line: string) => {
      cleanup();
      resolve(line.endsWith('\r') ? line.slice(0, -1) : line);
    };
    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      const newline = buffer.indexOf('\n');
      if (newline !== -1) done(buffer.slice(0, newline));
    };
    const onEnd = () => done(buffer + decoder.end());
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
    input.resume();
  });
}
