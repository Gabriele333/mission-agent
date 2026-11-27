import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { readJsonFile, writeFileAtomic } from './files.js';
import type { Layout } from './layout.js';

/**
 * The journal of an update in progress, `maintenance.json`, and the lock, `maintenance.lock`
 * (chapter 7.5). The journal is written before each stage and removed at the end, so a run that
 * was killed leaves it behind, and the next run finds where it stopped.
 */

/** The stages of an update, in order. */
export const STAGES = ['building', 'stopping', 'copying', 'swapping', 'starting', 'finishing', 'going-back', 'needs-repair'] as const;
export type Stage = (typeof STAGES)[number];

export interface Journal {
  operation: 'update';
  stage: Stage;
  oldVersion: string;
  newVersion: string;
  root: string;
  pid: number;
  startedAt: string;
  /** A service ran the harness of the root before the update. */
  wasService: boolean;
  /** The copy of the root folder that the update made. */
  copyDir?: string;
  /** The harness of the new version may have started, so it may have changed the root folder. */
  newStarted?: boolean;
  /** Why the update went back, or why going back failed. */
  reason?: string;
}

export function readJournal(layout: Layout): Journal | undefined {
  const v = readJsonFile(layout.journal);
  if (v === null || typeof v !== 'object') return undefined;
  const j = v as Record<string, unknown>;
  if (j.operation !== 'update' || !(STAGES as readonly unknown[]).includes(j.stage)) return undefined;
  if (typeof j.oldVersion !== 'string' || typeof j.newVersion !== 'string' || typeof j.root !== 'string') return undefined;
  const out: Journal = {
    operation: 'update',
    stage: j.stage as Stage,
    oldVersion: j.oldVersion,
    newVersion: j.newVersion,
    root: j.root,
    pid: typeof j.pid === 'number' ? j.pid : 0,
    startedAt: typeof j.startedAt === 'string' ? j.startedAt : '',
    wasService: j.wasService === true,
  };
  if (typeof j.copyDir === 'string') out.copyDir = j.copyDir;
  if (j.newStarted === true) out.newStarted = true;
  if (typeof j.reason === 'string') out.reason = j.reason;
  return out;
}

/** True when the journal is unreadable but present: it is then kept, and the user is told. */
export function journalUnreadable(layout: Layout): boolean {
  try {
    readFileSync(layout.journal);
  } catch {
    return false;
  }
  return readJournal(layout) === undefined;
}

export function writeJournal(layout: Layout, journal: Journal): void {
  writeFileAtomic(layout.journal, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
}

export function removeJournal(layout: Layout): void {
  try {
    unlinkSync(layout.journal);
  } catch {
    // Already gone.
  }
}

/** The stage `a` comes at or after the stage `b`. */
export function stageAtLeast(a: Stage, b: Stage): boolean {
  return STAGES.indexOf(a) >= STAGES.indexOf(b);
}

// ---------------------------------------------------------------- the lock

/** True when a process with this id exists. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists, and belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type LockResult = { ok: true; tookOver?: number } | { ok: false; pid: number };

function lockPid(layout: Layout): number | undefined {
  const v = readJsonFile(layout.lock);
  if (v === null || typeof v !== 'object') return undefined;
  const pid = (v as Record<string, unknown>).pid;
  return typeof pid === 'number' ? pid : undefined;
}

/**
 * Takes the lock for the process `pid`. A lock whose process is gone is stale and is taken over.
 * A lock file that cannot be read counts as stale too.
 */
export function takeLock(layout: Layout, pid: number, alive: (pid: number) => boolean = processAlive): LockResult {
  const text = `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`;
  try {
    writeFileSync(layout.lock, text, { flag: 'wx', mode: 0o600 });
    return { ok: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const holder = lockPid(layout);
  if (holder === pid) return { ok: true };
  if (holder !== undefined && alive(holder)) return { ok: false, pid: holder };
  writeFileAtomic(layout.lock, text, 0o600);
  // Two runs can take over the same stale lock at once. Only the one whose id is in the file has it.
  const now = lockPid(layout);
  if (now !== pid) return { ok: false, pid: now ?? 0 };
  return holder === undefined ? { ok: true } : { ok: true, tookOver: holder };
}

/** Removes the lock, but only when this process holds it. */
export function releaseLock(layout: Layout, pid: number): void {
  if (lockPid(layout) !== pid) return;
  try {
    unlinkSync(layout.lock);
  } catch {
    // Already gone.
  }
}

/** The process that holds the lock, when it still runs. */
export function lockHolder(layout: Layout, alive: (pid: number) => boolean = processAlive): number | undefined {
  const pid = lockPid(layout);
  return pid !== undefined && alive(pid) ? pid : undefined;
}
