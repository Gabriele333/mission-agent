/**
 * Shared types of the harness. Every module builds against this file.
 * Section numbers such as §A.4 refer to docs/design.md.
 * The self-improvement loop (§I) and signals (§A.4.7) are not built yet.
 */

// ---------------------------------------------------------------- basic ids

/** `m_` plus 12 lowercase base32 characters, or `sys-<name>` for a system mission (§A.4). */
export type MissionId = string;

export const SYS_GENERAL = 'sys-general';
export const SYS_MISSION_ADMIN = 'sys-mission-admin';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// ---------------------------------------------------------------- agent configuration (§A.1)

export interface RunLimits {
  /** One step is one model call. */
  maxSteps: number;
  maxCostUsd: number;
  maxMinutes: number;
}

/** The content of `agent.yaml`, with defaults applied. Keys in the file use snake_case. */
export interface AgentConfig {
  agentName: string;
  defaultSurface: 'telegram' | 'terminal';
  /** The numeric id of the user's Telegram account. Unset when Telegram is not used. */
  telegramUserId?: number;
  modelLogin: 'api_key' | 'subscription';
  maxIndexLineChars: number;
  maxNoteBytes: number;
  coreMemoryMaxLines: number;
  coreMemoryMaxLineChars: number;
  maxInstructionsChars: number;
  maxDescriptionChars: number;
  runLimits: RunLimits;
  maxCostPerDayUsd: number;
  approvalWaitHours: number;
  triageSwitchConfidence: number;
  retriesAfterFailure: number;
  defaultModel: string;
  defaultEffort: Effort;
  triageModel: string;
  triageEffort: Effort;
}

/** The agent configuration plus the two text files that belong to it (§A.1, §A.2). */
export interface LoadedConfig {
  config: AgentConfig;
  /** The core text, with `{agent name}` already replaced. */
  coreText: string;
  /** The paragraph about saving notes (§I.1). Empty when its file does not exist. */
  noteParagraph: string;
}

// ---------------------------------------------------------------- manifest (§A.4)

export type MissionStatus = 'active' | 'frozen';

export interface TriggerSubscription {
  /** A trigger id, such as `trigger:cron`. */
  use: string;
  /** Parameters of the subscription, such as `at` for a timer. */
  [param: string]: unknown;
}

export type GateKind = 'gate:allow' | 'gate:require_approval' | 'gate:deny';

export interface GateRule {
  use: GateKind;
  /** An action id, such as `action:email.send`. */
  for: string;
  /** The sentence shown to the user in the approval request. */
  note?: string;
}

export interface Manifest {
  id: MissionId;
  name: string;
  description: string;
  version: number;
  status: MissionStatus;
  triggers: TriggerSubscription[];
  /** Tool ids, such as `tool:gmail`. */
  tools: string[];
  context: { instructions: string };
  /** Signal ids. Accepted and validated as a list of strings, not used yet. */
  signals: string[];
  gates: GateRule[];
  /** A model id, or `default`. */
  model?: string;
  effort?: Effort;
  /** Lower than the harness defaults, never higher (§D). */
  limits?: Partial<{ max_steps: number; max_cost_usd: number; max_minutes: number }>;
}

/** What the mission admin gives to create or edit a mission. The registry sets id and version. */
export type ManifestDraft = Omit<Manifest, 'id' | 'version' | 'status'> & { status?: MissionStatus };

export interface ManifestError {
  /** The manifest file, or the mission id for a manifest that is part of the code. */
  source: string;
  message: string;
}

/** The ids of the code that a manifest can refer to. The registry validates against it. */
export interface CodeCatalog {
  toolIds(): string[];
  triggerIds(): string[];
  actionIds(): string[];
  /** Mission ids that may list the tool. Undefined means any mission. */
  toolReservedFor(toolId: string): MissionId[] | undefined;
  /** Returns an error text, or null when the parameters of a subscription are valid. */
  validateTriggerParams(sub: TriggerSubscription): string | null;
}

