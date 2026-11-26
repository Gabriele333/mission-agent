import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { tempPaths, waitFor } from '../../server/test-helpers.js';
import { ChatClientError, NOT_RUNNING_TEXT, parseLine, runChatClient } from './client.js';
import { approvalRequest, startHarness, type Harness } from './test-helpers.js';
import type { Paths } from '../../paths.js';
import { mkdirSync, writeFileSync } from 'node:fs';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const LABEL = 'Ada · inbox-curator';

async function harness(paths?: Paths & { remove(): void }): Promise<Harness> {
  const h = await startHarness(paths);
  if (!paths) cleanups.push(() => h.paths.remove());
  cleanups.push(() => h.stop());
  // The fake harness answers every chat message in the label of one mission.
  h.host.onIncoming = (m) => h.surface.send({ missionId: 'm_k7q3zp2xw9ha', label: LABEL, text: `Got: ${m.text}` });
  return h;
}

interface Chat {
  input: PassThrough;
  out(): string;
  type(line: string): void;
  done: Promise<void>;
  /** Waits until the output contains the text the given number of times. */
  waitForText(text: string, times?: number): Promise<void>;
}

function startChat(paths: Paths, extra: { tty?: boolean } = {}): Chat {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (c: Buffer) => (text += c.toString('utf8')));
  if (extra.tty) {
    Object.assign(input, { isTTY: true, isRaw: false, setRawMode: () => input });
    Object.assign(output, { isTTY: true, columns: 80, rows: 24 });
  }
  const done = runChatClient({ paths, input, output, reconnectDelayMs: 20 });
  cleanups.push(async () => {
    input.end();
    await done.catch(() => {});
  });
  const count = (t: string) => text.split(t).length - 1;
  return {
    input,
    out: () => text,
    type: (line) => input.write(`${line}\n`),
    done,
    waitForText: (t, times = 1) => waitFor(() => count(t) >= times, `the output "${t}"`),
  };
}

