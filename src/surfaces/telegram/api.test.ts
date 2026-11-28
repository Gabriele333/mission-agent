import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTelegramApi, FileTooLargeError, scrubToken, StoppedError, TelegramError } from './api.js';
import { fakeTelegram, settle, TOKEN } from './test-helpers.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Telegram API client', () => {
  it('posts JSON to the method URL and returns the result', async () => {
    const tg = fakeTelegram();
    const api = createTelegramApi({ token: () => TOKEN, fetchFn: tg.fetchFn });
    const me = await api.call<{ username: string }>('getMe');
    expect(me.username).toBe('ada_bot');
    expect(tg.requests[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
  });

  it('waits retry_after seconds on a rate limit, then retries', async () => {
    const tg = fakeTelegram();
    tg.script('sendMessage', () => ({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } }));
    const api = createTelegramApi({ token: () => TOKEN, fetchFn: tg.fetchFn });
    let done = false;
    const p = api.call('sendMessage', { chat_id: 1, text: 'x' }).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(6_900);
    expect(done).toBe(false);
    expect(tg.calls('sendMessage')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(done).toBe(true);
    expect(tg.calls('sendMessage')).toHaveLength(2);
  });

  it('retries network errors and server errors with a growing wait', async () => {
    const tg = fakeTelegram();
    tg.script('getMe', () => 'network');
    tg.script('getMe', () => ({ ok: false, error_code: 502, description: 'Bad Gateway' }));
    tg.script('getMe', () => 'network');
    const api = createTelegramApi({ token: () => TOKEN, fetchFn: tg.fetchFn });
    const p = api.call('getMe');
    await vi.advanceTimersByTimeAsync(999);
    expect(tg.calls('getMe')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); // 1 s after the first failure
    expect(tg.calls('getMe')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000); // 2 s after the second
    expect(tg.calls('getMe')).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(4000); // 4 s after the third
    await expect(p).resolves.toMatchObject({ username: 'ada_bot' });
    expect(tg.calls('getMe')).toHaveLength(4);
  });

  it('does not retry a bad request', async () => {
    const tg = fakeTelegram();
    tg.script('sendMessage', () => ({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }));
    const api = createTelegramApi({ token: () => TOKEN, fetchFn: tg.fetchFn });
    await expect(api.call('sendMessage', {})).rejects.toMatchObject({ code: 400, retryable: false });
    expect(tg.calls('sendMessage')).toHaveLength(1);
  });

  it('gives up after the number of attempts', async () => {
    const tg = fakeTelegram();
    for (let i = 0; i < 5; i++) tg.script('getMe', () => 'network');
    const api = createTelegramApi({ token: () => TOKEN, fetchFn: tg.fetchFn });
    const p = api.call('getMe', {}, { attempts: 3 });
    const caught = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await caught;
    expect(err).toBeInstanceOf(TelegramError);
    expect(tg.calls('getMe')).toHaveLength(3);
  });

  it('never puts the token in an error message', async () => {
    const tg = fakeTelegram();
    tg.script('getMe', () => 'network');
    tg.script('sendMessage', () => ({ ok: false, error_code: 400, description: `Bad Request: bot${TOKEN} is odd` }));
    const api = createTelegramApi({ token: () => TOKEN, fetchFn: tg.fetchFn });
    const e1 = (await api.call('getMe', {}, { attempts: 1 }).catch((e: unknown) => e)) as Error;
    const e2 = (await api.call('sendMessage', {}).catch((e: unknown) => e)) as Error;
    for (const e of [e1, e2]) {
      expect(e.message).not.toContain(TOKEN);
      expect(e.message).not.toContain(TOKEN.split(':')[1]);
      expect(String(e.stack)).not.toContain(TOKEN);
      expect((e as { cause?: unknown }).cause).toBeUndefined();
    }
    // The network error of the fake names the full URL in its cause; the client keeps only a scrubbed copy.
    expect(e1.message).toContain('<token>');
  });

  it('scrubs anything shaped like a bot token', () => {
    expect(scrubToken(`x ${TOKEN} y`, undefined)).toBe('x <token> y');
    expect(scrubToken('nothing here 12:ab', 'abc')).toBe('nothing here 12:ab');
  });

  it('stops waiting at once when the signal aborts', async () => {
    const tg = fakeTelegram();
    tg.script('getMe', () => ({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3600 } }));
    const api = createTelegramApi({ token: () => TOKEN, fetchFn: tg.fetchFn });
    const controller = new AbortController();
    const p = api.call('getMe', {}, { signal: controller.signal }).catch((e: unknown) => e);
    await settle();
    controller.abort();
    expect(await p).toBeInstanceOf(StoppedError);
  });

  it('times out an attempt that gets no answer', async () => {
    const tg = fakeTelegram();
    const api = createTelegramApi({ token: () => TOKEN, fetchFn: tg.fetchFn });
    // getUpdates with no batch waits until aborted, as a long poll does.
    const p = api.call('getUpdates', {}, { attempts: 1, timeoutMs: 5000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5000);
    const err = (await p) as TelegramError;
    expect(err).toBeInstanceOf(TelegramError);
    expect(err.message).toMatch(/no answer within 5 s/);
    expect(err.retryable).toBe(true);
  });

  it('downloads a file and refuses one over the limit', async () => {
    const tg = fakeTelegram();
    tg.files.set('documents/a.bin', new Uint8Array([1, 2, 3]));
    tg.files.set('documents/big.bin', new Uint8Array(100));
    const api = createTelegramApi({ token: () => TOKEN, fetchFn: tg.fetchFn });
    expect(Array.from(await api.download('documents/a.bin', 10))).toEqual([1, 2, 3]);
    await expect(api.download('documents/big.bin', 10)).rejects.toBeInstanceOf(FileTooLargeError);
    await expect(api.download('documents/none.bin', 10, { attempts: 1 })).rejects.toMatchObject({ code: 404 });
  });
});

describe('testTelegramApiUrl', () => {
  it('accepts http://127.0.0.1:<port> only', async () => {
    const { testTelegramApiUrl, TELEGRAM_API_VARIABLE } = await import('./api.js');
    expect(TELEGRAM_API_VARIABLE).toBe('MISSION_AGENT_TELEGRAM_API');
    expect(testTelegramApiUrl('http://127.0.0.1:8081')).toBe('http://127.0.0.1:8081');
    expect(testTelegramApiUrl(' http://127.0.0.1:65535 ')).toBe('http://127.0.0.1:65535');
    for (const bad of [
      'http://127.0.0.1:0',
      'http://127.0.0.1:65536',
      'http://127.0.0.1',
      'http://127.0.0.1:8081/',
      'https://127.0.0.1:8081',
      'http://localhost:8081',
      'http://127.0.0.2:8081',
      'http://127.0.0.1:8081@evil.example',
      'https://api.telegram.org',
      '',
    ]) {
      expect(testTelegramApiUrl(bad)).toBeUndefined();
    }
  });
});
