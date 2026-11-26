import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { secretDelete, secretList, secretSet, terminalIo, type SecretIo, type TerminalInput } from './commands.js';
import { createMemorySecretStore } from './memory.js';

const KEY = 'credential:model.api_key';
const BOT = 'credential:telegram.bot_token';

function fakeIo(answers: string[] = []): SecretIo & { lines: string[]; questions: string[] } {
  const lines: string[] = [];
  const questions: string[] = [];
  return {
    lines,
    questions,
    async promptHidden(question) {
      questions.push(question);
      return answers.shift() ?? '';
    },
    print(line) {
      lines.push(line);
    },
  };
}

describe('secretSet', () => {
  it('asks for the value with hidden input and stores it', async () => {
    const store = createMemorySecretStore();
    const io = fakeIo(['sk-ant-new-value']);
    await secretSet(store, KEY, io);
    expect(io.questions).toEqual([`Value for ${KEY}: `]);
    expect(await store.get(KEY)).toBe('sk-ant-new-value');
    expect(io.lines).toEqual([`Stored a value for ${KEY}.`]);
  });

  it('replaces a value that exists', async () => {
    const store = createMemorySecretStore({ [KEY]: 'sk-ant-old-value' });
    const io = fakeIo(['sk-ant-new-value']);
    await secretSet(store, KEY, io);
    expect(await store.get(KEY)).toBe('sk-ant-new-value');
    expect(io.lines).toEqual([`Replaced the value of ${KEY}.`]);
  });

  it('refuses an empty value and keeps the old one', async () => {
    const store = createMemorySecretStore({ [KEY]: 'sk-ant-old-value' });
    await expect(secretSet(store, KEY, fakeIo(['']))).rejects.toThrow(/empty/);
    await expect(secretSet(store, KEY, fakeIo(['   ']))).rejects.toThrow(/empty/);
    expect(await store.get(KEY)).toBe('sk-ant-old-value');
  });

  it('refuses an invalid id before asking', async () => {
    const io = fakeIo(['x']);
    await expect(secretSet(createMemorySecretStore(), 'model.api_key', io)).rejects.toThrow(/not valid/);
    expect(io.questions).toEqual([]);
  });

  it('never prints the value', async () => {
    const io = fakeIo(['sk-ant-very-secret']);
    await secretSet(createMemorySecretStore(), KEY, io);
    expect(io.lines.join('\n')).not.toContain('sk-ant-very-secret');
  });
});

describe('secretDelete', () => {
  it('removes the value, and says so when there was none', async () => {
    const store = createMemorySecretStore({ [KEY]: 'sk-ant-old-value' });
    const io = fakeIo();
    await secretDelete(store, KEY, io);
    expect(await store.has(KEY)).toBe(false);
    await secretDelete(store, KEY, io);
    expect(io.lines).toEqual([`Deleted the value of ${KEY}.`, `${KEY} has no value. Nothing was deleted.`]);
  });

  it('refuses an invalid id', async () => {
    await expect(secretDelete(createMemorySecretStore(), 'bad', fakeIo())).rejects.toThrow(/not valid/);
  });
});

describe('secretList', () => {
  it('prints each required id and whether a value is present, never a value', async () => {
    const store = createMemorySecretStore({ [BOT]: 'bot-token-secret' });
    const io = fakeIo();
    const missing = await secretList(store, [KEY, BOT, KEY], io);
    expect(io.lines).toEqual([`${KEY}       missing`, `${BOT}  present`]);
    expect(io.lines.join('\n')).not.toContain('bot-token-secret');
    expect(missing).toEqual([KEY]);
  });

  it('says when no credential is required', async () => {
    const io = fakeIo();
    expect(await secretList(createMemorySecretStore(), [], io)).toEqual([]);
    expect(io.lines).toEqual(['No credential is required.']);
  });
});

describe('terminalIo', () => {
  function sink(): PassThrough & { text(): string } {
    const s = new PassThrough() as PassThrough & { text(): string };
    let data = '';
    s.on('data', (c: Buffer) => (data += c.toString()));
    s.text = () => data;
    return s;
  }

  it('reads one line from standard input when it is not a terminal', async () => {
    const input = new PassThrough();
    const output = sink();
    const prompt = sink();
    const io = terminalIo({ input, output, prompt });
    const answer = io.promptHidden('Value: ');
    input.write('sk-ant-');
    input.write('piped-value\r\nsecond line\n');
    expect(await answer).toBe('sk-ant-piped-value');
    expect(prompt.text()).toBe('');
    io.print('done');
    expect(output.text()).toBe('done\n');
  });

  it('reads the last line when input ends without a newline', async () => {
    const input = new PassThrough();
    const io = terminalIo({ input, output: sink(), prompt: sink() });
    const answer = io.promptHidden('Value: ');
    input.end('no-newline-value');
    expect(await answer).toBe('no-newline-value');
  });

  it('reads with no echo on a terminal and restores the mode', async () => {
    const input = new PassThrough() as PassThrough & TerminalInput;
    const modes: boolean[] = [];
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (mode: boolean) => {
      modes.push(mode);
      input.isRaw = mode;
      return input;
    };
    const prompt = sink();
    const output = sink();
    const io = terminalIo({ input, output, prompt });
    const answer = io.promptHidden('Value: ');
    input.write('sk-anX');
    input.write('\u007f');
    input.write('t-typed');
    input.write('\u001b[A');
    input.write('\r');
    expect(await answer).toBe('sk-ant-typed');
    expect(modes).toEqual([true, false]);
    expect(prompt.text()).toBe('Value: \n');
    expect(output.text()).toBe('');
  });

  it('cancels on Ctrl-C', async () => {
    const input = new PassThrough() as PassThrough & TerminalInput;
    input.isTTY = true;
    input.setRawMode = () => input;
    const io = terminalIo({ input, output: sink(), prompt: sink() });
    const answer = io.promptHidden('Value: ');
    input.write('abc\u0003');
    await expect(answer).rejects.toThrow(/Cancelled/);
  });
});
