import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createConfigHolder, defaultConfig, initRootFolder } from '../config/index.js';
import { openStore } from '../db/index.js';
import { createMissionRegistry, MISSION_ADMIN_MANIFEST, type WatchingMissionRegistry } from '../manifest/index.js';
import { pathsFor, type Paths } from '../paths.js';
import {
  checkModelLogin,
  createModelCaller,
  createRunEngine,
  type LoginCheck,
  type ModelLoginDeps,
  type QueryFn,
} from '../run/index.js';
import { clearStaleApprovals, createApprovalQueue, createGate } from '../safety/index.js';
import {
  assertCredentialId,
  createKeychainStore,
  createRedactor,
  createSecretCache,
  isCredentialId,
  TELEGRAM_BOT_TOKEN,
} from '../secrets/index.js';
import { createLocalServer, isServerAlive, readServerFile, type LocalServer } from '../server/index.js';
import {
  checkBot,
  createTelegramSurface,
  pairTelegramUser,
  TELEGRAM_SURFACE_ID,
  TelegramError,
  type BotCheck,
  type FetchFn,
  type TelegramSurfaceOptions,
} from '../surfaces/telegram/index.js';
import { createTerminalSurface, TERMINAL_SURFACE_ID, type TerminalSurface } from '../surfaces/terminal/index.js';
import { builtinTools, createCodeCatalog, createToolCatalog } from '../tools/index.js';
import { createTriage } from '../triage/index.js';
import {
  chatTrigger,
  createScheduler,
  createTriggerCatalog,
  cronTrigger,
  type Scheduler,
  type TriggerCatalog,
} from '../triggers/index.js';
import {
  SYS_GENERAL,
  type ApprovalQueue,
  type LoadedConfig,
  type Manifest,
  type ManifestError,
  type MissionId,
  type MissionStatus,
  type SecretStore,
  type Store,
  type Surface,
  type SurfaceHost,
  type ToolCatalog,
  type ToolHost,
  type TriggerEvent,
} from '../types.js';
import { approvalDetails } from './approval-details.js';
import {
  isTerminalOnlyCredential,
  missingCredentialText,
  missionCredentialIds,
  requiredCredentialIds,
  type CredentialSources,
} from './credentials.js';
import { createDispatcher, type Dispatcher } from './dispatcher.js';
import {
  MISSION_STATE_PREFIXES,
  pauseReason,
  recordAlive,
  recordCleanStop,
  recordStart,
  STATE_KEYS,
  takeInterruptedRuns,
  type BlockerKind,
  type PauseEntry,
  type PauseRecord,
} from './state.js';
import { createSurfaceSet } from './surfaces.js';

/** The harness: builds every module in the order the modules need, starts and stops them (§2.1, §H). */

export interface HarnessOptions {
  root: string;
  /** Undefined uses `state/claude`. Null leaves `CLAUDE_CONFIG_DIR` out (live tests only). */
  sdkConfigDir?: string | null;
  /** Replaces the SDK's `query`, for tests. */
  queryFn?: QueryFn;
  /** Default: the Keychain store. */
  secretStore?: SecretStore;
  now?: () => Date;
  log?: (text: string) => void;
  /** Builds the Telegram surface. For tests. */
  createTelegramSurface?: (options: TelegramSurfaceOptions) => Surface;
  /** Time between two writes of `last_alive_at`. Default one minute. */
  aliveIntervalMs?: number;
  /** How long `stop()` waits for the runs in progress to end. Default 20 seconds. */
  stopWaitMs?: number;
  /** Wait after a change of agent.yaml before it is read again. Default 300 ms. */
  configDebounceMs?: number;
  /** The time zone of the date in a run's input. Defaults to the machine's. */
  timeZone?: string;
  /** Replaces `fetch` for the bot check and the pairing of the setup page. For tests. */
  telegramFetch?: FetchFn;
}

/** A timer run that was missed while the harness was stopped (§B.2), as the scheduler reported it at the start. */
export interface MissedTimerRun {
  missionId: MissionId;
  expression: string;
  /** ISO time of the last missed run. */
  dueAt: string;
  count: number;
  /** True when there were more missed runs than `count`. */
  countIsMinimum: boolean;
}

export interface HarnessStatus {
  running: boolean;
  pid: number;
  startedAt?: string;
  paused: boolean;
  /** Empty when the agent is not paused. */
  pauseReason: string;
  pause: PauseRecord;
  agentName?: string;
  configError?: string;
  defaultSurface: 'telegram' | 'terminal';
  telegramRunning: boolean;
  missions: { id: MissionId; name: string; status: MissionStatus; version: number; running: boolean }[];
  manifestErrors: ManifestError[];
}

