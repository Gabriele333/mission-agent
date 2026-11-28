import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '../../db/index.js';
import { describeApproval } from '../../safety/index.js';
import { SYS_GENERAL, type ApprovalAnswer, type ApprovalRequest, type IncomingMessage, type Store, type SurfaceHost } from '../../types.js';
import {
  createTelegramSurface,
  OFFSET_STATE_KEY,
  ONE_CHAT_NOTICE,
  ONE_CHAT_NOTICE_STATE_KEY,
  REASON_WAIT_MS,
  REPLY_THREAD_STATE_KEY,
  SENT_MESSAGES_KEPT,
  TYPING_REPEAT_MS,
  WORKING_SIGN_MAX_MS,
  type TelegramSurfaceOptions,
} from './surface.js';
import { fakeTelegram, messageUpdate, OTHER, pressUpdate, settle, textUpdate, TOKEN, USER, type FakeTelegram } from './test-helpers.js';

const M1 = 'm_k7q3zp2xw9ha';
const NAMES: Record<string, string> = { [M1]: 'inbox-curator', [SYS_GENERAL]: 'general' };

let root: string;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-11-25T10:00:00Z'));
  root = mkdtempSync(join(tmpdir(), 'tg-surface-'));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

async function until(cond: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await settle(2);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function setup(opts: { tg?: FakeTelegram; store?: Store; over?: Partial<TelegramSurfaceOptions> } = {}) {
  const tg = opts.tg ?? fakeTelegram();
  const store = opts.store ?? createMemoryStore();
  const incoming: IncomingMessage[] = [];
  const answers: [string, ApprovalAnswer][] = [];
  const waiting = new Set<string>();
  const errors: Error[] = [];
  const host: SurfaceHost = {
    // Saves the files as the dispatcher does once it accepts a message: in the folder of the mission
    // of the replied message, or of the general mission.
    incoming: async (m) => {
      if (m.saveFiles === undefined) return void incoming.push(m);
      const { saveFiles, ...rest } = m;
      const files = await saveFiles(m.missionId ?? SYS_GENERAL);
      if (files !== undefined) incoming.push({ ...rest, files });
    },
    answerApproval: (id, a) => {
      if (!waiting.has(id)) return false;
      waiting.delete(id);
      answers.push([id, a]);
      return true;
    },
    label: (id) => `Ada · ${NAMES[id ?? SYS_GENERAL] ?? id}`,
    store,
  };
  const surface = createTelegramSurface({
    token: () => TOKEN,
    userId: () => USER,
    dataDir: (id) => join(root, 'missions', id, 'data'),
    missionName: (id) => NAMES[id],
    generalMissionId: SYS_GENERAL,
    fetchFn: tg.fetchFn,
    onError: (e) => void errors.push(e),
    ...opts.over,
  });
  return { tg, store, surface, host, incoming, answers, waiting, errors };
}

async function started(opts: Parameters<typeof setup>[0] = {}) {
  const s = setup(opts);
  await s.surface.start(s.host);
  await until(() => s.tg.calls('getUpdates').length > 0, 'first poll');
  return s;
}

function request(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'apr_0123456789abcdef',
    missionId: M1,
    action: 'action:email.send',
    toolName: 'mcp__gmail__send',
    input: { to: 'bob@example.com', subject: 'Hi' },
    createdAt: '2026-11-25T10:00:00.000Z',
    expiresAt: '2026-11-26T10:00:00.000Z',
    ...over,
  };
}

function keyboardOf(params: Record<string, unknown>) {
  return (params.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
}

describe('start and polling', () => {
  it('long-polls for messages and button presses only, with no check of topic mode', async () => {
    const { tg, surface, errors } = await started();
    expect(tg.calls('getMe')).toHaveLength(0);
    const poll = tg.calls('getUpdates')[0]!.params;
    expect(poll).toMatchObject({ timeout: 30, allowed_updates: ['message', 'callback_query'] });
    expect(poll.offset).toBeUndefined();
    expect(errors).toEqual([]);
    await surface.stop();
  });

  it('stop() ends a waiting long poll at once and polls no more', async () => {
    const { tg, surface } = await started();
    const before = tg.calls('getUpdates').length;
    await surface.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tg.calls('getUpdates').length).toBe(before);
    await expect(surface.send({ missionId: M1, label: 'Ada · inbox-curator', text: 'x' })).rejects.toThrow(/stopped/);
  });

  it('retries a failed poll with a growing wait and reports it without the token', async () => {
    const tg = fakeTelegram();
    tg.script('getUpdates', () => 'network');
    tg.script('getUpdates', () => ({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }));
    const { surface, errors, host } = setup({ tg });
    await surface.start(host);
    await until(() => tg.calls('getUpdates').length === 1, 'first poll');
    await settle();
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => tg.calls('getUpdates').length === 2, 'second poll');
    await settle();
    await vi.advanceTimersByTimeAsync(1999);
    expect(tg.calls('getUpdates')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => tg.calls('getUpdates').length === 3, 'third poll');
    expect(errors).toHaveLength(2);
    for (const e of errors) {
      expect(e.message).not.toContain(TOKEN);
      expect(e.message).not.toContain(TOKEN.split(':')[1]);
    }
    await surface.stop();
  });

  it('waits retry_after seconds when polling is rate limited', async () => {
    const tg = fakeTelegram();
    tg.script('getUpdates', () => ({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 9 } }));
    const s = setup({ tg });
    await s.surface.start(s.host);
    await until(() => tg.calls('getUpdates').length === 1, 'first poll');
    await vi.advanceTimersByTimeAsync(8_999);
    expect(tg.calls('getUpdates')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => tg.calls('getUpdates').length === 2, 'second poll');
    await s.surface.stop();
  });
});

