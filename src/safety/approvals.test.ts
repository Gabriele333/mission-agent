import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, ApprovalRequest } from '../types.js';
import { clearStaleApprovals, createApprovalQueue, describeApproval, type ApprovalQueueOptions } from './approvals.js';

function fakeStore() {
  const rows = new Map<string, ApprovalRequest>();
  return {
    rows,
    saveApproval: (req: ApprovalRequest) => void rows.set(req.id, req),
    deleteApproval: (id: string) => void rows.delete(id),
    listApprovals: () => [...rows.values()],
  };
}

function setup(over: Partial<ApprovalQueueOptions> & { hours?: number } = {}) {
  const store = fakeStore();
  const shown: ApprovalRequest[] = [];
  const closed: [string, string][] = [];
  let n = 0;
  const queue = createApprovalQueue({
    store,
    config: () => ({ approvalWaitHours: over.hours ?? 24 }) as AgentConfig,
    show: async (req) => void shown.push(req),
    close: async (id, outcome) => void closed.push([id, outcome]),
    now: () => new Date('2026-11-25T10:00:00.000Z'),
    newId: () => `apr_${++n}`,
    ...over,
  });
  return { queue, store, shown, closed };
}

const call = { missionId: 'm_abc', action: 'action:email.send', toolName: 'mcp__gmail__send', input: { to: 'a@b.c' } };

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('approval queue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('saves, shows and resolves on an answer, then deletes and closes', async () => {
    const { queue, store, shown, closed } = setup();
    const p = queue.request({ ...call, note: 'ask before sending' });
    await flush();
    expect(store.rows.get('apr_1')).toMatchObject({
      missionId: 'm_abc',
      note: 'ask before sending',
      createdAt: '2026-11-25T10:00:00.000Z',
      expiresAt: '2026-11-26T10:00:00.000Z',
    });
    expect(shown.map((r) => r.id)).toEqual(['apr_1']);
    expect(queue.pending().map((r) => r.id)).toEqual(['apr_1']);
    expect(queue.answer('apr_1', { kind: 'approved' })).toBe(true);
    await expect(p).resolves.toEqual({ kind: 'approved' });
    await flush();
    expect(store.rows.size).toBe(0);
    expect(queue.pending()).toEqual([]);
    expect(closed).toEqual([['apr_1', 'approved']]);
  });

  it('ignores a second answer and an unknown id', async () => {
    const { queue, closed } = setup();
    const p = queue.request(call);
    expect(queue.answer('apr_1', { kind: 'rejected', reason: 'not now' })).toBe(true);
    expect(queue.answer('apr_1', { kind: 'approved' })).toBe(false);
    expect(queue.answer('apr_99', { kind: 'approved' })).toBe(false);
    await expect(p).resolves.toEqual({ kind: 'rejected', reason: 'not now' });
    await flush();
    expect(closed).toEqual([['apr_1', 'rejected: not now']]);
  });

  it('cancels after the time limit with the real number of hours', async () => {
    const { queue, store, closed } = setup({ hours: 2 });
    const p = queue.request(call);
    await vi.advanceTimersByTimeAsync(2 * 3_600_000 - 1);
    expect(queue.pending()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toEqual({ kind: 'cancelled', reason: 'no answer in 2 hours' });
    expect(store.rows.size).toBe(0);
    expect(closed).toEqual([['apr_1', 'cancelled: no answer in 2 hours']]);
    expect(queue.answer('apr_1', { kind: 'approved' })).toBe(false);
  });

  it('handles a wait longer than one timer allows', async () => {
    const { queue } = setup({ hours: 24 * 30 });
    const p = queue.request(call);
    await vi.advanceTimersByTimeAsync(29 * 24 * 3_600_000);
    expect(queue.pending()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    await expect(p).resolves.toEqual({ kind: 'cancelled', reason: 'no answer in 720 hours' });
  });

  it('stops the timer after an answer', async () => {
    const { queue, closed } = setup({ hours: 1 });
    void queue.request(call);
    queue.answer('apr_1', { kind: 'approved' });
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    expect(closed).toEqual([['apr_1', 'approved']]);
  });

  it('cancels the requests of one mission only', async () => {
    const { queue, store } = setup();
    const a = queue.request(call);
    const b = queue.request({ ...call, missionId: 'm_other' });
    queue.cancelForMission('m_abc', 'a new run started');
    await expect(a).resolves.toEqual({ kind: 'cancelled', reason: 'a new run started' });
    expect(queue.pending().map((r) => r.missionId)).toEqual(['m_other']);
    expect([...store.rows.keys()]).toEqual(['apr_2']);
    queue.answer('apr_2', { kind: 'approved' });
    await expect(b).resolves.toEqual({ kind: 'approved' });
  });

  it('cancels every request', async () => {
    const { queue, store, closed } = setup();
    const all = [queue.request(call), queue.request({ ...call, missionId: 'm_other' })];
    queue.cancelAll('the harness stops');
    for (const p of all) await expect(p).resolves.toEqual({ kind: 'cancelled', reason: 'the harness stops' });
    await flush();
    expect(store.rows.size).toBe(0);
    expect(closed.map((c) => c[1])).toEqual(['cancelled: the harness stops', 'cancelled: the harness stops']);
  });

  it('cancels a request that cannot be shown, so the action never runs', async () => {
    const { queue, store, closed } = setup({ show: async () => Promise.reject(new Error('Telegram is down')) });
    const p = queue.request(call);
    await expect(p).resolves.toEqual({
      kind: 'cancelled',
      reason: 'the request could not be shown to the user (Telegram is down)',
    });
    expect(store.rows.size).toBe(0);
    await flush();
    expect(closed).toHaveLength(1);
  });

  it('cancels when show throws at once', async () => {
    const { queue } = setup({
      show: () => {
        throw new Error('no surface');
      },
    });
    await expect(queue.request(call)).resolves.toMatchObject({ kind: 'cancelled' });
  });

  it('cancels a request that cannot be saved', async () => {
    const store = {
      saveApproval: () => {
        throw new Error('disk full');
      },
      deleteApproval: () => undefined,
    };
    const { queue, shown } = setup({ store });
    await expect(queue.request(call)).resolves.toEqual({
      kind: 'cancelled',
      reason: 'the request could not be saved (disk full)',
    });
    expect(shown).toEqual([]);
  });

  it('resolves even when close fails', async () => {
    const { queue } = setup({ close: async () => Promise.reject(new Error('gone')) });
    const p = queue.request(call);
    queue.answer('apr_1', { kind: 'approved' });
    await expect(p).resolves.toEqual({ kind: 'approved' });
    await flush();
  });

  it('says "1 hour" for a one-hour limit', async () => {
    const { queue } = setup({ hours: 1 });
    const p = queue.request(call);
    await vi.advanceTimersByTimeAsync(3_600_000);
    await expect(p).resolves.toEqual({ kind: 'cancelled', reason: 'no answer in 1 hour' });
  });
});