export interface Harness {
  readonly paths: Paths;
  readonly store: Store;
  readonly registry: WatchingMissionRegistry;
  readonly server: LocalServer;
  readonly dispatcher: Dispatcher;
  readonly approvals: ApprovalQueue;
  readonly terminal: TerminalSurface;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): HarnessStatus;
  /** The function the scheduler's `onEvent` calls (§B.2). */
  handleEvent(missionId: MissionId, event: TriggerEvent): void;
  /** The credentials the harness requires now (§A.5). */
  requiredCredentials(): string[];
  /** Reads one credential again after `secret set` or `secret delete`. */
  refreshSecret(id: string): Promise<void>;
  /** Resolves when the mission changes seen so far are handled and no run is in progress. */
  settle(): Promise<void>;
  /** The setup page stops the Telegram surface while it pairs the user's account (§5.1). */
  telegram: {
    stop(): Promise<void>;
    start(): Promise<void>;
    running(): boolean;
    /** Asks Telegram about the bot with the stored token (§5.1 step 3). */
    check(): Promise<BotCheck>;
    /**
     * Waits for a private message with the code and returns its sender. The surface must be
     * stopped first. The signal, or `stop()` of the harness, ends the wait.
     */
    pair(options: { code: string; timeoutMs: number; signal?: AbortSignal }): Promise<number>;
  };
  config(): LoadedConfig | undefined;
  configError(): string | undefined;

  // What the two local pages need (§J). Each of these was added for the pages.

  /** Reads the configuration files now, after the setup page wrote one, and applies them as a change of agent.yaml does. */
  reloadConfig(): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Writes through the secret store and reads the value again (§A.5). A value is never returned. */
  secrets: {
    has(id: string): Promise<boolean>;
    set(id: string, value: string): Promise<void>;
    delete(id: string): Promise<boolean>;
  };
  /** Checks the model login without a model call, and ends the pause when the login was what kept it (§5.1). */
  checkLogin(): Promise<LoginCheck>;
  /** The tools and triggers of the harness (§A.5, §B.2). */
  catalogs: { tools: ToolCatalog; triggers: TriggerCatalog };
  /** The timer runs that were missed while the harness was stopped, reported at this start. */
  missedTimerRuns(): MissedTimerRun[];
  /** Replaces any stored secret value found in a text with the credential's id. */
  redact(text: string): string;
}

/** Another harness answers on the local server of the same root folder. */
export class HarnessAlreadyRunningError extends Error {
  constructor(
    readonly root: string,
    readonly pid: number,
  ) {
    super(`Another harness is already running for ${root} (process ${pid}).`);
    this.name = 'HarnessAlreadyRunningError';
  }
}

/** The agent name used in labels while there is no valid agent.yaml. */
const FALLBACK_NAME = 'mission-agent';
const CONFIG_FILES = ['agent.yaml', 'core-prompt.md', 'note-paragraph.md'];
const CRASH_TEXT =
  'The harness stopped unexpectedly three times within ten minutes, so it started paused. ' +
  'Remove the cause, then send /resume.';

export const STATUS_PATH = '/api/status';
export const SECRETS_REQUIRED_PATH = '/api/secrets/required';
export const SECRETS_REFRESH_PATH = '/api/secrets/refresh';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultLog(text: string): void {
  process.stderr.write(`${new Date().toISOString()} ${text}\n`);
}

