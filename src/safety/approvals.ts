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
      input: input.input,
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + waitMs).toISOString(),
    };
    if (input.note !== undefined) req.note = input.note;

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

const MAX_VALUE_CHARS = 500;
const MAX_INPUT_CHARS = 2000;

/**
 * The text of a request for a surface. A shell command is shown in full. The input of a registry
 * action is shown in full too, because the user approves the whole manifest change (§4.2).
 * Any other input is shortened, and the text says so.
 */
export function describeApproval(req: ApprovalRequest, manifestName: string): string {
  const lines = [`Mission: ${manifestName}`, `Action: ${req.action}`];
  if (req.note !== undefined && req.note !== '') lines.push(`Note: ${req.note}`);
  if (req.toolName === SHELL_TOOL_NAME) {
    const command = typeof req.input.command === 'string' ? req.input.command : JSON.stringify(req.input.command);
    lines.push('Command:', command);
    return lines.join('\n');
  }
  const full = (REGISTRY_ACTIONS as readonly string[]).includes(req.action);
  lines.push('Input:', full ? JSON.stringify(req.input, null, 2) : shortInput(req.input));
  return lines.join('\n');
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