describe('runChatClient', () => {
  it('says that the harness is not running when there is no server file', async () => {
    const paths = tempPaths();
    cleanups.push(() => paths.remove());
    const output = new PassThrough();
    let text = '';
    output.on('data', (c: Buffer) => (text += c.toString('utf8')));
    const err = await runChatClient({ paths, input: new PassThrough(), output }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatClientError);
    expect((err as ChatClientError).exitCode).toBe(1);
    expect(text).toBe(`${NOT_RUNNING_TEXT}\n`);
    expect(text).toContain('mission-agent start');
  });

  it('says that the harness is not running when the server file is left from a stopped harness', async () => {
    const h = await startHarness();
    cleanups.push(() => h.paths.remove());
    const { port, token } = h;
    await h.stop();
    mkdirSync(h.paths.stateDir, { recursive: true });
    writeFileSync(h.paths.serverFile, JSON.stringify({ port, token, pid: 1, startedAt: '' }), { mode: 0o600 });
    const output = new PassThrough();
    let text = '';
    output.on('data', (c: Buffer) => (text += c.toString('utf8')));
    await expect(runChatClient({ paths: h.paths, input: new PassThrough(), output })).rejects.toThrow(NOT_RUNNING_TEXT);
    expect(text).toBe(`${NOT_RUNNING_TEXT}\n`);
  });

  it('sends lines and commands, and prints each answer with its label on the line before', async () => {
    const h = await harness();
    const chat = startChat(h.paths);
    await chat.waitForText('Connected to the harness.');
    chat.type('hello');
    await chat.waitForText('Got: hello');
    expect(chat.out()).toContain(`${LABEL}\nGot: hello\n`);
    chat.type('/mission inbox-curator');
    chat.type('   ');
    await chat.waitForText('Got: /mission inbox-curator');
    expect(h.host.incomingCalls).toEqual([
      { surface: 'surface:terminal', text: 'hello' },
      { surface: 'surface:terminal', text: '/mission inbox-curator' },
    ]);
    chat.input.end();
    await chat.done;
  });

  it('sends lines in the order they were typed', async () => {
    const h = await harness();
    const chat = startChat(h.paths);
    await chat.waitForText('Connected to the harness.');
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    chat.input.write(lines.map((l) => `${l}\n`).join(''));
    await waitFor(() => h.host.incomingCalls.length === 20, 'twenty messages');
    expect(h.host.incomingCalls.map((m) => m.text)).toEqual(lines);
  });

  it('sends a line typed just before the end of input', async () => {
    const h = await harness();
    const chat = startChat(h.paths);
    await chat.waitForText('Connected to the harness.');
    chat.input.end('last words\n');
    await chat.done;
    expect(h.host.incomingCalls).toEqual([{ surface: 'surface:terminal', text: 'last words' }]);
  });

  it('prints notices and the messages kept while no chat was open', async () => {
    const h = await harness();
    await h.surface.send({ missionId: 'm_k7q3zp2xw9ha', label: LABEL, text: 'Sent at night.' });
    const chat = startChat(h.paths);
    await chat.waitForText('Sent at night.');
    expect(chat.out()).toContain(`Messages sent while no chat was open:\n\n${LABEL}\nSent at night.\n`);
    h.surface.notice('Mission inbox-curator was frozen.');
    await chat.waitForText('Mission inbox-curator was frozen.');
  });

  it('sends approve and reject as chat text when no request waits', async () => {
    const h = await harness();
    const chat = startChat(h.paths);
    await chat.waitForText('Connected to the harness.');
    chat.type('approve');
    chat.type('reject this idea');
    await chat.waitForText('Got: reject this idea');
    expect(h.host.incomingCalls.map((m) => m.text)).toEqual(['approve', 'reject this idea']);
    expect(h.host.answers).toEqual([]);
  });

  it('answers one waiting request with approve, a, reject and r, with and without a reason', async () => {
    const h = await harness();
    const chat = startChat(h.paths);
    await chat.waitForText('Connected to the harness.');

    const cases: Array<[string, unknown, string]> = [
      ['approve', { kind: 'approved' }, 'approved'],
      ['a', { kind: 'approved' }, 'approved'],
      ['reject the first paragraph is too long', { kind: 'rejected', reason: 'the first paragraph is too long' }, 'rejected: the first paragraph is too long'],
      ['r', { kind: 'rejected' }, 'rejected'],
      ['R 3 paragraphs are too many', { kind: 'rejected', reason: '3 paragraphs are too many' }, 'rejected: 3 paragraphs are too many'],
    ];
    for (const [i, [line, answer, outcome]] of cases.entries()) {
      const id = `apr_${i}`;
      h.host.waitingIds.add(id);
      await h.surface.showApproval(approvalRequest(id), LABEL);
      await chat.waitForText(`Approval request 1 · ${LABEL}`, i + 1);
      chat.type(line);
      await waitFor(() => h.host.answers.length === i + 1, 'the answer');
      expect(h.host.answers.at(-1)).toEqual({ id, answer });
      const seen = cases.slice(0, i + 1).filter((c) => c[2] === outcome).length;
      await chat.waitForText(`Approval request 1 is closed: ${outcome}.`, seen);
    }
    expect(chat.out()).toContain('Mission: inbox-curator\nAction: action:email.send');
    expect(chat.out()).toContain('Answer with "approve" or "reject <reason>". The reason is optional.');
    expect(h.host.incomingCalls).toEqual([]);
  });

  it('uses short numbers when several requests wait', async () => {
    const h = await harness();
    const chat = startChat(h.paths);
    await chat.waitForText('Connected to the harness.');
    for (const id of ['apr_a', 'apr_b', 'apr_c']) {
      h.host.waitingIds.add(id);
      await h.surface.showApproval(approvalRequest(id), LABEL);
    }
    await chat.waitForText(`Approval request 3 · ${LABEL}`);
    expect(chat.out()).toContain('Answer with "approve 2" or "reject 2 <reason>". The reason is optional.');

    chat.type('approve');
    await chat.waitForText('Several approval requests are waiting. Add the number, for example: approve 1');
    chat.type('r too long');
    await chat.waitForText('Several approval requests are waiting. Add the number, for example: reject 1 <reason>');
    chat.type('approve 7');
    await chat.waitForText('No approval request number 7 is waiting.');
    expect(h.host.answers).toEqual([]);

    chat.type('approve 2');
    await chat.waitForText('Approval request 2 is closed: approved.');
    chat.type('reject 1 too long');
    await chat.waitForText('Approval request 1 is closed: rejected: too long.');
    expect(h.host.answers).toEqual([
      { id: 'apr_b', answer: { kind: 'approved' } },
      { id: 'apr_a', answer: { kind: 'rejected', reason: 'too long' } },
    ]);

    // One request is left, so the number is optional again.
    chat.type('a');
    await chat.waitForText('Approval request 3 is closed: approved.');
    expect(h.host.answers.at(-1)).toEqual({ id: 'apr_c', answer: { kind: 'approved' } });
    expect(h.host.incomingCalls).toEqual([]);
  });

  it('never gives a number to a new request while another request waits', async () => {
    const h = await harness();
    const chat = startChat(h.paths);
    await chat.waitForText('Connected to the harness.');
    for (const id of ['apr_a', 'apr_b']) {
      h.host.waitingIds.add(id);
      await h.surface.showApproval(approvalRequest(id), LABEL);
    }
    await chat.waitForText(`Approval request 2 · ${LABEL}`);
    chat.type('approve 1');
    await chat.waitForText('Approval request 1 is closed: approved.');

    // apr_b still waits as number 2, so the new request gets 3, not the free number 1.
    h.host.waitingIds.add('apr_c');
    await h.surface.showApproval(approvalRequest('apr_c'), LABEL);
    await chat.waitForText(`Approval request 3 · ${LABEL}`);
    expect(chat.out().split(`Approval request 1 · ${LABEL}`)).toHaveLength(2);
    chat.type('approve 1');
    await chat.waitForText('No approval request number 1 is waiting.');
    expect(h.host.answers).toEqual([{ id: 'apr_a', answer: { kind: 'approved' } }]);
    chat.type('approve 3');
    await chat.waitForText('Approval request 3 is closed: approved.');
    expect(h.host.answers.at(-1)).toEqual({ id: 'apr_c', answer: { kind: 'approved' } });
    chat.type('approve');
    await chat.waitForText('Approval request 2 is closed: approved.');
    expect(h.host.answers.at(-1)).toEqual({ id: 'apr_b', answer: { kind: 'approved' } });

    // With no request waiting, the numbers start at 1 again.
    h.host.waitingIds.add('apr_d');
    await h.surface.showApproval(approvalRequest('apr_d'), LABEL);
    await chat.waitForText(`Approval request 1 · ${LABEL}`, 2);
  });

  it('says so when the request no longer waits', async () => {
    const h = await harness();
    const chat = startChat(h.paths);
    await chat.waitForText('Connected to the harness.');
    // Not in waitingIds: the host answers false, as for a request that just timed out.
    await h.surface.showApproval(approvalRequest('apr_gone'), LABEL);
    await chat.waitForText('Approval request 1 ·');
    chat.type('approve');
    await chat.waitForText('Approval request 1 is no longer waiting. The answer changed nothing.');
  });

  it('shows the requests that still wait when the chat opens', async () => {
    const h = await harness();
    h.host.waitingIds.add('apr_1');
    await h.surface.showApproval(approvalRequest('apr_1'), LABEL);
    const chat = startChat(h.paths);
    await chat.waitForText(`Approval request 1 · ${LABEL}`);
    chat.type('approve');
    await chat.waitForText('Approval request 1 is closed: approved.');
  });

  it('connects again after the harness restarts, and says once that the connection was lost', async () => {
    const paths = tempPaths();
    cleanups.push(() => paths.remove());
    const first = await harness(paths);
    const chat = startChat(paths);
    await chat.waitForText('Connected to the harness.');

    await first.stop();
    await chat.waitForText('The connection to the harness was lost. Trying to connect again.');
    // Several attempts fail while no harness runs.
    await new Promise((r) => setTimeout(r, 150));
    chat.type('lost line');
    await chat.waitForText('The message was not sent: the harness is not answering.');

    const second = await harness(paths);
    expect(second.port).not.toBe(first.port);
    second.host.waitingIds.add('apr_new');
    await second.surface.showApproval(approvalRequest('apr_new'), LABEL);
    await chat.waitForText('Connected to the harness again.');
    await chat.waitForText(`Approval request 1 · ${LABEL}`);
    chat.type('hello again');
    await chat.waitForText('Got: hello again');
    expect(second.host.incomingCalls).toEqual([{ surface: 'surface:terminal', text: 'hello again' }]);

    const lost = chat.out().split('The connection to the harness was lost.').length - 1;
    expect(lost).toBe(1);
    expect(chat.out()).toContain('The harness is stopping.');
  });

  it('ends without an error on Ctrl+C in a terminal', async () => {
    const h = await harness();
    const chat = startChat(h.paths, { tty: true });
    await chat.waitForText('Connected to the harness.');
    chat.input.write('\x03');
    await expect(chat.done).resolves.toBeUndefined();
  });
});

