/**
 * Live test of the whole harness. It calls the model through the machine's own Claude Code
 * sign-in, so it runs only with MISSION_AGENT_LIVE=1 and costs a little on that plan.
 * It talks to the harness only through the HTTP routes of the terminal surface, except for
 * (e), which hands a timer event to the harness as the scheduler would.
 * The checks run in order and share one harness.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../../src/harness/index.js';
import { createMemorySecretStore } from '../../src/secrets/index.js';
import { readServerFile } from '../../src/server/index.js';
import { collectEvents, waitFor, type EventCollector } from '../../src/server/test-helpers.js';
import { REGISTRY_ACTION_IDS } from '../../src/tools/index.js';
import { SYS_GENERAL } from '../../src/types.js';

const MODEL = 'claude-haiku-5-5';
const NEW_MISSION = 'haiku-notes';
const WAIT_MS = 150_000;

let tmp: string;
let root: string;
let harness: Harness;
let stream: EventCollector;
let base: string;
let token: string;
let newId: string;
const logs: string[] = [];

interface StreamEvent {
  event: string;
  data: { id?: string; missionId?: string | null; label?: string; text?: string };
}

const events = () => stream.events as StreamEvent[];

async function say(text: string): Promise<void> {
  const res = await fetch(`${base}/api/chat/message`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  expect(res.status).toBe(202);
}

async function answer(id: string, decision: 'approve' | 'reject'): Promise<void> {
  const res = await fetch(`${base}/api/chat/approvals/${id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ decision }),
  });
  expect(res.ok).toBe(true);
}

/** Waits for the first event after `from` that matches, and returns it. */
async function next(from: number, match: (e: StreamEvent) => boolean, what: string, ms = WAIT_MS): Promise<StreamEvent> {
  let found: StreamEvent | undefined;
  await waitFor(
    () => {
      found = events().slice(from).find(match);
      return found !== undefined;
    },
    what,
    ms,
  );
  return found as StreamEvent;
}

const isText = (e: StreamEvent) => e.event === 'message' || e.event === 'notice';

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mission-agent-live-harness-'));
  root = join(tmp, 'root');
  mkdirSync(root);
  writeFileSync(
    join(root, 'agent.yaml'),
    [
      'agent_name: Ada',
      'model_login: subscription',
      'default_surface: terminal',
      `default_model: ${MODEL}`,
      `triage_model: ${MODEL}`,
      'default_effort: low',
      'run_limits:',
      '  max_steps: 15',
      '  max_cost_usd: 0.5',
      '  max_minutes: 5',
      '',
    ].join('\n'),
  );
  harness = createHarness({ root, sdkConfigDir: null, secretStore: createMemorySecretStore(), log: (t) => logs.push(t) });
  await harness.start();
  const info = readServerFile(harness.paths);
  if (info === undefined) throw new Error('The harness wrote no server file.');
  base = `http://127.0.0.1:${info.port}`;
  token = info.token;
  stream = await collectEvents(`${base}/api/chat/stream`, token);
}, 60_000);

afterAll(async () => {
  stream?.close();
  await harness?.stop();
  if (logs.length > 0) console.log(`Harness log:\n${logs.join('\n')}`);
  rmSync(tmp, { recursive: true, force: true });
});

