import type { MissionId, RunInput, Store } from '../types.js';

/** Keys of the harness's own values in the `state` table (§E.2.2). */
export const STATE_KEYS = {
  /** JSON `PauseRecord`. Absent when the agent is not paused (§B.1). */
  paused: 'paused',
  /** The mission of the last chat message in the terminal (§B.3). */
  currentChatMission: 'current_chat_mission',
  /** ISO time written every minute and at a clean stop. Passed to the scheduler as `lastStoppedAt`. */
  lastAliveAt: 'last_alive_at',
  /** Present while the harness runs. Still present at a start means the last run of the harness crashed. */
  running: 'harness.running',
  /** JSON list of the ISO times of the starts that followed a crash (§H). */
  crashStarts: 'harness.crash_starts',
  /** JSON map from mission id to the run that is in progress (§H). */
  runsInProgress: 'harness.runs_in_progress',
  /** The local date (YYYY-MM-DD) on which the user was told that the daily cost limit is reached (§D). */
  dailyLimitNoticedOn: 'daily_limit_noticed_on',
  /** ISO time of the last check for a newer release that got an answer (chapter 7.4). */
  releaseCheckedAt: 'release.checked_at',
  /** The newest release that the user was told about, such as `0.2.0`. */
  releaseNoticed: 'release.noticed',
  /** The newest release that the last check found, such as `0.2.0`. */
  releaseLatest: 'release.latest',
  /** The notes of that release, when it is newer than the program that runs. */
  releaseNotes: 'release.notes',
} as const;

/** Keys that belong to one mission and are removed when it is deleted. */
export const MISSION_STATE_PREFIXES = ['run.session_totals:', 'manifest_hash:'] as const;

export const CRASH_WINDOW_MS = 10 * 60_000;
export const CRASHES_TO_PAUSE = 3;

// ---------------------------------------------------------------- pause (§B.1, §H, §A.5)

/**
 * `hold` is a pause that only `/resume` ends: the user's `/pause`, or the crash rule.
 * `blocker` is a pause that the harness sets and ends itself: no valid agent.yaml, no model
 * login, no bot token. The agent is paused while either is set.
 */
export type HoldKind = 'user' | 'crash';
export type BlockerKind = 'config' | 'login' | 'credential';

export interface PauseEntry<K extends string> {
  kind: K;
  reason: string;
  since: string;
}

export interface PauseRecord {
  hold?: PauseEntry<HoldKind>;
  blocker?: PauseEntry<BlockerKind>;
}

export function readPause(store: Pick<Store, 'getState'>): PauseRecord {
  const raw = store.getState(STATE_KEYS.paused);
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as PauseRecord;
    if (parsed !== null && typeof parsed === 'object') return parsed;
  } catch {
    // A value written by hand: treat it as the user's pause.
  }
  return { hold: { kind: 'user', reason: 'The agent was paused.', since: new Date(0).toISOString() } };
}

export function writePause(store: Pick<Store, 'setState' | 'deleteState'>, record: PauseRecord): void {
  if (record.hold === undefined && record.blocker === undefined) store.deleteState(STATE_KEYS.paused);
  else store.setState(STATE_KEYS.paused, JSON.stringify(record));
}

/** The reasons of a pause, in one text. Empty when the agent is not paused. */
export function pauseReason(record: PauseRecord): string {
  return [record.blocker?.reason, record.hold?.reason].filter((r): r is string => r !== undefined && r !== '').join(' ');
}

/** How the user ends a pause: fix the cause first when something blocks the agent, then send /resume. */
export function resumeHint(record: PauseRecord): string {
  return record.blocker !== undefined ? 'After you fix this, send /resume.' : 'Send /resume to end the pause.';
}

// ---------------------------------------------------------------- crash rule (§H)

export interface StartRecord {
  /** True when the previous run of the harness did not stop cleanly. */
  crashed: boolean;
  /** True when three starts followed a crash within ten minutes. */
  pauseForCrashes: boolean;
  /** The time the harness last wrote that it was alive, or undefined on a first start. */
  lastStoppedAt?: string;
}