describe('clearStaleApprovals', () => {
  it('removes and returns the requests left from before a restart', () => {
    const store = fakeStore();
    const old: ApprovalRequest = {
      id: 'apr_old',
      missionId: 'm_abc',
      action: 'action:email.send',
      toolName: 'mcp__gmail__send',
      input: {},
      createdAt: '2026-11-24T10:00:00.000Z',
      expiresAt: '2026-11-25T10:00:00.000Z',
    };
    store.saveApproval(old);
    expect(clearStaleApprovals(store)).toEqual([old]);
    expect(store.rows.size).toBe(0);
    expect(clearStaleApprovals(store)).toEqual([]);
  });
});

describe('describeApproval', () => {
  const base: ApprovalRequest = {
    id: 'apr_1',
    missionId: 'm_abc',
    action: 'action:email.send',
    toolName: 'mcp__gmail__send',
    input: { to: 'a@b.c', body: 'y'.repeat(3000) },
    note: 'ask before sending any reply',
    createdAt: '2026-11-25T10:00:00.000Z',
    expiresAt: '2026-11-26T10:00:00.000Z',
  };

  it('shows the mission, the action, the note and a shortened input', () => {
    const text = describeApproval(base, 'inbox-curator');
    expect(text).toContain('Mission: inbox-curator');
    expect(text).toContain('Action: action:email.send');
    expect(text).toContain('Note: ask before sending any reply');
    expect(text).toContain('a@b.c');
    expect(text).toContain('2500 more characters not shown');
    expect(text.length).toBeLessThan(1000);
  });

  it('shows a shell command in full', () => {
    const command = `echo ${'z'.repeat(5000)}`;
    const text = describeApproval(
      { ...base, toolName: 'Bash', action: 'action:shell.run', note: command, input: { command } },
      'dev',
    );
    expect(text).toContain(`Command:\n${command}`);
    expect(text).not.toContain('not shown');
  });

  it('shows the input of a registry action in full', () => {
    const instructions = 'w'.repeat(3900);
    const text = describeApproval(
      { ...base, action: 'action:registry.edit', toolName: 'mcp__registry__edit', input: { instructions } },
      'sys-mission-admin',
    );
    expect(text).toContain(instructions);
    expect(text).not.toContain('not shown');
  });
});
