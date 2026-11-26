import { clearLine, createInterface, cursorTo } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import type { Paths } from '../../paths.js';
import { isServerAlive, readEventStream, readServerFile, serverUrl, type ServerInfo } from '../../server/index.js';
import {
  CHAT_MESSAGE_PATH,
  CHAT_STREAM_PATH,
  type ChatApprovalBody,
  type ChatApprovalClosedEvent,
  type ChatApprovalEvent,
  type ChatApprovalReply,
  type ChatMessageEvent,
  type ChatNoticeEvent,
} from './events.js';

/**
 * The terminal chat (`mission-agent chat`, §F.1 Terminal). A separate program that connects to the
 * running harness through the local server, prints what the harness sends and sends what the user types.
 */

export const NOT_RUNNING_TEXT = 'The harness is not running. Start it with `mission-agent start`.';

/** Thrown when the chat cannot start. Its message is already printed; the caller sets the exit code. */
export class ChatClientError extends Error {
  override readonly name = 'ChatClientError';
  readonly exitCode = 1;
}

export interface ChatClientOptions {
  paths: Pick<Paths, 'serverFile'>;
  /** Default `process.stdin`. */
  input?: NodeJS.ReadableStream;
  /** Default `process.stdout`. */
  output?: NodeJS.WritableStream;
  /** Wait before each new connection attempt after the stream drops. Default 1 second. */
  reconnectDelayMs?: number;
}

interface Waiting {
  number: number;
  id: string;
}

/** What a typed line means while requests wait. */
export type ParsedLine =
  | { kind: 'chat' }
  | { kind: 'answer'; number: number; decision: 'approve' | 'reject'; reason?: string }
  | { kind: 'error'; message: string };

/**
 * Reads `approve`, `a`, `reject <reason>` and `r <reason>`, with an optional request number after the
 * word. With no request waiting, every line is chat text. An `approve` followed by anything other
 * than a number is chat text, so a sentence that starts with "a" never approves an action.
 */
export function parseLine(text: string, numbers: number[]): ParsedLine {
  if (numbers.length === 0) return { kind: 'chat' };
  const m = /^(approve|a|reject|r)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return { kind: 'chat' };
  const decision = (m[1] as string).toLowerCase().startsWith('a') ? 'approve' : 'reject';
  let rest = (m[2] ?? '').trim();
  let number: number | undefined;
  const n = /^(\d+)(?:\s+([\s\S]*))?$/.exec(rest);
  if (n) {
    const asked = Number(n[1]);
    if (numbers.includes(asked)) {
      number = asked;
      rest = (n[2] ?? '').trim();
    } else if (numbers.length > 1 || rest === n[1]) {
      return { kind: 'error', message: `No approval request number ${asked} is waiting.` };
    }
  }
  if (decision === 'approve' && rest !== '') return { kind: 'chat' };
  if (number === undefined) {
    if (numbers.length > 1) {
      const example = decision === 'approve' ? `approve ${numbers[0]}` : `reject ${numbers[0]} <reason>`;
      return {
        kind: 'error',
        message: `Several approval requests are waiting. Add the number, for example: ${example}`,
      };
    }
    number = numbers[0] as number;
  }
  if (decision === 'approve') return { kind: 'answer', number, decision };
  return rest === '' ? { kind: 'answer', number, decision } : { kind: 'answer', number, decision, reason: rest };
}

