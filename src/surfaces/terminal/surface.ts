import { describeApproval } from '../../safety/index.js';
import type { LocalServer, EventStream } from '../../server/index.js';
import type { ApprovalAnswer, ApprovalRequest, MissionId, OutgoingMessage, Surface, SurfaceHost } from '../../types.js';
import {
  CHAT_APPROVAL_PATH,
  CHAT_MESSAGE_PATH,
  CHAT_STREAM_PATH,
  type ChatApprovalClosedEvent,
  type ChatApprovalEvent,
  type ChatApprovalReply,
  type ChatMessageEvent,
  type ChatNoticeEvent,
} from './events.js';

/** The terminal surface, server side (§F.1 Terminal). The chat program connects to its routes. */

export const TERMINAL_SURFACE_ID = 'surface:terminal';
export const BACKLOG_SIZE = 200;

export interface TerminalSurfaceOptions {
  server: Pick<LocalServer, 'route'>;
  /**
   * The mission name shown in the text of an approval request. When it is not given or returns
   * undefined, the name is the part of the label after ` · `.
   */
  missionName?: (missionId: MissionId) => string | undefined;
  /** How many messages are kept while no chat program is connected. Default 200. */
  backlogSize?: number;
  /** Called when `host.incoming` fails. The user also gets a notice. */
  onError?: (err: unknown) => void;
  now?: () => Date;
}

export interface TerminalSurface extends Surface {
  /** Sends a text from the harness to the chat programs. It is kept like a message when none is connected. */
  notice(text: string, label?: string): void;
  /** The number of chat programs connected now. */
  clientCount(): number;
}

type Kept = { event: 'message'; data: ChatMessageEvent } | { event: 'notice'; data: ChatNoticeEvent };

export function createTerminalSurface(options: TerminalSurfaceOptions): TerminalSurface {
  const backlogSize = options.backlogSize ?? BACKLOG_SIZE;
  const now = options.now ?? (() => new Date());
  const clients = new Set<EventStream>();
  const backlog: Kept[] = [];
  const waiting = new Map<string, ChatApprovalEvent>();
  let host: SurfaceHost | undefined;

  function keepOrSend(item: Kept): void {
    if (clients.size === 0) {
      backlog.push(item);
      if (backlog.length > backlogSize) backlog.splice(0, backlog.length - backlogSize);
      return;
    }
    broadcast(item.event, item.data);
  }

  function broadcast(event: string, data: unknown): void {
    for (const client of [...clients]) {
      try {
        client.send(event, data);
      } catch {
        clients.delete(client);
      }
    }
  }

  function notice(text: string, label = ''): void {
    keepOrSend({ event: 'notice', data: { label, text, sentAt: now().toISOString() } });
  }

  const { server } = options;

  server.route('GET', CHAT_STREAM_PATH, (_req, res) => {
    if (!host) return res.text('The terminal surface is not started.', 503);
    const stream = res.stream();
    clients.add(stream);
    stream.onClose(() => clients.delete(stream));
    for (const item of backlog.splice(0)) stream.send(item.event, { ...item.data, earlier: true });
    for (const req of waiting.values()) stream.send('approval', req);
  });

  server.route('POST', CHAT_MESSAGE_PATH, (req, res) => {
    const h = host;
    if (!h) return res.text('The terminal surface is not started.', 503);
    const body = req.body as { text?: unknown } | undefined;
    if (body === null || typeof body !== 'object' || typeof body.text !== 'string' || body.text.trim() === '') {
      return res.text('The body must be {"text": "<message>"} with a text that is not empty.', 400);
    }
    const text = body.text;
    // The answer arrives on the stream, so the request does not wait for the run.
    Promise.resolve()
      .then(() => h.incoming({ surface: TERMINAL_SURFACE_ID, text }))
      .catch((err: unknown) => {
        try {
          options.onError?.(err);
        } catch {
          // Nothing else to do.
        }
        const why = err instanceof Error ? err.message : String(err);
        notice(`The harness could not handle the message: ${why}`);
      });
    res.json({ ok: true }, 202);
  });

  server.route('POST', CHAT_APPROVAL_PATH, (req, res) => {
    const h = host;
    if (!h) return res.text('The terminal surface is not started.', 503);
    const body = req.body as { decision?: unknown; reason?: unknown } | undefined;
    const decision = body !== null && typeof body === 'object' ? body.decision : undefined;
    const reason = body !== null && typeof body === 'object' ? body.reason : undefined;
    if ((decision !== 'approve' && decision !== 'reject') || (reason !== undefined && typeof reason !== 'string')) {
      return res.text('The body must be {"decision": "approve" | "reject", "reason"?: "<text>"}.', 400);
    }
    let answer: ApprovalAnswer;
    if (decision === 'approve') {
      answer = { kind: 'approved' };
    } else {
      const trimmed = typeof reason === 'string' ? reason.trim() : '';
      answer = trimmed === '' ? { kind: 'rejected' } : { kind: 'rejected', reason: trimmed };
    }
    const reply: ChatApprovalReply = { wasWaiting: h.answerApproval(req.params.id ?? '', answer) };
    res.json(reply);
  });

  return {
    id: TERMINAL_SURFACE_ID,
    hasThreads: false,
    credentials: [],

    async start(h: SurfaceHost) {
      host = h;
    },

    async stop() {
      host = undefined;
      broadcast('notice', { label: '', text: 'The harness is stopping.', sentAt: now().toISOString() });
      for (const client of [...clients]) client.close();
      clients.clear();
      waiting.clear();
      backlog.length = 0;
    },

    async send(msg: OutgoingMessage) {
      const sentAt = now().toISOString();
      if (msg.missionId === null) {
        keepOrSend({ event: 'notice', data: { label: msg.label, text: msg.text, sentAt } });
        return;
      }
      const data: ChatMessageEvent = { missionId: msg.missionId, label: msg.label, text: msg.text, sentAt };
      if (msg.filePath !== undefined) data.filePath = msg.filePath;
      keepOrSend({ event: 'message', data });
    },

    async showApproval(req: ApprovalRequest, label: string) {
      const name = options.missionName?.(req.missionId) ?? missionNameFromLabel(label) ?? req.missionId;
      const event: ChatApprovalEvent = {
        id: req.id,
        missionId: req.missionId,
        label,
        text: describeApproval(req, name),
        createdAt: req.createdAt,
        expiresAt: req.expiresAt,
      };
      waiting.set(req.id, event);
      broadcast('approval', event);
    },

    async closeApproval(id: string, outcome: string) {
      waiting.delete(id);
      const event: ChatApprovalClosedEvent = { id, outcome };
      broadcast('approval_closed', event);
    },

    notice,
    clientCount: () => clients.size,
  };
}

function missionNameFromLabel(label: string): string | undefined {
  const at = label.indexOf(' · ');
  if (at === -1) return undefined;
  const name = label.slice(at + 3).trim();
  return name === '' ? undefined : name;
}
