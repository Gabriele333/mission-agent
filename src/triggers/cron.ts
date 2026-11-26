import { Cron } from 'croner';
import type { MissionId, Subscription, TriggerContext, TriggerDefinition, TriggerEvent, TriggerInstance } from '../types.js';

export const CRON_TRIGGER_ID = 'trigger:cron';

/**
 * The longest wait of one timer. The timer wakes up at least this often and checks the clock again,
 * so a change of the system clock or a sleep of the machine delays a firing by one minute at most.
 */
const MAX_WAIT_MS = 60_000;

/** How many missed times are counted one by one before the count is reported as "more than". */
const MISSED_COUNT_CAP = 1000;

/** Parses a five-field expression. Returns the parsed job, or an error text. */
function parseExpression(at: unknown): Cron | string {
  if (at === undefined) return 'needs "at", a cron expression with five fields, such as "0 7 * * *".';
  if (typeof at !== 'string') return '"at" must be a text, a cron expression with five fields, such as "0 7 * * *".';
  const fields = at.trim().split(/\s+/);
  if (at.trim() === '' || fields.length !== 5) {
    return `"at" is "${at}", which has ${at.trim() === '' ? 0 : fields.length} fields. A cron expression has five: minute, hour, day of month, month, day of week.`;
  }
  // Croner replaces "?" with the current time, so the schedule would change at each start.
  if (at.includes('?')) return `"at" is "${at}". The character "?" is not accepted.`;
  let cron: Cron;
  try {
    cron = new Cron(at.trim());
  } catch (e) {
    const detail = e instanceof Error ? e.message.replace(/^CronPattern:\s*/, '') : String(e);
    return `"at" is "${at}", which is not a valid cron expression: ${detail}`;
  }
  if (cron.nextRun() === null) return `"at" is "${at}", which never fires.`;
  return cron;
}