export async function runChatClient(options: ChatClientOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const reconnectDelayMs = options.reconnectDelayMs ?? 1000;
  const write = (text: string) => output.write(`${text}\n`);

  let info: ServerInfo | undefined = readServerFile(options.paths);
  if (info === undefined || !(await isServerAlive(info))) {
    write(NOT_RUNNING_TEXT);
    throw new ChatClientError(NOT_RUNNING_TEXT);
  }

  const terminal = Boolean((input as { isTTY?: boolean }).isTTY && (output as { isTTY?: boolean }).isTTY);
  const rl = createInterface({ input, output, terminal, prompt: '> ' });
  const waiting = new Map<string, Waiting>();
  const pending = new Set<Promise<void>>();
  const ended = new AbortController();
  let streamAbort: AbortController | undefined;
  let shownEarlierHeading = false;

  /** Prints above the line the user is typing, then draws the prompt and the typed text again. */
  function print(text: string): void {
    if (terminal) {
      clearLine(output, 0);
      cursorTo(output, 0);
      write(text);
      rl.prompt(true);
    } else {
      write(text);
    }
  }

  function numbers(): number[] {
    return [...waiting.values()].map((w) => w.number).sort((a, b) => a - b);
  }

  function freeNumber(): number {
    const used = new Set(numbers());
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  function current(): ServerInfo {
    return info as ServerInfo;
  }

  async function post(path: string, body: unknown): Promise<Response> {
    const at = current();
    return fetch(`${serverUrl(at)}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${at.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function sendMessage(text: string): Promise<void> {
    try {
      const res = await post(CHAT_MESSAGE_PATH, { text });
      if (!res.ok) print(`The message was not sent: ${(await res.text()) || `status ${res.status}`}`);
      else await res.body?.cancel();
    } catch {
      print('The message was not sent: the harness is not answering.');
    }
  }

  async function sendAnswer(w: Waiting, body: ChatApprovalBody): Promise<void> {
    try {
      const res = await post(`/api/chat/approvals/${encodeURIComponent(w.id)}`, body);
      if (!res.ok) {
        print(`The answer was not sent: ${(await res.text()) || `status ${res.status}`}`);
        return;
      }
      const reply = (await res.json()) as ChatApprovalReply;
      if (!reply.wasWaiting) {
        waiting.delete(w.id);
        print(`Approval request ${w.number} is no longer waiting. The answer changed nothing.`);
      }
    } catch {
      print('The answer was not sent: the harness is not answering.');
    }
  }

  // Each line is sent after the one before it has been answered, so the harness gets them in order.
  let queue: Promise<void> = Promise.resolve();
  function track(send: () => Promise<void>): void {
    const p = queue.then(send);
    queue = p;
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }

  function onEvent(event: string, data: unknown): void {
    switch (event) {
      case 'message': {
        const m = data as ChatMessageEvent;
        if (m.earlier) showEarlierHeading();
        const lines = [m.label, m.text];
        if (m.filePath) lines.push(`File: ${m.filePath}`);
        print(`${lines.join('\n')}\n`);
        break;
      }
      case 'notice': {
        const n = data as ChatNoticeEvent;
        if (n.earlier) showEarlierHeading();
        print(n.label ? `${n.label}\n${n.text}\n` : `${n.text}\n`);
        break;
      }
      case 'approval': {
        const a = data as ChatApprovalEvent;
        if (waiting.has(a.id)) break;
        const number = freeNumber();
        waiting.set(a.id, { number, id: a.id });
        const how =
          waiting.size > 1
            ? `Answer with "approve ${number}" or "reject ${number} <reason>". The reason is optional.`
            : 'Answer with "approve" or "reject <reason>". The reason is optional.';
        print(`Approval request ${number} · ${a.label}\n${a.text}\n${how}\n`);
        break;
      }
      case 'approval_closed': {
        const c = data as ChatApprovalClosedEvent;
        const w = waiting.get(c.id);
        if (!w) break;
        waiting.delete(c.id);
        print(`Approval request ${w.number} is closed: ${c.outcome}.\n`);
        break;
      }
    }
  }

  function showEarlierHeading(): void {
    if (shownEarlierHeading) return;
    shownEarlierHeading = true;
    print('Messages sent while no chat was open:\n');
  }

  /** Connects to the stream and reads it. Connects again after a drop until the chat ends. */
  async function streamLoop(): Promise<void> {
    let first = true;
    let saidLost = false;
    while (!ended.signal.aborted) {
      // After a restart the harness has a new port and a new token.
      if (!first) info = readServerFile(options.paths) ?? info;
      const at = current();
      const controller = new AbortController();
      streamAbort = controller;
      let body: AsyncIterable<Uint8Array> | undefined;
      try {
        const res = await fetch(`${serverUrl(at)}${CHAT_STREAM_PATH}`, {
          headers: { authorization: `Bearer ${at.token}` },
          signal: controller.signal,
        });
        if (res.ok && res.body) body = res.body;
        else await res.body?.cancel();
      } catch {
        // Not connected; tried again below.
      }

      if (body) {
        // The harness sends the requests that still wait at each connection, with new numbers.
        waiting.clear();
        shownEarlierHeading = false;
        if (first) print('Connected to the harness. Type a message and press Enter. Ctrl+C ends the chat.\n');
        else if (saidLost) print('Connected to the harness again.\n');
        first = false;
        saidLost = false;
        try {
          for await (const ev of readEventStream(body)) {
            let data: unknown;
            try {
              data = JSON.parse(ev.data);
            } catch {
              continue;
            }
            onEvent(ev.event, data);
          }
        } catch {
          // The stream dropped or was aborted.
        }
      }

      if (ended.signal.aborted) break;
      first = false;
      if (!saidLost) {
        print('The connection to the harness was lost. Trying to connect again.\n');
        saidLost = true;
      }
      try {
        await delay(reconnectDelayMs, undefined, { signal: ended.signal });
      } catch {
        // The chat ended during the wait.
      }
    }
  }

  const loop = streamLoop();

  rl.on('line', (line) => {
    const text = line.trim();
    if (text === '') {
      if (terminal) rl.prompt();
      return;
    }
    const parsed = parseLine(text, numbers());
    if (parsed.kind === 'error') {
      print(parsed.message);
      return;
    }
    if (parsed.kind === 'chat') {
      track(() => sendMessage(text));
      return;
    }
    const w = [...waiting.values()].find((x) => x.number === parsed.number);
    if (!w) return;
    const body: ChatApprovalBody = { decision: parsed.decision };
    if (parsed.reason !== undefined) body.reason = parsed.reason;
    track(() => sendAnswer(w, body));
  });

  // Ctrl+C in a terminal closes the input, which ends the chat like the end of input does.
  rl.on('SIGINT', () => rl.close());
  const onProcessSigint = () => rl.close();
  if (input === process.stdin) process.once('SIGINT', onProcessSigint);

  await new Promise<void>((resolve) => rl.once('close', resolve));
  process.off('SIGINT', onProcessSigint);
  // Lines typed just before the end of input are still sent.
  await Promise.allSettled([...pending]);
  ended.abort();
  streamAbort?.abort();
  await loop;
  if (terminal) write('');
}
