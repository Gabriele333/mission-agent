import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** Reads the messages of one `query()` call and keeps what the run engine needs. */

/** Assistant errors that mean the model login is missing or refused (§A.5). Such a run is not retried. */
export const LOGIN_ERRORS: ReadonlySet<string> = new Set(['authentication_failed', 'oauth_org_not_allowed']);

/** The text the SDK puts in `errors` when the session to resume does not exist. */
const SESSION_NOT_FOUND = /No conversation found with session ID/i;

export interface UsageTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** The fields of a result message that the engine reads. */
interface ResultView {
  subtype: string;
  isError: boolean;
  result?: string;
  errors: string[];
  stopReason: string | null;
  terminalReason?: string;
  numTurns: number;
  totals: UsageTotals;
}

export class MessageCollector {
  /** The session id from the init message, or from the first message that carries one. */
  sessionId: string | undefined;
  toolsCalled: string[] = [];
  /** Set when the SDK reports that the login is missing or refused. The SDK's own text. */
  loginError: string | undefined;
  /** Another assistant error, such as `rate_limit`. */
  assistantError: string | undefined;
  /** True when the model refused the request and no fallback model answered. */
  refused = false;
  result: ResultView | undefined;
  thrown: unknown;

  private initSession: string | undefined;
  private messageIds = new Set<string>();
  private lastTextId: string | undefined;
  private lastText = '';

  add(raw: SDKMessage): void {
    const msg = raw as unknown as Record<string, unknown>;
    const sessionId = typeof msg.session_id === 'string' && msg.session_id !== '' ? msg.session_id : undefined;
    if (sessionId !== undefined && this.sessionId === undefined) this.sessionId = sessionId;

    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init' && sessionId !== undefined) {
          this.initSession = sessionId;
          this.sessionId = sessionId;
        }
        if (msg.subtype === 'model_refusal_no_fallback') this.refused = true;
        break;
      case 'assistant':
        this.addAssistant(msg);
        break;
      case 'result':
        this.result = readResult(msg);
        if (this.result.stopReason === 'refusal') this.refused = true;
        break;
      default:
        break;
    }
  }

  /** The session the SDK really used. Undefined when the run never started one. */
  realSessionId(): string | undefined {
    return this.initSession ?? this.sessionId;
  }

  sessionNotFound(): boolean {
    const r = this.result;
    if (r === undefined) return SESSION_NOT_FOUND.test(errorText(this.thrown));
    return r.isError && r.errors.some((e) => SESSION_NOT_FOUND.test(e));
  }

  /** Model calls: the result's turn count, or the assistant messages seen when there is no result. */
  steps(): number {
    return this.result !== undefined ? this.result.numTurns : this.messageIds.size;
  }

  /** The final text: the result's text after a success, else the last text the model wrote. */
  finalText(): string {
    const r = this.result;
    if (r !== undefined && r.subtype === 'success' && !r.isError && typeof r.result === 'string') return r.result;
    return this.lastText;
  }

  private addAssistant(msg: Record<string, unknown>): void {
    const message = (msg.message ?? {}) as Record<string, unknown>;
    const id = typeof message.id === 'string' ? message.id : undefined;
    if (id !== undefined) this.messageIds.add(id);
    const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];
    let text = '';
    for (const block of content) {
      if (block.type === 'tool_use' && typeof block.name === 'string' && !this.toolsCalled.includes(block.name)) {
        this.toolsCalled.push(block.name);
      }
      if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    }
    if (typeof msg.error === 'string') {
      if (LOGIN_ERRORS.has(msg.error)) this.loginError = text || msg.error;
      else this.assistantError = msg.error;
      // A synthetic error message is not the model's answer.
      return;
    }
    if (message.stop_reason === 'refusal') this.refused = true;
    if (text !== '') {
      // While a response streams, several messages share one id and each holds one block.
      this.lastText = id !== undefined && id === this.lastTextId ? `${this.lastText}${text}` : text;
      this.lastTextId = id;
    }
  }
}

function readResult(msg: Record<string, unknown>): ResultView {
  return {
    subtype: typeof msg.subtype === 'string' ? msg.subtype : 'unknown',
    isError: msg.is_error === true,
    result: typeof msg.result === 'string' ? msg.result : undefined,
    errors: Array.isArray(msg.errors) ? msg.errors.filter((e): e is string => typeof e === 'string') : [],
    stopReason: typeof msg.stop_reason === 'string' ? msg.stop_reason : null,
    terminalReason: typeof msg.terminal_reason === 'string' ? msg.terminal_reason : undefined,
    numTurns: typeof msg.num_turns === 'number' ? msg.num_turns : 0,
    totals: usageTotals(msg),
  };
}

/**
 * Cost and tokens of a result. On a resumed session these are totals for the whole session,
 * not for this call (checked with SDK 0.3.325), so the engine subtracts the previous totals.
 * Input tokens include the tokens read from and written to the prompt cache.
 */
function usageTotals(msg: Record<string, unknown>): UsageTotals {
  const costUsd = num(msg.total_cost_usd);
  const models = (msg.modelUsage ?? {}) as Record<string, Record<string, unknown>>;
  let inputTokens = 0;
  let outputTokens = 0;
  const entries = Object.values(models);
  if (entries.length > 0) {
    for (const m of entries) {
      inputTokens += num(m.inputTokens) + num(m.cacheReadInputTokens) + num(m.cacheCreationInputTokens);
      outputTokens += num(m.outputTokens);
    }
  } else {
    const u = (msg.usage ?? {}) as Record<string, unknown>;
    inputTokens = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
    outputTokens = num(u.output_tokens);
  }
  return { costUsd, inputTokens, outputTokens };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function errorText(err: unknown): string {
  if (err === undefined || err === null) return '';
  return err instanceof Error ? err.message : String(err);
}