function validateCronParams(params: Record<string, unknown>): string | null {
  const unknown = Object.keys(params).filter((k) => k !== 'at');
  if (unknown.length > 0) return `has unknown parameters: ${unknown.join(', ')}. A timer takes only "at".`;
  const parsed = parseExpression(params.at);
  return typeof parsed === 'string' ? parsed : null;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** The time in the machine's local time zone, as 07:00. */
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** The date in the machine's local time zone, as 2026-11-24. */
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The key of the firing of one expression at one scheduled time, for one mission. */
export function cronEventKey(missionId: MissionId, expression: string, scheduledAt: Date): string {
  return `${CRON_TRIGGER_ID}|${missionId}|${expression}|${scheduledAt.toISOString()}`;
}

interface Missed {
  count: number;
  /** True when there were more missed times than `count`. */
  capped: boolean;
  first: Date;
  last: Date;
}

/** Walks forward from `from` (a scheduled time) and returns the last scheduled time at or before `now`. */
function walkForward(cron: Cron, from: Date, now: Date, limit: number): { last: Date; steps: number; done: boolean } {
  let last = from;
  let steps = 1;
  while (steps < limit) {
    const next = cron.nextRun(last);
    if (next === null || next.getTime() > now.getTime()) return { last, steps, done: true };
    last = next;
    steps++;
  }
  const next = cron.nextRun(last);
  return { last, steps, done: next === null || next.getTime() > now.getTime() };
}

/** The scheduled times after `since` and at or before `now`. Null when there is none. */
export function missedTimes(cron: Cron, since: Date, now: Date): Missed | null {
  const first = cron.nextRun(since);
  if (first === null || first.getTime() > now.getTime()) return null;
  const counted = walkForward(cron, first, now, MISSED_COUNT_CAP);
  if (counted.done) return { count: counted.steps, capped: false, first, last: counted.last };

  // Too many to count. Find the last one by starting from a short time before now, then longer ones.
  const spans = [60_000, 3_600_000, 86_400_000, 31 * 86_400_000, 366 * 86_400_000];
  for (const span of spans) {
    const start = new Date(Math.max(since.getTime(), now.getTime() - span));
    const candidate = cron.nextRun(start);
    if (candidate === null || candidate.getTime() > now.getTime()) continue;
    const found = walkForward(cron, candidate, now, MISSED_COUNT_CAP);
    if (found.done) return { count: MISSED_COUNT_CAP, capped: true, first, last: found.last };
  }
  return { count: MISSED_COUNT_CAP, capped: true, first, last: counted.last };
}

/** All missions that subscribed with one expression share one timer. */
interface Slot {
  expression: string;
  cron: Cron;
  missions: Set<MissionId>;
  next: Date | null;
  timer?: ReturnType<typeof setTimeout>;
}

function createCronInstance(ctx: TriggerContext): TriggerInstance {
  const slots = new Map<string, Slot>();
  let firstCall = true;
  let stopped = false;

  function clear(slot: Slot): void {
    if (slot.timer !== undefined) clearTimeout(slot.timer);
    slot.timer = undefined;
  }

  function fire(slot: Slot, scheduledAt: Date): void {
    const time = new Date().toISOString();
    for (const missionId of [...slot.missions]) {
      const event: TriggerEvent = {
        triggerId: CRON_TRIGGER_ID,
        time,
        key: cronEventKey(missionId, slot.expression, scheduledAt),
        summary: `Timer "${slot.expression}" fired at ${localTime(scheduledAt)}`,
        data: { expression: slot.expression, scheduledAt: scheduledAt.toISOString() },
      };
      ctx.emit(missionId, event);
    }
  }

  function arm(slot: Slot): void {
    clear(slot);
    if (stopped || slot.next === null) return;
    const wait = Math.max(0, Math.min(slot.next.getTime() - Date.now(), MAX_WAIT_MS));
    const timer = setTimeout(() => check(slot), wait);
    timer.unref?.();
    slot.timer = timer;
  }

  function check(slot: Slot): void {
    slot.timer = undefined;
    if (stopped || slots.get(slot.expression) !== slot || slot.next === null) return;
    const now = Date.now();
    if (now >= slot.next.getTime()) {
      const scheduledAt = slot.next;
      // Compute the next time from the later of now and the scheduled time, so a late wake-up fires once.
      slot.next = slot.cron.nextRun(new Date(Math.max(now, scheduledAt.getTime())));
      try {
        fire(slot, scheduledAt);
      } finally {
        arm(slot);
      }
      return;
    }
    arm(slot);
  }

  function emitMissed(missionId: MissionId, expression: string, cron: Cron, since: Date, now: Date): void {
    const missed = missedTimes(cron, since, now);
    if (missed === null) return;
    const due = `${localTime(missed.last)} on ${localDate(missed.last)}`;
    const summary =
      missed.count === 1
        ? `Timer "${expression}" was missed while the harness was stopped. It was due at ${due}.`
        : `Timer "${expression}" was missed ${missed.capped ? `more than ${missed.count}` : missed.count} times while the harness was stopped. The last time was due at ${due}.`;
    ctx.emit(missionId, {
      triggerId: CRON_TRIGGER_ID,
      time: now.toISOString(),
      // The same key as the firing at the last missed time: a second start with the same stop time gives the same key.
      key: cronEventKey(missionId, expression, missed.last),
      summary,
      data: {
        expression,
        scheduledAt: missed.last.toISOString(),
        missed: true,
        missedCount: missed.count,
        missedCountIsMinimum: missed.capped,
        firstMissedAt: missed.first.toISOString(),
      },
    });
  }

  return {
    async setSubscriptions(subs: Subscription[]): Promise<void> {
      if (stopped) return;
      const wanted = new Map<string, { cron: Cron; missions: Set<MissionId> }>();
      const problems: string[] = [];
      for (const sub of subs) {
        const error = validateCronParams(sub.params);
        if (error !== null) {
          problems.push(`${sub.missionId}: ${error}`);
          continue;
        }
        const parsed = parseExpression(sub.params.at) as Cron;
        const expression = (sub.params.at as string).trim();
        const entry = wanted.get(expression) ?? { cron: parsed, missions: new Set<MissionId>() };
        entry.missions.add(sub.missionId);
        wanted.set(expression, entry);
      }

      for (const [expression, slot] of slots) {
        if (!wanted.has(expression)) {
          clear(slot);
          slots.delete(expression);
        }
      }
      for (const [expression, entry] of wanted) {
        const existing = slots.get(expression);
        if (existing !== undefined) {
          // The timer keeps running. Only the list of missions changes.
          existing.missions = entry.missions;
          continue;
        }
        const slot: Slot = { expression, cron: entry.cron, missions: entry.missions, next: entry.cron.nextRun(new Date()) };
        slots.set(expression, slot);
        arm(slot);
      }

      // A missed run is checked once, for the subscriptions that exist when the harness starts (§B.2).
      if (firstCall) {
        firstCall = false;
        const since = ctx.lastStoppedAt === undefined ? NaN : Date.parse(ctx.lastStoppedAt);
        if (!Number.isNaN(since)) {
          const now = new Date();
          for (const [expression, entry] of wanted) {
            for (const missionId of entry.missions) emitMissed(missionId, expression, entry.cron, new Date(since), now);
          }
        }
      }

      if (problems.length > 0) {
        throw new Error(`Some timer subscriptions were not started: ${problems.join(' ')}`);
      }
    },
    async stop(): Promise<void> {
      stopped = true;
      for (const slot of slots.values()) clear(slot);
      slots.clear();
    },
  };
}

/** The timer that comes with the harness (§B.2). One parameter, `at`, in the machine's local time zone. */
export const cronTrigger: TriggerDefinition = {
  id: CRON_TRIGGER_ID,
  credentials: [],
  validateParams: validateCronParams,
  create: (ctx) => createCronInstance(ctx),
};
