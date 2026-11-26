import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '../db/index.js';
import type { MissionId, Subscription, TriggerContext, TriggerEvent, TriggerInstance } from '../types.js';
import { cronEventKey, cronTrigger } from './cron.js';

// Local time, so the tests pass in any time zone. 25 November 2026 has no daylight saving change.
const START = new Date(2026, 10, 25, 6, 59, 0);
const at = (day: number, h: number, m: number) => new Date(2026, 10, day, h, m, 0);

let events: { missionId: MissionId; event: TriggerEvent }[];
let instances: TriggerInstance[];

function make(lastStoppedAt?: string): TriggerInstance {
  const ctx: TriggerContext = {
    emit: (missionId, event) => events.push({ missionId, event }),
    credentials: {},
    ...(lastStoppedAt !== undefined ? { lastStoppedAt } : {}),
  };
  const instance = cronTrigger.create(ctx);
  if (instance === null) throw new Error('cron trigger returned null');
  instances.push(instance);
  return instance;
}

const sub = (missionId: MissionId, expr: string): Subscription => ({ missionId, params: { at: expr } });

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  events = [];
  instances = [];
});
afterEach(async () => {
  for (const i of instances) await i.stop();
  vi.useRealTimers();
});

describe('validateParams', () => {
  const v = cronTrigger.validateParams;
  it('accepts a five-field expression', () => {
    expect(v({ at: '0 7 * * *' })).toBeNull();
    expect(v({ at: '*/15 9-17 * * mon-fri' })).toBeNull();
  });
  it('rejects a missing or wrong expression', () => {
    expect(v({})).toMatch(/needs "at"/);
    expect(v({ at: 7 })).toMatch(/must be a text/);
    expect(v({ at: '' })).toMatch(/0 fields/);
    expect(v({ at: '0 7 * *' })).toMatch(/4 fields/);
    expect(v({ at: '0 0 7 * * *' })).toMatch(/6 fields/);
    expect(v({ at: '@daily' })).toMatch(/1 fields/);
    expect(v({ at: '61 7 * * *' })).toMatch(/not a valid cron expression/);
    expect(v({ at: 'x 7 * * *' })).toMatch(/not a valid cron expression/);
    expect(v({ at: '? 7 * * *' })).toMatch(/"\?" is not accepted/);
    expect(v({ at: '0 0 30 2 *' })).toMatch(/never fires/);
  });
  it('rejects unknown parameters', () => {
    expect(v({ at: '0 7 * * *', every: 'day' })).toBe('has unknown parameters: every. A timer takes only "at".');
  });
});

