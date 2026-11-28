import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative } from 'node:path';
import type { Paths } from '../paths.js';
import { isNotLoggedIn } from '../run/index.js';
import { chatMissions, commandOf, decideChatMission, missionOfCommand, parseCommand, type ParsedCommand } from '../triage/index.js';
import { CHAT_TRIGGER_ID, CRON_TRIGGER_ID } from '../triggers/index.js';
import {
  SYS_GENERAL,
  type AgentConfig,
  type ApprovalQueue,
  type IncomingMessage,
  type Manifest,
  type MissionId,
  type MissionRegistry,
  type OutgoingMessage,
  type RecentLine,
  type RunEngine,
  type RunInput,
  type RunResult,
  type Store,
  type TriggerEvent,
  type Triage,
  type WorkingSign,
} from '../types.js';
import {
  inputSummary,
  localDate,
  markRunEnded,
  markRunStarted,
  pauseReason,
  readPause,
  resumeHint,
  startOfLocalDay,
  startOfNextLocalDay,
  STATE_KEYS,
  writePause,
  type BlockerKind,
  type HoldKind,
  type PauseEntry,
  type PauseRecord,
} from './state.js';
import type { SurfaceSet } from './surfaces.js';

/**
 * The dispatcher decides which run starts when (§B, §C.3, §D, §G). It handles the chat commands
 * (§B.1), routes chat messages to a mission (§B.3), keeps one turn per mission at a time, and sends
 * what a run produced to the right surface (§F.1).
 */

/** How many lines of the chat the fast step sees (§B.3). They are kept in memory only. */
export const RECENT_LINES_MAX = 8;
/** Each recent line is cut to this many characters. */
export const RECENT_LINE_MAX_CHARS = 300;
/** How many direct answers of the fast step are kept for the general mission's next chat run. */
export const DIRECT_EXCHANGES_MAX = 10;
/** The most characters of direct exchanges put before that chat text. */
export const DIRECT_EXCHANGES_MAX_CHARS = 4000;

/** The fixed line when the general mission's normal run takes the message. */
export const WORKING_TEXT = 'Working on it.';
/** The fixed line when another mission takes the message. */
export function callingText(missionName: string): string {
  return `Calling ${missionName}.`;
}

export interface DispatcherDeps {
  registry: Pick<MissionRegistry, 'get' | 'getByName' | 'list'>;
  store: Store;
  engine: RunEngine;
  approvals: Pick<ApprovalQueue, 'pending' | 'cancelForMission'>;
  triage: Triage;
  config: () => AgentConfig;
  surfaces: SurfaceSet;
  /** `<agent name> · <mission name>`, or the agent name alone for null (§F.1). */
  label(missionId: MissionId | null): string;
  paths: Pick<Paths, 'missionDir' | 'dataDir'>;
  /** Replaces secret values in a text from a run before it reaches the user (§A.5). */
  redact?: (text: string) => string;
  /** Checks again what blocks the agent, on /resume. Undefined when nothing blocks any more. */
  recheckBlocker?: () => Promise<PauseEntry<BlockerKind> | undefined>;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (text: string) => void;
}

