import type { AccountInfo, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createMemoryStore } from '../db/index.js';
import { initMsg, resultMsg, textMsg } from '../run/test-helpers.js';
import type { QueryFn, RunQuery } from '../run/index.js';
import { makeHarness } from '../tools/test-helpers.js';
import {
  SYS_GENERAL,
  type AgentConfig,
  type ApprovalRequest,
  type ManifestDraft,
  type MissionId,
  type OutgoingMessage,
  type RunRequest,
  type RunResult,
  type Store,
  type Surface,
  type SurfaceHost,
  type TriageInput,
  type TriageResult,
  type TriggerEvent,
} from '../types.js';
import { createDispatcher, type Dispatcher } from './dispatcher.js';
import { createSurfaceSet } from './surfaces.js';

// ---------------------------------------------------------------- a fake run engine

export interface HeldRun {
  req: RunRequest;
  finish(result?: Partial<RunResult>): void;
}

export interface FakeEngine {
  run(req: RunRequest): Promise<RunResult>;
  stop(missionId: MissionId): Promise<boolean>;
  running(): MissionId[];
  /** Every request, in the order the dispatcher made them. */
  requests: RunRequest[];
  /** Runs that wait for `finish`. Only filled while `hold` is true. */
  held: HeldRun[];
  /** When true, a run waits until the test finishes it. When false, it ends at once with `respond`. */
  hold: boolean;
  respond(req: RunRequest): Partial<RunResult>;
  stops: MissionId[];
}

export function result(fields: Partial<RunResult> = {}): RunResult {
  return {
    status: 'success',
    finalText: 'done',
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    steps: 1,
    toolsCalled: [],
    startedAt: '2026-11-25T10:00:00.000Z',
    endedAt: '2026-11-25T10:00:01.000Z',
    retried: false,
    ...fields,
  };
}

export function fakeEngine(): FakeEngine {
  const active = new Map<MissionId, HeldRun>();
  const engine: FakeEngine = {
    requests: [],
    held: [],
    hold: false,
    stops: [],
    respond: (req) => ({ finalText: req.input.kind === 'chat' ? `answer to: ${req.input.text}` : 'event run done' }),
    async run(req) {
      engine.requests.push(req);
      if (active.has(req.missionId)) return result({ status: 'failed', error: 'already in progress' });
      if (!engine.hold) {
        await Promise.resolve();
        return result(engine.respond(req));
      }
      return new Promise<RunResult>((resolve) => {
        const held: HeldRun = {
          req,
          finish(fields) {
            active.delete(req.missionId);
            const i = engine.held.indexOf(held);
            if (i !== -1) engine.held.splice(i, 1);
            resolve(result(fields ?? engine.respond(req)));
          },
        };
        active.set(req.missionId, held);
        engine.held.push(held);
      });
    },
    async stop(missionId) {
      engine.stops.push(missionId);
      const held = active.get(missionId);
      if (held === undefined) return false;
      held.finish({ status: 'stopped', error: 'The run was stopped by the user.', finalText: '' });
      return true;
    },
    running: () => [...active.keys()],
  };
  return engine;
}

// ---------------------------------------------------------------- fake surfaces

export interface FakeSurface extends Surface {
  sent: OutgoingMessage[];
  shown: ApprovalRequest[];
  closed: { id: string; outcome: string }[];
  /** How often the harness said that the set of missions changed. */
  changes: number;
  /** Every sign that the agent works, in order. `open` is false once it was stopped. */
  signs: { open: boolean; startedAfter: number }[];
  host?: SurfaceHost;
  texts(): string[];
}

/** A surface for tests. `full` gives it the two optional operations, as Telegram has them. */
export function fakeSurface(id: string, full: boolean): FakeSurface {
  const s: FakeSurface = {
    id,
    credentials: [],
    sent: [],
    shown: [],
    closed: [],
    changes: 0,
    signs: [],
    texts: () => s.sent.map((m) => m.text),
    async start(host) {
      s.host = host;
    },
    async stop() {},
    async send(msg) {
      s.sent.push(msg);
    },
    async showApproval(req) {
      s.shown.push(req);
    },
    async closeApproval(reqId, outcome) {
      s.closed.push({ id: reqId, outcome });
    },
  };
  if (full) {
    s.missionsChanged = async () => {
      s.changes += 1;
    };
    s.showWorking = () => {
      const sign = { open: true, startedAfter: s.sent.length };
      s.signs.push(sign);
      return {
        stop() {
          sign.open = false;
        },
      };
    };
  }
  return s;
}

// ---------------------------------------------------------------- a dispatcher with fakes around it

export const TERMINAL = 'surface:terminal';
export const TELEGRAM = 'surface:telegram';

export interface DispatcherRig {
  dispatcher: Dispatcher;
  engine: FakeEngine;
  store: Store;
  terminal: FakeSurface;
  telegram: FakeSurface;
  config: AgentConfig;
  /** What the classifier answers. Default: the general mission with confidence 0. */
  classify: (text: string, input: TriageInput) => TriageResult | Promise<TriageResult>;
  /** Every input the classifier received. */
  triageInputs: TriageInput[];
  pending: ApprovalRequest[];
  cancelled: { missionId: MissionId; reason: string }[];
  clock: { now: Date };
  timers: { fn: () => void; ms: number }[];
  logs: string[];
  registry: ReturnType<typeof makeHarness>['registry'];
  paths: ReturnType<typeof makeHarness>['paths'];
  create(draft: Partial<ManifestDraft> & { name: string }): MissionId;
  /** Builds a second dispatcher on the same store, as after a restart. */
  restart(): Dispatcher;
  event(triggerId: string, key: string, summary?: string): TriggerEvent;
  approval(missionId: MissionId, action?: string): ApprovalRequest;
  cleanUp(): void;
}

