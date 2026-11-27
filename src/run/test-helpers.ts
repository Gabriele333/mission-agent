import type {
  AccountInfo,
  HookCallback,
  HookJSONOutput,
  Options,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from 'node:events';
import type { QueryFn, RunQuery } from './sdk.js';
import type { SignInChild, SignInSpawn, SignInSpawnOptions } from './sign-in.js';

/** A fake of the SDK's `query()` for unit tests. Each call runs the next script. */

export interface ToolOutcome {
  hook: 'allow' | 'deny' | 'ask' | 'none';
  hookReason?: string;
  /** Set when the fake called `canUseTool`. */
  permission?: PermissionResult;
  /** True when the tool would run. */
  ran: boolean;
}

export interface FakeCall {
  options: Options;
  prompt: string;
  interrupted: boolean;
  closed: boolean;
}

export interface ScriptContext {
  call: FakeCall;
  /** Calls the PreToolUse hook, then `canUseTool` on ask, as the SDK does. */
  useTool(toolName: string, input: Record<string, unknown>, toolUseId?: string): Promise<ToolOutcome>;
  /** Calls `canUseTool` directly, without the hook. */
  askDirectly(toolName: string, input: Record<string, unknown>, toolUseId: string): Promise<PermissionResult>;
  /** Resolves when the engine calls `interrupt()`. */
  interrupted: Promise<void>;
}

export type Script = (ctx: ScriptContext) => AsyncGenerator<SDKMessage, void, unknown>;

export function fakeQuery(
  scripts: Script[],
  account: AccountInfo = {},
): { queryFn: QueryFn; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  let next = 0;
  let toolCounter = 0;

  const queryFn: QueryFn = ({ prompt, options }) => {
    const script = scripts[Math.min(next, scripts.length - 1)];
    next += 1;
    if (script === undefined) throw new Error('fakeQuery: no script');
    const call: FakeCall = { options, prompt: '', interrupted: false, closed: false };
    calls.push(call);
    let onInterrupt: () => void = () => {};
    const interrupted = new Promise<void>((resolve) => {
      onInterrupt = resolve;
    });

    const hook = (): HookCallback => {
      const h = options.hooks?.PreToolUse?.[0]?.hooks[0];
      if (h === undefined) throw new Error('fakeQuery: no PreToolUse hook');
      return h;
    };

    const ctx: ScriptContext = {
      call,
      interrupted,
      async useTool(toolName, input, toolUseId) {
        const id = toolUseId ?? `toolu_${++toolCounter}`;
        const out = (await hook()(
          {
            hook_event_name: 'PreToolUse',
            tool_name: toolName,
            tool_input: input,
            tool_use_id: id,
            session_id: 's',
            transcript_path: '/t',
            cwd: options.cwd ?? '/',
          },
          id,
          { signal: new AbortController().signal },
        )) as HookJSONOutput & { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
        const decision = (out.hookSpecificOutput?.permissionDecision ?? 'none') as ToolOutcome['hook'];
        const reason = out.hookSpecificOutput?.permissionDecisionReason;
        if (decision === 'ask') {
          const permission = await ctx.askDirectly(toolName, input, id);
          return { hook: 'ask', hookReason: reason, permission, ran: permission.behavior === 'allow' };
        }
        return { hook: decision, hookReason: reason, ran: decision === 'allow' };
      },
      async askDirectly(toolName, input, toolUseId) {
        const can = options.canUseTool;
        if (can === undefined) throw new Error('fakeQuery: no canUseTool');
        const res = await can(toolName, input, {
          signal: new AbortController().signal,
          toolUseID: toolUseId,
          requestId: 'r',
        });
        if (res === null) throw new Error('fakeQuery: canUseTool returned null');
        return res;
      },
    };

    async function* run(): AsyncGenerator<SDKMessage, void, unknown> {
      if (typeof prompt === 'string') {
        call.prompt = prompt;
      } else {
        const first = await prompt[Symbol.asyncIterator]().next();
        const m = first.value as SDKUserMessage | undefined;
        call.prompt = typeof m?.message.content === 'string' ? m.message.content : '';
      }
      for await (const msg of script!(ctx)) {
        if (call.closed) return;
        yield msg;
      }
    }

    const gen = run();
    const q: RunQuery = {
      [Symbol.asyncIterator]: () => gen,
      async interrupt() {
        call.interrupted = true;
        onInterrupt();
        return undefined;
      },
      close() {
        call.closed = true;
      },
      async accountInfo() {
        return account;
      },
    };
    return q;
  };

  return { queryFn, calls };
}

// ---------------------------------------------------------------- message builders

export function initMsg(sessionId: string): SDKMessage {
  return { type: 'system', subtype: 'init', session_id: sessionId, tools: [], skills: [], plugins: [] } as unknown as SDKMessage;
}

export function textMsg(text: string, id = 'msg_1', sessionId = 's1'): SDKMessage {
  return {
    type: 'assistant',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { id, role: 'assistant', content: [{ type: 'text', text }], stop_reason: null },
  } as unknown as SDKMessage;
}

export function toolUseMsg(name: string, input: Record<string, unknown>, id = 'msg_t', sessionId = 's1'): SDKMessage {
  return {
    type: 'assistant',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { id, role: 'assistant', content: [{ type: 'tool_use', id: `tu_${name}`, name, input }], stop_reason: null },
  } as unknown as SDKMessage;
}

export function errorAssistantMsg(error: string, text: string, sessionId = 's1'): SDKMessage {
  return {
    type: 'assistant',
    session_id: sessionId,
    parent_tool_use_id: null,
    error,
    message: { id: 'synthetic', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }], stop_reason: 'stop_sequence' },
  } as unknown as SDKMessage;
}

