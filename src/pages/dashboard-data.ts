import { readdirSync, readFileSync, statSync } from 'node:fs';
import { Cron } from 'croner';
import type { ReadOnlyStore } from '../db/index.js';
import type { Harness } from '../harness/index.js';
import { isSystemMissionId } from '../manifest/index.js';
import { CRON_TRIGGER_ID } from '../triggers/index.js';
import type { Manifest, MissionId, RunRow } from '../types.js';

/**
 * The data of the dashboard (chapter 6). Every function here only reads: the harness's state in
 * memory, the database through a read-only connection, and the mission folders.
 * Texts such as names, inputs and errors are returned as data. The page shows them as text only.
 */

/** The SDK loads at most 200 lines or 25 KB of a mission index (§C.1). */
export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_BYTES = 25 * 1024;

/** The longest input of an approval that the dashboard shows. */
const APPROVAL_INPUT_CHARS = 600;

export interface DashboardSource {
  harness: Harness;
  /** Opens the database for reading only. The caller closes it. */
  openStore(): ReadOnlyStore;
  now(): Date;
}

function nameOf(h: Harness, id: MissionId): string {
  return h.registry.get(id)?.name ?? id;
}

function withStore<T>(src: DashboardSource, fn: (store: ReadOnlyStore) => T): T {
  const store = src.openStore();
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------- the harness

export function harnessView(src: DashboardSource) {
  const h = src.harness;
  const st = h.status();
  return {
    agentName: st.agentName ?? null,
    running: st.running,
    startedAt: st.startedAt ?? null,
    paused: st.paused,
    pauseReason: st.pauseReason,
    pausedSince: st.pause.blocker?.since ?? st.pause.hold?.since ?? null,
    configError: st.configError ?? null,
    defaultSurface: st.defaultSurface,
    telegramRunning: st.telegramRunning,
    missedTimerRuns: h.missedTimerRuns().map((m) => ({ ...m, missionName: nameOf(h, m.missionId) })),
    manifestErrors: st.manifestErrors,
    now: src.now().toISOString(),
  };
}

// ---------------------------------------------------------------- missions

/** The next time of each timer of an active mission, from its cron expression (§B.2). */
function nextTimerRun(m: Manifest, now: Date): string | null {
  if (m.status !== 'active') return null;
  let next: Date | null = null;
  for (const sub of m.triggers) {
    if (sub.use !== CRON_TRIGGER_ID || typeof sub.at !== 'string') continue;
    try {
      const at = new Cron(sub.at.trim()).nextRun(now);
      if (at !== null && (next === null || at < next)) next = at;
    } catch {
      // The registry rejects an invalid expression, so this does not happen.
    }
  }
  return next === null ? null : next.toISOString();
}

function lastRunOf(row: RunRow | undefined) {
  if (row === undefined) return null;
  return { startedAt: row.startedAt, endedAt: row.endedAt, status: row.status, error: row.error ?? null };
}

export function missionsView(src: DashboardSource) {
  const h = src.harness;
  const busy = new Set(h.status().missions.filter((m) => m.running).map((m) => m.id));
  const now = src.now();
  return withStore(src, (store) => ({
    missions: h.registry.list().map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      status: m.status,
      version: m.version,
      system: isSystemMissionId(m.id),
      running: busy.has(m.id),
      timers: m.triggers.filter((t) => t.use === CRON_TRIGGER_ID).map((t) => String(t.at)),
      lastRun: lastRunOf(store.listRuns({ missionId: m.id, limit: 1 })[0]),
      nextTimerRun: nextTimerRun(m, now),
    })),
    invalid: h.registry.errors(),
  }));
}

// ---------------------------------------------------------------- runs

export const DEFAULT_RUNS = 50;
export const MAX_RUNS = 500;

export function runsView(src: DashboardSource, options: { limit?: number; missionId?: string } = {}) {
  const h = src.harness;
  const limit = Math.min(MAX_RUNS, Math.max(1, Math.trunc(options.limit ?? DEFAULT_RUNS)));
  return withStore(src, (store) => {
    const filter: { limit: number; missionId?: string } = { limit };
    if (options.missionId !== undefined) filter.missionId = options.missionId;
    return {
      runs: store.listRuns(filter).map((r) => ({
        id: r.id ?? null,
        missionId: r.missionId,
        missionName: nameOf(h, r.missionId),
        manifestVersion: r.manifestVersion,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        input: r.input,
        toolsCalled: r.toolsCalled,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costUsd: r.costUsd,
        status: r.status,
        failed: r.status === 'failed',
        error: r.error ?? null,
      })),
    };
  });
}

// ---------------------------------------------------------------- cost

function startOfLocalDay(now: Date, daysBack: number): Date {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d;
}

