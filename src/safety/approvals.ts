import { randomBytes } from 'node:crypto';
import type { AgentConfig, ApprovalAnswer, ApprovalQueue, ApprovalRequest, MissionId, Store } from '../types.js';
import { REGISTRY_ACTIONS, SHELL_TOOL_NAME } from './gate.js';
import { errorText } from './path-rules.js';

/** The approval queue of §G. */

export interface ApprovalQueueOptions {
  store: Pick<Store, 'saveApproval' | 'deleteApproval'>;
  config: () => AgentConfig;
  /** Shows the request on the surfaces. A rejection cancels the request. */
  show(req: ApprovalRequest): Promise<void>;
  /** Tells the surfaces that the request is closed, so they can remove the buttons. */
  close(id: string, outcome: string): Promise<void>;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  newId?: () => string;
  /**
   * Removes secret values from a text (§A.5). The queue applies it to the note and to every text
   * in the input before the request is saved, shown or listed. The caller keeps the original
   * input for the tool call itself.
   */
  redact?: (text: string) => string;
}

interface Waiting {
  req: ApprovalRequest;
  resolve: (answer: ApprovalAnswer) => void;
  timer?: unknown;
}

/** The longest delay that `setTimeout` accepts. A longer wait is split into several timers. */
const MAX_TIMER_MS = 2_147_483_647;
const DEFAULT_WAIT_HOURS = 24;

export function createApprovalQueue(options: ApprovalQueueOptions): ApprovalQueue {
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const newId = options.newId ?? (() => `apr_${randomBytes(8).toString('hex')}`);
  const waiting = new Map<string, Waiting>();
  const redactText = (text: string): string => {
    if (options.redact === undefined) return text;
    try {
      return options.redact(text);
    } catch {
      // Showing the text unredacted could leak a secret, so nothing of it is shown.
      return '[text removed: the redactor failed]';
    }
  };

  function finish(id: string, answer: ApprovalAnswer): boolean {
    const entry = waiting.get(id);
    if (!entry) return false;
    waiting.delete(id);
    if (entry.timer !== undefined) clearTimer(entry.timer);
    try {
      options.store.deleteApproval(id);
    } catch {
      // The request is cleared from the store at the next start (clearStaleApprovals).
    }
    entry.resolve(answer);
    Promise.resolve()
      .then(() => options.close(id, outcomeText(answer)))
      .catch(() => {
        // A surface that cannot remove its buttons changes nothing: the answer is final.
      });
    return true;
  }

  function arm(id: string, leftMs: number, hours: number): void {
    const entry = waiting.get(id);
    if (!entry) return;
    const step = Math.min(leftMs, MAX_TIMER_MS);
    entry.timer = setTimer(() => {
      if (leftMs - step > 0) arm(id, leftMs - step, hours);
      else finish(id, { kind: 'cancelled', reason: `no answer in ${hoursText(hours)}` });
    }, step);
  }

  function request(
    input: Pick<ApprovalRequest, 'missionId' | 'action' | 'toolName' | 'input' | 'note'>,
  ): Promise<ApprovalAnswer> {
    const hours = waitHours(options.config);
    const waitMs = hours * 3_600_000;
    const created = now();
    const req: ApprovalRequest = {
      id: newId(),
      missionId: input.missionId,
      action: input.action,
      toolName: input.toolName,
      input: redactValue(input.input, redactText) as Record<string, unknown>,
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + waitMs).toISOString(),
    };
    if (input.note !== undefined) req.note = redactText(input.note);

    return new Promise<ApprovalAnswer>((resolve) => {
      waiting.set(req.id, { req, resolve });
      try {
        options.store.saveApproval(req);
      } catch (err) {
        finish(req.id, { kind: 'cancelled', reason: `the request could not be saved (${errorText(err)})` });
        return;
      }
      arm(req.id, waitMs, hours);
      Promise.resolve()
        .then(() => options.show({ ...req }))
        .catch((err: unknown) => {
          finish(req.id, {
            kind: 'cancelled',
            reason: `the request could not be shown to the user (${errorText(err)})`,
          });
        });
    });
  }

  return {
    request,
    answer: (id, answer) => finish(id, answer),
    cancelForMission(missionId: MissionId, reason: string) {
      for (const [id, entry] of [...waiting]) {
        if (entry.req.missionId === missionId) finish(id, { kind: 'cancelled', reason });
      }
    },
    cancelAll(reason: string) {
      for (const id of [...waiting.keys()]) finish(id, { kind: 'cancelled', reason });
    },
    pending() {
      return [...waiting.values()]
        .map((e) => ({ ...e.req }))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
  };
}

/**
 * Removes the requests left in the store by an earlier run of the harness and returns them,
 * so the harness can tell the user and each mission (§G). Call it at start-up, before any request.
 */
export function clearStaleApprovals(store: Pick<Store, 'listApprovals' | 'deleteApproval'>): ApprovalRequest[] {
  const stale = store.listApprovals();
  for (const req of stale) store.deleteApproval(req.id);
  return stale;
}