/** The valid manifests, kept in memory (§A.4, Mission registry). */
export interface MissionRegistry {
  /** Every valid manifest, system missions included. */
  list(): Manifest[];
  get(id: MissionId): Manifest | undefined;
  getByName(name: string): Manifest | undefined;
  errors(): ManifestError[];
  /** Scans `missions/` again. Raises `version` in a file whose content changed (§A.4). */
  reload(): void;
  onChange(listener: () => void): void;
  /** Starts and stops watching `missions/` for changed files. */
  watch(): void;
  stopWatching(): void;
  /** The four operations of the mission admin (§4.2.1). Each one validates before it writes. */
  create(draft: ManifestDraft): Manifest;
  edit(id: MissionId, patch: Partial<ManifestDraft>): Manifest;
  setStatus(id: MissionId, status: MissionStatus): Manifest;
  /** Removes the mission's folder. The caller removes the session, the approvals and the thread. */
  remove(id: MissionId): void;
}

// ---------------------------------------------------------------- tools (§A.5)

export interface OperationDeclaration {
  /** The tool name as the SDK reports it in a tool call, such as `mcp__gmail__send` or `WebSearch`. */
  sdkToolName: string;
  /** An action id, such as `action:email.send`. */
  action: string;
  /** `read` only reads. `change` changes something outside the agent. */
  effect: 'read' | 'change';
}

export interface ToolContext {
  missionId: MissionId;
  root: string;
  /** Values of the credentials that the tool declared, keyed by credential id. */
  credentials: Record<string, string>;
  host: ToolHost;
}

/** What a run needs to have one tool. */
export interface ToolProvision {
  /** Names of SDK built-in tools to enable, such as `WebSearch`. */
  sdkTools?: string[];
  /** MCP servers to pass to the run, keyed by server name. Values are SDK MCP server configs. */
  mcpServers?: Record<string, unknown>;
}

/** One tool of the harness: its declaration and the code that provides it to a run. */
export interface ToolDefinition {
  /** `tool:<name>`. Undefined for a tool that every mission has (§C.5). */
  id?: string;
  operations: OperationDeclaration[];
  /** Credential ids that the tool needs. */
  credentials: string[];
  /** Mission ids that may list this tool. Undefined means any mission. */
  reservedFor?: MissionId[];
  provide(ctx: ToolContext): ToolProvision;
}

/** What tool code can ask of the harness. */
export interface ToolHost {
  /** Sends a text, and optionally a file from the mission's `data/` folder, to the user (§F.1). */
  sendMessage(missionId: MissionId, text: string, filePath?: string): Promise<void>;
  registry: MissionRegistry;
  /** Removes what belongs to a deleted mission outside its folder: session, approvals, thread. */
  cleanUpDeletedMission(id: MissionId): Promise<void>;
  /** Called after a mission is created, renamed, frozen or unfrozen, so that surfaces update threads. */
  missionChanged(id: MissionId): Promise<void>;
}

export interface ToolCatalog extends Pick<CodeCatalog, 'toolIds' | 'actionIds' | 'toolReservedFor'> {
  get(toolId: string): ToolDefinition | undefined;
  /** Tools that every mission has without listing them: the message tool and the delete tool. */
  alwaysOn(): ToolDefinition[];
  /** Finds the declaration of an operation by the name the SDK reports. */
  findOperation(sdkToolName: string): { tool: ToolDefinition; operation: OperationDeclaration } | undefined;
}

// ---------------------------------------------------------------- gate and approvals (§D.3, §E.2.1, §G)

export interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
}

export type GateDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; message: string }
  | { decision: 'ask'; action: string; note?: string };

/** Decides on one tool call of a run: path rules for file tools, then the gate (§D.3, §E.2.1). */
export interface Gate {
  check(call: ToolCall, manifest: Manifest): GateDecision;
}

export interface ApprovalRequest {
  id: string;
  missionId: MissionId;
  action: string;
  toolName: string;
  input: Record<string, unknown>;
  note?: string;
  createdAt: string;
  /** ISO time after which the harness cancels the request (§G). */
  expiresAt: string;
}

export type ApprovalAnswer =
  | { kind: 'approved' }
  | { kind: 'rejected'; reason?: string }
  | { kind: 'cancelled'; reason: string };