/** Records a start. A crash writes nothing, so a `running` mark that is still there means a crash. */
export function recordStart(store: Pick<Store, 'getState' | 'setState'>, now: Date): StartRecord {
  const crashed = store.getState(STATE_KEYS.running) !== undefined;
  let starts: string[] = [];
  try {
    const raw = store.getState(STATE_KEYS.crashStarts);
    const parsed: unknown = raw === undefined ? [] : JSON.parse(raw);
    if (Array.isArray(parsed)) starts = parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    starts = [];
  }
  if (crashed) starts.push(now.toISOString());
  starts = starts.filter((t) => {
    const at = Date.parse(t);
    return Number.isFinite(at) && now.getTime() - at <= CRASH_WINDOW_MS && at <= now.getTime();
  });
  store.setState(STATE_KEYS.crashStarts, JSON.stringify(starts));
  store.setState(STATE_KEYS.running, now.toISOString());
  const lastStoppedAt = store.getState(STATE_KEYS.lastAliveAt);
  const record: StartRecord = { crashed, pauseForCrashes: starts.length >= CRASHES_TO_PAUSE };
  if (lastStoppedAt !== undefined) record.lastStoppedAt = lastStoppedAt;
  return record;
}

export function recordAlive(store: Pick<Store, 'setState'>, now: Date): void {
  store.setState(STATE_KEYS.lastAliveAt, now.toISOString());
}

export function recordCleanStop(store: Pick<Store, 'setState' | 'deleteState'>, now: Date): void {
  recordAlive(store, now);
  store.deleteState(STATE_KEYS.running);
}

// ---------------------------------------------------------------- runs in progress (§H)

export interface RunInProgress {
  missionId: MissionId;
  manifestVersion: number;
  startedAt: string;
  /** A short summary of the input, already redacted. */
  input: string;
}

function readRuns(store: Pick<Store, 'getState'>): Record<MissionId, RunInProgress> {
  const raw = store.getState(STATE_KEYS.runsInProgress);
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as Record<MissionId, RunInProgress>;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeRuns(store: Pick<Store, 'setState' | 'deleteState'>, runs: Record<MissionId, RunInProgress>): void {
  if (Object.keys(runs).length === 0) store.deleteState(STATE_KEYS.runsInProgress);
  else store.setState(STATE_KEYS.runsInProgress, JSON.stringify(runs));
}

export function markRunStarted(store: Pick<Store, 'getState' | 'setState' | 'deleteState'>, run: RunInProgress): void {
  const runs = readRuns(store);
  runs[run.missionId] = run;
  writeRuns(store, runs);
}

export function markRunEnded(store: Pick<Store, 'getState' | 'setState' | 'deleteState'>, missionId: MissionId): void {
  const runs = readRuns(store);
  if (!(missionId in runs)) return;
  delete runs[missionId];
  writeRuns(store, runs);
}

/** Returns and forgets the runs that were in progress when the harness last stopped. */
export function takeInterruptedRuns(store: Pick<Store, 'getState' | 'setState' | 'deleteState'>): RunInProgress[] {
  const runs = Object.values(readRuns(store));
  store.deleteState(STATE_KEYS.runsInProgress);
  return runs;
}

/** What started a run, in one short text, as the logbook shows it. */
export function inputSummary(input: RunInput, max = 300): string {
  const text = input.kind === 'chat' ? input.text : input.events.map((e) => `${e.triggerId}: ${e.summary}`).join('\n');
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// ---------------------------------------------------------------- local time

/** The start of the local day of `now`. */
export function startOfLocalDay(now: Date): Date {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

/** The start of the next local day. */
export function startOfNextLocalDay(now: Date): Date {
  const d = startOfLocalDay(now);
  d.setDate(d.getDate() + 1);
  return d;
}

/** The local date as YYYY-MM-DD. */
export function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
