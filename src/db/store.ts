import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import type {
  ApprovalRequest,
  MissionId,
  QueuedEvent,
  RunRow,
  RunStatus,
  Store,
  TriggerEvent,
} from '../types.js';
import { migrate, readSchemaVersion, SCHEMA_VERSION } from './schema.js';

/** How long a process waits for the write lock of another process, in milliseconds. */
const BUSY_TIMEOUT_MS = 5000;

/** Seen event keys older than this are removed when the store opens. */
const SEEN_KEY_DAYS = 30;

const DEFAULT_RUN_LIMIT = 100;

/** What the dashboard and the command line tools may read while the harness runs. */
export type ReadOnlyStore = Pick<
  Store,
  'listRuns' | 'costSince' | 'listApprovals' | 'getState' | 'getSession' | 'missionsWithEvents' | 'close'
>;

type Row = Record<string, SQLOutputValue>;

function text(v: SQLOutputValue | undefined): string {
  if (typeof v !== 'string') throw new Error(`Expected a text value in the database, found ${typeof v}.`);
  return v;
}

function num(v: SQLOutputValue | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  throw new Error(`Expected a number in the database, found ${typeof v}.`);
}

/** Returns the time in the form `2026-11-25T10:00:00.000Z`, so that times compare as text. */
function isoUtc(value: string, field: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`${field} is not a valid ISO 8601 time: ${JSON.stringify(value)}`);
  return d.toISOString();
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Runs `fn` in one write transaction. */
function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

function toRunRow(r: Row): RunRow {
  const row: RunRow = {
    id: num(r.id),
    missionId: text(r.mission_id),
    manifestVersion: num(r.manifest_version),
    startedAt: text(r.started_at),
    endedAt: text(r.ended_at),
    input: text(r.input),
    toolsCalled: JSON.parse(text(r.tools_called)) as string[],
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    costUsd: num(r.cost_usd),
    status: text(r.status) as RunStatus,
    finalText: text(r.final_text),
  };
  if (r.error !== null && r.error !== undefined) row.error = text(r.error);
  return row;
}

function toApproval(r: Row): ApprovalRequest {
  const req: ApprovalRequest = {
    id: text(r.id),
    missionId: text(r.mission_id),
    action: text(r.action),
    toolName: text(r.tool_name),
    input: JSON.parse(text(r.input)) as Record<string, unknown>,
    createdAt: text(r.created_at),
    expiresAt: text(r.expires_at),
  };
  if (r.note !== null && r.note !== undefined) req.note = text(r.note);
  return req;
}

