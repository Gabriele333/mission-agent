import { afterEach, describe, expect, it } from 'vitest';
import { createLocalServer } from '../../server/index.js';
import { collectEvents, tempPaths, waitFor } from '../../server/test-helpers.js';
import { createTerminalSurface } from './surface.js';
import { approvalRequest, fakeHost, startHarness, type Harness } from './test-helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function harness(): Promise<Harness> {
  const h = await startHarness();
  cleanups.push(() => h.paths.remove());
  cleanups.push(() => h.stop());
  return h;
}

async function connect(h: Harness) {
  const c = await collectEvents(`${h.base}/api/chat/stream`, h.token);
  cleanups.push(() => c.close());
  return c;
}

function postJson(h: Harness, path: string, body: unknown) {
  return fetch(`${h.base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const msg = (text: string) => ({ missionId: 'm_k7q3zp2xw9ha', label: 'Ada · inbox-curator', text });

describe('terminal surface', () => {
  it('declares its id, no threads and no credentials', () => {
    const s = createTerminalSurface({ server: { route: () => {} } });
    expect(s.id).toBe('surface:terminal');
    expect(s.hasThreads).toBe(false);
    expect(s.credentials).toEqual([]);
    expect(s.createThread).toBeUndefined();
    expect(s.renameThread).toBeUndefined();
    expect(s.deleteThread).toBeUndefined();
  });

  it('delivers each message to every connected chat program', async () => {
    const h = await harness();
    const a = await connect(h);
    const b = await connect(h);
    await waitFor(() => h.surface.clientCount() === 2, 'two clients');
    await h.surface.send(msg('Three new mails.'));
    await h.surface.send({ missionId: null, label: 'Ada', text: 'The agent is paused.' });
    for (const c of [a, b]) {
      await waitFor(() => c.events.length === 2, 'two events');
      expect(c.events[0]).toMatchObject({
        event: 'message',
        data: { label: 'Ada · inbox-curator', text: 'Three new mails.', missionId: 'm_k7q3zp2xw9ha' },
      });
      expect((c.events[0]?.data as { earlier?: boolean }).earlier).toBeUndefined();
      expect(c.events[1]).toMatchObject({ event: 'notice', data: { label: 'Ada', text: 'The agent is paused.' } });
    }
  });

  it('keeps the last 200 messages while no chat program is connected and delivers them once, as earlier', async () => {
    const h = await harness();
    for (let i = 1; i <= 205; i++) await h.surface.send(msg(`message ${i}`));
    const first = await connect(h);
    await waitFor(() => first.events.length === 200, '200 earlier messages');
    expect(first.events[0]).toMatchObject({ event: 'message', data: { text: 'message 6', earlier: true } });
    expect(first.events[199]).toMatchObject({ data: { text: 'message 205', earlier: true } });

    const second = await connect(h);
    await waitFor(() => h.surface.clientCount() === 2, 'the second client');
    await h.surface.send(msg('new'));
    await waitFor(() => second.events.length === 1, 'the new message');
    expect(second.events).toEqual([{ event: 'message', data: expect.objectContaining({ text: 'new' }) }]);
  });

  it('passes a message or a command to the host and answers at once', async () => {
    const h = await harness();
    let release: () => void = () => {};
    h.host.onIncoming = () => new Promise<void>((r) => (release = r));
    const res = await postJson(h, '/api/chat/message', { text: '/mission inbox-curator' });
    expect(res.status).toBe(202);
    expect(h.host.incomingCalls).toEqual([{ surface: 'surface:terminal', text: '/mission inbox-curator' }]);
    release();
  });

  it('refuses a message body without text', async () => {
    const h = await harness();
    expect((await postJson(h, '/api/chat/message', { text: '  ' })).status).toBe(400);
    expect((await postJson(h, '/api/chat/message', { other: 1 })).status).toBe(400);
    expect(h.host.incomingCalls).toEqual([]);
  });

  it('sends a notice when the host fails on a message', async () => {
    const h = await harness();
    const c = await connect(h);
    h.host.onIncoming = () => {
      throw new Error('triage failed');
    };
    await postJson(h, '/api/chat/message', { text: 'hello' });
    await waitFor(() => c.events.length === 1, 'the notice');
    expect(c.events[0]).toMatchObject({
      event: 'notice',
      data: { text: 'The harness could not handle the message: triage failed' },
    });
  });

  it('shows an approval, takes the answer, and closes it', async () => {
    const h = await harness();
    const c = await connect(h);
    h.host.waitingIds.add('apr_1');
    await h.surface.showApproval(approvalRequest('apr_1', { note: 'Check the reply.' }), 'Ada · inbox-curator');
    await waitFor(() => c.events.length === 1, 'the approval');
    expect(c.events[0]?.event).toBe('approval');
    const shown = c.events[0]?.data as { id: string; text: string; label: string };
    expect(shown.id).toBe('apr_1');
    expect(shown.label).toBe('Ada · inbox-curator');
    expect(shown.text).toContain('Mission: inbox-curator');
    expect(shown.text).toContain('Action: action:email.send');
    expect(shown.text).toContain('Note: Check the reply.');

    const res = await postJson(h, '/api/chat/approvals/apr_1', { decision: 'reject', reason: ' too long ' });
    expect(await res.json()).toEqual({ wasWaiting: true });
    expect(h.host.answers).toEqual([{ id: 'apr_1', answer: { kind: 'rejected', reason: 'too long' } }]);
    await waitFor(() => c.events.length === 2, 'the close');
    expect(c.events[1]).toEqual({ event: 'approval_closed', data: { id: 'apr_1', outcome: 'rejected: too long' } });

    const again = await postJson(h, '/api/chat/approvals/apr_1', { decision: 'approve' });
    expect(await again.json()).toEqual({ wasWaiting: false });
    expect(h.host.answers[1]).toEqual({ id: 'apr_1', answer: { kind: 'approved' } });
  });

  it('refuses an invalid approval answer', async () => {
    const h = await harness();
    expect((await postJson(h, '/api/chat/approvals/apr_1', { decision: 'maybe' })).status).toBe(400);
    expect((await postJson(h, '/api/chat/approvals/apr_1', { decision: 'reject', reason: 3 })).status).toBe(400);
    expect(h.host.answers).toEqual([]);
  });

  it('sends the requests that still wait to a chat program that connects later, and not the closed ones', async () => {
    const h = await harness();
    await h.surface.showApproval(approvalRequest('apr_1'), 'Ada · inbox-curator');
    await h.surface.showApproval(approvalRequest('apr_2'), 'Ada · inbox-curator');
    await h.surface.closeApproval('apr_1', 'approved');
    await h.surface.send(msg('while away'));
    const c = await connect(h);
    await waitFor(() => c.events.length === 2, 'the backlog and the waiting request');
    expect(c.events.map((e) => e.event)).toEqual(['message', 'approval']);
    expect((c.events[1]?.data as { id: string }).id).toBe('apr_2');
  });

  it('uses the missionName option for the text of a request', async () => {
    const paths = tempPaths();
    cleanups.push(() => paths.remove());
    const server = createLocalServer({ paths });
    const surface = createTerminalSurface({ server, missionName: () => 'sell-the-flat' });
    await surface.start(fakeHost(() => surface));
    const { port, token } = await server.start();
    cleanups.push(() => server.stop());
    const c = await collectEvents(`http://127.0.0.1:${port}/api/chat/stream`, token);
    cleanups.push(() => c.close());
    await surface.showApproval(approvalRequest('apr_1'), 'Ada');
    await waitFor(() => c.events.length === 1, 'the approval');
    expect((c.events[0]?.data as { text: string }).text).toContain('Mission: sell-the-flat');
  });

  it('answers 503 before start, and closes the streams with a notice on stop', async () => {
    const paths = tempPaths();
    cleanups.push(() => paths.remove());
    const server = createLocalServer({ paths });
    const surface = createTerminalSurface({ server });
    const { port, token } = await server.start();
    cleanups.push(() => server.stop());
    const base = `http://127.0.0.1:${port}`;
    const before = await fetch(`${base}/api/chat/stream`, { headers: { authorization: `Bearer ${token}` } });
    expect(before.status).toBe(503);

    await surface.start(fakeHost(() => surface));
    const c = await collectEvents(`${base}/api/chat/stream`, token);
    await waitFor(() => surface.clientCount() === 1, 'the client');
    await surface.stop();
    await c.ended;
    expect(c.events).toEqual([{ event: 'notice', data: expect.objectContaining({ text: 'The harness is stopping.' }) }]);
    expect(surface.clientCount()).toBe(0);
  });
});