describe('sender check', () => {
  it('passes on messages from the user in the private chat only, and answers no one else', async () => {
    const s = await started();
    s.tg.push(
      textUpdate(s.tg, 'from a stranger', { from: OTHER }),
      textUpdate(s.tg, 'from the user in a group', { chatId: -100123, chatType: 'supergroup' }),
      textUpdate(s.tg, 'stranger in the user chat id', { from: OTHER, chatId: USER }),
      textUpdate(s.tg, 'hello'),
    );
    await until(() => s.incoming.length === 1, 'incoming');
    await settle();
    expect(s.incoming).toEqual([{ surface: 'surface:telegram', text: 'hello' }]);
    expect(s.tg.calls('sendMessage')).toHaveLength(0);
    await s.surface.stop();
  });

  it('drops everything when the user is not set', async () => {
    const s = await started({ over: { userId: () => undefined } });
    s.tg.push(textUpdate(s.tg, 'hello'), pressUpdate(s.tg, 'a:apr_x', 5));
    await until(() => s.store.getState(OFFSET_STATE_KEY) !== undefined, 'offset');
    await settle();
    expect(s.incoming).toEqual([]);
    expect(s.tg.calls('answerCallbackQuery')).toHaveLength(0);
    await s.surface.stop();
  });

  it('ignores button presses from another account or another chat, without an answer', async () => {
    const s = await started();
    s.waiting.add('apr_1');
    const last = pressUpdate(s.tg, 'a:apr_1', 5, { chatId: -100123, chatType: 'supergroup' });
    s.tg.push(pressUpdate(s.tg, 'a:apr_1', 5, { from: OTHER }), last);
    await until(() => JSON.parse(s.store.getState(OFFSET_STATE_KEY) ?? '{"offset":0}').offset === last.update_id + 1, 'offset');
    await settle();
    expect(s.answers).toEqual([]);
    expect(s.tg.calls('answerCallbackQuery')).toHaveLength(0);
    s.tg.push(pressUpdate(s.tg, 'a:apr_1', 5));
    await until(() => s.answers.length === 1, 'answer');
    expect(s.answers).toEqual([['apr_1', { kind: 'approved' }]]);
    await until(() => s.tg.calls('answerCallbackQuery').length === 1, 'callback answer');
    await s.surface.stop();
  });
});

describe('one chat: where the agent writes (§F.1)', () => {
  it('sends with no thread when the user has not written yet and no thread is stored', async () => {
    const s = await started();
    await s.surface.send({ missionId: SYS_GENERAL, label: 'Ada · general', text: 'hi' });
    expect(s.tg.calls('sendMessage')[0]!.params).toEqual({ chat_id: USER, text: 'hi' });
    expect(s.tg.calls('createForumTopic')).toHaveLength(0);
    await s.surface.stop();
  });

  it("starts in the general mission's thread of the old layout when one is stored", async () => {
    const store = createMemoryStore();
    store.setThread(SYS_GENERAL, 40);
    store.setState(ONE_CHAT_NOTICE_STATE_KEY, 'sent');
    const s = await started({ store });
    await s.surface.send({ missionId: M1, label: 'Ada · inbox-curator', text: 'hi' });
    expect(s.tg.calls('sendMessage')[0]!.params).toMatchObject({ message_thread_id: 40 });
    await s.surface.stop();
  });

  it('writes where the user last wrote: in a thread, then outside any thread', async () => {
    const s = await started();
    s.tg.push(textUpdate(s.tg, 'in an old thread', { thread: 41 }));
    await until(() => s.incoming.length === 1, 'incoming');
    expect(s.store.getState(REPLY_THREAD_STATE_KEY)).toBe('41');
    await s.surface.send({ missionId: M1, label: 'Ada · inbox-curator', text: 'one' });
    await s.surface.showApproval(request(), 'Ada · inbox-curator');
    s.tg.push(textUpdate(s.tg, 'outside threads'));
    await until(() => s.incoming.length === 2, 'incoming');
    expect(s.store.getState(REPLY_THREAD_STATE_KEY)).toBe('none');
    await s.surface.send({ missionId: M1, label: 'Ada · inbox-curator', text: 'two' });
    const threads = s.tg.calls('sendMessage').map((r) => r.params.message_thread_id);
    expect(threads).toEqual([41, 41, undefined]);
    await s.surface.stop();
  });

  it('forgets a thread that no longer exists and sends once more with no thread', async () => {
    const s = await started();
    s.store.setState(REPLY_THREAD_STATE_KEY, '41');
    s.tg.script('sendMessage', () => ({ ok: false, error_code: 400, description: 'Bad Request: message thread not found' }));
    await s.surface.send({ missionId: M1, label: 'Ada · inbox-curator', text: 'hello' });
    const sent = s.tg.calls('sendMessage').map((r) => r.params);
    expect(sent).toEqual([
      { chat_id: USER, message_thread_id: 41, text: 'inbox-curator\nhello' },
      { chat_id: USER, text: 'inbox-curator\nhello' },
    ]);
    expect(s.store.getState(REPLY_THREAD_STATE_KEY)).toBe('none');
    // The same for a document.
    s.store.setState(REPLY_THREAD_STATE_KEY, '42');
    const dir = join(root, 'missions', M1, 'data');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.pdf'), 'pdf');
    s.tg.script('sendDocument', () => ({ ok: false, error_code: 400, description: 'Bad Request: TOPIC_ID_INVALID' }));
    await s.surface.send({ missionId: M1, label: 'Ada · inbox-curator', text: 'file', filePath: join(dir, 'a.pdf') });
    const docs = s.tg.calls('sendDocument').map((r) => r.params.message_thread_id);
    expect(docs).toEqual(['42', undefined]);
    // Any refusal with a thread is tried again with no thread, such as after topic mode was turned off.
    s.store.setState(REPLY_THREAD_STATE_KEY, '43');
    s.tg.script('sendMessage', () => ({ ok: false, error_code: 400, description: 'Bad Request: some other refusal' }));
    await s.surface.send({ missionId: M1, label: 'Ada · inbox-curator', text: 'again' });
    expect(s.tg.calls('sendMessage').slice(-2).map((r) => r.params.message_thread_id)).toEqual([43, undefined]);
    expect(s.store.getState(REPLY_THREAD_STATE_KEY)).toBe('none');
    // The stored threads of the old layout stay as they are.
    expect(s.store.getThread(SYS_GENERAL)).toBeUndefined();
    await s.surface.stop();
  });

  it('keeps the thread when the call is refused with no thread too, and throws the first error', async () => {
    const s = await started();
    s.store.setState(REPLY_THREAD_STATE_KEY, '41');
    s.tg.script('sendMessage', () => ({ ok: false, error_code: 400, description: 'Bad Request: message is too long' }));
    s.tg.script('sendMessage', () => ({ ok: false, error_code: 400, description: 'Bad Request: refused again' }));
    await expect(s.surface.send({ missionId: M1, label: 'Ada · inbox-curator', text: 'x' })).rejects.toThrow(/too long/);
    expect(s.tg.calls('sendMessage').map((r) => r.params.message_thread_id)).toEqual([41, undefined]);
    expect(s.store.getState(REPLY_THREAD_STATE_KEY)).toBe('41');
    await s.surface.stop();
  });

  it('does not try again with no thread for an error that is not a refusal', async () => {
    const s = await started();
    s.store.setState(REPLY_THREAD_STATE_KEY, '41');
    s.tg.script('sendMessage', () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }));
    await expect(s.surface.send({ missionId: M1, label: 'Ada · inbox-curator', text: 'x' })).rejects.toThrow(/blocked/);
    expect(s.tg.calls('sendMessage')).toHaveLength(1);
    expect(s.store.getState(REPLY_THREAD_STATE_KEY)).toBe('41');
    await s.surface.stop();
  });

  it('a message in an old mission thread is like any other: the thread names no mission', async () => {
    const s = await started();
    s.store.setThread(M1, 41);
    s.tg.push(textUpdate(s.tg, 'for the old mission thread', { thread: 41 }));
    await until(() => s.incoming.length === 1, 'incoming');
    expect(s.incoming).toEqual([{ surface: 'surface:telegram', text: 'for the old mission thread' }]);
    await s.surface.stop();
  });
});

