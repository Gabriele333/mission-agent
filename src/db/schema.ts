import type { DatabaseSync } from 'node:sqlite';

/**
 * One step of the schema. Steps run in order of `version`, each one in its own
 * transaction. A later version of the program adds steps at the end of the list
 * and never changes a step that was already released.
 */
export interface Migration {
  version: number;
  up(db: DatabaseSync): void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        -- The logbook (§E.2.2). One row per run.
        CREATE TABLE runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mission_id TEXT NOT NULL,
          manifest_version INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT NOT NULL,
          input TEXT NOT NULL,
          tools_called TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          cost_usd REAL NOT NULL,
          status TEXT NOT NULL,
          error TEXT,
          final_text TEXT NOT NULL
        );
        CREATE INDEX runs_started_at ON runs (started_at);
        CREATE INDEX runs_mission_started_at ON runs (mission_id, started_at);

        -- The session registry (§C.3).
        CREATE TABLE sessions (
          mission_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        -- The event queues (§B.2). The id gives the order of arrival.
        CREATE TABLE event_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mission_id TEXT NOT NULL,
          event TEXT NOT NULL,
          queued_at TEXT NOT NULL
        );
        CREATE INDEX event_queue_mission ON event_queue (mission_id, id);

        -- The keys of events already seen, per mission (§B.2).
        CREATE TABLE seen_event_keys (
          mission_id TEXT NOT NULL,
          event_key TEXT NOT NULL,
          seen_at TEXT NOT NULL,
          PRIMARY KEY (mission_id, event_key)
        );
        CREATE INDEX seen_event_keys_seen_at ON seen_event_keys (seen_at);

        -- Waiting approvals (§G).
        CREATE TABLE approvals (
          id TEXT PRIMARY KEY,
          mission_id TEXT NOT NULL,
          action TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          input TEXT NOT NULL,
          note TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE INDEX approvals_mission ON approvals (mission_id);

        -- Notices that wait for a mission's next run (§C.4).
        CREATE TABLE notices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mission_id TEXT NOT NULL,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX notices_mission ON notices (mission_id, id);

        -- The Telegram thread of each mission (§F.1). A thread belongs to one mission.
        CREATE TABLE threads (
          mission_id TEXT PRIMARY KEY,
          thread_id INTEGER NOT NULL UNIQUE
        );

        -- Small values of the harness, such as \`paused\`.
        CREATE TABLE state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  },
];

/** The schema version that this program writes and expects. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** The schema version is kept in SQLite's own `user_version` field of the file header. */
export function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row?.user_version ?? 0);
}

/**
 * Brings the database up to the last step of `migrations`. Throws when the file
 * was written by a newer program. Each step and its version number are saved
 * together, so a failed step leaves the file at the previous version.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): void {
  migrations.forEach((step, i) => {
    const previous = i === 0 ? 0 : migrations[i - 1]!.version;
    if (!Number.isInteger(step.version) || step.version <= previous) {
      throw new Error(`Migration versions must be increasing integers above 0; found ${step.version}.`);
    }
  });
  const target = migrations.length === 0 ? 0 : migrations[migrations.length - 1]!.version;
  for (const step of migrations) {
    // IMMEDIATE takes the write lock first, so two processes do not run the same step.
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = readSchemaVersion(db);
      if (current > target) {
        throw new Error(
          `The database has schema version ${current}, which is newer than this program supports (${target}).`,
        );
      }
      if (step.version > current) {
        step.up(db);
        // PRAGMA does not take parameters. The value is an integer from our own list.
        db.exec(`PRAGMA user_version = ${Math.trunc(step.version)}`);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