describe('parseLine', () => {
  it('treats every line as chat when no request waits', () => {
    expect(parseLine('approve', [])).toEqual({ kind: 'chat' });
    expect(parseLine('r too long', [])).toEqual({ kind: 'chat' });
  });

  it('does not take a sentence that starts with "a" as an approval', () => {
    expect(parseLine('a few thoughts', [1])).toEqual({ kind: 'chat' });
    expect(parseLine('approve it please', [1])).toEqual({ kind: 'chat' });
    expect(parseLine('approved', [1])).toEqual({ kind: 'chat' });
    expect(parseLine('rejection', [1])).toEqual({ kind: 'chat' });
  });

  it('reads the number and the reason', () => {
    expect(parseLine('APPROVE', [1])).toEqual({ kind: 'answer', number: 1, decision: 'approve' });
    expect(parseLine('approve 2', [1, 2])).toEqual({ kind: 'answer', number: 2, decision: 'approve' });
    expect(parseLine('a 1', [1])).toEqual({ kind: 'answer', number: 1, decision: 'approve' });
    expect(parseLine('reject 2 too long', [1, 2])).toEqual({
      kind: 'answer',
      number: 2,
      decision: 'reject',
      reason: 'too long',
    });
    expect(parseLine('r 2', [1, 2])).toEqual({ kind: 'answer', number: 2, decision: 'reject' });
    expect(parseLine('reject 3 lines too many', [1])).toEqual({
      kind: 'answer',
      number: 1,
      decision: 'reject',
      reason: '3 lines too many',
    });
  });

  it('refuses an unknown number or a missing number', () => {
    expect(parseLine('approve 3', [1])).toMatchObject({ kind: 'error' });
    expect(parseLine('reject 3 x', [1, 2])).toMatchObject({ kind: 'error' });
    expect(parseLine('approve', [1, 2])).toMatchObject({ kind: 'error' });
    expect(parseLine('reject too long', [1, 2])).toMatchObject({ kind: 'error' });
  });
});