describe('the label line (§F.1)', () => {
  it('starts a message of a mission with its name on its own line, but not for the general mission or a notice', async () => {
    const s = await started();
    await s.surface.send({ missionId: M1, label: 'Ada · inbox-curator', text: 'Three new mails.' });
    await s.surface.send({ missionId: SYS_GENERAL, label: 'Ada · general', text: 'Hello.' });
    await s.surface.send({ missionId: null, label: 'Ada', text: 'Calling inbox-curator.' });
    await s.surface.send({ missionId: 'm_2vx8qm4rt6pc', label: 'Ada · sell-the-flat', text: 'A buyer called.' });
    expect(s.tg.calls('sendMessage').map((r) => r.params.text)).toEqual([
      'inbox-curator\nThree new mails.',
      'Hello.',
      'Calling inbox-curator.',
      'sell-the-flat\nA buyer called.',
    ]);
    await s.surface.stop();
  });

  it('puts the name in the caption of a document, also when there is no text', async () => {
    const s = await started();
    const dir = join(root, 'missions', M1, 'data');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.pdf'), 'pdf');
    await s.surface.send({ missionId: M1, label: 'Ada · inbox-curator', text: '', filePath: join(dir, 'report.pdf') });
    expect(s.tg.calls('sendDocument')[0]!.params.caption).toBe('inbox-curator');
    await s.surface.stop();
  });
});

describe('a reply to a message of a mission (§B.1)', () => {
  it('goes to the mission that sent the message; a reply to a notice or an unknown message goes nowhere in particular', async () => {
    const s = await started();
    await s.surface.send({ missionId: M1, label: 'Ada · inbox-curator', text: 'Three new mails.' });
    await s.surface.send({ missionId: SYS_GENERAL, label: 'Ada · general', text: 'Hello.' });
    await s.surface.send({ missionId: null, label: 'Ada', text: 'Working on it.' });
    s.tg.push(
      textUpdate(s.tg, 'which ones?', { replyTo: 100 }),
      textUpdate(s.tg, 'and you?', { replyTo: 101 }),
      textUpdate(s.tg, 'ok', { replyTo: 102 }),
      textUpdate(s.tg, 'old', { replyTo: 7 }),
    );
    await until(() => s.incoming.length === 4, 'incoming');
    expect(s.incoming).toEqual([
      { surface: 'surface:telegram', text: 'which ones?', missionId: M1 },
      { surface: 'surface:telegram', text: 'and you?', missionId: SYS_GENERAL },
      { surface: 'surface:telegram', text: 'ok' },
      { surface: 'surface:telegram', text: 'old' },
    ]);
    await s.surface.stop();
  });

  it('remembers a bounded number of sent messages', async () => {
    const s = await started();
    for (let i = 0; i <= SENT_MESSAGES_KEPT; i++) await s.surface.send({ missionId: M1, label: 'Ada · inbox-curator', text: `m${i}` });
    s.tg.push(textUpdate(s.tg, 'first', { replyTo: 100 }), textUpdate(s.tg, 'second', { replyTo: 101 }));
    await until(() => s.incoming.length === 2, 'incoming');
    expect(s.incoming[0]).toEqual({ surface: 'surface:telegram', text: 'first' });
    expect(s.incoming[1]).toEqual({ surface: 'surface:telegram', text: 'second', missionId: M1 });
    await s.surface.stop();
  });

  it('routes a file sent as a reply to the folder of that mission', async () => {
    const s = await started();
    await s.surface.send({ missionId: M1, label: 'Ada · inbox-curator', text: 'Send me the scan.' });
    s.tg.files.set('documents/d1.bin', new TextEncoder().encode('one'));
    s.tg.push(
      messageUpdate(s.tg, {
        caption: 'here',
        document: { file_id: 'd1', file_name: 'scan.pdf', file_size: 3 },
        reply_to_message: { message_id: 100, date: 1, chat: { id: USER, type: 'private' } },
      }),
    );
    await until(() => s.incoming.length === 1, 'incoming');
    expect(s.incoming[0]).toEqual({ surface: 'surface:telegram', text: 'here', missionId: M1, files: [join(root, 'missions', M1, 'data', 'scan.pdf')] });
    await s.surface.stop();
  });
});

