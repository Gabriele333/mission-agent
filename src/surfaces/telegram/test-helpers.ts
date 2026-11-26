import type { FetchFn } from './api.js';
import type { TgCallbackQuery, TgMessage, TgUpdate } from './tg-types.js';

/** A fake Bot API for tests. It records every request and answers from a script. No network. */

export const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';
export const USER = 4242;
export const OTHER = 777;

export interface Recorded {
  method: string;
  url: string;
  params: Record<string, unknown>;
}

export interface BotAnswer {
  ok: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

type Handler = (params: Record<string, unknown>) => BotAnswer | 'network' | undefined;

const realSetImmediate = globalThis.setImmediate;

/** Lets pending promises and file system work finish. Works with fake timers, which leave setImmediate alone. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => realSetImmediate(r));
}

export function fakeTelegram() {
  const requests: Recorded[] = [];
  const batches: TgUpdate[][] = [];
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  /** One-off answers, used in order, before the default answer of a method. */
  const scripted = new Map<string, Handler[]>();
  let waiter: (() => void) | undefined;
  let nextMessageId = 100;
  let nextThreadId = 500;
  let nextUpdateId = 1;

  function ok(result: unknown): BotAnswer {
    return { ok: true, result };
  }

  function respond(answer: BotAnswer, status?: number): Response {
    return new Response(JSON.stringify(answer), {
      status: status ?? (answer.ok ? 200 : (answer.error_code ?? 400)),
      headers: { 'content-type': 'application/json' },
    });
  }

  function defaultAnswer(method: string, params: Record<string, unknown>): BotAnswer {
    switch (method) {
      case 'getMe':
        return ok({ id: 1, is_bot: true, first_name: 'Ada', username: 'ada_bot', has_topics_enabled: true });
      case 'createForumTopic':
        return ok({ message_thread_id: nextThreadId++, name: params.name, icon_color: 7322096 });
      case 'sendMessage':
      case 'sendDocument':
        return ok({
          message_id: nextMessageId++,
          date: 1_700_000_000,
          chat: { id: Number(params.chat_id), type: 'private' },
          message_thread_id: params.message_thread_id === undefined ? undefined : Number(params.message_thread_id),
          text: params.text,
        });
      case 'getFile':
        return ok({ file_id: params.file_id, file_size: 5, file_path: `documents/${String(params.file_id)}.bin` });
      default:
        return ok(true);
    }
  }

  const fetchFn: FetchFn = async (input, init) => {
    const url = String(input);
    const signal = init?.signal ?? undefined;
    if (url.includes('/file/bot')) {
      const path = decodeURIComponent(url.split('/file/bot')[1]!.split('/').slice(1).join('/'));
      requests.push({ method: 'download', url, params: { path } });
      const data = files.get(path);
      if (!data) return new Response('not found', { status: 404 });
      return new Response(data, { status: 200 });
    }
    const method = url.slice(url.lastIndexOf('/') + 1);
    let params: Record<string, unknown> = {};
    if (init?.body instanceof FormData) {
      for (const [k, v] of init.body.entries()) params[k] = v;
    } else if (typeof init?.body === 'string') {
      params = JSON.parse(init.body) as Record<string, unknown>;
    }
    requests.push({ method, url, params });

    const queue = scripted.get(method);
    const handler = queue?.shift();
    if (handler) {
      const answer = handler(params);
      if (answer === 'network') throw new TypeError('fetch failed', { cause: new Error(`connect ECONNREFUSED ${url}`) });
      if (answer) return respond(answer);
    }

    if (method === 'getUpdates') {
      // A call with timeout 0 is a short poll: it answers at once.
      if (batches.length === 0 && params.timeout !== 0) {
        // A long poll: wait for a new batch or for the abort.
        await new Promise<void>((resolve, reject) => {
          waiter = resolve;
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      }
      const offset = typeof params.offset === 'number' ? params.offset : undefined;
      const batch = (batches.shift() ?? []).filter((u) => offset === undefined || u.update_id >= offset);
      return respond(ok(batch));
    }
    return respond(defaultAnswer(method, params));
  };

  return {
    fetchFn,
    requests,
    files,
    /** Queues a one-off answer for the next call of a method. */
    script(method: string, handler: Handler) {
      const q = scripted.get(method) ?? [];
      q.push(handler);
      scripted.set(method, q);
    },
    /** Delivers a batch of updates to the next (or the waiting) getUpdates call. */
    push(...updates: TgUpdate[]) {
      batches.push(updates);
      const w = waiter;
      waiter = undefined;
      w?.();
    },
    calls(method: string) {
      return requests.filter((r) => r.method === method);
    },
    nextUpdateId: () => nextUpdateId++,
    setNextUpdateId(n: number) {
      nextUpdateId = n;
    },
  };
}

export type FakeTelegram = ReturnType<typeof fakeTelegram>;

export function textUpdate(
  tg: FakeTelegram,
  text: string,
  over: { from?: number; chatId?: number; chatType?: string; thread?: number; replyTo?: number } = {},
): TgUpdate {
  const from = over.from ?? USER;
  const message: TgMessage = {
    message_id: 9000 + Math.floor(Math.random() * 1000),
    from: { id: from, is_bot: false, first_name: 'U' },
    date: 1_764_000_000,
    chat: { id: over.chatId ?? from, type: over.chatType ?? 'private' },
    text,
  };
  if (over.thread !== undefined) {
    message.message_thread_id = over.thread;
    message.is_topic_message = true;
  }
  if (over.replyTo !== undefined) {
    message.reply_to_message = { message_id: over.replyTo, date: 1, chat: message.chat };
  }
  return { update_id: tg.nextUpdateId(), message };
}

export function messageUpdate(tg: FakeTelegram, message: Partial<TgMessage> & { thread?: number }): TgUpdate {
  const { thread, ...rest } = message;
  const m: TgMessage = {
    message_id: 8000,
    from: { id: USER, is_bot: false },
    date: 1_764_000_000,
    chat: { id: USER, type: 'private' },
    ...rest,
  };
  if (thread !== undefined) m.message_thread_id = thread;
  return { update_id: tg.nextUpdateId(), message: m };
}

export function pressUpdate(
  tg: FakeTelegram,
  data: string,
  messageId: number,
  over: { from?: number; chatId?: number; chatType?: string; noMessage?: boolean } = {},
): TgUpdate {
  const from = over.from ?? USER;
  const query: TgCallbackQuery = { id: `cq${tg.nextUpdateId()}`, from: { id: from, is_bot: false }, data };
  if (!over.noMessage) {
    query.message = { message_id: messageId, date: 1_764_000_000, chat: { id: over.chatId ?? from, type: over.chatType ?? 'private' } };
  }
  return { update_id: tg.nextUpdateId(), callback_query: query };
}
