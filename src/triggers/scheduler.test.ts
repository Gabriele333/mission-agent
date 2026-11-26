import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../config/defaults.js';
import { initRootFolder } from '../config/init-root.js';
import { createMissionRegistry, MISSION_ADMIN_MANIFEST, type WatchingMissionRegistry } from '../manifest/index.js';
import { fakeCatalog } from '../manifest/test-helpers.js';
import { pathsFor } from '../paths.js';
import type { CodeCatalog, ManifestDraft, MissionId, Subscription, TriggerContext, TriggerDefinition, TriggerEvent } from '../types.js';
import { createTriggerCatalog, type TriggerCatalog } from './catalog.js';
import { chatTrigger } from './chat.js';
import { cronTrigger } from './cron.js';
import { createScheduler, type Scheduler } from './scheduler.js';

const START = new Date(2026, 10, 25, 6, 59, 0);
const GMAIL = 'credential:gmail.token';

/** A trigger that needs a credential. The test emits its events by hand. */
function fakeEmailTrigger() {
  const state = { ctx: undefined as TriggerContext | undefined, subs: [] as Subscription[], stops: 0 };
  const def: TriggerDefinition = {
    id: 'trigger:email.received',
    credentials: [GMAIL],
    validateParams: (p) => (Object.keys(p).length > 0 ? 'takes no parameters.' : null),
    create(ctx) {
      state.ctx = ctx;
      return {
        setSubscriptions: async (subs) => {
          state.subs = subs;
        },
        stop: async () => {
          state.stops++;
        },
      };
    },
  };
  return { def, state };
}

let root: string;
let registry: WatchingMissionRegistry;
let triggers: TriggerCatalog;
let email: ReturnType<typeof fakeEmailTrigger>;
let secrets: Map<string, string>;
let events: { missionId: MissionId; event: TriggerEvent }[];
let errors: { triggerId: string; message: string }[];
let scheduler: Scheduler | undefined;

function setup(extra: TriggerDefinition[] = []): void {
  email = fakeEmailTrigger();
  triggers = createTriggerCatalog([cronTrigger, chatTrigger, email.def, ...extra]);
  const base = fakeCatalog();
  const catalog: CodeCatalog = {
    ...base,
    triggerIds: triggers.triggerIds,
    validateTriggerParams: triggers.validateTriggerParams,
  };
  const paths = pathsFor(root);
  initRootFolder(paths);
  const memory = new Map<string, string>();
  registry = createMissionRegistry({
    paths,
    catalog,
    config: () => defaultConfig('Ada'),
    codeManifests: [MISSION_ADMIN_MANIFEST],
    memory: { get: (k) => memory.get(k), set: (k, v) => void memory.set(k, v) },
  });
  registry.reload();
}

function makeScheduler(lastStoppedAt?: string): Scheduler {
  scheduler = createScheduler({
    catalog: triggers,
    registry,
    credentials(ids) {
      const out: Record<string, string> = {};
      for (const id of ids) {
        const v = secrets.get(id);
        if (v === undefined) throw new Error(`The credential ${id} has no value.`);
        out[id] = v;
      }
      return out;
    },
    ...(lastStoppedAt !== undefined ? { lastStoppedAt } : {}),
    onEvent: (missionId, event) => events.push({ missionId, event }),
    onError: (triggerId, error) => errors.push({ triggerId, message: error.message }),
  });
  return scheduler;
}

function draft(name: string, triggerList: ManifestDraft['triggers']): ManifestDraft {
  return {
    name,
    description: `The ${name} mission`,
    triggers: triggerList,
    tools: [],
    context: { instructions: 'Do the job.\n' },
    signals: [],
    gates: [],
  };
}

