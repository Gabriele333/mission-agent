import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoppedError } from './api.js';
import { checkBot, pairTelegramUser } from './setup.js';
import { fakeTelegram, OTHER, settle, textUpdate, TOKEN, USER } from './test-helpers.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('pairTelegramUser', () => {
  it('returns the sender of the private message whose text is the code, and marks the updates as read', async () => {
    const tg = fakeTelegram();
    const bot = textUpdate(tg, '482913', { from: OTHER });
    bot.message!.from!.is_bot = true;
    tg.push(
      textUpdate(tg, '/start'),
      textUpdate(tg, '482913', { chatId: -100, chatType: 'group', from: OTHER }),
      bot,
      textUpdate(tg, 'code 482913'),
      textUpdate(tg, ' 482913\n'),
    );
    const id = await pairTelegramUser({ token: TOKEN, code: '482913', timeoutMs: 60_000, fetchFn: tg.fetchFn });
    expect(id).toBe(USER);
    const polls = tg.calls('getUpdates');
    expect(polls[0]!.params).toMatchObject({ allowed_updates: ['message'], timeout: 30 });
    expect(polls.at(-1)!.params).toMatchObject({ offset: 6, timeout: 0 });
  });

  it('keeps polling until the code arrives', async () => {
    const tg = fakeTelegram();
    tg.push(textUpdate(tg, 'hello'));
    const p = pairTelegramUser({ token: TOKEN, code: 'ABC123', timeoutMs: 120_000, fetchFn: tg.fetchFn });
    await settle();
    expect(tg.calls('getUpdates')).toHaveLength(2);
    expect(tg.calls('getUpdates')[1]!.params.offset).toBe(2);
    tg.push(textUpdate(tg, 'ABC123', { from: 99 }));
    await expect(p).resolves.toBe(99);
  });

  it('gives up after the time limit', async () => {
    const tg = fakeTelegram();
    const p = pairTelegramUser({ token: TOKEN, code: 'X1', timeoutMs: 60_000, fetchFn: tg.fetchFn });
    const caught = p.then(
      () => new Error('resolved'),
      (e: unknown) => e as Error,
    );
    await vi.advanceTimersByTimeAsync(200_000);
    const err = await caught;
    expect(err.message).toMatch(/No message with the code reached the bot within 60 seconds/);
  });

  it('stops at once on a refused token, without the token in the message', async () => {
    const tg = fakeTelegram();
    tg.script('getUpdates', () => ({ ok: false, error_code: 401, description: 'Unauthorized' }));
    const err = (await pairTelegramUser({ token: TOKEN, code: 'X1', timeoutMs: 60_000, fetchFn: tg.fetchFn }).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/refused the bot token/);
    expect(err.message).not.toContain(TOKEN);
  });

  it('ends when the signal aborts', async () => {
    const tg = fakeTelegram();
    const controller = new AbortController();
    const p = pairTelegramUser({ token: TOKEN, code: 'X1', timeoutMs: 60_000, fetchFn: tg.fetchFn, signal: controller.signal }).catch((e: unknown) => e);
    await settle();
    controller.abort();
    expect(await p).toBeInstanceOf(StoppedError);
  });
});

describe('checkBot', () => {
  it('reports the username and whether topic mode is on', async () => {
    const tg = fakeTelegram();
    expect(await checkBot(TOKEN, tg.fetchFn)).toEqual({ ok: true, username: 'ada_bot', topicsEnabled: true });
    tg.script('getMe', () => ({ ok: true, result: { id: 1, is_bot: true, first_name: 'A', username: 'b_bot' } }));
    expect(await checkBot(TOKEN, tg.fetchFn)).toEqual({ ok: true, username: 'b_bot', topicsEnabled: false });
  });

  it('explains a refused token', async () => {
    const tg = fakeTelegram();
    tg.script('getMe', () => ({ ok: false, error_code: 401, description: 'Unauthorized' }));
    const r = await checkBot(TOKEN, tg.fetchFn);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/refused the bot token/);
  });

  it('reports a network error without the token', async () => {
    const tg = fakeTelegram();
    tg.script('getMe', () => 'network');
    const r = await checkBot(TOKEN, tg.fetchFn);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/network error/);
      expect(r.reason).not.toContain(TOKEN);
    }
  });
});