describe('firing', () => {
  it('emits one event per subscribed mission at the scheduled minute', async () => {
    await make().setSubscriptions([sub('m_a', '0 7 * * *'), sub('m_b', '0 7 * * *')]);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events.map((e) => e.missionId)).toEqual(['m_a', 'm_b']);
    const first = events[0]!.event;
    expect(first.triggerId).toBe('trigger:cron');
    expect(first.summary).toBe('Timer "0 7 * * *" fired at 07:00');
    expect(first.time).toBe(at(25, 7, 0).toISOString());
    expect(first.data).toEqual({ expression: '0 7 * * *', scheduledAt: at(25, 7, 0).toISOString() });
    expect(first.key).toBe(cronEventKey('m_a', '0 7 * * *', at(25, 7, 0)));
  });

  it('gives a key unique per mission, expression and scheduled minute', async () => {
    await make().setSubscriptions([sub('m_a', '0 7 * * *'), sub('m_b', '0 7 * * *'), sub('m_a', '0 7 * * 3')]);
    await vi.advanceTimersByTimeAsync(24 * 3600_000 + 60_000);
    // 25 November 2026 is a Wednesday, so "0 7 * * 3" fires on the first day only.
    expect(events).toHaveLength(5);
    const keys = events.map((e) => e.event.key);
    expect(new Set(keys).size).toBe(5);
    expect(keys).toContain(cronEventKey('m_a', '0 7 * * *', at(26, 7, 0)));
  });

  it('fires once when the same mission lists the same expression twice', async () => {
    await make().setSubscriptions([sub('m_a', '0 7 * * *'), sub('m_a', '0 7 * * *')]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toHaveLength(1);
  });

  it('fires every minute for "* * * * *"', async () => {
    await make().setSubscriptions([sub('m_a', '* * * * *')]);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(events.map((e) => e.event.data.scheduledAt)).toEqual([
      at(25, 7, 0).toISOString(),
      at(25, 7, 1).toISOString(),
      at(25, 7, 2).toISOString(),
    ]);
  });

  it('stops firing after stop', async () => {
    const i = make();
    await i.setSubscriptions([sub('m_a', '0 7 * * *')]);
    await i.stop();
    await vi.advanceTimersByTimeAsync(2 * 3600_000);
    expect(events).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('setSubscriptions', () => {
  it('adds, keeps and removes subscriptions without firing twice', async () => {
    const i = make();
    await i.setSubscriptions([sub('m_a', '0 7 * * *'), sub('m_c', '30 7 * * *')]);
    await vi.advanceTimersByTimeAsync(30_000);
    await i.setSubscriptions([sub('m_a', '0 7 * * *'), sub('m_b', '0 7 * * *')]);
    await i.setSubscriptions([sub('m_a', '0 7 * * *'), sub('m_b', '0 7 * * *')]);
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(events.map((e) => e.missionId)).toEqual(['m_a', 'm_b']);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('removes a mission from a shared expression', async () => {
    const i = make();
    await i.setSubscriptions([sub('m_a', '0 7 * * *'), sub('m_b', '0 7 * * *')]);
    await i.setSubscriptions([sub('m_b', '0 7 * * *')]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events.map((e) => e.missionId)).toEqual(['m_b']);
  });

  it('starts the valid subscriptions and throws for the invalid ones', async () => {
    const i = make();
    await expect(i.setSubscriptions([sub('m_a', '0 7 * * *'), sub('m_b', 'nonsense')])).rejects.toThrow(/m_b/);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events.map((e) => e.missionId)).toEqual(['m_a']);
  });
});

describe('missed timer run', () => {
  it('emits one event for many missed times', async () => {
    await make(at(22, 6, 0).toISOString()).setSubscriptions([sub('m_a', '0 7 * * *')]);
    expect(events).toHaveLength(1);
    const e = events[0]!.event;
    expect(e.summary).toBe(
      'Timer "0 7 * * *" was missed 3 times while the harness was stopped. The last time was due at 07:00 on 2026-11-24.',
    );
    expect(e.key).toBe(cronEventKey('m_a', '0 7 * * *', at(24, 7, 0)));
    expect(e.time).toBe(START.toISOString());
    expect(e.data).toMatchObject({ missed: true, missedCount: 3, firstMissedAt: at(22, 7, 0).toISOString() });
    // The normal firing still happens at 07:00.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toHaveLength(2);
    expect(events[1]!.event.summary).toBe('Timer "0 7 * * *" fired at 07:00');
  });

  it('says when a single missed run was due', async () => {
    await make(at(24, 6, 0).toISOString()).setSubscriptions([sub('m_a', '0 7 * * *')]);
    expect(events[0]!.event.summary).toBe(
      'Timer "0 7 * * *" was missed while the harness was stopped. It was due at 07:00 on 2026-11-24.',
    );
  });

  it('emits nothing when no time was missed', async () => {
    await make(at(25, 6, 58).toISOString()).setSubscriptions([sub('m_a', '0 7 * * *')]);
    await make(at(24, 7, 0).toISOString()).setSubscriptions([sub('m_a', '0 7 * * *')]);
    expect(events).toHaveLength(0);
  });

  it('emits nothing without a stop time', async () => {
    await make().setSubscriptions([sub('m_a', '0 7 * * *')]);
    expect(events).toHaveLength(0);
  });

  it('gives the same key on a second start with the same stop time, so the store drops it', async () => {
    const stoppedAt = at(22, 6, 0).toISOString();
    await make(stoppedAt).setSubscriptions([sub('m_a', '0 7 * * *')]);
    await make(stoppedAt).setSubscriptions([sub('m_a', '0 7 * * *')]);
    expect(events).toHaveLength(2);
    expect(events[0]!.event.key).toBe(events[1]!.event.key);
    const store = createMemoryStore();
    expect(store.enqueueEvent('m_a', events[0]!.event)).toBe(true);
    expect(store.enqueueEvent('m_a', events[1]!.event)).toBe(false);
    store.close();
  });

  it('counts at most 1000 missed times and still finds the last one', async () => {
    await make(at(1, 0, 0).toISOString()).setSubscriptions([sub('m_a', '* * * * *')]);
    expect(events).toHaveLength(1);
    const e = events[0]!.event;
    expect(e.summary).toMatch(/was missed more than 1000 times/);
    expect(e.data.scheduledAt).toBe(at(25, 6, 59).toISOString());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events[1]!.event.data.scheduledAt).toBe(at(25, 7, 0).toISOString());
  });

  it('is checked for the subscriptions of the first call only', async () => {
    const i = make(at(22, 6, 0).toISOString());
    await i.setSubscriptions([sub('m_a', '0 7 * * *')]);
    await i.setSubscriptions([sub('m_a', '0 7 * * *'), sub('m_b', '0 7 * * *')]);
    expect(events.map((e) => e.missionId)).toEqual(['m_a']);
  });
});
