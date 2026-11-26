import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate, readSchemaVersion, SCHEMA_VERSION, type Migration } from './schema.js';
import { openStore } from './store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mission-agent-schema-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tables(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => String(r.name));
}

describe('schema', () => {
  it('creates every table on a new database and sets the version', () => {
    const db = new DatabaseSync(':memory:');
    expect(readSchemaVersion(db)).toBe(0);
    migrate(db);
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(tables(db)).toEqual([
      'approvals',
      'event_queue',
      'notices',
      'runs',
      'seen_event_keys',
      'sessions',
      'state',
      'threads',
    ]);
    db.close();
  });

  it('does nothing when the database is already up to date', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('migrates a file from an older schema version and keeps its data', () => {
    const file = join(dir, 'agent.db');
    // Simulate a file written by an older program that knew only the first step.
    const older = new DatabaseSync(file);
    migrate(older, MIGRATIONS.slice(0, 1));
    older.prepare('INSERT INTO state (key, value) VALUES (?, ?)').run('paused', 'true');
    older.close();

    const added: Migration = {
      version: SCHEMA_VERSION + 1,
      up(db) {
        db.exec('CREATE TABLE extra (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
        db.exec("INSERT INTO extra (label) SELECT 'from ' || key FROM state");
      },
    };
    const newer = new DatabaseSync(file);
    migrate(newer, [...MIGRATIONS, added]);
    expect(readSchemaVersion(newer)).toBe(SCHEMA_VERSION + 1);
    expect(newer.prepare('SELECT value FROM state WHERE key = ?').get('paused')?.value).toBe('true');
    expect(newer.prepare('SELECT label FROM extra').get()?.label).toBe('from paused');
    newer.close();
  });

  it('openStore brings a file at version 0 up to the current version', () => {
    const file = join(dir, 'agent.db');
    const raw = new DatabaseSync(file);
    expect(readSchemaVersion(raw)).toBe(0);
    raw.close();
    const store = openStore(file);
    store.setState('a', 'b');
    store.close();
    const check = new DatabaseSync(file);
    expect(readSchemaVersion(check)).toBe(SCHEMA_VERSION);
    check.close();
  });

  it('leaves the file at the previous version when a step fails', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const broken: Migration = {
      version: SCHEMA_VERSION + 1,
      up(d) {
        d.exec('CREATE TABLE half_done (a)');
        throw new Error('step failed');
      },
    };
    expect(() => migrate(db, [...MIGRATIONS, broken])).toThrow('step failed');
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(tables(db)).not.toContain('half_done');
    db.close();
  });

  it('refuses a file written by a newer program', () => {
    const file = join(dir, 'agent.db');
    const raw = new DatabaseSync(file);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    raw.close();
    expect(() => openStore(file)).toThrow(/newer than this program supports/);
  });

  it('refuses a list of steps that is not in increasing order', () => {
    const db = new DatabaseSync(':memory:');
    const step = (version: number): Migration => ({ version, up() {} });
    expect(() => migrate(db, [step(2), step(1)])).toThrow(/increasing/);
    expect(() => migrate(db, [step(1), step(1)])).toThrow(/increasing/);
    expect(readSchemaVersion(db)).toBe(0);
    db.close();
  });
});