/** Holds the actions that wait for the user (§G). */
export interface ApprovalQueue {
  /** Shows the request to the user and waits. Resolves on an answer, on the time limit or on a cancel. */
  request(req: Pick<ApprovalRequest, 'missionId' | 'action' | 'toolName' | 'input' | 'note'>): Promise<ApprovalAnswer>;
  /** Called by a surface. Returns false when the request is no longer waiting. */
  answer(id: string, answer: ApprovalAnswer): boolean;
  cancelForMission(missionId: MissionId, reason: string): void;
  cancelAll(reason: string): void;
  pending(): ApprovalRequest[];
}

// ---------------------------------------------------------------- triggers (§B.2)

export interface TriggerEvent {
  triggerId: string;
  /** ISO time of the event. */
  time: string;
  /** Unique key. The harness drops an event whose key it has already seen for the mission. */
  key: string;
  /** One line in plain words that says what happened. */
  summary: string;
  data: Record<string, unknown>;
}

export interface Subscription {
  missionId: MissionId;
  params: Record<string, unknown>;
}

export interface TriggerContext {
  /** Gives one event to the harness for one subscribed mission. */
  emit(missionId: MissionId, event: TriggerEvent): void;
  credentials: Record<string, string>;
  /** ISO time at which the harness last stopped, for a timer run that was missed (§B.2). */
  lastStoppedAt?: string;
}

export interface TriggerInstance {
  /** Starts watching, or replaces the subscriptions of a trigger that already runs. */
  setSubscriptions(subs: Subscription[]): Promise<void>;
  stop(): Promise<void>;
}

export interface TriggerDefinition {
  /** `trigger:<thing>.<event>`, or `trigger:cron` and `trigger:chat`. */
  id: string;
  credentials: string[];
  /** Returns an error text, or null when the parameters are valid. */
  validateParams(params: Record<string, unknown>): string | null;
  /** `trigger:chat` watches nothing and returns null. */
  create(ctx: TriggerContext): TriggerInstance | null;
}

// ---------------------------------------------------------------- runs (§C, §D, §H)

export type RunInput =
  | { kind: 'chat'; text: string; surface: string }
  | { kind: 'events'; events: TriggerEvent[] };

export interface RunRequest {
  missionId: MissionId;
  input: RunInput;
  /** Notices from the harness, added to the run's input (§C.4). */
  notices: string[];
}

export type RunStatus = 'success' | 'failed' | 'stopped' | 'limit' | 'declined';

export interface RunResult {
  status: RunStatus;
  /** The run's final text. Empty when there is none. */
  finalText: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  steps: number;
  sessionId?: string;
  toolsCalled: string[];
  /** Set when the status is not `success`. */
  error?: string;
  startedAt: string;
  endedAt: string;
  /** True when the run was tried a second time after a failure (§H). */
  retried: boolean;
}

/** Makes one run of one mission through the SDK. The caller holds the mission's turn slot (§C.3). */
export interface RunEngine {
  run(req: RunRequest): Promise<RunResult>;
  /** Stops the run in progress of a mission. Returns false when there is none. */
  stop(missionId: MissionId): Promise<boolean>;
  running(): MissionId[];
}

// ---------------------------------------------------------------- store (§E.2.2)

export interface RunRow {
  id?: number;
  missionId: MissionId;
  manifestVersion: number;
  startedAt: string;
  endedAt: string;
  /** What started the run, in short: the chat text or the event summaries. Secrets are already redacted. */
  input: string;
  toolsCalled: string[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  status: RunStatus;
  error?: string;
  finalText: string;
}

export interface QueuedEvent {
  id: number;
  missionId: MissionId;
  event: TriggerEvent;
  queuedAt: string;
}

/** The database: logbook and harness state. One SQLite file, `state/agent.db` (§E.2.2). */
export interface Store {
  // logbook
  insertRun(row: RunRow): number;
  listRuns(filter?: { missionId?: MissionId; limit?: number }): RunRow[];
  /** Total cost of the runs that started at or after the given ISO time. */
  costSince(isoTime: string, missionId?: MissionId): number;

  // session registry (§C.3)
  getSession(missionId: MissionId): string | undefined;
  setSession(missionId: MissionId, sessionId: string): void;
  deleteSession(missionId: MissionId): void;