export interface ResultFields {
  subtype?: string;
  isError?: boolean;
  result?: string;
  errors?: string[];
  cost?: number;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string | null;
  terminalReason?: string;
  sessionId?: string;
}

export function resultMsg(f: ResultFields = {}): SDKMessage {
  const subtype = f.subtype ?? 'success';
  return {
    type: 'result',
    subtype,
    is_error: f.isError ?? subtype !== 'success',
    result: f.result ?? (subtype === 'success' ? 'done' : undefined),
    errors: f.errors ?? (subtype === 'success' ? undefined : []),
    total_cost_usd: f.cost ?? 0.01,
    num_turns: f.turns ?? 1,
    stop_reason: f.stopReason ?? null,
    terminal_reason: f.terminalReason,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {
      'claude-haiku-5-5': { inputTokens: f.inputTokens ?? 100, outputTokens: f.outputTokens ?? 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    },
    session_id: f.sessionId ?? 's1',
  } as unknown as SDKMessage;
}

// ---------------------------------------------------------------- a fake of the sign-in program

export interface FakeSignInChild {
  command: string;
  args: readonly string[];
  options: SignInSpawnOptions;
  signals: (NodeJS.Signals | undefined)[];
  /** Ends the fake program with this exit code. */
  exit(code: number | null, signal?: NodeJS.Signals | null): void;
  /** Reports that the program could not start. */
  fail(err: Error): void;
  /** How many listeners the sign-in put on the fake's output streams. It must be none. */
  outputListeners(): number;
}

/** A spawner that starts nothing and records each call. A killed fake ends at once, as the real program does on SIGTERM. */
export function fakeSignInSpawn(): { spawn: SignInSpawn; children: FakeSignInChild[] } {
  const children: FakeSignInChild[] = [];
  const spawn: SignInSpawn = (command, args, options) => {
    const events = new EventEmitter();
    // Streams that a real program with open pipes would have. They hold a value of a sign-in.
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    let ended = false;
    const child: FakeSignInChild & SignInChild & { stdout: EventEmitter; stderr: EventEmitter } = {
      command,
      args,
      options,
      signals: [],
      stdout,
      stderr,
      exit(code, signal = null) {
        if (ended) return;
        ended = true;
        stdout.emit('data', 'Paste code here if prompted > secret-oauth-value');
        events.emit('exit', code, signal);
      },
      fail(err) {
        if (ended) return;
        ended = true;
        events.emit('error', err);
      },
      outputListeners: () => stdout.listenerCount('data') + stderr.listenerCount('data'),
      once(event: string, listener: (...a: never[]) => void) {
        events.once(event, listener as (...a: unknown[]) => void);
        return child;
      },
      kill(signal) {
        child.signals.push(signal);
        queueMicrotask(() => child.exit(null, signal ?? 'SIGTERM'));
        return true;
      },
    } as FakeSignInChild & SignInChild & { stdout: EventEmitter; stderr: EventEmitter };
    children.push(child);
    return child;
  };
  return { spawn, children };
}
