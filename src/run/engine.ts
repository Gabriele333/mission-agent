import type { CanUseTool, HookCallback, HookJSONOutput, PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { pathsFor, type Paths } from '../paths.js';
import { MissingCredentialError, MODEL_API_KEY, type SecretCache } from '../secrets/index.js';
import type {
  ApprovalAnswer,
  ApprovalQueue,
  Gate,
  GateDecision,
  LoadedConfig,
  Manifest,
  MissionId,
  MissionRegistry,
  Redactor,
  RunEngine,
  RunInput,
  RunLimits,
  RunRequest,
  RunResult,
  RunStatus,
  Store,
  ToolCall,
  ToolCatalog,
  ToolDefinition,
  ToolHost,
  ToolProvision,
} from '../types.js';
import { RunClock } from './clock.js';
import { configDirFor, notLoggedInText } from './login.js';
import { MessageCollector, errorText, type UsageTotals } from './messages.js';
import { buildRunOptions, hostEnvFromProcess, resolveLimits, type HostEnv } from './options.js';
import { sdkQuery, userMessage, type QueryFn, type RunQuery } from './sdk.js';

/** The run engine: one run of one mission through the SDK (§2.1, §C, §D, §H). */

export interface RunEngineDeps {
  paths: Paths;
  config: () => LoadedConfig;
  registry: MissionRegistry;
  store: Store;
  gate: Gate;
  approvals: ApprovalQueue;
  tools: ToolCatalog;
  toolHost: ToolHost;
  secrets: Pick<SecretCache, 'get' | 'pick'>;
  redactor: Redactor;
  /** Undefined uses `state/claude`. Null leaves `CLAUDE_CONFIG_DIR` out (live tests only). Never read from a file. */
  sdkConfigDir?: string | null;
  /** Defaults to the SDK's `query`. */
  queryFn?: QueryFn;
  now?: () => Date;
  /** The time zone of the date in the run's input. Defaults to the machine's. */
  timeZone?: string;
  hostEnv?: HostEnv;
  /** Receives every SDK message, for traces and tests. Must not throw. */
  onMessage?: (missionId: MissionId, message: SDKMessage) => void;
  /** Receives problems that do not change a run's outcome, such as a logbook write that failed. */
  log?: (text: string) => void;
}

/** How long the engine waits for the SDK to end after an interrupt or a result before it closes it. */
const CLOSE_AFTER_MS = 15_000;
/** The longest input text kept in a logbook row. */
const MAX_LOG_INPUT_CHARS = 2000;
const TOTALS_KEY = 'run.session_totals:';

interface ActiveRun {
  query?: RunQuery;
  /** Set by stop() or by the time limit. */
  stopReason?: 'stop' | 'time';
  closeTimer?: ReturnType<typeof setTimeout>;
}

interface AttemptOutcome {
  status: RunStatus;
  error?: string;
  loginFailure: boolean;
  sessionNotFound: boolean;
  sessionId?: string;
  finalText: string;
  usage: UsageTotals;
  steps: number;
  toolsCalled: string[];
}

export function createRunEngine(deps: RunEngineDeps): RunEngine {
  const queryFn = deps.queryFn ?? sdkQuery;
  const now = deps.now ?? (() => new Date());
  const timeZone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const active = new Map<MissionId, ActiveRun>();

  async function run(req: RunRequest): Promise<RunResult> {
    const startedAt = now();
    // The check and the entry happen before any await, so two calls cannot both pass.
    if (active.has(req.missionId)) {
      return refused(startedAt, `A run of the mission ${req.missionId} is already in progress.`);
    }
    const manifest = deps.registry.get(req.missionId);
    if (manifest === undefined) return refused(startedAt, `The mission ${req.missionId} does not exist.`);
    const entry: ActiveRun = {};
    active.set(req.missionId, entry);
    try {
      return await runMission(req, manifest, entry, startedAt);
    } finally {
      if (entry.closeTimer !== undefined) clearTimeout(entry.closeTimer);
      active.delete(req.missionId);
    }
  }

  async function runMission(req: RunRequest, manifest: Manifest, entry: ActiveRun, startedAt: Date): Promise<RunResult> {
    const loaded = deps.config();
    const cfg = loaded.config;
    const configDir = configDirFor(deps.paths, deps.sdkConfigDir);
    const limits = resolveLimits(cfg.runLimits, manifest);
    const outcomeBase = { usage: zeroUsage(), steps: 0, toolsCalled: [], finalText: '', loginFailure: false, sessionNotFound: false };

    const early = (error: string, loginFailure = false) =>
      finish(req, manifest, startedAt, { ...outcomeBase, status: 'failed', error, loginFailure }, false);

    if (manifest.status !== 'active') return early(`The mission ${manifest.name} is ${manifest.status} and does not run.`);

    let apiKey: string | undefined;
    if (cfg.modelLogin === 'api_key') {
      apiKey = deps.secrets.get(MODEL_API_KEY);
      if (!apiKey) return early(notLoggedInText('api_key', configDir), true);
    }

    let provisions: ToolProvision[];
    try {
      provisions = collectProvisions(manifest);
    } catch (err) {
      return early(`The run did not start: ${errorText(err)}`);
    }

    if (configDir !== null) {
      try {
        mkdirSync(configDir, { recursive: true });
      } catch {
        // Claude Code reports a folder it cannot use.
      }
    }

    const clock = new RunClock(limits.maxMinutes * 60_000, () => halt(entry, 'time'), () => now().getTime());
    let sessionId = deps.store.getSession(manifest.id);
    let notices = [...req.notices];
    let retriesLeft = Math.max(0, Math.floor(cfg.retriesAfterFailure));
    let retried = false;
    let freshSessionTried = false;
    let sessionNote: string | undefined;
    const sum: AttemptOutcome = { ...outcomeBase, status: 'failed', toolsCalled: [] };
    let last: AttemptOutcome | undefined;

    for (let first = true; ; first = false) {
      if (entry.stopReason !== undefined) break;
      if (!first) {
        try {
          provisions = collectProvisions(manifest);
        } catch (err) {
          last = { ...outcomeBase, status: 'failed', error: `The run did not start again: ${errorText(err)}` };
          break;
        }
      }
      const outcome = await attempt({ req, manifest, loaded, provisions, sessionId, apiKey, notices, entry, clock, limits });
      last = outcome;
      addUp(sum, outcome);

      if (outcome.sessionNotFound && sessionId !== undefined && !freshSessionTried) {
        // The saved session is gone. Start a new one once. This is not a retry (§C.3).
        freshSessionTried = true;
        sessionNote = `The saved session ${sessionId} was not found, so a new session was started.`;
        safe(() => deps.store.deleteSession(manifest.id));
        sessionId = undefined;
        notices = [...req.notices, 'The earlier conversation of this mission could not be found. This is a new conversation.'];
        continue;
      }
      if (outcome.sessionId !== undefined) {
        sessionId = outcome.sessionId;
        safe(() => deps.store.setSession(manifest.id, outcome.sessionId as string));
      }
      if (
        outcome.status === 'failed' &&
        !outcome.loginFailure &&
        retriesLeft > 0 &&
        entry.stopReason === undefined &&
        !clock.hasExpired()
      ) {
        retriesLeft -= 1;
        retried = true;
        notices = [...req.notices, `The harness is trying this run again because the previous attempt failed: ${outcome.error ?? 'unknown error'}`];
        continue;
      }
      break;
    }
    clock.pause();

    let final: AttemptOutcome;
    if (entry.stopReason === 'stop') final = { ...sum, status: 'stopped', error: 'The run was stopped by the user.' };
    else if (entry.stopReason === 'time') final = { ...sum, status: 'limit', error: timeLimitText(limits) };
    else final = { ...sum, status: last?.status ?? 'failed', error: last?.error, loginFailure: last?.loginFailure ?? false };
    final.finalText = last?.finalText ?? '';
    final.sessionId = sessionId;
    if (final.status === 'failed' && sessionNote !== undefined) final.error = `${final.error ?? 'The run failed.'} Note: ${sessionNote}`;
    return finish(req, manifest, startedAt, final, retried);
  }

  /** Every always-on tool and every tool the manifest lists, each with only its own credentials (§A.5). */
  function collectProvisions(manifest: Manifest): ToolProvision[] {
    const tools: ToolDefinition[] = [];
    for (const t of deps.tools.alwaysOn()) if (!tools.includes(t)) tools.push(t);
    for (const id of manifest.tools) {
      const t = deps.tools.get(id);
      if (t === undefined) throw new Error(`the tool ${id} is not part of the harness.`);
      if (!tools.includes(t)) tools.push(t);
    }
    const missing: string[] = [];
    const picked = new Map<ToolDefinition, Record<string, string>>();
    for (const t of tools) {
      try {
        picked.set(t, t.credentials.length > 0 ? deps.secrets.pick(t.credentials) : {});
      } catch (err) {
        if (!(err instanceof MissingCredentialError)) throw err;
        for (const id of err.ids) if (!missing.includes(id)) missing.push(id);
      }
    }
    if (missing.length > 0) throw new MissingCredentialError(missing);
    return tools.map((t) => {
      try {
        return t.provide({ missionId: manifest.id, root: deps.paths.root, credentials: picked.get(t) ?? {}, host: deps.toolHost });
      } catch (err) {
        throw new Error(`the tool ${t.id ?? 'that every mission has'} could not be prepared (${errorText(err)}).`);
      }
    });
  }

  interface AttemptInput {
    req: RunRequest;
    manifest: Manifest;
    loaded: LoadedConfig;
    provisions: ToolProvision[];
    sessionId: string | undefined;
    apiKey: string | undefined;
    notices: string[];
    entry: ActiveRun;
    clock: RunClock;
    limits: RunLimits;
  }

  async function attempt(a: AttemptInput): Promise<AttemptOutcome> {
    const { manifest, entry, clock } = a;
    const missionId = manifest.id;
    const configDir = configDirFor(deps.paths, deps.sdkConfigDir);
    const asks = new Map<string, { toolName: string; input: Record<string, unknown>; decision: GateDecision }>();

    /** The gate with the mission's current manifest, so a freeze during the run takes effect at once. */
    const checkGate = (call: ToolCall): GateDecision => {
      const current = deps.registry.get(missionId);
      if (current === undefined) return { decision: 'deny', message: 'The tool call is refused: the mission no longer exists.' };
      return deps.gate.check(call, current);
    };

    const preToolUse: HookCallback = async (input, toolUseId) => {
      try {
        if (input.hook_event_name !== 'PreToolUse') return {};
        const call: ToolCall = {
          toolName: input.tool_name,
          input: asRecord(input.tool_input),
          toolUseId: input.tool_use_id ?? toolUseId ?? '',
        };
        const decision = checkGate(call);
        if (decision.decision === 'ask') asks.set(call.toolUseId, { toolName: call.toolName, input: call.input, decision });
        return hookOutput(decision);
      } catch (err) {
        return hookOutput({ decision: 'deny', message: `The tool call is refused: the safety check failed (${errorText(err)}).` });
      }
    };

    const canUseTool: CanUseTool = async (toolName, input, opts) => {
      try {
        const recorded = asks.get(opts.toolUseID);
        asks.delete(opts.toolUseID);
        // Only an ask that the hook made for this exact call counts. Anything else goes through the gate again.
        const decision =
          recorded !== undefined && recorded.toolName === toolName && isDeepStrictEqual(recorded.input, input)
            ? recorded.decision
            : checkGate({ toolName, input, toolUseId: opts.toolUseID });
        if (decision.decision === 'allow') return { behavior: 'allow', updatedInput: input };
        if (decision.decision === 'deny') return { behavior: 'deny', message: decision.message };
        if (entry.stopReason !== undefined) return { behavior: 'deny', message: 'The run was stopped, so the action did not run.' };

        clock.beginWait();
        let answer: ApprovalAnswer;
        try {
          const request = { missionId, action: decision.action, toolName, input, ...(decision.note !== undefined ? { note: decision.note } : {}) };
          answer = await deps.approvals.request(request);
        } finally {
          clock.endWait();
        }
        if (entry.stopReason !== undefined && answer.kind === 'approved') {
          return { behavior: 'deny', message: 'The run was stopped, so the action did not run.' };
        }
        return permissionFor(answer, decision.action, input);
      } catch (err) {
        return { behavior: 'deny', message: `The action is refused: the approval step failed (${errorText(err)}).` };
      }
    };

    const collector = new MessageCollector();
    let built: ReturnType<typeof buildRunOptions>;
    let runPaths: Paths;
    try {
      runPaths = realPaths(deps.paths);
      built = buildRunOptions({
        manifest,
        loaded: a.loaded,
        paths: runPaths,
        provisions: a.provisions,
        ...(a.sessionId !== undefined ? { resume: a.sessionId } : {}),
        ...(a.apiKey !== undefined ? { modelApiKey: a.apiKey } : {}),
        sdkConfigDir: configDir,
        coreMemoryText: readText(runPaths.coreMemoryFile),
        hostEnv: deps.hostEnv ?? hostEnvFromProcess(),
        hooks: { preToolUse, canUseTool },
        input: a.req.input,
        notices: a.notices,
        now: now(),
        timeZone,
      });
    } catch (err) {
      return { ...emptyOutcome(), error: `The run did not start: ${errorText(err)}` };
    }

    let endInput: () => void = () => {};
    const inputDone = new Promise<void>((resolve) => {
      endInput = resolve;
    });
    // The prompt is a stream so that interrupt() works. It stays open until the result arrives.
    async function* input(): AsyncGenerator<ReturnType<typeof userMessage>> {
      yield userMessage(built.prompt);
      await inputDone;
    }

    let q: RunQuery;
    try {
      q = queryFn({ prompt: input(), options: built.options });
    } catch (err) {
      endInput();
      return { ...emptyOutcome(), error: `The SDK call could not start: ${errorText(err)}` };
    }
    entry.query = q;
    if (entry.stopReason !== undefined) halt(entry, entry.stopReason);
    clock.start();
    try {
      for await (const msg of q) {
        collector.add(msg);
        if (deps.onMessage) safe(() => deps.onMessage?.(missionId, msg));
        if (msg.type === 'result') {
          endInput();
          armClose(entry);
        }
      }
    } catch (err) {
      // After an error result the SDK also throws. The result is already read.
      collector.thrown = err;
    } finally {
      clock.pause();
      endInput();
      entry.query = undefined;
      if (entry.closeTimer !== undefined) clearTimeout(entry.closeTimer);
      entry.closeTimer = undefined;
    }

    return classify(collector, entry, a.limits, a.loaded.config.modelLogin, configDir, missionId);
  }

  function classify(
    c: MessageCollector,
    entry: ActiveRun,
    limits: RunLimits,
    login: LoadedConfig['config']['modelLogin'],
    configDir: string | null,
    missionId: MissionId,
  ): AttemptOutcome {
    const sessionNotFound = c.sessionNotFound();
    const realSession = sessionNotFound ? undefined : c.realSessionId();
    const usage = c.result !== undefined ? usageOfRun(missionId, realSession, c.result.totals) : zeroUsage();
    const base = {
      loginFailure: false,
      sessionNotFound,
      sessionId: realSession,
      finalText: c.loginError !== undefined ? '' : c.finalText(),
      usage,
      steps: c.steps(),
      toolsCalled: [...c.toolsCalled],
    };
    const r = c.result;
    if (entry.stopReason === 'stop') return { ...base, status: 'stopped', error: 'The run was stopped by the user.' };
    if (entry.stopReason === 'time') return { ...base, status: 'limit', error: timeLimitText(limits) };
    if (c.loginError !== undefined) {
      return { ...base, status: 'failed', loginFailure: true, error: notLoggedInText(login, configDir, c.loginError) };
    }
    if (c.refused) return { ...base, status: 'declined', error: 'The model declined the request.' };
    if (r !== undefined) {
      if (r.subtype === 'error_max_turns' || r.terminalReason === 'max_turns') {
        return { ...base, status: 'limit', error: `The run reached its limit of ${limits.maxSteps} steps.` };
      }
      if (r.subtype === 'error_max_budget_usd' || r.terminalReason === 'budget_exhausted') {
        return { ...base, status: 'limit', error: `The run reached its cost limit of ${limits.maxCostUsd} dollars.` };
      }
      if (r.subtype === 'success' && !r.isError) return { ...base, status: 'success' };
      const detail = r.errors.join('; ') || (r.isError ? r.result : undefined) || `the SDK ended the run with "${r.subtype}"`;
      return { ...base, status: 'failed', error: `The run failed: ${detail}` };
    }
    const thrown = errorText(c.thrown);
    return { ...base, status: 'failed', error: `The run failed: ${thrown || 'the SDK ended without a result'}` };
  }

  /**
   * The cost and tokens of this call alone. The SDK reports totals for the whole session,
   * so the totals saved after the session's previous run are subtracted. When the SDK's
   * total is lower than the saved one, it started counting again and its total is used.
   */
  function usageOfRun(missionId: MissionId, sessionId: string | undefined, totals: UsageTotals): UsageTotals {
    const key = TOTALS_KEY + missionId;
    let before = zeroUsage();
    try {
      const saved = deps.store.getState(key);
      if (saved !== undefined && sessionId !== undefined) {
        const parsed = JSON.parse(saved) as UsageTotals & { sessionId?: string };
        if (parsed.sessionId === sessionId) before = parsed;
      }
    } catch {
      before = zeroUsage();
    }
    if (sessionId !== undefined) safe(() => deps.store.setState(key, JSON.stringify({ sessionId, ...totals })));
    const minus = (now: number, then: number) => (now >= then ? now - then : now);
    return {
      costUsd: minus(totals.costUsd, num(before.costUsd)),
      inputTokens: minus(totals.inputTokens, num(before.inputTokens)),
      outputTokens: minus(totals.outputTokens, num(before.outputTokens)),
    };
  }

  /** Writes the logbook row (§E.2.2) and builds the result. Every text is redacted first. */
  function finish(req: RunRequest, manifest: Manifest, startedAt: Date, o: AttemptOutcome, retried: boolean): RunResult {
    const endedAt = now();
    const redact = (t: string) => {
      try {
        return deps.redactor.redact(t);
      } catch {
        return '[text removed: the redactor failed]';
      }
    };
    const finalText = redact(o.finalText);
    const error = o.status === 'success' || o.error === undefined ? undefined : redact(o.error);
    const result: RunResult = {
      status: o.status,
      finalText,
      costUsd: o.usage.costUsd,
      inputTokens: o.usage.inputTokens,
      outputTokens: o.usage.outputTokens,
      steps: o.steps,
      toolsCalled: o.toolsCalled,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      retried,
    };
    if (o.sessionId !== undefined) result.sessionId = o.sessionId;
    if (error !== undefined) result.error = error;
    try {
      deps.store.insertRun({
        missionId: manifest.id,
        manifestVersion: manifest.version,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        input: cut(redact(inputSummary(req.input)), MAX_LOG_INPUT_CHARS),
        toolsCalled: result.toolsCalled,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        status: result.status,
        ...(error !== undefined ? { error } : {}),
        finalText,
      });
    } catch (err) {
      deps.log?.(`The logbook row of a run of ${manifest.id} could not be written: ${errorText(err)}`);
    }
    return result;
  }

  /** A run that never started and has no logbook row: no mission, or one already running. */
  function refused(startedAt: Date, error: string): RunResult {
    const t = startedAt.toISOString();
    return {
      status: 'failed',
      finalText: '',
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      steps: 0,
      toolsCalled: [],
      error,
      startedAt: t,
      endedAt: now().toISOString(),
      retried: false,
    };
  }

  /** Interrupts the SDK call. If it does not end soon, closes it. */
  function halt(entry: ActiveRun, reason: 'stop' | 'time'): void {
    if (entry.stopReason === undefined) entry.stopReason = reason;
    const q = entry.query;
    if (q === undefined) return;
    try {
      void q.interrupt().catch(() => closeQuery(entry));
    } catch {
      closeQuery(entry);
    }
    armClose(entry);
  }

  function armClose(entry: ActiveRun): void {
    if (entry.closeTimer !== undefined) return;
    entry.closeTimer = setTimeout(() => closeQuery(entry), CLOSE_AFTER_MS);
  }

  function closeQuery(entry: ActiveRun): void {
    try {
      entry.query?.close();
    } catch {
      // Already closed.
    }
  }

  return {
    run,
    async stop(missionId) {
      const entry = active.get(missionId);
      if (entry === undefined) return false;
      entry.stopReason = 'stop';
      // An action of the run that waits for approval is cancelled (§B.1).
      safe(() => deps.approvals.cancelForMission(missionId, 'the run was stopped'));
      halt(entry, 'stop');
      return true;
    },
    running() {
      return [...active.keys()];
    },
  };
}

function hookOutput(decision: GateDecision): HookJSONOutput {
  if (decision.decision === 'allow') {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
  }
  if (decision.decision === 'deny') {
    return {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.message },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: decision.note ?? `The action ${decision.action} waits for the user's approval.`,
    },
  };
}