/** The methods that only read. Both the full store and the read-only view use them. */
function readMethods(db: DatabaseSync): ReadOnlyStore {
  const runsAll = db.prepare('SELECT * FROM runs ORDER BY started_at DESC, id DESC LIMIT ?');
  const runsOfMission = db.prepare(
    'SELECT * FROM runs WHERE mission_id = ? ORDER BY started_at DESC, id DESC LIMIT ?',
  );
  const costAll = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs WHERE started_at >= ?');
  const costOfMission = db.prepare(
    'SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs WHERE started_at >= ? AND mission_id = ?',
  );
  const approvalsAll = db.prepare('SELECT * FROM approvals ORDER BY created_at, id');
  const stateGet = db.prepare('SELECT value FROM state WHERE key = ?');
  const sessionGet = db.prepare('SELECT session_id FROM sessions WHERE mission_id = ?');
  // The mission whose oldest waiting event came first is listed first.
  const eventMissions = db.prepare('SELECT mission_id FROM event_queue GROUP BY mission_id ORDER BY MIN(id)');

  return {
    listRuns(filter) {
      const limit = Math.max(0, Math.trunc(filter?.limit ?? DEFAULT_RUN_LIMIT));
      const rows =
        filter?.missionId === undefined ? runsAll.all(limit) : runsOfMission.all(filter.missionId, limit);
      return rows.map(toRunRow);
    },
    costSince(isoTime, missionId) {
      const since = isoUtc(isoTime, 'isoTime');
      const row = missionId === undefined ? costAll.get(since) : costOfMission.get(since, missionId);
      return num(row?.total);
    },
    listApprovals() {
      return approvalsAll.all().map(toApproval);
    },
    getState(key) {
      const row = stateGet.get(key);
      return row === undefined ? undefined : text(row.value);
    },
    getSession(missionId) {
      const row = sessionGet.get(missionId);
      return row === undefined ? undefined : text(row.session_id);
    },
    missionsWithEvents() {
      return eventMissions.all().map((r) => text(r.mission_id));
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
}

function storeOn(db: DatabaseSync): Store {
  const read = readMethods(db);

  const runInsert = db.prepare(`
    INSERT INTO runs (mission_id, manifest_version, started_at, ended_at, input, tools_called,
      input_tokens, output_tokens, cost_usd, status, error, final_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const sessionSet = db.prepare(`
    INSERT INTO sessions (mission_id, session_id, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (mission_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`);
  const sessionDelete = db.prepare('DELETE FROM sessions WHERE mission_id = ?');

  const seenInsert = db.prepare(
    'INSERT OR IGNORE INTO seen_event_keys (mission_id, event_key, seen_at) VALUES (?, ?, ?)',
  );
  const seenDeleteMission = db.prepare('DELETE FROM seen_event_keys WHERE mission_id = ?');
  const eventInsert = db.prepare('INSERT INTO event_queue (mission_id, event, queued_at) VALUES (?, ?, ?)');
  const eventsOfMission = db.prepare('SELECT * FROM event_queue WHERE mission_id = ? ORDER BY id');
  const eventsDelete = db.prepare('DELETE FROM event_queue WHERE mission_id = ?');
  const eventDeleteById = db.prepare('DELETE FROM event_queue WHERE id = ?');

  const approvalSave = db.prepare(`
    INSERT OR REPLACE INTO approvals (id, mission_id, action, tool_name, input, note, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const approvalDelete = db.prepare('DELETE FROM approvals WHERE id = ?');
  const approvalsDeleteMission = db.prepare('DELETE FROM approvals WHERE mission_id = ?');

  const noticeAdd = db.prepare('INSERT INTO notices (mission_id, text, created_at) VALUES (?, ?, ?)');
  const noticesOfMission = db.prepare('SELECT text FROM notices WHERE mission_id = ? ORDER BY id');
  const noticesDelete = db.prepare('DELETE FROM notices WHERE mission_id = ?');

  const threadGet = db.prepare('SELECT thread_id FROM threads WHERE mission_id = ?');
  // REPLACE also removes another mission's row that holds the same thread id.
  const threadSet = db.prepare('INSERT OR REPLACE INTO threads (mission_id, thread_id) VALUES (?, ?)');
  const threadDelete = db.prepare('DELETE FROM threads WHERE mission_id = ?');
  const threadMission = db.prepare('SELECT mission_id FROM threads WHERE thread_id = ?');

  const stateSet = db.prepare(
    'INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  );
  const stateDelete = db.prepare('DELETE FROM state WHERE key = ?');

  return {
    ...read,

    insertRun(row) {
      const result = runInsert.run(
        row.missionId,
        row.manifestVersion,
        isoUtc(row.startedAt, 'startedAt'),
        isoUtc(row.endedAt, 'endedAt'),
        row.input,
        JSON.stringify(row.toolsCalled),
        row.inputTokens,
        row.outputTokens,
        row.costUsd,
        row.status,
        row.error ?? null,
        row.finalText,
      );
      return Number(result.lastInsertRowid);
    },

    setSession(missionId, sessionId) {
      sessionSet.run(missionId, sessionId, nowIso());
    },
    deleteSession(missionId) {
      sessionDelete.run(missionId);
    },

    enqueueEvent(missionId, event) {
      return tx(db, () => {
        const now = nowIso();
        if (seenInsert.run(missionId, event.key, now).changes === 0) return false;
        eventInsert.run(missionId, JSON.stringify(event), now);
        return true;
      });
    },
    takeEvents(missionId, triggerId) {
      return tx(db, () => {
        const all = eventsOfMission.all(missionId).map(toQueuedEvent);
        if (triggerId === undefined) {
          eventsDelete.run(missionId);
          return all;
        }
        const picked = all.filter((e) => e.event.triggerId === triggerId);
        for (const e of picked) eventDeleteById.run(e.id);
        return picked;
      });
    },
    peekEvents(missionId) {
      return eventsOfMission.all(missionId).map(toQueuedEvent);
    },
    deleteEvents(missionId) {
      eventsDelete.run(missionId);
    },

    saveApproval(req) {
      approvalSave.run(
        req.id,
        req.missionId,
        req.action,
        req.toolName,
        JSON.stringify(req.input),
        req.note ?? null,
        isoUtc(req.createdAt, 'createdAt'),
        isoUtc(req.expiresAt, 'expiresAt'),
      );
    },
    deleteApproval(id) {
      approvalDelete.run(id);
    },

    addNotice(missionId, noticeText) {
      noticeAdd.run(missionId, noticeText, nowIso());
    },
    takeNotices(missionId) {
      return tx(db, () => {
        const rows = noticesOfMission.all(missionId);
        noticesDelete.run(missionId);
        return rows.map((r) => text(r.text));
      });
    },

    getThread(missionId) {
      const row = threadGet.get(missionId);
      return row === undefined ? undefined : num(row.thread_id);
    },
    setThread(missionId, threadId) {
      threadSet.run(missionId, threadId);
    },
    deleteThread(missionId) {
      threadDelete.run(missionId);
    },
    missionOfThread(threadId) {
      const row = threadMission.get(threadId);
      return row === undefined ? undefined : text(row.mission_id);
    },

    setState(key, value) {
      stateSet.run(key, value);
    },
    deleteState(key) {
      stateDelete.run(key);
    },

    deleteMissionState(missionId: MissionId) {
      tx(db, () => {
        sessionDelete.run(missionId);
        eventsDelete.run(missionId);
        seenDeleteMission.run(missionId);
        approvalsDeleteMission.run(missionId);
        noticesDelete.run(missionId);
        threadDelete.run(missionId);
      });
    },
  };
}

function pruneSeenKeys(db: DatabaseSync): void {
  const cutoff = new Date(Date.now() - SEEN_KEY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM seen_event_keys WHERE seen_at < ?').run(cutoff);
}

function openWritable(location: string): Store {
  const db = new DatabaseSync(location, { timeout: BUSY_TIMEOUT_MS });
  try {
    if (location !== ':memory:') {
      // WAL lets a reader in another process work while the harness writes.
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
    }
    migrate(db);
    pruneSeenKeys(db);
    return storeOn(db);
  } catch (err) {
    db.close();
    throw err;
  }
}

/** Opens the harness database, creating the folder and the file when missing, and brings the schema up to date. */
function toQueuedEvent(r: Record<string, unknown>): QueuedEvent {
  return {
    id: Number(r.id),
    missionId: String(r.mission_id),
    event: JSON.parse(String(r.event)) as TriggerEvent,
    queuedAt: String(r.queued_at),
  };
}

export function openStore(dbFile: string): Store {
  if (dbFile !== ':memory:') mkdirSync(dirname(dbFile), { recursive: true });
  return openWritable(dbFile);
}

/** The same store on an in-memory database. For tests. */
export function createMemoryStore(): Store {
  return openWritable(':memory:');
}

/**
 * Opens the database for reading only, for the dashboard and the command line tools.
 * It does not create the file and does not change the schema.
 */
export function openStoreReadOnly(dbFile: string): ReadOnlyStore {
  if (!existsSync(dbFile)) {
    throw new Error(`The database file ${dbFile} does not exist. Start the harness once to create it.`);
  }
  const db = new DatabaseSync(dbFile, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    const version = readSchemaVersion(db);
    if (version !== SCHEMA_VERSION) {
      throw new Error(
        version < SCHEMA_VERSION
          ? `The database file ${dbFile} has schema version ${version}, older than ${SCHEMA_VERSION}. Start the harness once to update it.`
          : `The database file ${dbFile} has schema version ${version}, newer than this program supports (${SCHEMA_VERSION}).`,
      );
    }
    return readMethods(db);
  } catch (err) {
    db.close();
    throw err;
  }
}
