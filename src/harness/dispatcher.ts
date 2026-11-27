import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import type { Paths } from '../paths.js';
import { isNotLoggedIn } from '../run/index.js';
import { chatMissions, decideChatMission, parseCommand, type ParsedCommand } from '../triage/index.js';
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
  type RunEngine,
  type RunInput,
  type RunResult,
  type Store,
  type TriggerEvent,
  type Triage,
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
}

interface EventsItem {
  kind: 'events';
  events: TriggerEvent[];
}

type WorkItem = ChatItem | EventsItem;

type RunSource = { kind: 'chat'; surface: string } | { kind: 'events' };

const COMMAND_LIST = 'The commands are /mission <name> (terminal only), /stop, /pause, /resume and /improve.';

function takesChat(m: Manifest): boolean {
  return m.triggers.some((t) => t.use === CHAT_TRIGGER_ID);
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
  let midnightTimer: unknown;
  let closed = false;

  // The user's pause and the crash pause survive a restart (§B.1). A blocker is checked again at each start.
  let hold = readPause(store).hold;
  let blocker: PauseEntry<BlockerKind> | undefined;

  const record = (): PauseRecord => ({ ...(hold ? { hold } : {}), ...(blocker ? { blocker } : {}) });
  const persist = () => writePause(store, record());
  const isPaused = () => hold !== undefined || blocker !== undefined;
  const nameOf = (id: MissionId) => registry.get(id)?.name ?? id;
  const isThreaded = (surfaceId: string) => surfaces.get(surfaceId)?.hasThreads === true;
  const currentMission = () => store.getState(STATE_KEYS.currentChatMission) ?? SYS_GENERAL;

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
      for (const item of queue ?? []) void reply(item.surface, manifest === undefined ? null : missionId, why);
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
    await afterRun(manifest, item, result);
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

  async function handleChat(msg: IncomingMessage): Promise<void> {
    const where = msg.missionId ?? null;
    if (isPaused()) return reply(msg.surface, where, pausedText());
    let files = [...(msg.files ?? [])];
    let target: Manifest;

    if (msg.missionId !== undefined) {
      // A message in a mission's thread goes to that mission. Triage does not run (§F.1).
      const m = registry.get(msg.missionId);
      if (m === undefined) {
        return reply(msg.surface, null, 'The mission of this thread no longer exists. Write in the general thread instead.');
      }
      if (m.status === 'frozen') return reply(msg.surface, m.id, frozenText(m));
      if (!takesChat(m)) return reply(msg.surface, m.id, noChatText(m));
      target = m;
    } else {
      // The terminal keeps a current mission. The general thread on Telegram has none (§B.3).
      const generalThread = isThreaded(msg.surface);
      const candidates = chatMissions(registry.list());
      const result = await deps.triage.classify(
        msg.text,
        candidates.map(({ id, name, description }) => ({ id, name, description })),
      );
      const decision = decideChatMission({
        result,
        currentMissionId: generalThread ? SYS_GENERAL : currentMission(),
        threshold: deps.config().triageSwitchConfidence,
        isGeneralThread: generalThread,
        chatMissionIds: candidates.map((c) => c.id),
      });
      log(`Triage: ${decision.reason}`);
      const m = registry.get(decision.missionId) ?? registry.get(SYS_GENERAL);
      if (m === undefined) return reply(msg.surface, null, 'No mission can take this message: the general mission is not loaded.');
      target = m;
      if (!generalThread) store.setState(STATE_KEYS.currentChatMission, m.id);
      if (m.id !== SYS_GENERAL) {
        if (generalThread) {
          await reply(msg.surface, null, `This message went to the mission ${m.name}. Its answer appears in that mission's thread.`);
        }
        // The surface saved the files in the general mission's data folder before triage ran.
        const dataDir = deps.paths.dataDir(m.id);
        files = files.map((f) => {
          try {
            return moveInto(f, dataDir);
          } catch (err) {
            log(`A file from the user could not be moved to ${m.id}: ${errorText(err)}`);
            return f;
          }
        });
      }
    }

    // The files are saved only now that the message is accepted, in the folder of the mission that takes it.
    if (msg.saveFiles !== undefined) {
      let saved: string[] | undefined;
      try {
        saved = await msg.saveFiles(target.id);
      } catch (err) {
        log(`The files of a message for ${target.id} could not be saved: ${errorText(err)}`);
        return reply(msg.surface, target.id, 'The file could not be saved, so the message was not passed on. Please send it again.');
      }
      if (saved === undefined) return;
      files.push(...saved);
    }

    cancelWaitingApproval(target.id, 'a new chat message arrived for the mission');
    const queue = chatQueues.get(target.id) ?? [];
    queue.push({ kind: 'chat', text: chatText(msg.text, files, target.id), surface: msg.surface });
    chatQueues.set(target.id, queue);
    pump(target.id);
  }

  // ------------------------------------------------------------ commands (§B.1)

  function missionCommand(msg: IncomingMessage, arg: string): string {
    if (isThreaded(msg.surface)) {
      return 'The /mission command works in the terminal only. Here, write in the thread of the mission.';
    }
    const names = chatMissions(registry.list())
      .map((m) => m.name)
      .join(', ');
    const list = `Missions that take chat messages: ${names}.`;
    if (arg === '') return `The current mission is ${nameOf(currentMission())}. To switch, send /mission <name>. ${list}`;
    const m = registry.getByName(arg) ?? registry.get(arg);
    if (m === undefined) return `There is no mission named "${arg}". ${list}`;
    if (m.status === 'frozen') return `${frozenText(m)} ${list}`;
    if (!takesChat(m)) return `${noChatText(m)} ${list}`;
    store.setState(STATE_KEYS.currentChatMission, m.id);
    return `The current mission is now ${m.name}.`;
  }

  async function stopCommand(msg: IncomingMessage): Promise<string> {
    const target = isThreaded(msg.surface) ? (msg.missionId ?? SYS_GENERAL) : currentMission();
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
    const say = (text: string) => reply(msg.surface, msg.missionId ?? null, text);
    switch (cmd.name) {
      case 'mission':
        return say(missionCommand(msg, cmd.arg));
      case 'stop':
        return say(await stopCommand(msg));
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
      return serial(msg.surface, () => (cmd !== null ? handleCommand(msg, cmd) : handleChat(msg)));
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
    forgetMission(missionId) {
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
      if (midnightTimer !== undefined) clearTimer(midnightTimer);
      midnightTimer = undefined;
    },
  };
}
