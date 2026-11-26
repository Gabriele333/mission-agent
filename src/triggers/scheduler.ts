import type { MissionId, MissionRegistry, Subscription, TriggerEvent, TriggerInstance } from '../types.js';
import type { TriggerCatalog } from './catalog.js';

export interface SchedulerDeps {
  catalog: TriggerCatalog;
  registry: MissionRegistry;
  /** Returns the values of the given credential ids. Throws when one is missing. */
  credentials(ids: string[]): Record<string, string>;
  /** ISO time at which the harness last stopped. Given only to the triggers created by `start` (§B.2). */
  lastStoppedAt?: string;
  /** Receives every event. The harness stores it with `store.enqueueEvent` and starts the run. */
  onEvent(missionId: MissionId, event: TriggerEvent): void;
  onError(triggerId: string, error: Error): void;
}

export interface Scheduler {
  /** Starts one instance per trigger that an active mission subscribes to, and follows registry changes. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Reads the registry again and updates the triggers. Also call it after a credential was set. */
  refresh(): Promise<void>;
}

interface Running {
  instance: TriggerInstance;
  /** The subscriptions last given to the instance, as JSON, to skip a call when nothing changed. */
  subsJson: string;
  /** Shared with the instance's `emit`. Holds the missions that the instance may emit events for. */
  allowed: { missions: Set<MissionId> };
}

const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

/** Runs the triggers of the active missions (§B.2). It stores nothing and starts no run. */
export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { catalog, registry } = deps;
  const running = new Map<string, Running>();
  /** The last credential error reported for a trigger, so the same error is not reported on every refresh. */
  const credentialErrors = new Map<string, string>();
  let started = false;
  let stopped = false;
  let queue: Promise<void> = Promise.resolve();
  let listening = false;

  function report(triggerId: string, error: unknown): void {
    try {
      deps.onError(triggerId, asError(error));
    } catch {
      // An error in the error handler must not stop the scheduler.
    }
  }

  /** The subscriptions of the active missions, grouped by trigger id. A frozen mission has none. */
  function wantedSubscriptions(): Map<string, Subscription[]> {
    const wanted = new Map<string, Subscription[]>();
    for (const m of registry.list()) {
      if (m.status !== 'active') continue;
      for (const sub of m.triggers) {
        const { use, ...params } = sub;
        const list = wanted.get(use) ?? [];
        list.push({ missionId: m.id, params });
        wanted.set(use, list);
      }
    }
    return wanted;
  }

  async function stopInstance(triggerId: string): Promise<void> {
    const r = running.get(triggerId);
    if (r === undefined) return;
    running.delete(triggerId);
    try {
      await r.instance.stop();
    } catch (e) {
      report(triggerId, e);
    }
  }

  async function startInstance(triggerId: string, subs: Subscription[], atStart: boolean): Promise<void> {
    const def = catalog.get(triggerId);
    if (def === undefined) return;

    let credentials: Record<string, string>;
    try {
      credentials = def.credentials.length > 0 ? deps.credentials(def.credentials) : {};
      credentialErrors.delete(triggerId);
    } catch (e) {
      const message =
        `Trigger ${triggerId} is not started because a credential is missing. ` +
        `It needs ${def.credentials.join(', ')}. ${asError(e).message}`;
      if (credentialErrors.get(triggerId) !== message) {
        credentialErrors.set(triggerId, message);
        report(triggerId, new Error(message));
      }
      return;
    }

    const allowed = { missions: new Set<MissionId>() };
    let instance: TriggerInstance | null;
    try {
      instance = def.create({
        emit(missionId, event) {
          if (stopped || running.get(triggerId)?.allowed !== allowed) return;
          if (!allowed.missions.has(missionId)) {
            report(triggerId, new Error(`Trigger ${triggerId} gave an event for ${missionId}, which does not subscribe to it. The event was dropped.`));
            return;
          }
          try {
            deps.onEvent(missionId, { ...event, triggerId });
          } catch (e) {
            report(triggerId, e);
          }
        },
        credentials,
        ...(atStart && deps.lastStoppedAt !== undefined ? { lastStoppedAt: deps.lastStoppedAt } : {}),
      });
    } catch (e) {
      report(triggerId, e);
      return;
    }
    // A trigger such as `trigger:chat` watches nothing.
    if (instance === null) return;
    const entry: Running = { instance, subsJson: '', allowed };
    running.set(triggerId, entry);
    await giveSubscriptions(triggerId, entry, subs);
  }

  async function giveSubscriptions(triggerId: string, entry: Running, subs: Subscription[]): Promise<void> {
    const json = JSON.stringify(subs);
    if (json === entry.subsJson) return;
    // Missions are allowed before the call, because a trigger can emit during it (a missed timer run).
    entry.allowed.missions = new Set(subs.map((s) => s.missionId));
    entry.subsJson = json;
    try {
      await entry.instance.setSubscriptions(subs);
    } catch (e) {
      report(triggerId, e);
    }
  }

  async function doRefresh(atStart: boolean): Promise<void> {
    if (stopped) return;
    let wanted: Map<string, Subscription[]>;
    try {
      wanted = wantedSubscriptions();
    } catch (e) {
      report('scheduler', e);
      return;
    }

    for (const triggerId of [...running.keys()]) {
      if (!wanted.has(triggerId) || catalog.get(triggerId) === undefined) await stopInstance(triggerId);
    }
    for (const triggerId of catalog.ids()) {
      if (stopped) return;
      const subs = wanted.get(triggerId);
      if (subs === undefined || subs.length === 0) {
        credentialErrors.delete(triggerId);
        continue;
      }
      try {
        const r = running.get(triggerId);
        if (r !== undefined) await giveSubscriptions(triggerId, r, subs);
        else await startInstance(triggerId, subs, atStart);
      } catch (e) {
        report(triggerId, e);
      }
    }
  }

  /** Refreshes run one after the other, never at the same time. */
  function enqueue(atStart: boolean): Promise<void> {
    queue = queue.then(() => doRefresh(atStart)).catch((e: unknown) => report('scheduler', e));
    return queue;
  }

  return {
    async start() {
      if (started) return;
      started = true;
      if (!listening) {
        listening = true;
        registry.onChange(() => {
          if (started && !stopped) void enqueue(false);
        });
      }
      await enqueue(true);
    },
    refresh() {
      if (!started || stopped) return queue;
      return enqueue(false);
    },
    async stop() {
      stopped = true;
      await queue;
      for (const triggerId of [...running.keys()]) await stopInstance(triggerId);
    },
  };
}
