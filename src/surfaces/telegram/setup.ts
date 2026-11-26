import { backoffMs, createTelegramApi, realTimers, scrubToken, sleep, StoppedError, TelegramError, type FetchFn, type Timers } from './api.js';
import type { TgBotInfo, TgUpdate } from './tg-types.js';

/** Helpers for the setup page (§5.1 step 3). */

export type BotCheck = { ok: true; username: string; topicsEnabled: boolean } | { ok: false; reason: string };

/** Asks Telegram about the bot with `getMe`, so the setup page can say when topic mode is off. */
export async function checkBot(token: string, fetchFn?: FetchFn): Promise<BotCheck> {
  const opts: Parameters<typeof createTelegramApi>[0] = { token: () => token };
  if (fetchFn) opts.fetchFn = fetchFn;
  const api = createTelegramApi(opts);
  try {
    const me = await api.call<TgBotInfo>('getMe', {}, { attempts: 1, timeoutMs: 15_000 });
    return { ok: true, username: me.username ?? '', topicsEnabled: me.has_topics_enabled === true };
  } catch (err) {
    if (err instanceof TelegramError && (err.code === 401 || err.code === 404)) {
      return { ok: false, reason: 'Telegram refused the bot token. Copy the token from BotFather again.' };
    }
    const text = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: scrubToken(text, token) };
  }
}

export interface PairOptions {
  token: string;
  /** The code shown to the user. The first private message whose text is this code wins. */
  code: string;
  /** How long to wait for the message. */
  timeoutMs: number;
  fetchFn?: FetchFn;
  /** Ends the wait early. The promise then rejects. */
  signal?: AbortSignal;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Milliseconds since 1970. Default `Date.now`. */
  now?: () => number;
}

/**
 * Waits for a private message whose text is exactly the code (white space around it is ignored)
 * and returns the numeric id of its sender. Other updates are read and dropped.
 * The harness's own Telegram polling must not run at the same time: Telegram answers a second
 * `getUpdates` caller with an error (409).
 */
export async function pairTelegramUser(options: PairOptions): Promise<number> {
  const code = options.code.trim();
  if (code === '') throw new Error('The pairing code is empty.');
  const timers: Timers = {
    setTimer: options.setTimer ?? realTimers.setTimer,
    clearTimer: options.clearTimer ?? realTimers.clearTimer,
  };
  const now = options.now ?? Date.now;
  const apiOpts: Parameters<typeof createTelegramApi>[0] = { token: () => options.token, timers };
  if (options.fetchFn) apiOpts.fetchFn = options.fetchFn;
  const api = createTelegramApi(apiOpts);
  const deadline = now() + options.timeoutMs;
  let offset: number | undefined;
  let failures = 0;

  while (now() < deadline) {
    if (options.signal?.aborted) throw new StoppedError();
    const waitSeconds = Math.max(0, Math.min(30, Math.floor((deadline - now()) / 1000)));
    const params: Record<string, unknown> = { timeout: waitSeconds, allowed_updates: ['message'] };
    if (offset !== undefined) params.offset = offset;
    let updates: TgUpdate[];
    try {
      const callOpts: Parameters<typeof api.call>[2] = { attempts: 1, timeoutMs: (waitSeconds + 15) * 1000 };
      if (options.signal) callOpts.signal = options.signal;
      updates = await api.call<TgUpdate[]>('getUpdates', params, callOpts);
      failures = 0;
    } catch (err) {
      if (err instanceof StoppedError) throw err;
      if (err instanceof TelegramError && (err.code === 401 || err.code === 404)) {
        throw new Error('Telegram refused the bot token. Copy the token from BotFather again.');
      }
      failures++;
      const wait = err instanceof TelegramError && err.retryAfter !== undefined ? err.retryAfter * 1000 : backoffMs(failures);
      const left = deadline - now();
      if (left <= 0) break;
      await sleep(Math.min(wait, left), timers, options.signal);
      continue;
    }
    let found: number | undefined;
    for (const u of updates) {
      offset = u.update_id + 1;
      const m = u.message;
      if (found !== undefined || !m || m.chat.type !== 'private' || !m.from || m.from.is_bot) continue;
      if (m.from.id !== m.chat.id) continue;
      if (typeof m.text === 'string' && m.text.trim() === code) found = m.from.id;
    }
    if (found !== undefined) {
      // Marks the updates as read, so the harness does not take the code as a chat message.
      try {
        await api.call('getUpdates', { offset, timeout: 0, limit: 1 }, { attempts: 2 });
      } catch {
        // The pairing still succeeded. The surface may later receive the code as a chat message.
      }
      return found;
    }
  }
  throw new Error(`No message with the code reached the bot within ${Math.round(options.timeoutMs / 1000)} seconds.`);
}