export interface Dispatcher {
  /** The harness function for an incoming message (§B.1). Resolves when the message is routed, not when its run ends. */
  incoming(msg: IncomingMessage): Promise<void>;
  /** The scheduler's `onEvent`: stores the event and starts a run when the mission is free (§B.2). */
  onEvent(missionId: MissionId, event: TriggerEvent): void;
  /** The message tool's route (§F.1): the surface of the chat message that started the run, or the default surface. */
  sendFromRun(missionId: MissionId, text: string, filePath?: string): Promise<void>;
  /**
   * A notice from the harness on the default surface. Never throws. `status` marks a notice about
   * the state of the agent, such as a pause or its end (see `OutgoingMessage.status`).
   */
  notifyUser(text: string, missionId?: MissionId | null, options?: { status?: boolean }): Promise<void>;
  pauseRecord(): PauseRecord;
  isPaused(): boolean;
  /** A pause that only /resume ends. `stopRuns` stops every run in progress, as /pause does. */
  hold(kind: HoldKind, reason: string, stopRuns: boolean): Promise<void>;
  /** A pause that the harness sets and ends. Undefined ends it. */
  setBlocker(blocker: PauseEntry<BlockerKind> | undefined): void;
  resume(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Starts the waiting work of every mission that is free. */
  kick(): void;
  /** The run of a mission waits for an approval: the sign that the agent works ends (§F.1). */
  runWaitsForApproval(missionId: MissionId): void;
  /** Cancels the action of a mission that waits for approval and tells the mission (§G). */
  cancelWaitingApproval(missionId: MissionId, why: string): boolean;
  /** Drops the chat messages that wait for a mission that was deleted. */
  forgetMission(missionId: MissionId): void;
  /** The missions with a run in progress. */
  busy(): MissionId[];
  /** Resolves when no message is being routed and no run is in progress. */
  idle(): Promise<void>;
  close(): void;
}

interface ChatItem {
  kind: 'chat';
  text: string;
  surface: string;
  /** Shows the user that the agent works on this message, until the run ends. */
  sign?: WorkingSign;
}

interface EventsItem {
  kind: 'events';
  events: TriggerEvent[];
}

type WorkItem = ChatItem | EventsItem;

type RunSource = { kind: 'chat'; surface: string } | { kind: 'events' };

const COMMAND_LIST =
  'The commands are /mission <name>, /stop, /stop <mission>, /pause, /resume and /improve. ' +
  'Each mission that takes chat messages also has its own command. Send /mission to see them.';

function takesChat(m: Manifest): boolean {
  return m.triggers.some((t) => t.use === CHAT_TRIGGER_ID);
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Moves a file into a folder, with a number added to its name when the name is taken. */
function moveInto(file: string, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const ext = extname(file);
  const stem = basename(file, ext);
  let target = join(dir, basename(file));
  for (let n = 1; existsSync(target); n++) target = join(dir, `${stem}-${n}${ext}`);
  renameSync(file, target);
  return target;
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const { registry, store, engine, surfaces } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const redact = deps.redact ?? ((t: string) => t);
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref());
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const chatQueues = new Map<MissionId, ChatItem[]>();
  const running = new Map<MissionId, Promise<void>>();
  const sources = new Map<MissionId, RunSource>();
  const routeChains = new Map<string, Promise<void>>();
  const routing = new Set<Promise<void>>();
  /** The sign of the chat message whose run is in progress, per mission. */
  const activeSigns = new Map<MissionId, WorkingSign>();
  /** The last lines of the chat, across missions. In memory only, for the fast step (§B.3). */
  const recent: RecentLine[] = [];
  /** The direct answers of the fast step since the general mission's last chat run. */
  const direct: { user: string; answer: string }[] = [];
  let midnightTimer: unknown;
  let closed = false;

  // The user's pause and the crash pause survive a restart (§B.1). A blocker is checked again at each start.
  let hold = readPause(store).hold;
  let blocker: PauseEntry<BlockerKind> | undefined;

  const record = (): PauseRecord => ({ ...(hold ? { hold } : {}), ...(blocker ? { blocker } : {}) });
  const persist = () => writePause(store, record());
  const isPaused = () => hold !== undefined || blocker !== undefined;
  const nameOf = (id: MissionId) => registry.get(id)?.name ?? id;
  const currentMission = () => store.getState(STATE_KEYS.currentChatMission) ?? SYS_GENERAL;
  const setCurrent = (id: MissionId) => store.setState(STATE_KEYS.currentChatMission, id);

  // ------------------------------------------------------------ what the fast step sees (§B.3)

  function remember(speaker: string, text: string): void {
    const t = text.trim();
    if (t === '') return;
    recent.push({ speaker, text: cut(t, RECENT_LINE_MAX_CHARS) });
    if (recent.length > RECENT_LINES_MAX) recent.splice(0, recent.length - RECENT_LINES_MAX);
  }

  /** A mission wrote to the user in chat: it becomes the current mission when it takes chat. */
  function spoke(missionId: MissionId, text: string): void {
    remember(nameOf(missionId), text);
    const m = registry.get(missionId);
    if (m !== undefined && m.status === 'active' && takesChat(m)) setCurrent(missionId);
  }

  function keepDirect(user: string, answer: string): void {
    direct.push({ user, answer });
    if (direct.length > DIRECT_EXCHANGES_MAX) direct.splice(0, direct.length - DIRECT_EXCHANGES_MAX);
    const size = () => direct.reduce((n, e) => n + e.user.length + e.answer.length, 0);
    while (direct.length > 1 && size() > DIRECT_EXCHANGES_MAX_CHARS) direct.shift();
  }

  /** The chat text for the general mission, after the direct exchanges it has not seen. Clears them. */
  function withEarlier(text: string): string {
    if (direct.length === 0) return text;
    const lines = direct.flatMap((e) => [`User: ${e.user}`, `Answer: ${e.answer}`]);
    direct.length = 0;
    const block = cut(lines.join('\n'), DIRECT_EXCHANGES_MAX_CHARS);
    return (
      'Earlier messages of this chat. The fast first step of the harness answered them directly, without a run of this mission:\n' +
      `${block}\n\nThe new message:\n${text}`
    );
  }

  /** Writes a direct answer to the logbook under the general mission's tag (§E.2.2). */
  function logDirect(text: string, answer: string, startedAt: string): void {
    try {
      store.insertRun({
        missionId: SYS_GENERAL,
        manifestVersion: registry.get(SYS_GENERAL)?.version ?? 1,
        startedAt,
        endedAt: now().toISOString(),
        input: redact(inputSummary({ kind: 'chat', text, surface: '' })),
        toolsCalled: [],
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        status: 'success',
        finalText: answer,
      });
    } catch (err) {
      log(`The logbook row of a direct answer could not be written: ${errorText(err)}`);
    }
  }

  /** Starts the sign that the agent works on the surface of a message. Never throws. */
  function startSign(surfaceId: string): WorkingSign | undefined {
    try {
      return surfaces.get(surfaceId)?.showWorking?.();
    } catch (err) {
      log(`The sign that the agent works could not be shown: ${errorText(err)}`);
      return undefined;
    }
  }

  // ------------------------------------------------------------ sending

  async function reply(surfaceId: string, missionId: MissionId | null, text: string): Promise<void> {
    const surface = surfaces.get(surfaceId) ?? surfaces.defaultSurface();
    try {
      await surface.send({ missionId, label: deps.label(missionId), text });
    } catch (err) {
      log(`A message could not be sent on ${surface.id}: ${errorText(err)}`);
    }
  }

  async function notifyUser(text: string, missionId: MissionId | null = null, options: { status?: boolean } = {}): Promise<void> {
    const surface = surfaces.defaultSurface();
    try {
      const msg: OutgoingMessage = { missionId, label: deps.label(missionId), text };
      if (options.status === true) msg.status = true;
      await surface.send(msg);
    } catch (err) {
      log(`A notice could not be sent on ${surface.id}: ${errorText(err)}. The notice was: ${text}`);
    }
  }

  async function sendFromRun(missionId: MissionId, text: string, filePath?: string): Promise<void> {
    const source = sources.get(missionId);
    const surface =
      source?.kind === 'chat' ? (surfaces.get(source.surface) ?? surfaces.defaultSurface()) : surfaces.defaultSurface();
    const msg = { missionId, label: deps.label(missionId), text: redact(text) };
    await surface.send(filePath === undefined ? msg : { ...msg, filePath });
    spoke(missionId, msg.text);
  }

  // ------------------------------------------------------------ pause

  function pausedText(): string {
    return `The agent is paused, so this message was not passed on. ${pauseReason(record())} ${resumeHint(record())}`;
  }

  async function holdPause(kind: HoldKind, reason: string, stopRuns: boolean): Promise<void> {
    hold = { kind, reason, since: now().toISOString() };
    persist();
    if (stopRuns) for (const id of engine.running()) await engine.stop(id);
  }

  function setBlocker(next: PauseEntry<BlockerKind> | undefined): void {
    blocker = next;
    persist();
    if (!isPaused()) kick();
  }

  async function resume(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (blocker !== undefined) {
      const still = deps.recheckBlocker ? await deps.recheckBlocker() : blocker;
      if (still !== undefined) {
        blocker = still;
        persist();
        return { ok: false, reason: still.reason };
      }
      blocker = undefined;
    }
    hold = undefined;
    persist();
    kick();
    return { ok: true };
  }

  // ------------------------------------------------------------ approvals (§G)

  function cancelWaitingApproval(missionId: MissionId, why: string): boolean {
    const waiting = deps.approvals.pending().filter((r) => r.missionId === missionId);
    if (waiting.length === 0) return false;
    deps.approvals.cancelForMission(missionId, why);
    for (const r of waiting) {
      store.addNotice(
        missionId,
        `Your request for ${r.action} was cancelled because ${why}. The action did not run. Ask again if it is still needed.`,
      );
    }
    return true;
  }

  // ------------------------------------------------------------ daily cost limit (§D)

  function dailyLimitReached(): boolean {
    const limit = deps.config().maxCostPerDayUsd;
    return store.costSince(startOfLocalDay(now()).toISOString()) >= limit;
  }

  function noteDailyLimit(): void {
    const day = localDate(now());
    if (store.getState(STATE_KEYS.dailyLimitNoticedOn) !== day) {
      store.setState(STATE_KEYS.dailyLimitNoticedOn, day);
      const limit = deps.config().maxCostPerDayUsd;
      void notifyUser(
        `The daily cost limit of ${limit} dollars is reached. Timers and events start no run until tomorrow. ` +
          'Chat messages still start runs.',
      );
    }
    if (midnightTimer === undefined) {
      const wait = startOfNextLocalDay(now()).getTime() - now().getTime() + 1000;
      midnightTimer = setTimer(() => {
        midnightTimer = undefined;
        kick();
      }, Math.max(1000, wait));
    }
  }

  // ------------------------------------------------------------ the turn of each mission (§C.3)

  function nextItem(missionId: MissionId): WorkItem | undefined {
    const manifest = registry.get(missionId);
    const queue = chatQueues.get(missionId);
    if (manifest === undefined || manifest.status !== 'active') {
      // A mission that was deleted or frozen since the work arrived does not run.
      chatQueues.delete(missionId);
      const why =
        manifest === undefined ? 'The mission no longer exists, so this message was not passed on.' : frozenText(manifest);
      for (const item of queue ?? []) {
        item.sign?.stop();
        void reply(item.surface, manifest === undefined ? null : missionId, why);
      }
      store.deleteEvents(missionId);
      return undefined;
    }
    if (queue !== undefined && queue.length > 0) {
      const item = queue.shift() as ChatItem;
      if (queue.length === 0) chatQueues.delete(missionId);
      return item;
    }
    const waiting = store.peekEvents(missionId);
    const first = waiting[0];
    if (first === undefined) return undefined;
    if (dailyLimitReached()) {
      noteDailyLimit();
      return undefined;
    }
    // The oldest event decides the trigger. All waiting events of that trigger become one run (§B.2).
    const taken = store.takeEvents(missionId, first.event.triggerId);
    if (taken.length === 0) return undefined;
    return { kind: 'events', events: taken.map((q) => q.event) };
  }

  function pump(missionId: MissionId): void {
    if (closed || running.has(missionId) || isPaused()) return;
    let item: WorkItem | undefined;
    try {
      item = nextItem(missionId);
    } catch (err) {
      log(`The next run of ${missionId} could not be chosen: ${errorText(err)}`);
      return;
    }
    if (item === undefined) return;
    const task = runItem(missionId, item)
      .catch((err: unknown) => log(`A run of ${missionId} ended with an error in the harness: ${errorText(err)}`))
      .finally(() => {
        running.delete(missionId);
        pump(missionId);
      });
    running.set(missionId, task);
  }

  function kick(): void {
    const ids = new Set<MissionId>([...chatQueues.keys()]);
    try {
      for (const id of store.missionsWithEvents()) ids.add(id);
    } catch (err) {
      log(`The event queues could not be read: ${errorText(err)}`);
    }
    for (const id of ids) pump(id);
  }

  async function runItem(missionId: MissionId, item: WorkItem): Promise<void> {
    const manifest = registry.get(missionId) as Manifest;
    const input: RunInput =
      item.kind === 'chat' ? { kind: 'chat', text: item.text, surface: item.surface } : { kind: 'events', events: item.events };
    const notices = store.takeNotices(missionId);
    sources.set(missionId, item.kind === 'chat' ? { kind: 'chat', surface: item.surface } : { kind: 'events' });
    if (item.kind === 'chat' && item.sign !== undefined) activeSigns.set(missionId, item.sign);
    const startedAt = now().toISOString();
    markRunStarted(store, { missionId, manifestVersion: manifest.version, startedAt, input: redact(inputSummary(input)) });
    let result: RunResult;
    try {
      result = await engine.run({ missionId, input, notices });
    } catch (err) {
      result = {
        status: 'failed',
        finalText: '',
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        steps: 0,
        toolsCalled: [],
        error: `The run failed in the harness: ${errorText(err)}`,
        startedAt,
        endedAt: now().toISOString(),
        retried: false,
      };
    } finally {
      sources.delete(missionId);
      markRunEnded(store, missionId);
    }
    try {
      await afterRun(manifest, item, result);
    } finally {
      if (item.kind === 'chat') {
        item.sign?.stop();
        if (activeSigns.get(missionId) === item.sign) activeSigns.delete(missionId);
      }
    }
  }

  /** What the user hears after a run (§F.1, §H). */
  async function afterRun(manifest: Manifest, item: WorkItem, result: RunResult): Promise<void> {
    if (isNotLoggedIn(result)) {
      const reason = result.error ?? 'The model login is not ready.';
      setBlocker({ kind: 'login', reason, since: now().toISOString() });
      const text = `The agent is paused because the model login is not ready. ${reason}`;
      if (item.kind === 'chat') await reply(item.surface, manifest.id, text);
      else await notifyUser(text, null, { status: true });
      return;
    }
    const problem = problemText(manifest, item, result);
    if (item.kind === 'chat') {
      if (result.status === 'success') {
        const text = result.finalText.trim() === '' ? 'The mission finished without an answer.' : result.finalText;
        await reply(item.surface, manifest.id, text);
        spoke(manifest.id, text);
      } else if (problem !== undefined) {
        if (result.finalText.trim() !== '') await reply(item.surface, manifest.id, result.finalText);
        await reply(item.surface, manifest.id, problem);
      }
    } else if (problem !== undefined) {
      // A trigger run's final text goes to the logbook only. A problem is still reported (§H).
      await notifyUser(problem, manifest.id);
    }
    if (dailyLimitReached()) noteDailyLimit();
  }

  function problemText(manifest: Manifest, item: WorkItem, result: RunResult): string | undefined {
    const what =
      item.kind === 'chat'
        ? `The run of ${manifest.name}`
        : `The run of ${manifest.name} that ${[...new Set(item.events.map((e) => e.triggerId))].join(' and ')} started`;
    const detail = result.error === undefined ? '' : ` ${result.error}`;
    switch (result.status) {
      case 'success':
      case 'stopped':
        // The user stopped it and was already told.
        return undefined;
      case 'failed':
        return `${what} failed${result.retried ? ', also when it was tried again' : ''}.${detail}`;
      case 'limit':
        return `${what} stopped at a run limit and was not tried again.${detail}`;
      case 'declined':
        return `${what} ended because the model declined the request.`;
    }
  }

  // ------------------------------------------------------------ chat messages (§B.1, §B.3, §F.1)

  function frozenText(m: Manifest): string {
    return `The mission ${m.name} is frozen, so it takes no messages.`;
  }

  function noChatText(m: Manifest): string {
    return `The mission ${m.name} takes no chat messages: its manifest does not list trigger:chat.`;
  }

  /** The chat text with the files the user sent, named relative to the mission's folder. */
  function chatText(text: string, files: string[], missionId: MissionId): string {
    if (files.length === 0) return text;
    const dir = deps.paths.missionDir(missionId);
    const list = files.map((f) => `- ${relative(dir, f)}`).join('\n');
    return `${text}\n\nFiles the user sent, saved in your folder:\n${list}`.trim();
  }

  /**
   * Queues a chat message for a mission that takes it. The caller has checked the pause and that
   * the mission is active and takes chat. Returns true when the message is queued: the sign then
   * belongs to the queued item and ends with its run.
   */
  async function deliver(
    msg: IncomingMessage,
    target: Manifest,
    text: string,
    opts: { sign?: WorkingSign; announce?: string } = {},
  ): Promise<boolean> {
    // Files that a surface saved before the mission was known move to the mission's own folder.
    const dataDir = deps.paths.dataDir(target.id);
    const inside = (f: string) => {
      const r = relative(dataDir, f);
      return r !== '' && !r.startsWith('..') && !isAbsolute(r);
    };
    let files = (msg.files ?? []).map((f) => {
      if (inside(f)) return f;
      try {
        return moveInto(f, dataDir);
      } catch (err) {
        log(`A file from the user could not be moved to ${target.id}: ${errorText(err)}`);
        return f;
      }
    });

    // The files are saved only now that the message is accepted, in the folder of the mission that takes it.
    if (msg.saveFiles !== undefined) {
      let saved: string[] | undefined;
      try {
        saved = await msg.saveFiles(target.id);
      } catch (err) {
        log(`The files of a message for ${target.id} could not be saved: ${errorText(err)}`);
        await reply(msg.surface, target.id, 'The file could not be saved, so the message was not passed on. Please send it again.');
        return false;
      }
      if (saved === undefined) return false;
      files = [...files, ...saved];
    }

    cancelWaitingApproval(target.id, 'a new chat message arrived for the mission');
    setCurrent(target.id);
    remember('user', text);
    // The fixed line is the harness's own text, not the model's (§B.3).
    if (opts.announce !== undefined) await reply(msg.surface, null, opts.announce);
    const body = chatText(text, files, target.id);
    const queue = chatQueues.get(target.id) ?? [];
    const item: ChatItem = {
      kind: 'chat',
      // Only the general mission gets the direct exchanges: missions stay apart from each other.
      text: target.id === SYS_GENERAL ? withEarlier(body) : body,
      surface: msg.surface,
    };
    if (opts.sign !== undefined) item.sign = opts.sign;
    queue.push(item);
    chatQueues.set(target.id, queue);
    pump(target.id);
    return true;
  }

  /**
   * A chat message that no command decides (§B.3): a reply to a mission's message goes to that
   * mission; anything else goes to the fast step, which picks the mission and sometimes answers.
   */
  async function handleChat(msg: IncomingMessage): Promise<void> {
    if (isPaused()) return reply(msg.surface, null, pausedText());
    // The sign starts before the model call, so the user sees at once that the agent works.
    const sign = startSign(msg.surface);
    let handed = false;
    try {
      if (msg.missionId !== undefined) {
        const m = registry.get(msg.missionId);
        // A reply to a message of a mission that no longer exists goes to the fast step.
        if (m !== undefined) {
          if (m.status === 'frozen') return await reply(msg.surface, null, frozenText(m));
          if (!takesChat(m)) return await reply(msg.surface, null, noChatText(m));
          handed = await deliver(msg, m, msg.text, sign === undefined ? {} : { sign });
          return;
        }
      }

      const startedAt = now().toISOString();
      const current = currentMission();
      const candidates = chatMissions(registry.list());
      const result = await deps.triage.classify({
        text: msg.text,
        candidates: candidates.map(({ id, name, description }) => ({ id, name, description })),
        lastMission: nameOf(current),
        recent: recent.map((l) => ({ ...l })),
      });
      // The harness stopped during the call, and the store may be closed: the message goes nowhere.
      if (closed) return;
      const decision = decideChatMission({
        result,
        currentMissionId: current,
        threshold: deps.config().triageSwitchConfidence,
        chatMissionIds: candidates.map((c) => c.id),
      });
      log(`Triage: ${result.failed === true ? 'The fast step failed or timed out. ' : ''}${decision.reason}`);
      const m = registry.get(decision.missionId) ?? registry.get(SYS_GENERAL);
      if (m === undefined) return await reply(msg.surface, null, 'No mission can take this message: the general mission is not loaded.');

      // A direct answer: no run starts. A message with a file always goes to a run.
      const hasFiles = msg.saveFiles !== undefined || (msg.files ?? []).length > 0;
      if (m.id === SYS_GENERAL && result.answer !== undefined && !hasFiles) {
        const answer = redact(result.answer);
        remember('user', msg.text);
        setCurrent(SYS_GENERAL);
        await reply(msg.surface, SYS_GENERAL, answer);
        remember(m.name, answer);
        logDirect(msg.text, answer, startedAt);
        keepDirect(msg.text, answer);
        return;
      }
      const announce = m.id === SYS_GENERAL ? WORKING_TEXT : callingText(m.name);
      handed = await deliver(msg, m, msg.text, sign === undefined ? { announce } : { sign, announce });
    } finally {
      if (!handed) sign?.stop();
    }
  }

  /** A mission's own command (§B.1): `/inbox_curator <text>` goes to that mission with no model call. */
  async function handleMissionCommand(msg: IncomingMessage, m: Manifest, rest: string): Promise<void> {
    if (m.status === 'frozen') return reply(msg.surface, null, frozenText(m));
    if (!takesChat(m)) return reply(msg.surface, null, noChatText(m));
    const hasFiles = msg.saveFiles !== undefined || (msg.files ?? []).length > 0;
    if (rest === '' && !hasFiles) {
      setCurrent(m.id);
      return reply(msg.surface, null, `Your next messages go to ${m.name}.`);
    }
    if (isPaused()) return reply(msg.surface, null, pausedText());
    const sign = startSign(msg.surface);
    let handed = false;
    try {
      handed = await deliver(msg, m, rest, sign === undefined ? {} : { sign });
    } finally {
      if (!handed) sign?.stop();
    }
  }

  // ------------------------------------------------------------ commands (§B.1)

  /** A mission by name, id or command, with or without the `/`. */
  function lookUp(arg: string): Manifest | undefined {
    const a = arg.trim().replace(/^\//, '');
    return registry.getByName(a) ?? registry.get(a) ?? missionOfCommand(a, registry.list());
  }

  function missionList(): string {
    const names = chatMissions(registry.list()).map((m) => {
      const cmd = commandOf(m);
      return cmd === undefined ? m.name : `${m.name} (/${cmd})`;
    });
    return `Missions that take chat messages: ${names.join(', ')}.`;
  }

  function missionCommand(arg: string): string {
    const list = missionList();
    if (arg === '') {
      return `The current mission is ${nameOf(currentMission())}. To switch, send /mission <name> or the command of the mission. ${list}`;
    }
    const m = lookUp(arg);
    if (m === undefined) return `There is no mission named "${arg}". ${list}`;
    if (m.status === 'frozen') return `${frozenText(m)} ${list}`;
    if (!takesChat(m)) return `${noChatText(m)} ${list}`;
    setCurrent(m.id);
    return `The current mission is now ${m.name}.`;
  }

  async function stopCommand(arg: string): Promise<string> {
    let target: MissionId;
    if (arg === '') {
      target = currentMission();
    } else {
      const m = lookUp(arg);
      if (m === undefined) return `There is no mission named "${arg}", so nothing was stopped.`;
      target = m.id;
    }
    const stopped = await engine.stop(target);
    // The engine cancels the waiting approval of the run it stops. This covers a request left without a run.
    deps.approvals.cancelForMission(target, 'the user sent /stop');
    return stopped
      ? `Stopped the run of ${nameOf(target)}. It is not continued and not tried again.`
      : `The mission ${nameOf(target)} has no run in progress.`;
  }

  async function pauseCommand(): Promise<string> {
    if (hold?.kind === 'user') return 'The agent is already paused. Send /resume to end the pause.';
    const stopping = engine.running().map(nameOf);
    await holdPause('user', 'The user sent /pause.', true);
    const stopped = stopping.length === 0 ? '' : ` Stopped the runs in progress of: ${stopping.join(', ')}.`;
    return (
      `The agent is paused.${stopped} No run starts until you send /resume. ` +
      'Timer runs and events that arrive meanwhile wait and run after /resume.'
    );
  }

  async function resumeCommand(): Promise<string> {
    if (!isPaused()) return 'The agent is not paused.';
    const r = await resume();
    return r.ok ? 'The pause has ended. Waiting timer runs and events start now.' : `The agent stays paused. ${r.reason}`;
  }

  async function handleCommand(msg: IncomingMessage, cmd: ParsedCommand): Promise<void> {
    // The answer to a command is the harness's own text, so it carries no mission label.
    const say = (text: string) => reply(msg.surface, null, text);
    switch (cmd.name) {
      case 'mission':
        return say(missionCommand(cmd.arg));
      case 'stop':
        return say(await stopCommand(cmd.arg));
      case 'pause':
        return say(await pauseCommand());
      case 'resume':
        return say(await resumeCommand());
      case 'improve':
        return say('Self-improvement is not part of this version, so /improve does nothing yet.');
      case 'unknown':
        return say(`"${cmd.arg}" is not a command. ${COMMAND_LIST}`);
    }
  }

  /** The order of §B.1: a harness command, a mission's command, then a chat message. No model reads a command. */
  async function route(msg: IncomingMessage, cmd: ParsedCommand | null): Promise<void> {
    if (cmd === null) return handleChat(msg);
    if (cmd.name !== 'unknown') return handleCommand(msg, cmd);
    const m = cmd.word === undefined ? undefined : missionOfCommand(cmd.word, registry.list());
    if (m === undefined) return handleCommand(msg, cmd);
    return handleMissionCommand(msg, m, cmd.rest ?? '');
  }

  /** Messages of one surface are routed one after the other, so their order is kept. */
  function serial(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = routeChains.get(key) ?? Promise.resolve();
    const run = prev.then(fn);
    const settled = run.catch(() => undefined);
    routeChains.set(key, settled);
    routing.add(settled);
    void settled.then(() => {
      routing.delete(settled);
      if (routeChains.get(key) === settled) routeChains.delete(key);
    });
    return run;
  }

  return {
    incoming(msg) {
      const cmd = parseCommand(msg.text);
      // /stop and /pause act at once, also while an earlier message is still being routed.
      if (cmd !== null && (cmd.name === 'stop' || cmd.name === 'pause')) return handleCommand(msg, cmd);
      return serial(msg.surface, () => route(msg, cmd));
    },

    onEvent(missionId, event) {
      let added: boolean;
      try {
        added = store.enqueueEvent(missionId, event);
      } catch (err) {
        log(`An event for ${missionId} could not be stored: ${errorText(err)}`);
        return;
      }
      // An event whose key was already seen is dropped (§B.2).
      if (!added) return;
      if (event.triggerId === CRON_TRIGGER_ID && !isPaused() && !dailyLimitReached()) {
        cancelWaitingApproval(missionId, 'a timer run arrived for the mission');
      }
      pump(missionId);
    },

    sendFromRun,
    notifyUser,
    pauseRecord: record,
    isPaused,
    hold: holdPause,
    setBlocker,
    resume,
    kick,
    cancelWaitingApproval,
    runWaitsForApproval(missionId) {
      activeSigns.get(missionId)?.stop();
      activeSigns.delete(missionId);
    },
    forgetMission(missionId) {
      for (const item of chatQueues.get(missionId) ?? []) item.sign?.stop();
      chatQueues.delete(missionId);
    },
    busy: () => [...running.keys()],
    async idle() {
      for (;;) {
        const waits = [...running.values(), ...routing];
        if (waits.length === 0) return;
        await Promise.allSettled(waits);
      }
    },
    close() {
      closed = true;
      for (const queue of chatQueues.values()) for (const item of queue) item.sign?.stop();
      for (const sign of activeSigns.values()) sign.stop();
      activeSigns.clear();
      if (midnightTimer !== undefined) clearTimer(midnightTimer);
      midnightTimer = undefined;
    },
  };
}
