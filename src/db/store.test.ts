import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalRequest, RunRow, Store, TriggerEvent } from '../types.js';
import { createMemoryStore, openStore, openStoreReadOnly } from './store.js';
import { SCHEMA_VERSION } from './schema.js';

let dir: string;
let dbFile: string;
const open: { close(): void }[] = [];

function track<T extends { close(): void }>(s: T): T {
  open.push(s);
  return s;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mission-agent-db-'));
  dbFile = join(dir, 'state', 'agent.db');
});

afterEach(() => {
  for (const s of open.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

function run(over: Partial<RunRow> = {}): RunRow {
  return {
    missionId: 'm_aaaaaaaaaaaa',
    manifestVersion: 1,
    startedAt: '2026-11-25T10:00:00.000Z',
    endedAt: '2026-11-25T10:01:00.000Z',
    input: 'hello',
    toolsCalled: ['WebSearch', 'mcp__gmail__send'],
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.25,
    status: 'success',
    finalText: 'done',
    ...over,
  };
}

function event(key: string, over: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    triggerId: 'trigger:cron',
    time: '2026-11-25T10:00:00.000Z',
    key,
    summary: `event ${key}`,
    data: { n: key },
    ...over,
  };
}

function approval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'ap1',
    missionId: 'm_aaaaaaaaaaaa',
    action: 'action:email.send',
    toolName: 'mcp__gmail__send',
    input: { to: 'a@example.com', body: { lines: ['x', 'y'] } },
    note: 'Send the email',
    createdAt: '2026-11-25T10:00:00.000Z',
    expiresAt: '2026-11-26T10:00:00.000Z',
    ...over,
  };
}

const A = 'm_aaaaaaaaaaaa';
const B = 'm_bbbbbbbbbbbb';