const missionsOf = () => events.map((e) => e.missionId);

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  root = mkdtempSync(join(tmpdir(), 'mission-agent-scheduler-'));
  secrets = new Map();
  events = [];
  errors = [];
  scheduler = undefined;
});
afterEach(async () => {
  await scheduler?.stop();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('createScheduler', () => {
  it('starts the triggers of active missions and follows manifest changes', async () => {
    setup();
    const a = registry.create(draft('news', [{ use: 'trigger:cron', at: '0 7 * * *' }, { use: 'trigger:chat' }]));
    const s = makeScheduler();
    await s.start();
    expect(errors).toEqual([]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(missionsOf()).toEqual([a.id]);

    // A new mission: the registry calls onChange, and the scheduler refreshes.
    // No call to refresh here: the change listener alone must start the new timer.
    const b = registry.create(draft('report', [{ use: 'trigger:cron', at: '30 7 * * *' }]));
    // A changed timer of an existing mission.
    registry.edit(a.id, { triggers: [{ use: 'trigger:cron', at: '45 7 * * *' }] });
    await s.refresh();

    events = [];
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(events.map((e) => [e.missionId, e.event.data.expression])).toEqual([
      [b.id, '30 7 * * *'],
      [a.id, '45 7 * * *'],
    ]);
  });

  it('refreshes on a registry change with no call to refresh', async () => {
    setup();
    const s = makeScheduler();
    await s.start();
    const a = registry.create(draft('news', [{ use: 'trigger:cron', at: '0 7 * * *' }]));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(missionsOf()).toEqual([a.id]);
  });

  it('stops firing for a frozen mission and starts again when it is active', async () => {
    setup();
    const a = registry.create(draft('news', [{ use: 'trigger:cron', at: '0 7 * * *' }]));
    const b = registry.create(draft('report', [{ use: 'trigger:cron', at: '0 7 * * *' }]));
    const s = makeScheduler();
    await s.start();
    registry.setStatus(a.id, 'frozen');
    await s.refresh();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(missionsOf()).toEqual([b.id]);

    registry.setStatus(a.id, 'active');
    await s.refresh();
    events = [];
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(missionsOf().sort()).toEqual([a.id, b.id].sort());
  });

  it('stops a trigger that no mission subscribes to any more', async () => {
    setup();
    const a = registry.create(draft('mail', [{ use: 'trigger:email.received' }]));
    secrets.set(GMAIL, 'token');
    const s = makeScheduler();
    await s.start();
    expect(email.state.subs).toEqual([{ missionId: a.id, params: {} }]);
    expect(email.state.ctx?.credentials).toEqual({ [GMAIL]: 'token' });
    registry.remove(a.id);
    await s.refresh();
    expect(email.state.stops).toBe(1);
  });

  it('does not start a trigger whose credential is missing, and starts the others', async () => {
    setup();
    const a = registry.create(draft('news', [{ use: 'trigger:cron', at: '0 7 * * *' }]));
    registry.create(draft('mail', [{ use: 'trigger:email.received' }]));
    const s = makeScheduler();
    await s.start();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.triggerId).toBe('trigger:email.received');
    expect(errors[0]!.message).toContain(GMAIL);
    expect(email.state.ctx).toBeUndefined();

    // The same missing credential is reported once, not on every refresh.
    registry.create(draft('other', [{ use: 'trigger:chat' }]));
    await s.refresh();
    expect(errors).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(missionsOf()).toEqual([a.id]);

    // After the user sets the value, a refresh starts the trigger.
    secrets.set(GMAIL, 'token');
    await s.refresh();
    expect(email.state.ctx).toBeDefined();
  });

  it('keeps the other triggers running when one trigger fails', async () => {
    const broken: TriggerDefinition = {
      id: 'trigger:broken.create',
      credentials: [],
      validateParams: () => null,
      create: () => {
        throw new Error('cannot start');
      },
    };
    const failing: TriggerDefinition = {
      id: 'trigger:broken.subs',
      credentials: [],
      validateParams: () => null,
      create: () => ({
        setSubscriptions: async () => {
          throw new Error('cannot subscribe');
        },
        stop: async () => {},
      }),
    };
    setup([broken, failing]);
    // The fake code catalog of the registry knows these ids through the trigger catalog.
    const a = registry.create(
      draft('news', [{ use: 'trigger:cron', at: '0 7 * * *' }, { use: 'trigger:broken.create' }, { use: 'trigger:broken.subs' }]),
    );
    const s = makeScheduler();
    await s.start();
    expect(errors.map((e) => [e.triggerId, e.message])).toEqual([
      ['trigger:broken.create', 'cannot start'],
      ['trigger:broken.subs', 'cannot subscribe'],
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(missionsOf()).toEqual([a.id]);
  });

  it('keeps going when onEvent throws, and drops an event for a mission that does not subscribe', async () => {
    setup();
    const a = registry.create(draft('mail', [{ use: 'trigger:email.received' }]));
    secrets.set(GMAIL, 'token');
    let throwOnce = true;
    scheduler = createScheduler({
      catalog: triggers,
      registry,
      credentials: () => ({ [GMAIL]: 'token' }),
      onEvent: (missionId, event) => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error('store is busy');
        }
        events.push({ missionId, event });
      },
      onError: (triggerId, error) => errors.push({ triggerId, message: error.message }),
    });
    await scheduler.start();
    const ev = (key: string): TriggerEvent => ({ triggerId: 'wrong', time: START.toISOString(), key, summary: 'Mail', data: {} });
    email.state.ctx!.emit(a.id, ev('1'));
    email.state.ctx!.emit(a.id, ev('2'));
    email.state.ctx!.emit('m_aaaaaaaaaaaa', ev('3'));
    expect(events.map((e) => e.event.key)).toEqual(['2']);
    // The scheduler sets the trigger id from the definition.
    expect(events[0]!.event.triggerId).toBe('trigger:email.received');
    expect(errors.map((e) => e.message)).toEqual([
      'store is busy',
      expect.stringContaining('does not subscribe to it'),
    ]);
  });

  it('gives the stop time to the triggers created at start only', async () => {
    setup();
    const a = registry.create(draft('news', [{ use: 'trigger:cron', at: '0 7 * * *' }]));
    const s = makeScheduler(new Date(2026, 10, 23, 12, 0).toISOString());
    await s.start();
    expect(events.map((e) => [e.missionId, e.event.data.missed])).toEqual([[a.id, true]]);

    // A trigger created later, for a mission created later, reports no missed run.
    registry.create(draft('mail', [{ use: 'trigger:email.received' }]));
    secrets.set(GMAIL, 'token');
    await s.refresh();
    expect(email.state.ctx).toBeDefined();
    expect(email.state.ctx!.lastStoppedAt).toBeUndefined();
  });

  it('emits nothing after stop', async () => {
    setup();
    registry.create(draft('news', [{ use: 'trigger:cron', at: '0 7 * * *' }]));
    const s = makeScheduler();
    await s.start();
    await s.stop();
    registry.create(draft('report', [{ use: 'trigger:cron', at: '0 7 * * *' }]));
    await s.refresh();
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