describe('the harness with the real model', () => {
  it('starts unpaused with the machine sign-in', () => {
    expect(harness.status().pauseReason).toBe('');
    expect(harness.status().paused).toBe(false);
  });

  it('(a) the general mission answers a chat message', async () => {
    const from = events().length;
    await say('What is 2 plus 2? Answer with the digit only.');
    const reply = await next(from, (e) => e.event === 'message' && e.data.missionId === SYS_GENERAL, 'the answer of sys-general');
    expect(reply.data.label).toBe('Ada · sys-general');
    expect(reply.data.text).toContain('4');
    await harness.settle();
  });

  it('(b) the mission admin creates a mission after an approval that shows the manifest', async () => {
    let from = events().length;
    await say('/mission sys-mission-admin');
    await next(from, (e) => isText(e) && e.data.text === 'The current mission is now sys-mission-admin.', 'the switch');
    from = events().length;
    await say(
      `Create a mission now, without questions. Name: ${NEW_MISSION}. Description: Writes short notes. ` +
        'Triggers: trigger:chat, and trigger:cron with at "0 7 * * *". No tools. ' +
        'Instructions: Answer in one short sentence.',
    );
    const approval = await next(from, (e) => e.event === 'approval', 'the approval request');
    const text = approval.data.text ?? '';
    expect(text).toContain(`Action: ${REGISTRY_ACTION_IDS.create}`);
    expect(text).toContain(`Creates the mission ${NEW_MISSION}`);
    expect(text).toContain(NEW_MISSION);
    expect(text).toContain('trigger:cron');
    expect(text).toContain('one short sentence');
    await answer(approval.data.id ?? '', 'approve');
    await waitFor(() => harness.registry.list().some((m) => m.name === NEW_MISSION), 'the new mission', WAIT_MS);
    newId = harness.registry.list().find((m) => m.name === NEW_MISSION)?.id ?? '';
    await harness.settle();
  });

  it('(c) /mission switches to the new mission and its answer carries its label', async () => {
    let from = events().length;
    await say(`/mission ${NEW_MISSION}`);
    await next(from, (e) => isText(e) && e.data.text === `The current mission is now ${NEW_MISSION}.`, 'the switch');
    from = events().length;
    // A greeting could get a direct answer of the general mission (§B.3), so the message is a task of the mission.
    await say('Write a short note about tea.');
    const reply = await next(from, (e) => e.event === 'message' && e.data.missionId === newId, 'the answer of the new mission');
    expect(reply.data.label).toBe(`Ada · ${NEW_MISSION}`);
    expect((reply.data.text ?? '').length).toBeGreaterThan(0);
    await harness.settle();
  });

  it('(d) /pause and /resume', async () => {
    let from = events().length;
    await say('/pause');
    await next(from, (e) => isText(e) && (e.data.text ?? '').startsWith('The agent is paused.'), 'the pause answer', 10_000);
    expect(harness.status().paused).toBe(true);
    from = events().length;
    await say('Are you there?');
    await next(from, (e) => isText(e) && (e.data.text ?? '').includes('this message was not passed on'), 'the paused answer', 10_000);
    from = events().length;
    await say('/resume');
    await next(from, (e) => isText(e) && (e.data.text ?? '').startsWith('The pause has ended.'), 'the resume answer', 10_000);
    expect(harness.status().paused).toBe(false);
  });

  it('(e) a timer run writes its final text to the logbook and not to the chat', async () => {
    const from = events().length;
    const runsBefore = harness.store.listRuns({ missionId: newId }).length;
    harness.handleEvent(newId, {
      triggerId: 'trigger:cron',
      key: `live-${Date.now()}`,
      time: new Date().toISOString(),
      summary: 'The daily timer fired. Write one short note about the weather in general.',
      data: {},
    });
    await waitFor(() => harness.store.listRuns({ missionId: newId }).length > runsBefore, 'the logbook row', WAIT_MS);
    await harness.settle();
    const row = harness.store.listRuns({ missionId: newId })[0];
    expect(row?.status).toBe('success');
    expect((row?.finalText ?? '').length).toBeGreaterThan(0);
    const chat = events().slice(from).filter((e) => e.event === 'message' && e.data.missionId === newId);
    expect(chat).toEqual([]);
  });

  it('(f) the mission admin deletes the mission after an approval that lists what is removed', async () => {
    let from = events().length;
    await say('/mission sys-mission-admin');
    await next(from, (e) => isText(e) && e.data.text === 'The current mission is now sys-mission-admin.', 'the switch');
    from = events().length;
    await say(`Delete the mission ${NEW_MISSION} now, without questions.`);
    const approval = await next(from, (e) => e.event === 'approval', 'the approval request');
    const text = approval.data.text ?? '';
    expect(text).toContain(`Action: ${REGISTRY_ACTION_IDS.delete}`);
    expect(text).toContain(`Deleting the mission ${NEW_MISSION} (${newId}) removes everything below:`);
    expect(text).toContain('manifest.yaml');
    expect(text).toContain('memory/');
    expect(text).toContain('its session');
    await answer(approval.data.id ?? '', 'approve');
    await waitFor(() => !existsSync(harness.paths.missionDir(newId)), 'the removed folder', WAIT_MS);
    await harness.settle();
    expect(harness.registry.get(newId)).toBeUndefined();
  });
});