describe('the menu of commands (§F.1)', () => {
  const list = [
    { command: 'stop', description: 'Stop' },
    { command: 'inbox_curator', description: 'Sorts my inbox' },
  ];

  it("publishes the list for the user's chat only, at the start and when the missions change", async () => {
    let commands = list;
    const s = await started({ over: { commands: () => commands } });
    await until(() => s.tg.calls('setMyCommands').length === 1, 'setMyCommands');
    expect(s.tg.calls('setMyCommands')[0]!.params).toEqual({ commands: list, scope: { type: 'chat', chat_id: USER } });
    commands = [list[0]!];
    await s.surface.missionsChanged!();
    expect(s.tg.calls('setMyCommands')[1]!.params).toEqual({ commands: [list[0]], scope: { type: 'chat', chat_id: USER } });
    await s.surface.stop();
  });

  it('reports a refused list and keeps working', async () => {
    const tg = fakeTelegram();
    tg.script('setMyCommands', () => ({ ok: false, error_code: 400, description: 'Bad Request: BOT_COMMAND_INVALID' }));
    const s = await started({ tg, over: { commands: () => list } });
    await until(() => s.errors.length === 1, 'the error');
    expect(s.errors[0]!.message).toMatch(/BOT_COMMAND_INVALID/);
    await s.surface.send({ missionId: SYS_GENERAL, label: 'Ada · general', text: 'still here' });
    expect(s.tg.calls('sendMessage')).toHaveLength(1);
    const polls = s.tg.calls('getUpdates').length;
    s.tg.push(textUpdate(s.tg, 'hello'));
    await until(() => s.tg.calls('getUpdates').length > polls, 'the next poll');
    await s.surface.stop();
  });

  it('publishes nothing without a list', async () => {
    const s = await started();
    await s.surface.missionsChanged!();
    expect(s.tg.calls('setMyCommands')).toHaveLength(0);
    await s.surface.stop();
  });
});

describe('the notice about the one chat (§F.1)', () => {
  it('is sent once, in the stored general thread, when threads of the old layout are stored', async () => {
    const store = createMemoryStore();
    store.setThread(SYS_GENERAL, 40);
    store.setThread(M1, 41);
    const first = await started({ store });
    await until(() => first.tg.calls('sendMessage').length === 1, 'the notice');
    expect(first.tg.calls('sendMessage')[0]!.params).toEqual({ chat_id: USER, message_thread_id: 40, text: ONE_CHAT_NOTICE });
    expect(ONE_CHAT_NOTICE).toContain('/general');
    await until(() => store.getState(ONE_CHAT_NOTICE_STATE_KEY) !== undefined, 'the flag');
    await first.surface.stop();
    const second = await started({ store });
    await settle();
    expect(second.tg.calls('sendMessage')).toHaveLength(0);
    // The stored threads stay.
    expect(store.getThread(M1)).toBe(41);
    await second.surface.stop();
  });

  it('is not sent when no thread is stored', async () => {
    const s = await started();
    await settle();
    expect(s.tg.calls('sendMessage')).toHaveLength(0);
    expect(s.store.getState(ONE_CHAT_NOTICE_STATE_KEY)).toBeUndefined();
    await s.surface.stop();
  });

  it('is tried again at the next start when it could not be sent', async () => {
    const store = createMemoryStore();
    store.setThread(M1, 41);
    const tg = fakeTelegram();
    tg.script('sendMessage', () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }));
    const first = await started({ tg, store });
    await until(() => first.errors.length === 1, 'the error');
    expect(store.getState(ONE_CHAT_NOTICE_STATE_KEY)).toBeUndefined();
    await first.surface.stop();
    const second = await started({ store });
    await until(() => second.tg.calls('sendMessage').length === 1, 'the notice');
    expect(second.tg.calls('sendMessage')[0]!.params.text).toBe(ONE_CHAT_NOTICE);
    await second.surface.stop();
  });
});

describe('the sign that the agent works (§F.1)', () => {
  it('sends typing at once and every 4 seconds until the sign stops', async () => {
    const s = await started();
    const sign = s.surface.showWorking!();
    await settle();
    expect(s.tg.calls('sendChatAction').map((r) => r.params)).toEqual([{ chat_id: USER, action: 'typing' }]);
    await vi.advanceTimersByTimeAsync(TYPING_REPEAT_MS);
    await vi.advanceTimersByTimeAsync(TYPING_REPEAT_MS);
    expect(s.tg.calls('sendChatAction')).toHaveLength(3);
    sign.stop();
    sign.stop();
    await vi.advanceTimersByTimeAsync(3 * TYPING_REPEAT_MS);
    expect(s.tg.calls('sendChatAction')).toHaveLength(3);
    await s.surface.stop();
  });

  it('ends by itself after 5 minutes at most', async () => {
    const s = await started();
    s.surface.showWorking!();
    await vi.advanceTimersByTimeAsync(WORKING_SIGN_MAX_MS + 1);
    const count = s.tg.calls('sendChatAction').length;
    expect(count).toBeGreaterThan(70);
    expect(count).toBeLessThanOrEqual(1 + WORKING_SIGN_MAX_MS / TYPING_REPEAT_MS);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.tg.calls('sendChatAction')).toHaveLength(count);
    expect(WORKING_SIGN_MAX_MS).toBe(5 * 60_000);
    expect(TYPING_REPEAT_MS).toBe(4000);
    await s.surface.stop();
  });

  it('goes on while one of two signs is open, uses the thread where the user wrote, and ignores errors', async () => {
    const s = await started();
    s.store.setState(REPLY_THREAD_STATE_KEY, '41');
    s.tg.script('sendChatAction', () => ({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }));
    const a = s.surface.showWorking!();
    const b = s.surface.showWorking!();
    a.stop();
    await vi.advanceTimersByTimeAsync(TYPING_REPEAT_MS);
    expect(s.tg.calls('sendChatAction').length).toBe(3);
    expect(s.tg.calls('sendChatAction').at(-1)!.params).toEqual({ chat_id: USER, action: 'typing', message_thread_id: 41 });
    b.stop();
    await vi.advanceTimersByTimeAsync(2 * TYPING_REPEAT_MS);
    expect(s.tg.calls('sendChatAction').length).toBe(3);
    expect(s.errors).toEqual([]);
    await s.surface.stop();
  });

  it('does nothing before the start and after the stop', async () => {
    const s = setup();
    s.surface.showWorking!().stop();
    await s.surface.start(s.host);
    await s.surface.stop();
    s.surface.showWorking!();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.tg.calls('sendChatAction')).toHaveLength(0);
  });
});