function permissionFor(answer: ApprovalAnswer, action: string, input: Record<string, unknown>): PermissionResult {
  switch (answer.kind) {
    case 'approved':
      return { behavior: 'allow', updatedInput: input };
    case 'rejected':
      return {
        behavior: 'deny',
        message:
          `The user rejected this action (${action}), so it did not run.` +
          (answer.reason ? ` The user's reason: ${answer.reason}` : ' The user gave no reason.'),
      };
    case 'cancelled':
      return { behavior: 'deny', message: `The approval request for ${action} was cancelled (${answer.reason}), so the action did not run.` };
  }
}

/** The root with every link resolved, so the SDK sees the same paths as the gate. */
function realPaths(paths: Paths): Paths {
  try {
    return pathsFor(realpathSync.native(paths.root));
  } catch {
    return paths;
  }
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function inputSummary(input: RunInput): string {
  if (input.kind === 'chat') return input.text;
  return input.events.map((e) => `${e.triggerId}: ${e.summary}`).join('\n');
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more characters)`;
}

function timeLimitText(limits: RunLimits): string {
  return `The run reached its time limit of ${limits.maxMinutes} minutes.`;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function zeroUsage(): UsageTotals {
  return { costUsd: 0, inputTokens: 0, outputTokens: 0 };
}

function emptyOutcome(): AttemptOutcome {
  return {
    status: 'failed',
    loginFailure: false,
    sessionNotFound: false,
    finalText: '',
    usage: zeroUsage(),
    steps: 0,
    toolsCalled: [],
  };
}

function addUp(sum: AttemptOutcome, o: AttemptOutcome): void {
  sum.usage = {
    costUsd: sum.usage.costUsd + o.usage.costUsd,
    inputTokens: sum.usage.inputTokens + o.usage.inputTokens,
    outputTokens: sum.usage.outputTokens + o.usage.outputTokens,
  };
  sum.steps += o.steps;
  for (const t of o.toolsCalled) if (!sum.toolsCalled.includes(t)) sum.toolsCalled.push(t);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // A failure here must not change the run's outcome.
  }
}