  // event queues and the keys of events already seen (§B.2)
  /** Returns false and stores nothing when the key was already seen for this mission. */
  enqueueEvent(missionId: MissionId, event: TriggerEvent): boolean;
  /**
   * Removes and returns the waiting events of a mission, oldest first.
   * With a trigger id, it takes only the events of that trigger and leaves the others (§B.2).
   */
  takeEvents(missionId: MissionId, triggerId?: string): QueuedEvent[];
  /** Returns the waiting events of a mission, oldest first, and removes nothing. */
  peekEvents(missionId: MissionId): QueuedEvent[];
  missionsWithEvents(): MissionId[];
  deleteEvents(missionId: MissionId): void;

  // waiting approvals (§G)
  saveApproval(req: ApprovalRequest): void;
  deleteApproval(id: string): void;
  listApprovals(): ApprovalRequest[];

  // notices that wait for a mission's next run (§C.4)
  addNotice(missionId: MissionId, text: string): void;
  takeNotices(missionId: MissionId): string[];

  // Telegram thread of each mission (§F.1)
  getThread(missionId: MissionId): number | undefined;
  setThread(missionId: MissionId, threadId: number): void;
  deleteThread(missionId: MissionId): void;
  missionOfThread(threadId: number): MissionId | undefined;

  // small values: `paused`, `current_chat_mission`, `last_stopped_at`, crash times and so on
  getState(key: string): string | undefined;
  setState(key: string, value: string): void;
  deleteState(key: string): void;

  /** Removes everything of a deleted mission except its logbook rows (§4.2.1). */
  deleteMissionState(missionId: MissionId): void;
  close(): void;
}

// ---------------------------------------------------------------- secrets (§A.5)

/** The one place that reads and writes the Keychain. Service `mission-agent`, account = credential id. */
export interface SecretStore {
  get(credentialId: string): Promise<string | undefined>;
  set(credentialId: string, value: string): Promise<void>;
  delete(credentialId: string): Promise<boolean>;
  has(credentialId: string): Promise<boolean>;
}

/** Replaces any stored secret value found in a text with the credential's id (§A.5). */
export interface Redactor {
  redact(text: string): string;
}

// ---------------------------------------------------------------- surfaces (§F.1)

export interface IncomingMessage {
  /** `surface:terminal` or `surface:telegram`. */
  surface: string;
  text: string;
  /** Set when the surface knows the mission, as in a Telegram thread of a mission. */
  missionId?: MissionId;
  /** Paths of files that the user sent, already saved by the surface in a temporary place. */
  files?: string[];
}

export interface OutgoingMessage {
  /** Null for a notice that concerns no mission. */
  missionId: MissionId | null;
  /** `<agent name> · <mission name>` (§F.1). */
  label: string;
  text: string;
  filePath?: string;
}

/** What a surface can ask of the harness. */
export interface SurfaceHost {
  /** A chat message or a command (a text that starts with `/`) from the user (§B.1). */
  incoming(msg: IncomingMessage): Promise<void>;
  answerApproval(id: string, answer: ApprovalAnswer): boolean;
  /** `<agent name> · <mission name>`. */
  label(missionId: MissionId | null): string;
  store: Store;
}

/** One way to talk to the user. A surface is not a tool and not an MCP server (§F.1). */
export interface Surface {
  /** `surface:<name>`. */
  id: string;
  hasThreads: boolean;
  /** Credential ids that the surface needs. */
  credentials: string[];
  start(host: SurfaceHost): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutgoingMessage): Promise<void>;
  /** Shows a request with approve and reject. The answer comes back through `host.answerApproval`. */
  showApproval(req: ApprovalRequest, label: string): Promise<void>;
  /** Tells the surface that a request is closed, so it can remove the buttons. */
  closeApproval(id: string, outcome: string): Promise<void>;
  /** Only for a surface with threads. */
  createThread?(missionId: MissionId, label: string): Promise<void>;
  renameThread?(missionId: MissionId, label: string): Promise<void>;
  deleteThread?(missionId: MissionId): Promise<void>;
}

// ---------------------------------------------------------------- triage (§B.3)

export interface TriageResult {
  missionId: MissionId;
  /** Between 0 and 1. */
  confidence: number;
}

export interface Triage {
  /** Picks a mission among the active missions that list `trigger:chat`. */
  classify(text: string, candidates: Pick<Manifest, 'id' | 'name' | 'description'>[]): Promise<TriageResult>;
}