describe('incoming messages', () => {
  it('passes commands on unchanged', async () => {
    const s = await started();
    s.tg.push(textUpdate(s.tg, '/stop', { thread: 41 }), textUpdate(s.tg, '/inbox_curator hi'));
    await until(() => s.incoming.length === 2, 'incoming');
    expect(s.incoming).toEqual([
      { surface: 'surface:telegram', text: '/stop' },
      { surface: 'surface:telegram', text: '/inbox_curator hi' },
    ]);
    await s.surface.stop();
  });

  it('does not wait for the run of a message before reading the next update', async () => {
    const s = setup();
    let release!: () => void;
    s.host.incoming = (m) => {
      s.incoming.push(m);
      return new Promise<void>((r) => (release = r));
    };
    await s.surface.start(s.host);
    s.waiting.add('apr_1');
    s.tg.push(textUpdate(s.tg, 'long run'), pressUpdate(s.tg, 'a:apr_1', 5));
    await until(() => s.answers.length === 1, 'approval during a run');
    release();
    await s.surface.stop();
  });

  it('tells the user when a kind of message is not supported, and ignores service messages', async () => {
    const s = await started();
    s.tg.push(
      messageUpdate(s.tg, { sticker: {} } as never),
      messageUpdate(s.tg, { forum_topic_created: { name: 'x' } } as never),
    );
    await until(() => s.tg.calls('sendMessage').length === 1, 'note');
    await settle();
    expect(String(s.tg.calls('sendMessage')[0]!.params.text)).toMatch(/not passed on/);
    expect(s.tg.calls('sendMessage')).toHaveLength(1);
    expect(s.incoming).toEqual([]);
    await s.surface.stop();
  });
});

describe('files from the user', () => {
  it('saves a document with a hostile name in the data folder of the mission it replies to', async () => {
    const s = await started();
    await s.surface.send({ missionId: M1, label: 'Ada · inbox-curator', text: 'Send it.' });
    const reply_to_message = { message_id: 100, date: 1, chat: { id: USER, type: 'private' } };
    s.tg.files.set('documents/d1.bin', new TextEncoder().encode('one'));
    s.tg.files.set('documents/d2.bin', new TextEncoder().encode('two'));
    s.tg.push(
      messageUpdate(s.tg, { reply_to_message, caption: 'see this', document: { file_id: 'd1', file_name: '../../x/.evil.sh', file_size: 3 } }),
      messageUpdate(s.tg, { reply_to_message, document: { file_id: 'd2', file_name: '../../x/.evil.sh', file_size: 3 } }),
    );
    await until(() => s.incoming.length === 2, 'incoming');
    const dir = join(root, 'missions', M1, 'data');
    expect(s.incoming[0]).toEqual({ surface: 'surface:telegram', text: 'see this', missionId: M1, files: [join(dir, '_.._x_.evil.sh')] });
    expect(s.incoming[1]).toEqual({ surface: 'surface:telegram', text: '', missionId: M1, files: [join(dir, '_.._x_.evil-1.sh')] });
    expect(readFileSync(join(dir, '_.._x_.evil.sh'), 'utf8')).toBe('one');
    expect(readFileSync(join(dir, '_.._x_.evil-1.sh'), 'utf8')).toBe('two');
    expect(existsSync(join(root, 'missions', 'x'))).toBe(false);
    await s.surface.stop();
  });

  it('saves a photo that is no reply in the general mission data folder, largest size first', async () => {
    const s = await started();
    s.tg.script('getFile', (p) => ({ ok: true, result: { file_id: p.file_id, file_size: 3, file_path: 'photos/file_7.jpg' } }));
    s.tg.files.set('photos/file_7.jpg', new Uint8Array([1, 2, 3]));
    s.tg.push(
      messageUpdate(s.tg, {
        date: 1_764_064_800,
        photo: [
          { file_id: 'small', width: 90, height: 90 },
          { file_id: 'big', width: 1280, height: 960 },
          { file_id: 'mid', width: 320, height: 240 },
        ],
      }),
    );
    await until(() => s.incoming.length === 1, 'incoming');
    expect(s.tg.calls('getFile')[0]!.params).toEqual({ file_id: 'big' });
    const path = join(root, 'missions', SYS_GENERAL, 'data', 'photo-20251125-100000.jpg');
    expect(s.incoming[0]).toEqual({ surface: 'surface:telegram', text: '', files: [path] });
    expect(existsSync(path)).toBe(true);
    await s.surface.stop();
  });

  it('downloads and saves nothing until the harness accepts the message, and nothing when it refuses it', async () => {
    const s = setup();
    const raw: IncomingMessage[] = [];
    // A host that refuses every message, as the dispatcher does while paused: it never calls saveFiles.
    s.host.incoming = async (m) => void raw.push(m);
    await s.surface.start(s.host);
    s.tg.files.set('documents/d1.bin', new TextEncoder().encode('one'));
    s.tg.push(messageUpdate(s.tg, { caption: 'see this', document: { file_id: 'd1', file_name: 'a.txt', file_size: 3 } }));
    await until(() => raw.length === 1, 'incoming');
    await settle();
    expect(raw[0]).toMatchObject({ surface: 'surface:telegram', text: 'see this' });
    expect(raw[0]?.files).toBeUndefined();
    expect(s.tg.calls('getFile')).toHaveLength(0);
    expect(s.tg.calls('download')).toHaveLength(0);
    expect(existsSync(join(root, 'missions', M1, 'data'))).toBe(false);

    // Accepted later: the file goes to the folder the harness names.
    expect(await raw[0]!.saveFiles!(M1)).toEqual([join(root, 'missions', M1, 'data', 'a.txt')]);
    expect(readFileSync(join(root, 'missions', M1, 'data', 'a.txt'), 'utf8')).toBe('one');
    await s.surface.stop();
  });

  it('refuses a file over 20 MB before downloading it', async () => {
    const s = await started();
    s.tg.push(messageUpdate(s.tg, { caption: 'big', document: { file_id: 'd9', file_name: 'big.iso', file_size: 30_000_000 } }));
    await until(() => s.tg.calls('sendMessage').length === 1, 'note');
    expect(String(s.tg.calls('sendMessage')[0]!.params.text)).toMatch(/larger than 20 MB/);
    expect(s.tg.calls('getFile')).toHaveLength(0);
    expect(s.incoming).toEqual([]);
    await s.surface.stop();
  });
});

