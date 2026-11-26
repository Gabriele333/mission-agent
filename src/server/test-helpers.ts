import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathsFor, type Paths } from '../paths.js';
import { readEventStream } from './event-stream.js';

/** A new agent root in the temporary folder. Call `remove` after the test. */
export function tempPaths(): Paths & { remove(): void } {
  const root = mkdtempSync(join(tmpdir(), 'mission-agent-server-'));
  return Object.assign(pathsFor(root), { remove: () => rmSync(root, { recursive: true, force: true }) });
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A request with full control of the headers, including Host and Origin, which fetch may change. */
export function rawRequest(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path ?? '/', headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Polls until the check passes, or fails after the time limit. */
export async function waitFor(check: () => boolean, what = 'the condition', timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export interface EventCollector {
  events: Array<{ event: string; data: unknown }>;
  /** Resolves when the stream ends. */
  ended: Promise<void>;
  close(): void;
}

/** Opens an event stream with fetch and collects its events. */
export async function collectEvents(url: string, token: string): Promise<EventCollector> {
  const controller = new AbortController();
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
  if (!res.ok || !res.body) throw new Error(`The stream answered ${res.status}.`);
  const events: EventCollector['events'] = [];
  const body = res.body;
  const ended = (async () => {
    try {
      for await (const ev of readEventStream(body)) events.push({ event: ev.event, data: JSON.parse(ev.data) });
    } catch {
      // Aborted by close().
    }
  })();
  return { events, ended, close: () => controller.abort() };
}