describe('openStore', () => {
  it('creates the parent folder and the file, in WAL mode', () => {
    expect(existsSync(dbFile)).toBe(false);
    track(openStore(dbFile));
    expect(existsSync(dbFile)).toBe(true);
    const raw = new DatabaseSync(dbFile);
    expect(raw.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    expect(raw.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
    raw.close();
  });

  it('allows close to be called twice', () => {
    const s = openStore(dbFile);
    s.close();
    expect(() => s.close()).not.toThrow();
  });
});

describe('logbook', () => {
  let s: Store;
  beforeEach(() => {
    s = track(createMemoryStore());
  });

  it('inserts a run and reads it back', () => {
    const id = s.insertRun(run({ error: undefined }));
    expect(id).toBeGreaterThan(0);
    const [row] = s.listRuns();
    expect(row).toEqual({ ...run(), id });
    expect(row).not.toHaveProperty('error');
  });

  it('keeps the error of a failed run', () => {
    s.insertRun(run({ status: 'failed', error: 'boom' }));
    expect(s.listRuns()[0]).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('stores tools called as JSON text', () => {
    const file = openStore(dbFile);
    file.insertRun(run());
    file.close();
    const raw = new DatabaseSync(dbFile);
    expect(raw.prepare('SELECT tools_called FROM runs').get()?.tools_called).toBe(
      '["WebSearch","mcp__gmail__send"]',
    );
    raw.close();
  });

  it('stores times in UTC and rejects a time that is not valid', () => {
    s.insertRun(run({ startedAt: '2026-11-25T12:00:00+02:00', endedAt: '2026-11-25T12:00:05+02:00' }));
    expect(s.listRuns()[0]).toMatchObject({
      startedAt: '2026-11-25T10:00:00.000Z',
      endedAt: '2026-11-25T10:00:05.000Z',
    });
    expect(() => s.insertRun(run({ startedAt: 'yesterday' }))).toThrow(/startedAt is not a valid ISO 8601 time/);
  });

  it('lists newest first, filters by mission and applies the limit', () => {
    s.insertRun(run({ startedAt: '2026-11-25T08:00:00.000Z', input: 'first' }));
    s.insertRun(run({ startedAt: '2026-11-25T10:00:00.000Z', input: 'third' }));
    s.insertRun(run({ startedAt: '2026-11-25T09:00:00.000Z', input: 'second', missionId: B }));
    expect(s.listRuns().map((r) => r.input)).toEqual(['third', 'second', 'first']);
    expect(s.listRuns({ missionId: A }).map((r) => r.input)).toEqual(['third', 'first']);
    expect(s.listRuns({ limit: 1 }).map((r) => r.input)).toEqual(['third']);
    expect(s.listRuns({ missionId: 'm_nonenonenone' })).toEqual([]);
  });

  it('returns at most 100 runs by default', () => {
    for (let i = 0; i < 105; i++) {
      s.insertRun(run({ startedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), input: String(i) }));
    }
    const rows = s.listRuns();
    expect(rows).toHaveLength(100);
    expect(rows[0]?.input).toBe('104');
    expect(s.listRuns({ limit: 200 })).toHaveLength(105);
  });

  it('sums the cost of runs that started at or after a time', () => {
    expect(s.costSince('2026-01-01T00:00:00.000Z')).toBe(0);
    s.insertRun(run({ startedAt: '2026-11-24T23:59:59.999Z', costUsd: 1 }));
    s.insertRun(run({ startedAt: '2026-11-25T00:00:00.000Z', costUsd: 0.5 }));
    s.insertRun(run({ startedAt: '2026-11-25T05:00:00.000Z', costUsd: 0.25, missionId: B }));
    expect(s.costSince('2026-11-25T00:00:00.000Z')).toBeCloseTo(0.75);
    expect(s.costSince('2026-11-25T00:00:00.000Z', A)).toBeCloseTo(0.5);
    expect(s.costSince('2026-11-25T00:00:00.000Z', B)).toBeCloseTo(0.25);
    // The same instant written with an offset.
    expect(s.costSince('2026-11-25T01:00:00+01:00')).toBeCloseTo(0.75);
    expect(() => s.costSince('not a time')).toThrow(/isoTime/);
  });
});

describe('session registry', () => {
  it('sets, replaces and deletes the session of a mission', () => {
    const s = track(createMemoryStore());
    expect(s.getSession(A)).toBeUndefined();
    s.setSession(A, 'sess-1');
    s.setSession(B, 'sess-b');
    s.setSession(A, 'sess-2');
    expect(s.getSession(A)).toBe('sess-2');
    s.deleteSession(A);
    expect(s.getSession(A)).toBeUndefined();
    expect(s.getSession(B)).toBe('sess-b');
  });
});

describe('event queue', () => {
  let s: Store;
  beforeEach(() => {
    s = track(createMemoryStore());
  });

  it('returns the events of one mission oldest first and removes them', () => {
    expect(s.enqueueEvent(A, event('k1'))).toBe(true);
    expect(s.enqueueEvent(B, event('k2'))).toBe(true);
    // An earlier event time does not change the order of arrival.
    expect(s.enqueueEvent(A, event('k3', { time: '2020-01-01T00:00:00.000Z' }))).toBe(true);
    const taken = s.takeEvents(A);
    expect(taken.map((q) => q.event.key)).toEqual(['k1', 'k3']);
    expect(taken[0]).toMatchObject({ missionId: A, event: event('k1') });
    expect(taken[0]!.id).toBeLessThan(taken[1]!.id);
    expect(new Date(taken[0]!.queuedAt).toISOString()).toBe(taken[0]!.queuedAt);
    expect(s.takeEvents(A)).toEqual([]);
    expect(s.takeEvents(B).map((q) => q.event.key)).toEqual(['k2']);
  });

  it('drops an event whose key was already seen for the mission', () => {
    expect(s.enqueueEvent(A, event('dup'))).toBe(true);
    expect(s.enqueueEvent(A, event('dup', { summary: 'second copy' }))).toBe(false);
    // The same key for another mission is a different event.
    expect(s.enqueueEvent(B, event('dup'))).toBe(true);
    const taken = s.takeEvents(A);
    expect(taken).toHaveLength(1);
    expect(taken[0]?.event.summary).toBe('event dup');
  });

  it('keeps seen keys after the events are taken or deleted', () => {
    s.enqueueEvent(A, event('k1'));
    s.takeEvents(A);
    expect(s.enqueueEvent(A, event('k1'))).toBe(false);
    s.enqueueEvent(A, event('k2'));
    s.deleteEvents(A);
    expect(s.enqueueEvent(A, event('k2'))).toBe(false);
    expect(s.takeEvents(A)).toEqual([]);
  });

  it('records no seen key when the event cannot be stored', () => {
    const bad = event('k1', { data: { big: 1n } });
    expect(() => s.enqueueEvent(A, bad)).toThrow();
    expect(s.missionsWithEvents()).toEqual([]);
    expect(s.enqueueEvent(A, event('k1'))).toBe(true);
  });

  it('lists the missions with waiting events and deletes the events of one mission', () => {
    expect(s.missionsWithEvents()).toEqual([]);
    s.enqueueEvent(B, event('k1'));
    s.enqueueEvent(A, event('k2'));
    s.enqueueEvent(B, event('k3'));
    expect(s.missionsWithEvents()).toEqual([B, A]);
    s.deleteEvents(B);
    expect(s.missionsWithEvents()).toEqual([A]);
    expect(s.takeEvents(B)).toEqual([]);
  });

  it('removes seen keys older than 30 days when the store opens', () => {
    const first = openStore(dbFile);
    first.enqueueEvent(A, event('old'));
    first.enqueueEvent(A, event('recent'));
    first.takeEvents(A);
    first.close();
    const raw = new DatabaseSync(dbFile);
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    raw.prepare('UPDATE seen_event_keys SET seen_at = ? WHERE event_key = ?').run(daysAgo(31), 'old');
    raw.prepare('UPDATE seen_event_keys SET seen_at = ? WHERE event_key = ?').run(daysAgo(29), 'recent');
    raw.close();
    const again = track(openStore(dbFile));
    expect(again.enqueueEvent(A, event('old'))).toBe(true);
    expect(again.enqueueEvent(A, event('recent'))).toBe(false);
  });
});

describe('approvals', () => {
  it('saves, lists and deletes waiting approvals, with input as JSON', () => {
    const s = track(createMemoryStore());
    expect(s.listApprovals()).toEqual([]);
    s.saveApproval(approval({ id: 'ap2', createdAt: '2026-11-25T11:00:00.000Z', note: undefined }));
    s.saveApproval(approval());
    const list = s.listApprovals();
    expect(list.map((a) => a.id)).toEqual(['ap1', 'ap2']);
    expect(list[0]).toEqual(approval());
    expect(list[1]).not.toHaveProperty('note');
    // Saving the same id again replaces the request.
    s.saveApproval(approval({ action: 'action:other' }));
    expect(s.listApprovals().find((a) => a.id === 'ap1')?.action).toBe('action:other');
    expect(s.listApprovals()).toHaveLength(2);
    s.deleteApproval('ap1');
    expect(s.listApprovals().map((a) => a.id)).toEqual(['ap2']);
    s.deleteApproval('missing');
    expect(s.listApprovals()).toHaveLength(1);
  });
});

describe('notices', () => {
  it('returns the notices of one mission in order and removes them', () => {
    const s = track(createMemoryStore());
    expect(s.takeNotices(A)).toEqual([]);
    s.addNotice(A, 'one');
    s.addNotice(B, 'other');
    s.addNotice(A, 'two');
    expect(s.takeNotices(A)).toEqual(['one', 'two']);
    expect(s.takeNotices(A)).toEqual([]);
    expect(s.takeNotices(B)).toEqual(['other']);
  });
});

describe('threads', () => {
  it('maps missions to threads both ways', () => {
    const s = track(createMemoryStore());
    expect(s.getThread(A)).toBeUndefined();
    expect(s.missionOfThread(7)).toBeUndefined();
    s.setThread(A, 7);
    s.setThread(B, 8);
    expect(s.getThread(A)).toBe(7);
    expect(s.missionOfThread(8)).toBe(B);
    s.setThread(A, 9);
    expect(s.getThread(A)).toBe(9);
    expect(s.missionOfThread(7)).toBeUndefined();
    s.deleteThread(A);
    expect(s.getThread(A)).toBeUndefined();
    expect(s.missionOfThread(9)).toBeUndefined();
  });

  it('gives a thread id to one mission only', () => {
    const s = track(createMemoryStore());
    s.setThread(A, 7);
    s.setThread(B, 7);
    expect(s.missionOfThread(7)).toBe(B);
    expect(s.getThread(A)).toBeUndefined();
  });
});

describe('state values', () => {
  it('sets, replaces and deletes a value', () => {
    const s = track(createMemoryStore());
    expect(s.getState('paused')).toBeUndefined();
    s.setState('paused', 'true');
    s.setState('paused', 'false');
    s.setState('current_chat_mission', A);
    expect(s.getState('paused')).toBe('false');
    s.deleteState('paused');
    expect(s.getState('paused')).toBeUndefined();
    expect(s.getState('current_chat_mission')).toBe(A);
  });
});

describe('deleteMissionState', () => {
  it('removes everything of the mission except its logbook rows', () => {
    const s = track(createMemoryStore());
    for (const m of [A, B]) {
      s.insertRun(run({ missionId: m }));
      s.setSession(m, `sess-${m}`);
      s.enqueueEvent(m, event('k1'));
      s.saveApproval(approval({ id: `ap-${m}`, missionId: m }));
      s.addNotice(m, `notice ${m}`);
    }
    s.setThread(A, 1);
    s.setThread(B, 2);
    s.setState('paused', 'false');

    s.deleteMissionState(A);

    expect(s.listRuns({ missionId: A })).toHaveLength(1);
    expect(s.getSession(A)).toBeUndefined();
    expect(s.missionsWithEvents()).toEqual([B]);
    expect(s.listApprovals().map((a) => a.missionId)).toEqual([B]);
    expect(s.takeNotices(A)).toEqual([]);
    expect(s.getThread(A)).toBeUndefined();
    expect(s.missionOfThread(1)).toBeUndefined();
    // The seen keys are gone too.
    expect(s.enqueueEvent(A, event('k1'))).toBe(true);

    // The other mission and the state values are untouched.
    expect(s.listRuns({ missionId: B })).toHaveLength(1);
    expect(s.getSession(B)).toBe(`sess-${B}`);
    expect(s.takeEvents(B)).toHaveLength(1);
    expect(s.takeNotices(B)).toEqual([`notice ${B}`]);
    expect(s.getThread(B)).toBe(2);
    expect(s.getState('paused')).toBe('false');
  });
});

describe('persistence', () => {
  it('keeps everything after close and reopen', () => {
    const first = openStore(dbFile);
    const runId = first.insertRun(run());
    first.setSession(A, 'sess-1');
    first.enqueueEvent(A, event('k1'));
    first.enqueueEvent(A, event('k2'));
    first.saveApproval(approval());
    first.addNotice(A, 'note');
    first.setThread(A, 42);
    first.setState('paused', 'true');
    first.close();

    const s = track(openStore(dbFile));
    expect(s.listRuns()).toEqual([{ ...run(), id: runId }]);
    expect(s.getSession(A)).toBe('sess-1');
    expect(s.enqueueEvent(A, event('k1'))).toBe(false);
    expect(s.takeEvents(A).map((q) => q.event)).toEqual([event('k1'), event('k2')]);
    expect(s.listApprovals()).toEqual([approval()]);
    expect(s.takeNotices(A)).toEqual(['note']);
    expect(s.getThread(A)).toBe(42);
    expect(s.missionOfThread(42)).toBe(A);
    expect(s.getState('paused')).toBe('true');
  });

  it('gives each memory store its own database', () => {
    const one = track(createMemoryStore());
    const two = track(createMemoryStore());
    one.setState('x', '1');
    expect(two.getState('x')).toBeUndefined();
  });
});

describe('openStoreReadOnly', () => {
  it('throws a clear error and creates nothing when the file does not exist', () => {
    expect(() => openStoreReadOnly(dbFile)).toThrow(/does not exist/);
    expect(existsSync(dbFile)).toBe(false);
    expect(existsSync(join(dir, 'state'))).toBe(false);
  });

  it('reads what the harness writes while both are open', () => {
    const s = track(openStore(dbFile));
    const view = track(openStoreReadOnly(dbFile));
    expect(view.listRuns()).toEqual([]);

    s.insertRun(run({ costUsd: 2 }));
    s.setSession(A, 'sess-1');
    s.enqueueEvent(A, event('k1'));
    s.saveApproval(approval());
    s.setState('paused', 'true');

    expect(view.listRuns({ missionId: A, limit: 5 })).toHaveLength(1);
    expect(view.costSince('2026-11-25T00:00:00.000Z')).toBe(2);
    expect(view.listApprovals()).toEqual([approval()]);
    expect(view.getState('paused')).toBe('true');
    expect(view.getSession(A)).toBe('sess-1');
    expect(view.missionsWithEvents()).toEqual([A]);
  });

  it('offers only the read methods and cannot write', () => {
    track(openStore(dbFile)).close();
    const view = track(openStoreReadOnly(dbFile));
    expect(Object.keys(view).sort()).toEqual(
      ['close', 'costSince', 'getSession', 'getState', 'listApprovals', 'listRuns', 'missionsWithEvents'].sort(),
    );
    expect(view).not.toHaveProperty('setState');
  });

  it('refuses a file whose schema is older, and leaves it unchanged', () => {
    const old = join(dir, 'old.db');
    const raw = new DatabaseSync(old);
    raw.exec('CREATE TABLE something (a)');
    raw.close();
    expect(() => openStoreReadOnly(old)).toThrow(/schema version 0, older than/);
    const check = new DatabaseSync(old);
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(0);
    expect(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'runs'").get()?.n).toBe(0);
    check.close();
  });

  it('refuses a file whose schema is newer', () => {
    track(openStore(dbFile)).close();
    const raw = new DatabaseSync(dbFile);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => openStoreReadOnly(dbFile)).toThrow(/newer than this program supports/);
  });
});

describe('events of one trigger', () => {
  it('takes only the events of the given trigger and leaves the others', () => {
    const store = createMemoryStore();
    const ev = (triggerId: string, key: string): TriggerEvent => ({ triggerId, time: '2026-01-01T00:00:00.000Z', key, summary: key, data: {} });
    store.enqueueEvent('m_a', ev('trigger:cron', 'k1'));
    store.enqueueEvent('m_a', ev('trigger:email.received', 'k2'));
    store.enqueueEvent('m_a', ev('trigger:cron', 'k3'));
    expect(store.peekEvents('m_a').map((e) => e.event.key)).toEqual(['k1', 'k2', 'k3']);
    expect(store.takeEvents('m_a', 'trigger:cron').map((e) => e.event.key)).toEqual(['k1', 'k3']);
    expect(store.peekEvents('m_a').map((e) => e.event.key)).toEqual(['k2']);
    store.close();
  });
});