describe('sending', () => {
  it('splits a long text into parts within the limit, in order, losing nothing', async () => {
    const s = await started();
    const text = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} ${'é😀'.repeat(10)}`).join('\n\n');
    await s.surface.send({ missionId: M1, label: 'Ada · inbox-curator', text });
    const parts = s.tg.calls('sendMessage').map((r) => String(r.params.text));
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.join('')).toBe(`inbox-curator\n${text}`);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    await s.surface.stop();
  });

  it('sends plain text: no parse mode and no entities, whatever the text holds', async () => {
    const s = await started();
    const text = '<b>bold</b> *star* _under_ [link](http://x) `code`';
    await s.surface.send({ missionId: SYS_GENERAL, label: 'Ada · general', text });
    const params = s.tg.calls('sendMessage')[0]!.params;
    expect(params.text).toBe(text);
    expect(params).not.toHaveProperty('parse_mode');
    expect(params).not.toHaveProperty('entities');
    await s.surface.stop();
  });

  it('sends a notice that concerns no mission as it is, in the same chat', async () => {
    const s = await started();
    await s.surface.send({ missionId: null, label: 'Ada', text: 'The agent is paused.' });
    expect(s.tg.calls('sendMessage')[0]!.params).toEqual({ chat_id: USER, text: 'The agent is paused.' });
    await s.surface.stop();
  });

  it('sends a file from the data folder as a document, and refuses one from elsewhere', async () => {
    const s = await started();
    const dir = join(root, 'missions', M1, 'data');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.pdf'), 'pdf');
    writeFileSync(join(root, 'secret.txt'), 'secret');
    await s.surface.send({ missionId: M1, label: 'Ada · inbox-curator', text: 'Here it is.', filePath: join(dir, 'report.pdf') });
    const doc = s.tg.calls('sendDocument')[0]!.params;
    expect(doc.chat_id).toBe(String(USER));
    expect(doc.message_thread_id).toBeUndefined();
    expect(doc.caption).toBe('inbox-curator\nHere it is.');
    expect((doc.document as File).name).toBe('report.pdf');
    expect(await (doc.document as File).text()).toBe('pdf');
    expect(doc).not.toHaveProperty('parse_mode');

    await expect(
      s.surface.send({ missionId: M1, label: 'Ada · inbox-curator', text: 'leak', filePath: join(root, 'secret.txt') }),
    ).rejects.toThrow(/not inside/);
    expect(s.tg.calls('sendDocument')).toHaveLength(1);
    expect(s.tg.calls('sendMessage')).toHaveLength(0);
    await s.surface.stop();
  });

  it('retries a send after retry_after and delivers it once', async () => {
    const s = await started();
    s.tg.script('sendMessage', () => ({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 3', parameters: { retry_after: 3 } }));
    const p = s.surface.send({ missionId: M1, label: 'Ada · inbox-curator', text: 'hi' });
    await settle();
    expect(s.tg.calls('sendMessage')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    expect(s.tg.calls('sendMessage')).toHaveLength(2);
    await s.surface.stop();
  });

  it('sends nothing for an empty text with no file', async () => {
    const s = await started();
    await s.surface.send({ missionId: M1, label: 'Ada · inbox-curator', text: '  \n ' });
    expect(s.tg.calls('sendMessage')).toHaveLength(0);
    await s.surface.stop();
  });
});

describe('approvals', () => {
  async function shown(req = request()) {
    const s = await started();
    s.waiting.add(req.id);
    await s.surface.showApproval(req, 'Ada · inbox-curator');
    const msg = s.tg.calls('sendMessage').at(-1)!;
    return { ...s, req, msg, messageId: 100 + s.tg.calls('sendMessage').length - 1 };
  }

  it('posts the rendered request with approve and reject buttons that fit in callback_data', async () => {
    const { msg, req, surface } = await shown();
    expect(msg.params.text).toBe(describeApproval(req, 'inbox-curator'));
    expect(msg.params.message_thread_id).toBeUndefined();
    const rows = keyboardOf(msg.params);
    expect(rows).toEqual([
      [
        { text: 'Approve', callback_data: `a:${req.id}` },
        { text: 'Reject', callback_data: `r:${req.id}` },
      ],
    ]);
    await surface.stop();
  });

  it('uses a short key when the request id is too long for callback_data', async () => {
    const id = `apr_${'z'.repeat(80)}`;
    const s = await shown(request({ id }));
    const rows = keyboardOf(s.msg.params);
    for (const b of rows[0]!) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    s.tg.push(pressUpdate(s.tg, rows[0]![0]!.callback_data, s.messageId));
    await until(() => s.answers.length === 1, 'answer');
    expect(s.answers).toEqual([[id, { kind: 'approved' }]]);
    await s.surface.stop();
  });

  it('approve answers the request and the callback', async () => {
    const s = await shown();
    s.tg.push(pressUpdate(s.tg, `a:${s.req.id}`, s.messageId));
    await until(() => s.tg.calls('answerCallbackQuery').length === 1, 'callback answer');
    expect(s.answers).toEqual([[s.req.id, { kind: 'approved' }]]);
    expect(s.tg.calls('answerCallbackQuery')[0]!.params.text).toBe('Approved.');
    await s.surface.closeApproval(s.req.id, 'approved');
    const edit = s.tg.calls('editMessageText')[0]!.params;
    expect(edit).toMatchObject({ chat_id: USER, message_id: s.messageId, reply_markup: { inline_keyboard: [] } });
    expect(String(edit.text)).toBe(`${describeApproval(s.req, 'inbox-curator')}\n\nOutcome: approved`);
    await s.surface.stop();
  });

  it('reject asks for a reason; a reply is the reason and not a chat message', async () => {
    const s = await shown();
    s.tg.push(pressUpdate(s.tg, `r:${s.req.id}`, s.messageId));
    await until(() => s.tg.calls('editMessageText').length === 1, 'edit');
    const edit = s.tg.calls('editMessageText')[0]!.params;
    expect(String(edit.text)).toMatch(/Reply to this message to give the reason/);
    expect(keyboardOf(edit)).toEqual([[{ text: 'No reason', callback_data: `n:${s.req.id}` }]]);
    expect(s.answers).toEqual([]);

    s.tg.push(textUpdate(s.tg, 'Not this week.', { replyTo: s.messageId }));
    await until(() => s.answers.length === 1, 'answer');
    expect(s.answers).toEqual([[s.req.id, { kind: 'rejected', reason: 'Not this week.' }]]);
    await settle();
    expect(s.incoming).toEqual([]);

    // The time limit no longer applies.
    await vi.advanceTimersByTimeAsync(REASON_WAIT_MS);
    expect(s.answers).toHaveLength(1);
    await s.surface.stop();
  });

  it('a reply to a request that does not wait for a reason is a normal chat message', async () => {
    const s = await shown();
    s.tg.push(textUpdate(s.tg, 'what is this?', { replyTo: s.messageId }));
    await until(() => s.incoming.length === 1, 'incoming');
    expect(s.incoming[0]).toEqual({ surface: 'surface:telegram', text: 'what is this?', missionId: M1 });
    expect(s.answers).toEqual([]);
    await s.surface.stop();
  });

  it('"No reason" rejects without a reason', async () => {
    const s = await shown();
    s.tg.push(pressUpdate(s.tg, `r:${s.req.id}`, s.messageId));
    await until(() => s.tg.calls('editMessageText').length === 1, 'edit');
    s.tg.push(pressUpdate(s.tg, `n:${s.req.id}`, s.messageId));
    await until(() => s.answers.length === 1, 'answer');
    expect(s.answers).toEqual([[s.req.id, { kind: 'rejected' }]]);
    await until(() => s.tg.calls('answerCallbackQuery').length === 2, 'callback answers');
    expect(s.tg.calls('answerCallbackQuery')[1]!.params.text).toBe('Rejected.');
    await vi.advanceTimersByTimeAsync(REASON_WAIT_MS);
    expect(s.answers).toHaveLength(1);
    await s.surface.stop();
  });

  it('rejects without a reason when nothing arrives within 5 minutes', async () => {
    const s = await shown();
    s.tg.push(pressUpdate(s.tg, `r:${s.req.id}`, s.messageId));
    await until(() => s.tg.calls('editMessageText').length === 1, 'edit');
    await vi.advanceTimersByTimeAsync(REASON_WAIT_MS - 1);
    expect(s.answers).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.answers).toEqual([[s.req.id, { kind: 'rejected' }]]);
    await s.surface.stop();
  });

  it('a press on a closed request says so and removes the buttons', async () => {
    const s = await shown();
    s.waiting.delete(s.req.id);
    await s.surface.closeApproval(s.req.id, 'cancelled: no answer in 24 hours');
    expect(String(s.tg.calls('editMessageText')[0]!.params.text)).toMatch(/Outcome: cancelled: no answer in 24 hours$/);
    for (const data of [`a:${s.req.id}`, `r:${s.req.id}`, `n:${s.req.id}`]) {
      s.tg.push(pressUpdate(s.tg, data, s.messageId));
    }
    await until(() => s.tg.calls('answerCallbackQuery').length === 3, 'callback answers');
    for (const c of s.tg.calls('answerCallbackQuery')) {
      expect(c.params.text).toBe('This request is no longer waiting for an answer.');
    }
    expect(s.answers).toEqual([]);
    await until(() => s.tg.calls('editMessageReplyMarkup').length === 3, 'button removal');
    expect(s.tg.calls('editMessageReplyMarkup')[0]!.params).toEqual({ chat_id: USER, message_id: s.messageId, reply_markup: { inline_keyboard: [] } });
    await s.surface.stop();
  });

  it('closeApproval during the wait for a reason ends the wait', async () => {
    const s = await shown();
    s.tg.push(pressUpdate(s.tg, `r:${s.req.id}`, s.messageId));
    await until(() => s.tg.calls('editMessageText').length === 1, 'edit');
    s.waiting.delete(s.req.id);
    await s.surface.closeApproval(s.req.id, 'cancelled: a new chat message arrived');
    await vi.advanceTimersByTimeAsync(REASON_WAIT_MS);
    expect(s.answers).toEqual([]);
    // The reply now is a chat message again.
    s.tg.push(textUpdate(s.tg, 'too late', { replyTo: s.messageId }));
    await until(() => s.incoming.length === 1, 'incoming');
    await s.surface.stop();
  });

  it('closeApproval for a request it never showed does nothing', async () => {
    const s = await started();
    await s.surface.closeApproval('apr_unknown', 'approved');
    expect(s.tg.calls('editMessageText')).toHaveLength(0);
    await s.surface.stop();
  });

  /** Shows a request, then stops the surface and starts a new one on the same store, as a new bot token does. */
  async function shownThenRestarted() {
    const first = await shown();
    first.store.saveApproval(first.req);
    await first.surface.stop();
    const polls = first.tg.calls('getUpdates').length;
    const second = setup({ tg: first.tg, store: first.store });
    second.waiting.add(first.req.id);
    await second.surface.start(second.host);
    await until(() => first.tg.calls('getUpdates').length > polls, 'poll of the new surface');
    return { ...second, req: first.req, messageId: first.messageId };
  }

  it('after a restart, reject on a request that still waits asks for the reason and takes the reply', async () => {
    const s = await shownThenRestarted();
    s.tg.push(pressUpdate(s.tg, `r:${s.req.id}`, s.messageId));
    await until(() => s.tg.calls('editMessageText').length === 1, 'edit');
    const edit = s.tg.calls('editMessageText')[0]!.params;
    expect(edit.message_id).toBe(s.messageId);
    expect(String(edit.text)).toMatch(/Reply to this message to give the reason/);
    expect(keyboardOf(edit)).toEqual([[{ text: 'No reason', callback_data: `n:${s.req.id}` }]]);
    expect(s.tg.calls('editMessageReplyMarkup')).toHaveLength(0);

    s.tg.push(textUpdate(s.tg, 'Not now.', { replyTo: s.messageId }));
    await until(() => s.answers.length === 1, 'answer');
    expect(s.answers).toEqual([[s.req.id, { kind: 'rejected', reason: 'Not now.' }]]);
    expect(s.incoming).toEqual([]);
    await s.surface.stop();
  });

  it('after a restart, approve answers the request and closeApproval shows the outcome on the old message', async () => {
    const s = await shownThenRestarted();
    s.tg.push(pressUpdate(s.tg, `a:${s.req.id}`, s.messageId));
    await until(() => s.answers.length === 1, 'answer');
    expect(s.answers).toEqual([[s.req.id, { kind: 'approved' }]]);
    await s.surface.closeApproval(s.req.id, 'approved');
    const edit = s.tg.calls('editMessageText').at(-1)!.params;
    expect(edit).toMatchObject({ message_id: s.messageId, reply_markup: { inline_keyboard: [] } });
    expect(String(edit.text)).toMatch(/Outcome: approved$/);
    await s.surface.stop();
  });

  it('after a restart, a press on a request that no longer waits says so and removes the buttons', async () => {
    const s = await shownThenRestarted();
    s.store.deleteApproval(s.req.id);
    s.waiting.delete(s.req.id);
    s.tg.push(pressUpdate(s.tg, `r:${s.req.id}`, s.messageId));
    await until(() => s.tg.calls('editMessageReplyMarkup').length === 1, 'button removal');
    expect(s.tg.calls('answerCallbackQuery').at(-1)!.params.text).toBe('This request is no longer waiting for an answer.');
    expect(s.tg.calls('editMessageText')).toHaveLength(0);
    await s.surface.stop();
  });

  it('splits a long request and puts the buttons on the last part', async () => {
    const req = request({ input: { body: 'x'.repeat(300) }, action: 'action:registry.create' });
    req.input = { a: 'y '.repeat(3000) };
    const s = await shown(req);
    const sent = s.tg.calls('sendMessage');
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.slice(0, -1).every((r) => r.params.reply_markup === undefined)).toBe(true);
    expect(sent.map((r) => String(r.params.text)).join('')).toBe(describeApproval(req, 'inbox-curator'));
    expect(keyboardOf(sent.at(-1)!.params)[0]).toHaveLength(2);
    await s.surface.stop();
  });
});

describe('offset across a restart', () => {
  it('stores the offset after each handled update and resumes from it', async () => {
    const store = createMemoryStore();
    const tg = fakeTelegram();
    tg.setNextUpdateId(70);
    const first = await started({ tg, store });
    tg.push(textUpdate(tg, 'one'), textUpdate(tg, 'two'));
    await until(() => first.incoming.length === 2, 'incoming');
    await until(() => tg.calls('getUpdates').length === 2, 'next poll');
    expect(JSON.parse(store.getState(OFFSET_STATE_KEY)!).offset).toBe(72);
    expect(tg.calls('getUpdates')[1]!.params.offset).toBe(72);
    await first.surface.stop();

    // The server sends update 71 again (it was not confirmed before the stop), then a new one.
    tg.script('getUpdates', () => ({
      ok: true,
      result: [
        { update_id: 71, message: { message_id: 1, date: 1, from: { id: USER }, chat: { id: USER, type: 'private' }, text: 'two' } },
        { update_id: 72, message: { message_id: 2, date: 1, from: { id: USER }, chat: { id: USER, type: 'private' }, text: 'three' } },
      ],
    }));
    const second = setup({ tg, store });
    await second.surface.start(second.host);
    await until(() => tg.calls('getUpdates').length >= 3, 'poll after the restart');
    expect(tg.calls('getUpdates')[2]!.params.offset).toBe(72);
    await until(() => second.incoming.length === 1, 'incoming');
    await settle();
    expect(second.incoming.map((m) => m.text)).toEqual(['three']);
    await second.surface.stop();
  });

  it('does not send an offset saved more than 24 hours ago', async () => {
    const store = createMemoryStore();
    store.setState(OFFSET_STATE_KEY, JSON.stringify({ offset: 50, savedAt: Date.now() - 25 * 3_600_000 }));
    const s = await started({ store });
    expect(s.tg.calls('getUpdates')[0]!.params.offset).toBeUndefined();
    await s.surface.stop();
  });

  it('does not mark an update as handled when the surface stops during it', async () => {
    const store = createMemoryStore();
    const tg = fakeTelegram();
    tg.setNextUpdateId(10);
    // The file download never answers, so the update is still in progress at the stop.
    const hanging = tg.fetchFn;
    const s = setup({
      tg,
      store,
      over: {
        fetchFn: (url, init) =>
          String(url).includes('/file/bot')
            ? new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
            : hanging(url, init),
      },
    });
    await s.surface.start(s.host);
    tg.push(messageUpdate(tg, { document: { file_id: 'd1', file_name: 'a.txt', file_size: 1 } }));
    await until(() => tg.calls('getFile').length === 1, 'getFile');
    await settle();
    await s.surface.stop();
    expect(store.getState(OFFSET_STATE_KEY)).toBeUndefined();
    expect(s.incoming).toEqual([]);
  });
});