export function costView(src: DashboardSource) {
  const h = src.harness;
  const now = src.now();
  // "The last 7 days" is today and the 6 days before it, in local time.
  const periods = [
    { key: 'today', label: 'Today', since: startOfLocalDay(now, 0).toISOString() },
    { key: 'week', label: 'Last 7 days', since: startOfLocalDay(now, 6).toISOString() },
    { key: 'month', label: 'Last 30 days', since: startOfLocalDay(now, 29).toISOString() },
    { key: 'all', label: 'All time', since: new Date(0).toISOString() },
  ];
  return withStore(src, (store) => {
    const ids: MissionId[] = h.registry.list().map((m) => m.id);
    // Deleted missions keep their logbook rows (§4.2.1), so their cost is still shown.
    for (const r of store.listRuns({ limit: MAX_RUNS })) if (!ids.includes(r.missionId)) ids.push(r.missionId);
    const totals = (missionId?: MissionId) =>
      Object.fromEntries(periods.map((p) => [p.key, store.costSince(p.since, missionId)])) as Record<string, number>;
    return {
      periods,
      total: totals(),
      missions: ids.map((id) => ({ id, name: nameOf(h, id), deleted: h.registry.get(id) === undefined, cost: totals(id) })),
    };
  });
}

// ---------------------------------------------------------------- approvals

export function approvalsView(src: DashboardSource) {
  const h = src.harness;
  const now = src.now().getTime();
  return {
    approvals: h.approvals.pending().map((a) => {
      let input = h.redact(JSON.stringify(a.input) ?? '');
      if (input.length > APPROVAL_INPUT_CHARS) input = `${input.slice(0, APPROVAL_INPUT_CHARS)}…`;
      return {
        id: a.id,
        missionId: a.missionId,
        missionName: nameOf(h, a.missionId),
        action: a.action,
        toolName: a.toolName,
        note: a.note ?? null,
        input,
        createdAt: a.createdAt,
        expiresAt: a.expiresAt,
        msLeft: Math.max(0, Date.parse(a.expiresAt) - now),
      };
    }),
  };
}

// ---------------------------------------------------------------- memory

function readOr(path: string, fallback: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return fallback;
  }
}

function lineCount(text: string): number {
  const t = text.replace(/\r\n/g, '\n').trimEnd();
  return t === '' ? 0 : t.split('\n').length;
}

function noteCount(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'MEMORY.md').length;
  } catch {
    return 0;
  }
}

export function memoryView(src: DashboardSource) {
  const h = src.harness;
  const p = h.paths;
  const cfg = h.config()?.config;
  const maxLines = cfg?.coreMemoryMaxLines ?? 50;
  const maxLineChars = cfg?.coreMemoryMaxLineChars ?? 200;
  const core = readOr(p.coreMemoryFile, '').replace(/\r\n/g, '\n').trimEnd();
  const coreLines = core === '' ? [] : core.split('\n');
  return {
    index: { maxLines: INDEX_MAX_LINES, maxBytes: INDEX_MAX_BYTES },
    core: {
      lines: coreLines.length,
      maxLines,
      maxLineChars,
      longLines: coreLines.filter((l) => l.length > maxLineChars).length,
    },
    missions: h.registry.list().map((m) => {
      const indexFile = p.memoryIndexFile(m.id);
      let indexBytes = 0;
      try {
        indexBytes = statSync(indexFile).size;
      } catch {
        indexBytes = 0;
      }
      return {
        id: m.id,
        name: m.name,
        status: m.status,
        notes: noteCount(p.memoryDir(m.id)),
        indexLines: lineCount(readOr(indexFile, '')),
        indexBytes,
      };
    }),
  };
}

// ---------------------------------------------------------------- tools and triggers

export async function codeView(src: DashboardSource) {
  const h = src.harness;
  const missions = h.registry.list();
  const present = new Map<string, boolean>();
  async function credentials(ids: readonly string[]) {
    const out: { id: string; present: boolean }[] = [];
    for (const id of ids) {
      if (!present.has(id)) present.set(id, await h.secrets.has(id));
      out.push({ id, present: present.get(id) === true });
    }
    return out;
  }
  const users = (test: (m: Manifest) => boolean) =>
    missions.filter(test).map((m) => ({ id: m.id, name: m.name, status: m.status }));

  const tools = [];
  for (const id of h.catalogs.tools.toolIds()) {
    const def = h.catalogs.tools.get(id);
    tools.push({
      id,
      reservedFor: def?.reservedFor ?? null,
      missions: users((m) => m.tools.includes(id)),
      credentials: await credentials(def?.credentials ?? []),
    });
  }
  const triggers = [];
  for (const id of h.catalogs.triggers.ids()) {
    const def = h.catalogs.triggers.get(id);
    triggers.push({
      id,
      missions: users((m) => m.triggers.some((t) => t.use === id)),
      credentials: await credentials(def?.credentials ?? []),
    });
  }
  return { tools, triggers };
}