/** A copy of the value with every text in it, keys included, passed through `redact`. */
function redactValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, redact));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k), redactValue(v, redact)]));
  }
  return value;
}

const MAX_VALUE_CHARS = 500;
const MAX_INPUT_CHARS = 2000;

/**
 * The text of a request for a surface. A shell command is shown in full. The input of a registry
 * action is shown in full too, because the user approves the whole manifest change (§4.2).
 * Any other input is shortened, and the text says so. The harness's `details`, when set, come
 * before the input. No hidden or control character reaches the surface as it is: each one is
 * shown as `<U+XXXX>` (see `visibleLine`).
 */
export function describeApproval(req: ApprovalRequest, manifestName: string): string {
  const lines = [`Mission: ${visibleLine(manifestName)}`, `Action: ${visibleLine(req.action)}`];
  const isShell = req.toolName === SHELL_TOOL_NAME;
  const command = typeof req.input.command === 'string' ? req.input.command : (JSON.stringify(req.input.command) ?? '');
  // For a shell call the gate sets the note to the command. The command block below shows it once.
  const note = req.note !== undefined && req.note !== '' && !(isShell && req.note === command) ? req.note : undefined;
  if (note !== undefined) lines.push(`Note: ${visibleLine(note)}`);
  // The details are the harness's own text and use line breaks for layout.
  if (req.details !== undefined && req.details !== '') lines.push(visibleText(req.details));
  if (isShell) {
    lines.push(...commandBlock(command));
    return lines.join('\n');
  }
  const full = (REGISTRY_ACTIONS as readonly string[]).includes(req.action);
  // JSON writes a line break inside a value as \n, so the line breaks left in the text are layout.
  lines.push('Input:', visibleText(full ? JSON.stringify(req.input, null, 2) : shortInput(req.input)));
  return lines.join('\n');
}

/** The mark at the start of each line of a shell command in an approval request. */
export const COMMAND_LINE_PREFIX = '| ';

/**
 * The command as a block in which every line starts with `| `, so no line of the command can look
 * like a line of the request itself. Hidden and control characters are shown as `<U+XXXX>`.
 */
function commandBlock(command: string): string[] {
  const commandLines = command.split('\n').map((l) => `${COMMAND_LINE_PREFIX}${visibleLine(l)}`);
  const count = commandLines.length === 1 ? '1 line' : `${commandLines.length} lines`;
  const head = `Command (${count}, each line starts with "${COMMAND_LINE_PREFIX.trim()}"):`;
  const hidden = countHidden(command.replaceAll('\n', ''));
  const warning =
    hidden === 0
      ? []
      : [`Warning: the command contains ${hidden} hidden or control ${hidden === 1 ? 'character' : 'characters'}, shown as <U+XXXX>.`];
  return [...warning, head, ...commandLines];
}

/**
 * Characters that a terminal or a chat app does not show as they are: C0 and C1 control characters
 * (an ANSI escape sequence starts with one), characters that reorder text (bidirectional marks,
 * embeddings, overrides and isolates), characters with no width, the Unicode line and paragraph
 * separators, and the invisible tag characters.
 */
const HIDDEN =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu;

function escapeChar(ch: string): string {
  return `<U+${(ch.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0')}>`;
}

/**
 * One line with every hidden character shown as `<U+XXXX>`, a line break included. A `<U+` that is
 * already in the text is written as `<U+003C>U+`, so the user can tell it from an escaped character.
 */
export function visibleLine(text: string): string {
  return text.replaceAll('<U+', '<U+003C>U+').replace(HIDDEN, escapeChar);
}

/** Like `visibleLine`, but a line break stays a line break. */
function visibleText(text: string): string {
  return text
    .split('\n')
    .map((l) => visibleLine(l))
    .join('\n');
}

function countHidden(text: string): number {
  return text.match(HIDDEN)?.length ?? 0;
}

function shortInput(input: Record<string, unknown>): string {
  const text = JSON.stringify(shortenValues(input), null, 2) ?? '';
  if (text.length <= MAX_INPUT_CHARS) return text;
  return `${text.slice(0, MAX_INPUT_CHARS)}\n… (${text.length - MAX_INPUT_CHARS} more characters not shown)`;
}

function shortenValues(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length <= MAX_VALUE_CHARS) return value;
    return `${value.slice(0, MAX_VALUE_CHARS)}… (${value.length - MAX_VALUE_CHARS} more characters not shown)`;
  }
  if (Array.isArray(value)) return value.map(shortenValues);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shortenValues(v)]));
  }
  return value;
}

function outcomeText(answer: ApprovalAnswer): string {
  switch (answer.kind) {
    case 'approved':
      return 'approved';
    case 'rejected':
      return answer.reason ? `rejected: ${answer.reason}` : 'rejected';
    case 'cancelled':
      return `cancelled: ${answer.reason}`;
  }
}

function waitHours(config: () => AgentConfig): number {
  const hours = config().approvalWaitHours;
  return typeof hours === 'number' && Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_WAIT_HOURS;
}

function hoursText(hours: number): string {
  return hours === 1 ? '1 hour' : `${hours} hours`;
}