export function dispatcherRig(options: { defaultSurface?: 'terminal' | 'telegram'; store?: Store } = {}): DispatcherRig {
  const h = makeHarness();
  const store = options.store ?? createMemoryStore();
  const engine = fakeEngine();
  const terminal = fakeSurface(TERMINAL, false);
  const telegram = fakeSurface(TELEGRAM, true);
  const config: AgentConfig = { ...h.config, defaultSurface: options.defaultSurface ?? 'terminal' };
  const surfaces = createSurfaceSet(() => (config.defaultSurface === 'telegram' ? TELEGRAM : TERMINAL), terminal);
  surfaces.add(telegram);
  const host: SurfaceHost = {
    incoming: async () => {},
    answerApproval: () => false,
    label: (id) => (id === null ? 'Ada' : `Ada · ${h.registry.get(id)?.name ?? id}`),
    store,
  };
  void terminal.start(host);
  void telegram.start(host);

  const rig: DispatcherRig = {
    engine,
    store,
    terminal,
    telegram,
    config,
    classify: () => ({ missionId: SYS_GENERAL, confidence: 0 }),
    triageInputs: [],
    pending: [],
    cancelled: [],
    clock: { now: new Date(2026, 10, 25, 10, 0, 0) },
    timers: [],
    logs: [],
    registry: h.registry,
    paths: h.paths,
    dispatcher: undefined as unknown as Dispatcher,
    create(draft) {
      return h.registry.create({
        description: `The ${draft.name} mission`,
        triggers: [{ use: 'trigger:chat' }],
        tools: [],
        context: { instructions: 'Test.' },
        signals: [],
        gates: [],
        ...draft,
      }).id;
    },
    restart: () => build(),
    event: (triggerId, key, summary = `event ${key}`) => ({ triggerId, key, summary, time: rig.clock.now.toISOString(), data: {} }),
    approval(missionId, action = 'action:email.send') {
      const req: ApprovalRequest = {
        id: `apr_${rig.pending.length + 1}`,
        missionId,
        action,
        toolName: 'mcp__x__y',
        input: {},
        createdAt: rig.clock.now.toISOString(),
        expiresAt: rig.clock.now.toISOString(),
      };
      rig.pending.push(req);
      return req;
    },
    cleanUp: () => h.cleanUp(),
  };

  function build(): Dispatcher {
    return createDispatcher({
      registry: h.registry,
      store,
      engine,
      approvals: {
        pending: () => [...rig.pending],
        cancelForMission(missionId, reason) {
          rig.cancelled.push({ missionId, reason });
          rig.pending = rig.pending.filter((r) => r.missionId !== missionId);
        },
      },
      triage: {
        classify: async (input) => {
          rig.triageInputs.push(structuredClone(input));
          return rig.classify(input.text, input);
        },
      },
      config: () => config,
      surfaces,
      label: host.label,
      paths: h.paths,
      now: () => rig.clock.now,
      setTimer: (fn, ms) => {
        rig.timers.push({ fn, ms });
        return rig.timers.length;
      },
      clearTimer: () => {},
      log: (t) => rig.logs.push(t),
    });
  }
  rig.dispatcher = build();
  return rig;
}

// ---------------------------------------------------------------- a fake SDK query for the whole harness

export interface ScriptedCall {
  prompt: string;
  options: Options;
}

/**
 * A `query` that answers each call with the messages the handler returns. Triage calls are
 * the ones with `maxTurns: 1` and no tools. The account answers the login check.
 */
export function scriptedQuery(
  handler: (call: ScriptedCall) => SDKMessage[] | Promise<SDKMessage[]>,
  account: AccountInfo = { email: 'user@example.com', subscriptionType: 'pro' },
): { queryFn: QueryFn; calls: ScriptedCall[] } {
  const calls: ScriptedCall[] = [];
  const queryFn: QueryFn = ({ prompt, options }) => {
    let closed = false;
    async function* messages(): AsyncGenerator<SDKMessage> {
      let text: string;
      if (typeof prompt === 'string') {
        text = prompt;
      } else {
        const first = await prompt[Symbol.asyncIterator]().next();
        const m = first.value as SDKUserMessage | undefined;
        text = typeof m?.message.content === 'string' ? m.message.content : '';
      }
      const call = { prompt: text, options };
      calls.push(call);
      for (const msg of await handler(call)) {
        if (closed) return;
        yield msg;
      }
    }
    const gen = messages();
    const q: RunQuery = {
      [Symbol.asyncIterator]: () => gen,
      interrupt: async () => undefined,
      close() {
        closed = true;
      },
      accountInfo: async () => account,
    };
    return q;
  };
  return { queryFn, calls };
}

/** True for the call that triage makes (§B.3). */
export function isTriageCall(call: ScriptedCall): boolean {
  return call.options.maxTurns === 1 && Array.isArray(call.options.tools) && call.options.tools.length === 0;
}

/** Answers triage with the general mission and every run with a short text. */
export function simpleAnswers(answer = (prompt: string) => `echo: ${prompt.split('\n').at(-1) ?? ''}`) {
  return (call: ScriptedCall): SDKMessage[] => {
    if (isTriageCall(call)) return [resultMsg({ result: '{"mission": "sys-general", "confidence": 0.1}' })];
    const text = answer(call.prompt);
    return [initMsg('sess-1'), textMsg(text), resultMsg({ result: text, sessionId: 'sess-1', cost: 0.001 })];
  };
}