export function createHarness(options: HarnessOptions): Harness {
  const paths = pathsFor(options.root);
  const now = options.now ?? (() => new Date());
  const log = options.log ?? defaultLog;

  initRootFolder(paths);
  const store = openStore(paths.dbFile);

  // ------------------------------------------------------------ configuration (§A.1, §H)

  const holder = createConfigHolder(paths);
  let loaded: LoadedConfig | undefined;
  let configError: string | undefined;
  let reportedConfigError: string | undefined;
  const fallback: LoadedConfig = { config: defaultConfig(FALLBACK_NAME), coreText: '', noteParagraph: '' };
  const loadedNow = () => loaded ?? fallback;
  const cfg = () => loadedNow().config;

  function readConfig(): boolean {
    const r = holder.reload();
    if (r.ok) {
      loaded = holder.current();
      configError = undefined;
      return true;
    }
    configError = r.error;
    return false;
  }

  // ------------------------------------------------------------ secrets (§A.5)

  const secretStore = options.secretStore ?? createKeychainStore();
  const cache = createSecretCache(secretStore);
  const redactor = createRedactor(() => cache.valuesForRedaction());
  /** The redacted text. If the redactor fails, nothing of the text is kept. */
  function safeRedact(text: string): string {
    try {
      return redactor.redact(text);
    } catch {
      return '[text removed: the redactor failed]';
    }
  }

  // ------------------------------------------------------------ catalogs and registry, in this order

  const triggerDefs = [cronTrigger, chatTrigger];
  // `catalog` is read only when a tool runs, after the catalog below exists.
  let tools: ToolCatalog | undefined;
  const toolCatalog: ToolCatalog = createToolCatalog(
    builtinTools({
      paths,
      config: cfg,
      catalog: () => {
        if (tools === undefined) throw new Error('The tool catalog is not built yet.');
        return tools;
      },
      triggers: () => triggerDefs,
    }),
  );
  tools = toolCatalog;
  const triggerCatalog = createTriggerCatalog(triggerDefs);
  const codeCatalog = createCodeCatalog(toolCatalog, triggerCatalog);
  const sources: CredentialSources = { tools: toolCatalog, triggers: triggerCatalog };
  const registry = createMissionRegistry({
    paths,
    catalog: codeCatalog,
    config: cfg,
    codeManifests: [MISSION_ADMIN_MANIFEST],
    memory: { get: (k) => store.getState(k), set: (k, v) => store.setState(k, v) },
  });
  const gate = createGate({ paths, config: cfg, catalog: toolCatalog });

  // ------------------------------------------------------------ surfaces (§F.1)

  const server = createLocalServer({
    paths,
    onError: (err, where) => log(`The local server failed at ${where}: ${errorText(err)}`),
  });
  const terminal = createTerminalSurface({
    server,
    missionName: (id) => registry.get(id)?.name,
    onError: (err) => log(`The terminal surface could not pass on a message: ${errorText(err)}`),
  });
  const surfaces = createSurfaceSet(
    () => (cfg().defaultSurface === 'telegram' ? TELEGRAM_SURFACE_ID : TERMINAL_SURFACE_ID),
    terminal,
  );

  function label(missionId: MissionId | null): string {
    const agent = cfg().agentName;
    if (missionId === null) return agent;
    return `${agent} · ${registry.get(missionId)?.name ?? missionId}`;
  }

  /** A frozen mission's thread has the word "frozen" in its name (§F.1). */
  function threadLabel(m: Manifest): string {
    return m.status === 'frozen' ? `${label(m.id)} (frozen)` : label(m.id);
  }

  /** The bot token is shown in the terminal only (§A.5): the log and the terminal surface. */
  function terminalOnly(text: string): void {
    log(text);
    terminal.notice(text, cfg().agentName);
  }

  // ------------------------------------------------------------ approvals (§G)

  const shownOn = new Map<string, string>();
  const approvals = createApprovalQueue({
    store,
    config: cfg,
    now,
    // The request that is saved, shown and listed holds no secret value (§A.5).
    // The engine keeps the original input for the tool call.
    redact: safeRedact,
    async show(req) {
      // Approval requests go to the default surface (§F.1).
      const surface = surfaces.defaultSurface();
      let details: string | undefined;
      try {
        details = await approvalDetails(req, {
          registry,
          store,
          paths,
          pendingApprovals: () => approvals.pending(),
          credentialIdsOf: (m) => missionCredentialIds(m, sources),
          hasSecret: async (id) => cache.get(id) !== undefined || (await secretStore.has(id)),
        });
      } catch (err) {
        log(`The details of an approval request could not be built: ${errorText(err)}`);
      }
      shownOn.set(req.id, surface.id);
      // The details quote the input, so they pass through the redactor too.
      const shown = details === undefined ? req : { ...req, details: safeRedact(details) };
      await surface.showApproval(shown, label(req.missionId));
    },
    async close(id, outcome) {
      const surfaceId = shownOn.get(id);
      shownOn.delete(id);
      const surface = surfaceId === undefined ? undefined : surfaces.get(surfaceId);
      await surface?.closeApproval(id, outcome);
    },
  });

  // ------------------------------------------------------------ run engine, model caller, triage

  const toolHost: ToolHost = {
    registry,
    sendMessage: (missionId, text, filePath) => dispatcher.sendFromRun(missionId, text, filePath),
    cleanUpDeletedMission: (id) => inMissionChain(() => cleanUp(id)),
    missionChanged: () => syncMissions(),
  };

  const engine = createRunEngine({
    paths,
    config: loadedNow,
    registry,
    store,
    gate,
    approvals,
    tools: toolCatalog,
    toolHost,
    secrets: cache,
    redactor,
    sdkConfigDir: options.sdkConfigDir,
    ...(options.queryFn !== undefined ? { queryFn: options.queryFn } : {}),
    now,
    ...(options.timeZone !== undefined ? { timeZone: options.timeZone } : {}),
    log,
  });

  const loginDeps: ModelLoginDeps = {
    paths,
    config: loadedNow,
    secrets: cache,
    sdkConfigDir: options.sdkConfigDir,
    ...(options.queryFn !== undefined ? { queryFn: options.queryFn } : {}),
  };
  const triage = createTriage({ callModel: createModelCaller(loginDeps), config: cfg });

  // ------------------------------------------------------------ pause blockers (§A.5, §H, §5.1)

  function requiredIds(): string[] {
    if (loaded === undefined) return [];
    return requiredCredentialIds(cfg(), registry.list(), sources);
  }

  async function loadSecrets(ids = requiredIds()): Promise<void> {
    try {
      await cache.load(ids);
    } catch (err) {
      log(`The credentials could not be read: ${errorText(err)}`);
    }
  }

  let telegramRefused = false;

  function configBlockerText(): string {
    if (!holder.exists()) {
      return (
        `agent.yaml does not exist in ${paths.root}, so the agent has no name yet. ` +
        `Set it up in the setup page (mission-agent setup --root "${paths.root}"), ` +
        `or create the file with: mission-agent init --root "${paths.root}" --name <agent name>`
      );
    }
    return configError ?? 'agent.yaml is invalid.';
  }

  /** What keeps the agent paused, or undefined. It checks the model login without a model call. */
  async function computeBlocker(): Promise<PauseEntry<BlockerKind> | undefined> {
    const since = now().toISOString();
    if (loaded === undefined) return { kind: 'config', reason: configBlockerText(), since };
    if (cfg().defaultSurface === 'telegram' && (cache.get(TELEGRAM_BOT_TOKEN) === undefined || telegramRefused)) {
      return {
        kind: 'credential',
        reason:
          `Telegram is the default surface, but the bot token ${TELEGRAM_BOT_TOKEN} is missing or was refused. ` +
          `Enter it with: mission-agent secret set ${TELEGRAM_BOT_TOKEN}`,
        since,
      };
    }
    const check = await checkModelLogin(loginDeps);
    if (!check.ok) return { kind: 'login', reason: check.reason, since };
    return undefined;
  }

  /** Checks the blocker again and tells the user when the pause ends. */
  async function reevaluateBlocker(): Promise<void> {
    const before = dispatcher.pauseRecord().blocker;
    const next = await computeBlocker();
    dispatcher.setBlocker(next);
    if (before !== undefined && next === undefined) {
      await dispatcher.notifyUser(
        dispatcher.isPaused()
          ? `Fixed: ${before.reason} The agent is still paused: ${pauseReason(dispatcher.pauseRecord())}`
          : 'The agent is no longer paused. Runs start again.',
      );
    }
  }

  // ------------------------------------------------------------ dispatcher

  const dispatcher: Dispatcher = createDispatcher({
    registry,
    store,
    engine,
    approvals,
    triage,
    config: cfg,
    surfaces,
    label,
    paths,
    redact: (t) => redactor.redact(t),
    recheckBlocker: async () => {
      await loadSecrets();
      return computeBlocker();
    },
    now,
    log,
  });

  const surfaceHost: SurfaceHost = {
    incoming: (msg) => dispatcher.incoming(msg),
    answerApproval: (id, answer) => approvals.answer(id, answer),
    label,
    store,
  };

  // ------------------------------------------------------------ Telegram (§F.1)

  let telegram: Surface | undefined;
  let telegramHeld = false;
  let authFailures = 0;

  function onTelegramError(err: Error): void {
    log(`Telegram: ${err.message}`);
    // A wrong bot token fails on every poll. Two refusals in a row count as a missing credential (§A.5).
    if (!(err instanceof TelegramError) || (err.code !== 401 && err.code !== 404)) return;
    authFailures += 1;
    if (authFailures < 2 || telegramRefused) return;
    telegramRefused = true;
    void stopTelegram();
    terminalOnly(
      `Telegram refused the bot token, so the Telegram surface is stopped. ` +
        `Enter the token again with: mission-agent secret set ${TELEGRAM_BOT_TOKEN}`,
    );
    if (cfg().defaultSurface === 'telegram') void reevaluateBlocker();
  }

  async function startTelegram(): Promise<void> {
    if (telegram !== undefined || telegramHeld || telegramRefused || loaded === undefined) return;
    if (cfg().telegramUserId === undefined || cache.get(TELEGRAM_BOT_TOKEN) === undefined) return;
    authFailures = 0;
    const make = options.createTelegramSurface ?? createTelegramSurface;
    const surface = make({
      token: () => cache.get(TELEGRAM_BOT_TOKEN) ?? '',
      userId: () => cfg().telegramUserId,
      dataDir: (id) => paths.dataDir(id),
      missionName: (id) => registry.get(id)?.name,
      generalMissionId: SYS_GENERAL,
      onError: onTelegramError,
    });
    await surface.start(surfaceHost);
    telegram = surface;
    surfaces.add(surface);
    // Each mission has its own thread. Missions created while Telegram was off get theirs now.
    for (const m of registry.list()) {
      if (store.getThread(m.id) !== undefined) continue;
      try {
        await surface.createThread?.(m.id, threadLabel(m));
      } catch (err) {
        log(`The Telegram thread of ${m.id} could not be created: ${errorText(err)}`);
      }
    }
  }

  async function stopTelegram(): Promise<void> {
    const surface = telegram;
    if (surface === undefined) return;
    telegram = undefined;
    surfaces.remove(surface.id);
    try {
      await surface.stop();
    } catch (err) {
      log(`The Telegram surface did not stop cleanly: ${errorText(err)}`);
    }
  }

  // ------------------------------------------------------------ mission changes (§A.4, §4.2.1)

  interface Known {
    name: string;
    status: MissionStatus;
    version: number;
  }
  let known = new Map<MissionId, Known>();
  const reportedErrors = new Set<string>();
  let missionChain: Promise<void> = Promise.resolve();

  const snapshot = (list: Manifest[]) =>
    new Map<MissionId, Known>(list.map((m) => [m.id, { name: m.name, status: m.status, version: m.version }]));

  /** Mission changes are handled one after the other. */
  function inMissionChain(fn: () => Promise<void>): Promise<void> {
    const run = missionChain.then(fn);
    missionChain = run.catch((err: unknown) => log(`A mission change was not fully handled: ${errorText(err)}`));
    return run;
  }

  function sayMissing(id: string, usedBy?: string): void {
    const text = missingCredentialText(id, usedBy);
    if (isTerminalOnlyCredential(id)) terminalOnly(text);
    else void dispatcher.notifyUser(text);
  }

  async function checkMissionCredentials(m: Manifest): Promise<void> {
    const ids = missionCredentialIds(m, sources);
    if (ids.length === 0) return;
    await loadSecrets(ids);
    for (const id of ids) if (cache.get(id) === undefined) sayMissing(id, m.name);
  }

  async function checkAllCredentials(): Promise<void> {
    for (const id of requiredIds()) if (cache.get(id) === undefined) sayMissing(id);
  }

  async function updateThread(m: Manifest): Promise<void> {
    if (telegram === undefined) return;
    try {
      if (store.getThread(m.id) === undefined) await telegram.createThread?.(m.id, threadLabel(m));
      else await telegram.renameThread?.(m.id, threadLabel(m));
    } catch (err) {
      log(`The Telegram thread of ${m.id} could not be updated: ${errorText(err)}`);
    }
  }

  /** Removes what belongs to a deleted mission outside its folder (§4.2.1). Safe to call twice. */
  async function cleanUp(id: MissionId): Promise<void> {
    dispatcher.forgetMission(id);
    if (engine.running().includes(id)) await engine.stop(id);
    approvals.cancelForMission(id, 'the mission was deleted');
    if (telegram !== undefined && store.getThread(id) !== undefined) {
      try {
        await telegram.deleteThread?.(id);
      } catch (err) {
        log(`The Telegram thread of the deleted mission ${id} could not be deleted: ${errorText(err)}`);
      }
    }
    store.deleteMissionState(id);
    for (const prefix of MISSION_STATE_PREFIXES) store.deleteState(prefix + id);
    if (store.getState(STATE_KEYS.currentChatMission) === id) store.deleteState(STATE_KEYS.currentChatMission);
    known.delete(id);
  }

  function reportManifestErrors(): void {
    const current = new Set<string>();
    for (const e of registry.errors()) {
      const key = `${e.source}: ${e.message}`;
      current.add(key);
      if (!reportedErrors.has(key)) {
        reportedErrors.add(key);
        log(`Invalid manifest. ${key}`);
        void dispatcher.notifyUser(`The manifest ${e.source} is invalid, so its mission does not run: ${e.message}`);
      }
    }
    for (const key of [...reportedErrors]) if (!current.has(key)) reportedErrors.delete(key);
  }

  /** Compares the registry with what the harness last saw, and acts on each difference. */
  async function doSync(): Promise<void> {
    const list = registry.list();
    for (const m of list) {
      const prev = known.get(m.id);
      if (prev === undefined) {
        await updateThread(m);
        if (m.status === 'active') await checkMissionCredentials(m);
        continue;
      }
      if (prev.name !== m.name || prev.status !== m.status) await updateThread(m);
      if (prev.status === 'active' && m.status === 'frozen') {
        // A frozen mission does not run, so nothing of it may wait for the user (§A.4.3).
        approvals.cancelForMission(m.id, 'the mission was frozen');
        if (engine.running().includes(m.id)) await engine.stop(m.id);
      }
      if (prev.version !== m.version && m.status === 'active') await checkMissionCredentials(m);
    }
    const next = snapshot(list);
    for (const id of known.keys()) {
      // A manifest that became invalid keeps its folder. Only a removed folder is a deletion.
      if (!next.has(id) && !existsSync(paths.missionDir(id))) await cleanUp(id);
    }
    known = next;
    reportManifestErrors();
  }

  function syncMissions(): Promise<void> {
    return inMissionChain(doSync);
  }

  // ------------------------------------------------------------ local routes (§J.3)

  server.route('GET', STATUS_PATH, (_req, res) => res.json(status()));
  server.route('GET', SECRETS_REQUIRED_PATH, (_req, res) => res.json({ ids: requiredIds() }));
  server.route('POST', SECRETS_REFRESH_PATH, async (req, res) => {
    const id = (req.body as { id?: unknown } | undefined)?.id;
    if (!isCredentialId(id)) return res.text('The body must be {"id": "credential:<owner>.<name>"}.', 400);
    try {
      await refreshSecret(id);
    } catch (err) {
      return res.text(`The credential could not be read again: ${errorText(err)}`, 500);
    }
    res.json({ ok: true });
  });

  async function refreshSecret(id: string): Promise<void> {
    assertCredentialId(id);
    await cache.refresh(id);
    if (id === TELEGRAM_BOT_TOKEN) {
      telegramRefused = false;
      await stopTelegram();
      await startTelegram();
    }
    // A trigger whose credential was missing can start now.
    await scheduler?.refresh();
    const blocker = dispatcher.pauseRecord().blocker;
    if (blocker !== undefined && blocker.kind !== 'config') await reevaluateBlocker();
  }

  // ------------------------------------------------------------ watching agent.yaml

  let configWatcher: FSWatcher | undefined;
  let configTimer: ReturnType<typeof setTimeout> | undefined;
  let configSeen = '';

  /** The content of the three configuration files, to skip a reload when nothing changed. */
  function configFingerprint(): string {
    return CONFIG_FILES.map((f) => {
      try {
        return readFileSync(join(paths.root, f), 'utf8');
      } catch {
        return '\u0000missing';
      }
    }).join('\u0000');
  }

  // A check from the watcher and one from the setup page run one after the other.
  let configChain: Promise<void> = Promise.resolve();
  function queueConfigCheck(): Promise<void> {
    const run = configChain.then(onConfigChanged);
    configChain = run.catch((err: unknown) => log(`The new configuration was not fully applied: ${errorText(err)}`));
    return configChain;
  }

  function scheduleConfigCheck(): void {
    if (configTimer !== undefined) clearTimeout(configTimer);
    configTimer = setTimeout(() => {
      configTimer = undefined;
      void queueConfigCheck();
    }, options.configDebounceMs ?? 300);
  }

  function watchConfig(): void {
    try {
      configWatcher = watch(paths.root, (_event, filename) => {
        if (filename === null || CONFIG_FILES.includes(filename)) scheduleConfigCheck();
      });
      configWatcher.on('error', (err) => log(`Watching agent.yaml stopped: ${errorText(err)}`));
    } catch (err) {
      log(`agent.yaml cannot be watched for changes: ${errorText(err)}`);
    }
    // On macOS the watcher misses changes made in the first moments after it starts. One check covers them.
    scheduleConfigCheck();
  }

  async function onConfigChanged(): Promise<void> {
    if (!running) return;
    const seen = configFingerprint();
    if (seen === configSeen) return;
    configSeen = seen;
    const hadConfig = loaded !== undefined;
    const before = loaded?.config;
    if (!readConfig()) {
      if (configError !== reportedConfigError) {
        reportedConfigError = configError;
        const text = hadConfig
          ? `agent.yaml is invalid, so the harness keeps the last valid values. ${configError ?? ''}`
          : `agent.yaml is still not valid. ${configError ?? ''}`;
        log(text);
        terminal.notice(text, cfg().agentName);
      }
      if (!hadConfig) dispatcher.setBlocker(await computeBlocker());
      return;
    }
    reportedConfigError = undefined;
    registry.reload();
    await loadSecrets();
    if (cfg().telegramUserId === undefined) await stopTelegram();
    else await startTelegram();
    if (before !== undefined && before.agentName !== cfg().agentName && telegram !== undefined) {
      for (const m of registry.list()) await updateThread(m);
    }
    if (!hadConfig || dispatcher.pauseRecord().blocker !== undefined) await reevaluateBlocker();
    if (!hadConfig) await checkAllCredentials();
    await scheduler?.refresh();
  }

  // ------------------------------------------------------------ start and stop

  let scheduler: Scheduler | undefined;
  let aliveTimer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let startedAt: string | undefined;
  let missed: MissedTimerRun[] = [];

  /** Keeps the missed timer runs that the scheduler reports at the start, for the dashboard. */
  function noteMissed(missionId: MissionId, event: TriggerEvent): void {
    const d = event.data;
    if (event.triggerId !== cronTrigger.id || d.missed !== true) return;
    missed.push({
      missionId,
      expression: String(d.expression ?? ''),
      dueAt: String(d.scheduledAt ?? event.time),
      count: typeof d.missedCount === 'number' ? d.missedCount : 1,
      countIsMinimum: d.missedCountIsMinimum === true,
    });
  }

  function status(): HarnessStatus {
    const rec = dispatcher.pauseRecord();
    const busy = new Set(dispatcher.busy());
    const out: HarnessStatus = {
      running,
      pid: process.pid,
      paused: dispatcher.isPaused(),
      pauseReason: pauseReason(rec),
      pause: rec,
      defaultSurface: cfg().defaultSurface,
      telegramRunning: telegram !== undefined,
      missions: registry
        .list()
        .map((m) => ({ id: m.id, name: m.name, status: m.status, version: m.version, running: busy.has(m.id) })),
      manifestErrors: registry.errors(),
    };
    if (startedAt !== undefined) out.startedAt = startedAt;
    if (loaded !== undefined) out.agentName = loaded.config.agentName;
    if (configError !== undefined) out.configError = configError;
    return out;
  }

  async function start(): Promise<void> {
    if (running) return;
    // A second harness must not replace the server file of one that runs (§J.3).
    const info = readServerFile(paths);
    if (info !== undefined && (await isServerAlive(info))) throw new HarnessAlreadyRunningError(paths.root, info.pid);

    const startTime = now();
    const startRecord = recordStart(store, startTime);
    try {
      await startInner(startRecord);
    } catch (err) {
      // A start that failed is not a crash of a running harness.
      store.deleteState(STATE_KEYS.running);
      await server.stop().catch(() => undefined);
      throw err;
    }
  }

  async function startInner(startRecord: ReturnType<typeof recordStart>): Promise<void> {
    missed = [];
    configSeen = configFingerprint();
    readConfig();
    registry.reload();
    known = snapshot(registry.list());

    // Requests left by the last run of the harness are cancelled before any new one (§G).
    const stale = clearStaleApprovals(store);
    for (const r of stale) {
      store.addNotice(
        r.missionId,
        `Your request for ${r.action} was cancelled because the harness restarted. The action did not run. Ask again if it is still needed.`,
      );
    }

    // A run that was in progress is not continued and not repeated (§H).
    const interrupted = takeInterruptedRuns(store);
    const stopReason = 'The harness stopped while this run was in progress. The run is not continued and not repeated.';
    for (const r of interrupted) {
      // The harness was last seen alive at lastStoppedAt, which can be before the run started.
      const seen = startRecord.lastStoppedAt;
      const endedAt = seen !== undefined && seen > r.startedAt ? seen : r.startedAt;
      try {
        store.insertRun({
          missionId: r.missionId,
          manifestVersion: r.manifestVersion,
          startedAt: r.startedAt,
          endedAt,
          input: r.input,
          toolsCalled: [],
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          status: 'failed',
          error: stopReason,
          finalText: '',
        });
      } catch (err) {
        log(`The interrupted run of ${r.missionId} could not be recorded: ${errorText(err)}`);
      }
      store.addNotice(r.missionId, `Your run that started at ${r.startedAt} was interrupted because the harness stopped. It may have acted in part.`);
    }

    await loadSecrets();
    if (startRecord.pauseForCrashes) await dispatcher.hold('crash', CRASH_TEXT, false);
    const blocker = await computeBlocker();

    await terminal.start(surfaceHost);
    await server.start();
    running = true;
    startedAt = now().toISOString();
    try {
      await startTelegram();
    } catch (err) {
      log(`The Telegram surface did not start: ${errorText(err)}`);
    }

    registry.onChange(() => void syncMissions());
    registry.watch();
    watchConfig();

    // What the user must know about this start.
    if (startRecord.crashed) log('The harness did not stop cleanly the last time it ran.');
    if (stale.length > 0) {
      const list = stale.map((r) => `${registry.get(r.missionId)?.name ?? r.missionId}: ${r.action}`).join('; ');
      await dispatcher.notifyUser(
        `The harness restarted, so ${stale.length === 1 ? 'one approval request' : `${stale.length} approval requests`} ` +
          `that waited were cancelled (${list}). Each mission can ask again at its next run.`,
      );
    }
    for (const r of interrupted) {
      const name = registry.get(r.missionId)?.name ?? r.missionId;
      await dispatcher.notifyUser(
        `A run of ${name} that started at ${r.startedAt} was in progress when the harness stopped. ` +
          'It is recorded as failed in the logbook and is not repeated.',
        registry.get(r.missionId) === undefined ? null : r.missionId,
      );
    }
    reportManifestErrors();
    if (loaded !== undefined) await checkAllCredentials();

    // Setting the blocker also starts the work that waits, when the agent is not paused.
    dispatcher.setBlocker(blocker);
    if (dispatcher.isPaused()) {
      const text = `The harness started paused. ${pauseReason(dispatcher.pauseRecord())}`;
      log(text);
      if (blocker?.kind === 'credential') terminal.notice(text, cfg().agentName);
      else await dispatcher.notifyUser(text);
    }

    scheduler = createScheduler({
      catalog: triggerCatalog,
      registry,
      credentials: (ids) => cache.pick(ids),
      ...(startRecord.lastStoppedAt !== undefined ? { lastStoppedAt: startRecord.lastStoppedAt } : {}),
      onEvent: (missionId, event) => {
        noteMissed(missionId, event);
        dispatcher.onEvent(missionId, event);
      },
      onError: (triggerId, err) => log(`Trigger ${triggerId}: ${err.message}`),
    });
    await scheduler.start();

    // A crash writes nothing, so the harness writes that it is alive every minute.
    recordAlive(store, now());
    aliveTimer = setInterval(() => {
      try {
        recordAlive(store, now());
      } catch (err) {
        log(`last_alive_at could not be written: ${errorText(err)}`);
      }
    }, options.aliveIntervalMs ?? 60_000);
    aliveTimer.unref();
  }

  let storeOpen = true;
  function closeStore(): void {
    if (!storeOpen) return;
    storeOpen = false;
    store.close();
  }

  async function stop(): Promise<void> {
    // A harness whose start failed still holds the database open.
    if (!running) return closeStore();
    running = false;
    pairAbort?.abort();
    if (aliveTimer !== undefined) clearInterval(aliveTimer);
    if (configTimer !== undefined) clearTimeout(configTimer);
    configWatcher?.close();
    registry.stopWatching();
    await scheduler?.stop();

    // No new run starts. The runs in progress are stopped, and their logbook rows are written.
    dispatcher.close();
    const deadline = Date.now() + (options.stopWaitMs ?? 20_000);
    while (dispatcher.busy().length > 0 && Date.now() < deadline) {
      for (const id of engine.running()) await engine.stop(id);
      await Promise.race([dispatcher.idle(), delay(200)]);
    }
    approvals.cancelAll('the harness is stopping');
    await missionChain.catch(() => undefined);

    await stopTelegram();
    await terminal.stop();
    await server.stop();
    recordCleanStop(store, now());
    closeStore();
  }

  // ------------------------------------------------------------ what the local pages need (§J)

  let pairAbort: AbortController | undefined;

  async function currentBotToken(): Promise<string | undefined> {
    await cache.refresh(TELEGRAM_BOT_TOKEN);
    return cache.get(TELEGRAM_BOT_TOKEN);
  }

  const noBotToken = `No bot token is stored. Enter the token of ${TELEGRAM_BOT_TOKEN} first.`;

  async function checkTelegramBot(): Promise<BotCheck> {
    const token = await currentBotToken();
    if (token === undefined) return { ok: false, reason: noBotToken };
    return checkBot(token, options.telegramFetch);
  }

  async function pairTelegram(opts: { code: string; timeoutMs: number; signal?: AbortSignal }): Promise<number> {
    if (telegram !== undefined) throw new Error('The Telegram surface is running. Stop it before the pairing.');
    if (pairAbort !== undefined) throw new Error('A pairing is already in progress.');
    if (!running) throw new Error('The harness is not running.');
    const token = await currentBotToken();
    if (token === undefined) throw new Error(noBotToken);
    const abort = new AbortController();
    pairAbort = abort;
    try {
      return await pairTelegramUser({
        token,
        code: opts.code,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal === undefined ? abort.signal : AbortSignal.any([abort.signal, opts.signal]),
        ...(options.telegramFetch !== undefined ? { fetchFn: options.telegramFetch } : {}),
      });
    } finally {
      if (pairAbort === abort) pairAbort = undefined;
    }
  }

  async function reloadConfigNow(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (running) await queueConfigCheck();
    else readConfig();
    if (loaded !== undefined && configError === undefined) return { ok: true };
    return { ok: false, error: configError ?? configBlockerText() };
  }

  async function checkLoginNow(): Promise<LoginCheck> {
    await loadSecrets();
    const check = await checkModelLogin(loginDeps);
    const blocker = dispatcher.pauseRecord().blocker;
    if (check.ok && running && blocker !== undefined && blocker.kind !== 'config') await reevaluateBlocker();
    return check;
  }

  return {
    paths,
    store,
    registry,
    server,
    dispatcher,
    approvals,
    terminal,
    start,
    stop,
    status,
    handleEvent: (missionId, event) => dispatcher.onEvent(missionId, event),
    requiredCredentials: requiredIds,
    refreshSecret,
    async settle() {
      // A run can change a mission, so the two waits repeat until neither has work left.
      for (let i = 0; i < 20; i++) {
        await missionChain;
        await dispatcher.idle();
        await missionChain;
        if (dispatcher.busy().length === 0) return;
      }
    },
    telegram: {
      async stop() {
        telegramHeld = true;
        await stopTelegram();
      },
      async start() {
        telegramHeld = false;
        await startTelegram();
      },
      running: () => telegram !== undefined,
      check: checkTelegramBot,
      pair: pairTelegram,
    },
    config: () => loaded,
    configError: () => configError,
    reloadConfig: reloadConfigNow,
    secrets: {
      async has(id) {
        assertCredentialId(id);
        return secretStore.has(id);
      },
      async set(id, value) {
        assertCredentialId(id);
        await secretStore.set(id, value);
        await refreshSecret(id);
      },
      async delete(id) {
        assertCredentialId(id);
        const deleted = await secretStore.delete(id);
        await refreshSecret(id);
        return deleted;
      },
    },
    checkLogin: checkLoginNow,
    catalogs: { tools: toolCatalog, triggers: triggerCatalog },
    missedTimerRuns: () => [...missed],
    redact: (text) => redactor.redact(text),
  };
}
