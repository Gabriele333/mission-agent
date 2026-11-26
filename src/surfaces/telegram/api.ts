/**
 * A small client for the Telegram Bot API (https://core.telegram.org/bots/api), built on `fetch`.
 * It retries network errors, server errors and rate limits, and it never puts the bot token
 * in an error message, because the token is part of every request URL.
 */

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface Timers {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export const DEFAULT_API_BASE = 'https://api.telegram.org';

/** An error answer from Telegram, or a failed request. The message never contains the token. */
export class TelegramError extends Error {
  constructor(
    readonly method: string,
    message: string,
    /** The `error_code` of Telegram's answer, or the HTTP status. Undefined for a network error. */
    readonly code?: number,
    /** Seconds to wait before the request can be repeated (`ResponseParameters.retry_after`). */
    readonly retryAfter?: number,
    /** True when a later attempt can succeed. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'TelegramError';
  }
}

/** Thrown when a request is abandoned because the surface stopped. */
export class StoppedError extends Error {
  constructor() {
    super('The Telegram connection was stopped.');
    this.name = 'StoppedError';
  }
}

/** Thrown by `download` when a file is larger than the limit. */
export class FileTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The file is larger than ${maxBytes} bytes.`);
    this.name = 'FileTooLargeError';
  }
}

const TOKEN_PATTERN = /\d{3,}:[A-Za-z0-9_-]{20,}/g;

/** Removes the token, and anything shaped like a bot token, from a text. */
export function scrubToken(text: string, token: string | undefined): string {
  let out = text;
  if (token) out = out.split(token).join('<token>');
  return out.replace(TOKEN_PATTERN, '<token>');
}

/** The wait before attempt `n + 1` after `n` failures: 1 s, 2 s, 4 s and so on, at most 60 s. */
export function backoffMs(failures: number): number {
  return Math.min(1000 * 2 ** Math.max(0, failures - 1), 60_000);
}

/** Waits `ms`. Rejects with StoppedError when the signal aborts. */
export function sleep(ms: number, timers: Timers, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new StoppedError());
      return;
    }
    const onAbort = () => {
      timers.clearTimer(handle);
      reject(new StoppedError());
    };
    const handle = timers.setTimer(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface ApiOptions {
  token: () => string;
  fetchFn?: FetchFn;
  timers?: Timers;
  baseUrl?: string;
}

export interface CallOptions {
  /** Aborts the request and any wait between attempts. */
  signal?: AbortSignal;
  /** Time limit of one attempt. Default 30 s. */
  timeoutMs?: number;
  /** Number of attempts, the first one included. Default 5. */
  attempts?: number;
}

export interface TelegramApi {
  /** Calls a method. `params` is sent as JSON, or as multipart form data when it is a FormData. */
  call<T>(method: string, params?: Record<string, unknown> | FormData, opts?: CallOptions): Promise<T>;
  /** Downloads a file by the `file_path` that `getFile` returned. Fails when it is larger than `maxBytes`. */
  download(filePath: string, maxBytes: number, opts?: CallOptions): Promise<Uint8Array>;
}

interface BotApiAnswer {
  ok?: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export function createTelegramApi(options: ApiOptions): TelegramApi {
  const fetchFn: FetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
  const timers = options.timers ?? realTimers;
  const base = (options.baseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');

  /** Runs one attempt with a time limit, linked to the caller's signal. */
  async function attempt<T>(
    label: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    run: (signal: AbortSignal, token: string) => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) throw new StoppedError();
    const token = options.token();
    const controller = new AbortController();
    let timedOut = false;
    const timer = timers.setTimer(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await run(controller.signal, token);
    } catch (err) {
      if (signal?.aborted) throw new StoppedError();
      if (err instanceof TelegramError || err instanceof FileTooLargeError) throw err;
      if (timedOut) {
        throw new TelegramError(label, `Telegram ${label} failed: no answer within ${Math.round(timeoutMs / 1000)} s.`, undefined, undefined, true);
      }
      throw new TelegramError(label, `Telegram ${label} failed: network error: ${scrubToken(networkText(err), token)}`, undefined, undefined, true);
    } finally {
      timers.clearTimer(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Repeats an attempt while the error is retryable, with a growing wait or Telegram's `retry_after`. */
  async function withRetries<T>(opts: CallOptions | undefined, once: () => Promise<T>): Promise<T> {
    const attempts = opts?.attempts ?? 5;
    for (let n = 1; ; n++) {
      try {
        return await once();
      } catch (err) {
        if (!(err instanceof TelegramError) || !err.retryable || n >= attempts) throw err;
        const wait = err.retryAfter !== undefined ? err.retryAfter * 1000 : backoffMs(n);
        await sleep(wait, timers, opts?.signal);
      }
    }
  }

  async function call<T>(method: string, params?: Record<string, unknown> | FormData, opts?: CallOptions): Promise<T> {
    return withRetries(opts, () =>
      attempt(method, opts?.signal, opts?.timeoutMs ?? 30_000, async (signal, token) => {
        const init: RequestInit = { method: 'POST', signal };
        if (params instanceof FormData) {
          init.body = params;
        } else {
          init.headers = { 'content-type': 'application/json' };
          init.body = JSON.stringify(params ?? {});
        }
        const res = await fetchFn(`${base}/bot${token}/${method}`, init);
        let answer: BotApiAnswer | undefined;
        try {
          answer = (await res.json()) as BotApiAnswer;
        } catch {
          answer = undefined;
        }
        if (answer?.ok === true) return answer.result as T;
        const code = answer?.error_code ?? res.status;
        const retryAfter = answer?.parameters?.retry_after;
        const description = scrubToken(answer?.description ?? `HTTP ${res.status}`, token);
        const retryable = retryAfter !== undefined || code === 429 || code >= 500;
        throw new TelegramError(method, `Telegram ${method} failed: ${description} (code ${code})`, code, retryAfter, retryable);
      }),
    );
  }

  async function download(filePath: string, maxBytes: number, opts?: CallOptions): Promise<Uint8Array> {
    const path = filePath.split('/').map(encodeURIComponent).join('/');
    return withRetries(opts, () =>
      attempt('file download', opts?.signal, opts?.timeoutMs ?? 120_000, async (signal, token) => {
        const res = await fetchFn(`${base}/file/bot${token}/${path}`, { method: 'GET', signal });
        if (!res.ok) {
          throw new TelegramError('file download', `Telegram file download failed: HTTP ${res.status}`, res.status, undefined, res.status >= 500 || res.status === 429);
        }
        return readLimited(res, maxBytes);
      }),
    );
  }

  return { call, download };
}

/** Reads a response body and stops as soon as it is larger than the limit. */
async function readLimited(res: Response, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = () => new FileTooLargeError(maxBytes);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** The message of a fetch error and of its cause. Node puts the reason, such as ENOTFOUND, in the cause. */
function networkText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) return `${err.message} (${cause.message})`;
  return err.message;
}
