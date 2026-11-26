import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../db/index.js';
import {
  markRunEnded,
  markRunStarted,
  readPause,
  recordCleanStop,
  recordStart,
  STATE_KEYS,
  takeInterruptedRuns,
  writePause,
} from './state.js';

const at = (min: number) => new Date(Date.UTC(2026, 10, 25, 10, min));

describe('the crash rule (§H)', () => {
  it('pauses on the third start within ten minutes that follows a crash', () => {
    const store = createMemoryStore();
    expect(recordStart(store, at(0))).toEqual({ crashed: false, pauseForCrashes: false });
    // No clean stop between the starts: each one is a crash.
    expect(recordStart(store, at(1)).pauseForCrashes).toBe(false);
    expect(recordStart(store, at(2)).pauseForCrashes).toBe(false);
    const third = recordStart(store, at(3));
    expect(third.crashed).toBe(true);
    expect(third.pauseForCrashes).toBe(true);
  });

  it('forgets crashes older than ten minutes', () => {
    const store = createMemoryStore();
    recordStart(store, at(0));
    recordStart(store, at(1));
    recordStart(store, at(2));
    expect(recordStart(store, at(14)).pauseForCrashes).toBe(false);
  });

  it('does not count a clean stop, and passes the time of the stop on', () => {
    const store = createMemoryStore();
    for (let i = 0; i < 4; i++) {
      const r = recordStart(store, at(i * 2));
      expect(r.pauseForCrashes).toBe(false);
      expect(r.crashed).toBe(false);
      recordCleanStop(store, at(i * 2 + 1));
    }
    expect(recordStart(store, at(20)).lastStoppedAt).toBe(at(7).toISOString());
  });
});

describe('runs in progress (§H)', () => {
  it('keeps the run until it ends, and returns the ones left after a crash', () => {
    const store = createMemoryStore();
    markRunStarted(store, { missionId: 'a', manifestVersion: 1, startedAt: at(0).toISOString(), input: 'x' });
    markRunStarted(store, { missionId: 'b', manifestVersion: 2, startedAt: at(1).toISOString(), input: 'y' });
    markRunEnded(store, 'a');
    expect(takeInterruptedRuns(store).map((r) => r.missionId)).toEqual(['b']);
    expect(store.getState(STATE_KEYS.runsInProgress)).toBeUndefined();
  });
});

describe('the pause record', () => {
  it('is written and read back, and removed when empty', () => {
    const store = createMemoryStore();
    writePause(store, { hold: { kind: 'user', reason: 'r', since: 's' } });
    expect(readPause(store).hold?.reason).toBe('r');
    writePause(store, {});
    expect(store.getState(STATE_KEYS.paused)).toBeUndefined();
  });

  it('reads a value written by hand as a pause of the user', () => {
    const store = createMemoryStore();
    store.setState(STATE_KEYS.paused, 'yes');
    expect(readPause(store).hold?.kind).toBe('user');
  });
});
