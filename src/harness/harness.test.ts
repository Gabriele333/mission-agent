import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore } from '../db/index.js';
import { pathsFor } from '../paths.js';
import type { QueryFn } from '../run/index.js';
import { fakeQuery, initMsg, resultMsg } from '../run/test-helpers.js';
import { createMemorySecretStore, MODEL_API_KEY, TELEGRAM_BOT_TOKEN } from '../secrets/index.js';
import { readServerFile } from '../server/index.js';
import { collectEvents, waitFor, type EventCollector } from '../server/test-helpers.js';
import { SYS_GENERAL, SYS_MISSION_ADMIN, type SecretStore } from '../types.js';
import { createHarness, HarnessAlreadyRunningError, type Harness, type HarnessOptions } from './harness.js';
import { STATE_KEYS } from './state.js';
import { fakeSurface, scriptedQuery, simpleAnswers, TELEGRAM, type FakeSurface } from './test-helpers.js';

let tmp: string;
let root: string;
let logs: string[];
let started: Harness[];
let streams: EventCollector[];
let telegram: FakeSurface;

const BOT_TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mission-agent-harness-'));
  root = join(tmp, 'root');
  mkdirSync(root);
  logs = [];
  started = [];
  streams = [];
  telegram = fakeSurface(TELEGRAM, true);
});

afterEach(async () => {
  for (const s of streams) s.close();
  for (const h of started) await h.stop();
  rmSync(tmp, { recursive: true, force: true });
});

function agentYaml(extra = ''): void {
  writeFileSync(join(root, 'agent.yaml'), `agent_name: Ada\nmodel_login: subscription\n${extra}`);
}

function make(
  options: { secrets?: SecretStore; handler?: Parameters<typeof scriptedQuery>[0]; extra?: Partial<HarnessOptions> } = {},
): Harness {
  const { queryFn } = scriptedQuery(options.handler ?? simpleAnswers());
  const h = createHarness({
    ...options.extra,
    root,
    secretStore: options.secrets ?? createMemorySecretStore(),
    queryFn,
    log: (t) => logs.push(t),
    stopWaitMs: 2000,
    configDebounceMs: 50,
    createTelegramSurface: () => telegram,
  });
  started.push(h);
  return h;
}

function server(h: Harness) {
  const info = readServerFile(h.paths);
  if (info === undefined) throw new Error('no server file');
  return { base: `http://127.0.0.1:${info.port}`, token: info.token };
}

async function chatStream(h: Harness): Promise<EventCollector> {
  const { base, token } = server(h);
  const c = await collectEvents(`${base}/api/chat/stream`, token);
  streams.push(c);
  return c;
}

async function post(h: Harness, path: string, body: unknown): Promise<Response> {
  const { base, token } = server(h);
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const textsOf = (c: EventCollector) => c.events.map((e) => (e.data as { text?: string }).text ?? '');

describe('start and stop', () => {
  it('creates the folder layout, starts paused without agent.yaml, serves /api/ping and removes state/server on stop', async () => {
    const h = make();
    await h.start();
    const paths = pathsFor(root);
    expect(existsSync(paths.manifestFile(SYS_GENERAL))).toBe(true);
    expect(existsSync(paths.memoryDir(SYS_MISSION_ADMIN))).toBe(true);
    expect(existsSync(paths.coreMemoryFile)).toBe(true);
    expect(existsSync(paths.dbFile)).toBe(true);

    const st = h.status();
    expect(st.paused).toBe(true);
    expect(st.pause.blocker?.kind).toBe('config');
    expect(st.pauseReason).toContain('agent.yaml does not exist');

    const { base, token } = server(h);
    const ping = await fetch(`${base}/api/ping`, { headers: { authorization: `Bearer ${token}` } });
    expect(ping.status).toBe(200);

    await h.stop();
    expect(existsSync(paths.serverFile)).toBe(false);
  });

  it('starts unpaused with agent.yaml and answers a chat message through the terminal routes', async () => {
    agentYaml();
    const h = make();
    await h.start();
    expect(h.status().paused).toBe(false);
    const stream = await chatStream(h);
    const res = await post(h, '/api/chat/message', { text: 'hello' });
    expect(res.status).toBe(202);
    await waitFor(() => stream.events.some((e) => e.event === 'message'), 'the answer');
    const msg = stream.events.find((e) => e.event === 'message')?.data as { label: string; text: string };
    expect(msg.label).toBe('Ada · sys-general');
    expect(msg.text).toBe('echo: hello');
    await h.settle();
    expect(h.store.listRuns({ missionId: SYS_GENERAL })[0]?.status).toBe('success');
  });

  it('refuses to start while another harness runs for the same root', async () => {
    agentYaml();
    const first = make();
    await first.start();
    const second = make();
    await expect(second.start()).rejects.toBeInstanceOf(HarnessAlreadyRunningError);
    // The server file of the first harness is untouched.
    expect(readServerFile(first.paths)?.pid).toBe(process.pid);
    const ping = await fetch(`${server(first).base}/api/ping`, { headers: { authorization: `Bearer ${server(first).token}` } });
    expect(ping.status).toBe(200);
  });
});

describe('the rules of a start (§G, §H)', () => {
  function seed(fn: (store: ReturnType<typeof openStore>) => void): void {
    const paths = pathsFor(root);
    const store = openStore(paths.dbFile);
    fn(store);
    store.close();
  }

  it('cancels the approvals left by the last run and tells the user and the mission', async () => {
    agentYaml();
    seed((store) =>
      store.saveApproval({
        id: 'apr_old',
        missionId: SYS_GENERAL,
        action: 'action:email.send',
        toolName: 'mcp__x__y',
        input: {},
        createdAt: '2026-11-25T08:00:00.000Z',
        expiresAt: '2026-11-26T08:00:00.000Z',
      }),
    );
    const h = make();
    await h.start();
    expect(h.store.listApprovals()).toEqual([]);
    expect(h.store.takeNotices(SYS_GENERAL).join(' ')).toContain('was cancelled because the harness restarted');
    const stream = await chatStream(h);
    await waitFor(() => textsOf(stream).some((t) => t.includes('approval request')), 'the notice');
    expect(textsOf(stream).find((t) => t.includes('approval request'))).toContain('sys-general: action:email.send');
  });

  it('records a run that was in progress when the harness stopped as failed, and tells the user', async () => {
    agentYaml();
    seed((store) =>
      store.setState(
        STATE_KEYS.runsInProgress,
        JSON.stringify({ [SYS_GENERAL]: { missionId: SYS_GENERAL, manifestVersion: 1, startedAt: '2026-11-25T08:00:00.000Z', input: 'do it' } }),
      ),
    );
    const h = make();
    await h.start();
    const row = h.store.listRuns({ missionId: SYS_GENERAL })[0];
    expect(row?.status).toBe('failed');
    expect(row?.input).toBe('do it');
    expect(row?.error).toContain('not continued and not repeated');
    const stream = await chatStream(h);
    await waitFor(() => textsOf(stream).some((t) => t.includes('in progress when the harness stopped')), 'the notice');
  });

  it('starts paused after the third start within ten minutes that follows a crash', async () => {
    agentYaml();
    const recent = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    seed((store) => {
      store.setState(STATE_KEYS.running, recent(1));
      store.setState(STATE_KEYS.crashStarts, JSON.stringify([recent(5), recent(2)]));
    });
    const h = make();
    await h.start();
    expect(h.status().pause.hold?.kind).toBe('crash');
    expect(h.status().pauseReason).toContain('three times within ten minutes');
  });

  it('does not count a clean stop as a crash', async () => {
    agentYaml();
    for (let i = 0; i < 3; i++) {
      const h = make();
      await h.start();
      expect(h.status().paused).toBe(false);
      await h.stop();
    }
  });

  it('keeps the user pause after a restart', async () => {
    agentYaml();
    const first = make();
    await first.start();
    await first.dispatcher.incoming({ surface: 'surface:terminal', text: '/pause' });
    await first.stop();
    const second = make();
    await second.start();
    expect(second.status().paused).toBe(true);
    expect(second.status().pauseReason).toBe('The user sent /pause.');
  });
});

describe('credentials (§A.5)', () => {
  it('starts paused when the model key is missing, and names it', async () => {
    writeFileSync(join(root, 'agent.yaml'), 'agent_name: Ada\nmodel_login: api_key\n');
    const h = make();
    await h.start();
    expect(h.status().pause.blocker?.kind).toBe('login');
    const stream = await chatStream(h);
    await waitFor(() => textsOf(stream).some((t) => t.includes(`${MODEL_API_KEY} has no value`)), 'the credential message');
    expect(textsOf(stream).find((t) => t.includes('has no value'))).toContain(`mission-agent secret set ${MODEL_API_KEY}`);
  });

  it('shows a missing bot token in the terminal only, and starts Telegram once the token is set', async () => {
    agentYaml('telegram_user_id: 4242\ndefault_surface: terminal\n');
    const secrets = createMemorySecretStore();
    const h = make({ secrets });
    await h.start();
    expect(h.telegram.running()).toBe(false);
    expect(logs.some((l) => l.includes(`${TELEGRAM_BOT_TOKEN} has no value`))).toBe(true);
    const stream = await chatStream(h);
    await waitFor(() => textsOf(stream).some((t) => t.includes(`${TELEGRAM_BOT_TOKEN} has no value`)), 'the terminal notice');

    await secrets.set(TELEGRAM_BOT_TOKEN, BOT_TOKEN);
    const res = await post(h, '/api/secrets/refresh', { id: TELEGRAM_BOT_TOKEN });
    expect(res.status).toBe(200);
    expect(h.telegram.running()).toBe(true);
    // Each mission gets its thread when Telegram starts.
    expect(telegram.threads.filter((t) => t.op === 'create').map((t) => t.missionId).sort()).toEqual([SYS_GENERAL, SYS_MISSION_ADMIN].sort());
  });

  it('starts paused when Telegram is the default surface and the bot token is missing', async () => {
    agentYaml('telegram_user_id: 4242\ndefault_surface: telegram\n');
    const h = make();
    await h.start();
    expect(h.status().pause.blocker?.kind).toBe('credential');
    expect(h.status().pauseReason).toContain(TELEGRAM_BOT_TOKEN);
  });
});

describe('mission changes (§A.4, §4.2.1, §F.1)', () => {
  it('creates, renames and deletes the thread, and cleans up a deleted mission', async () => {
    agentYaml('telegram_user_id: 4242\ndefault_surface: terminal\n');
    const h = make({ secrets: createMemorySecretStore({ [TELEGRAM_BOT_TOKEN]: BOT_TOKEN }) });
    await h.start();
    expect(h.telegram.running()).toBe(true);
    telegram.threads.length = 0;

    const m = h.registry.create({
      name: 'news',
      description: 'Curates the news',
      triggers: [{ use: 'trigger:chat' }],
      tools: [],
      context: { instructions: 'Curate.' },
      signals: [],
      gates: [],
    });
    await h.settle();
    expect(telegram.threads).toEqual([{ op: 'create', missionId: m.id, label: 'Ada · news' }]);

    const answer = h.approvals.request({ missionId: m.id, action: 'action:email.send', toolName: 'mcp__x__y', input: {} });
    h.registry.setStatus(m.id, 'frozen');
    await h.settle();
    expect(await answer).toEqual({ kind: 'cancelled', reason: 'the mission was frozen' });
    expect(telegram.threads.at(-1)).toEqual({ op: 'rename', missionId: m.id, label: 'Ada · news (frozen)' });

    h.registry.setStatus(m.id, 'active');
    await h.settle();
    expect(telegram.threads.at(-1)).toEqual({ op: 'rename', missionId: m.id, label: 'Ada · news' });

    h.store.setSession(m.id, 'sess-x');
    h.store.setState(`run.session_totals:${m.id}`, '{}');
    h.store.setState(STATE_KEYS.currentChatMission, m.id);
    h.registry.remove(m.id);
    await h.settle();
    expect(telegram.threads.at(-1)).toEqual({ op: 'delete', missionId: m.id });
    expect(h.store.getSession(m.id)).toBeUndefined();
    expect(h.store.getThread(m.id)).toBeUndefined();
    expect(h.store.getState(`run.session_totals:${m.id}`)).toBeUndefined();
    expect(h.store.getState(STATE_KEYS.currentChatMission)).toBeUndefined();
  });

  it('runs a timer event and keeps its final text in the logbook only', async () => {
    agentYaml();
    const h = make();
    await h.start();
    const m = h.registry.create({
      name: 'daily',
      description: 'A daily job',
      triggers: [{ use: 'trigger:cron', at: '0 7 * * *' }],
      tools: [],
      context: { instructions: 'Do the job.' },
      signals: [],
      gates: [],
    });
    const stream = await chatStream(h);
    await h.settle();
    h.handleEvent(m.id, { triggerId: 'trigger:cron', key: 'k1', time: new Date().toISOString(), summary: 'The timer fired.', data: {} });
    await h.settle();
    const row = h.store.listRuns({ missionId: m.id })[0];
    expect(row?.status).toBe('success');
    expect(row?.finalText).toContain('echo:');
    expect(stream.events.filter((e) => e.event === 'message')).toEqual([]);
  });
});

describe('agent.yaml (§H, §5.1)', () => {
  it('ends the pause when a valid agent.yaml appears while the harness runs', async () => {
    const h = make();
    await h.start();
    expect(h.status().paused).toBe(true);
    agentYaml();
    await waitFor(() => !h.status().paused, 'the end of the pause', 5000);
    expect(h.status().agentName).toBe('Ada');
  });
});

describe('approvals hold no secret value (§A.5, §G)', () => {
  it('redacts the shown text, the stored row and the pending list, and the approved call keeps the original input', async () => {
    writeFileSync(join(root, 'agent.yaml'), 'agent_name: Ada\nmodel_login: api_key\ndefault_surface: terminal\n');
    const KEY = 'sk-ant-api03-review-secret-value-1234567890';
    const command = `curl -H "x-api-key: ${KEY}" https://api.example.com/v1/x`;
    const plain = scriptedQuery(simpleAnswers(), { apiKeySource: 'ANTHROPIC_API_KEY' } as never);
    let permission: PermissionResult | undefined;
    const run = fakeQuery([
      async function* (ctx) {
        yield initMsg('s1');
        permission = (await ctx.useTool('Bash', { command }, 'toolu_secret')).permission;
        yield resultMsg({ result: 'ok', sessionId: 's1' });
      },
    ]);
    const queryFn: QueryFn = (p) => (Array.isArray(p.options.tools) && p.options.tools.length === 0 ? plain.queryFn(p) : run.queryFn(p));
    const h = createHarness({ root, secretStore: createMemorySecretStore({ [MODEL_API_KEY]: KEY }), queryFn, log: (t) => logs.push(t), stopWaitMs: 2000 });
    started.push(h);
    await h.start();
    const m = h.registry.create({
      name: 'shell-user',
      description: 'Uses the shell',
      triggers: [{ use: 'trigger:chat' }],
      tools: ['tool:shell'],
      context: { instructions: 'Test.' },
      signals: [],
      gates: [],
    });
    await h.settle();
    const stream = await chatStream(h);
    await post(h, '/api/chat/message', { text: `/mission ${m.name}` });
    await waitFor(() => textsOf(stream).some((t) => t.includes('current mission is now')), 'the switch');
    await post(h, '/api/chat/message', { text: 'call the api' });
    await waitFor(() => stream.events.some((e) => e.event === 'approval'), 'the approval request');

    const approval = stream.events.find((e) => e.event === 'approval')?.data as { id: string; text: string };
    expect(approval.text).toContain(`[${MODEL_API_KEY}]`);
    expect(JSON.stringify(stream.events)).not.toContain(KEY);
    expect(JSON.stringify(h.store.listApprovals())).not.toContain(KEY);
    expect(h.store.listApprovals()).toHaveLength(1);
    expect(JSON.stringify(h.approvals.pending())).not.toContain(KEY);
    expect(h.approvals.pending()[0]?.input.command).toBe(`curl -H "x-api-key: [${MODEL_API_KEY}]" https://api.example.com/v1/x`);

    const res = await post(h, `/api/chat/approvals/${approval.id}`, { decision: 'approve' });
    expect(res.status).toBe(200);
    await waitFor(() => permission !== undefined, 'the answer');
    expect(permission).toEqual({ behavior: 'allow', updatedInput: { command } });
    await h.settle();
  });
});

describe('an invalid manifest stops only its own mission (§A.4, §H)', () => {
  it('starts and runs the other missions when one manifest has too many YAML aliases', async () => {
    agentYaml();
    const id = 'm_aaaaaaaaaaaa';
    mkdirSync(join(root, 'missions', id), { recursive: true });
    writeFileSync(join(root, 'missions', id, 'manifest.yaml'), `id: ${id}\nx: &a hi\ny: [${Array.from({ length: 150 }, () => '*a').join(', ')}]\n`);
    const h = make();
    await h.start();
    expect(h.status().paused).toBe(false);
    expect(h.registry.get(SYS_GENERAL)).toBeDefined();
    expect(h.registry.errors().map((e) => e.message)).toContain(
      'The file could not be read as a manifest: Excessive alias count indicates a resource exhaustion attack',
    );
  });
});

describe('the check for a newer release (chapter 7.4)', () => {
  let now: Date;
  let checks: number;
  let answer: Awaited<ReturnType<NonNullable<HarnessOptions['releaseCheck']>>>;

  beforeEach(() => {
    now = new Date('2026-11-25T10:00:00.000Z');
    checks = 0;
    answer = { ok: true, current: '0.1.0', latest: '0.2.0', newer: true };
  });

  const withCheck = () =>
    make({
      extra: {
        now: () => now,
        releaseCheckPollMs: 20,
        releaseCheck: async () => {
          checks += 1;
          return answer;
        },
      },
    });

  it('tells the user once about a newer release, with the command that installs it, and looks once a day', async () => {
    agentYaml();
    const h = withCheck();
    await h.start();
    const stream = await chatStream(h);
    await waitFor(() => textsOf(stream).some((t) => t.includes('is available')), 'the notice');
    const notice = textsOf(stream).find((t) => t.includes('is available'));
    expect(notice).toBe(
      'Version 0.2.0 of the harness is available. This agent runs version 0.1.0. ' +
        `To install it, open the dashboard and press Install, or run in a terminal: mission-agent update --root ${root}`,
    );
    expect(h.store.getState(STATE_KEYS.releaseNoticed)).toBe('0.2.0');

    // Within a day the timer looks at the clock and does not ask again.
    await new Promise((r) => setTimeout(r, 120));
    expect(checks).toBe(1);

    // A day later it asks again, and says nothing about a release it already named.
    now = new Date('2026-11-26T10:00:01.000Z');
    await waitFor(() => checks === 2, 'the second check');
    await new Promise((r) => setTimeout(r, 60));
    expect(textsOf(stream).filter((t) => t.includes('is available'))).toHaveLength(1);

    // A newer one is named.
    answer = { ok: true, current: '0.1.0', latest: '0.3.0', newer: true };
    now = new Date('2026-11-27T10:00:02.000Z');
    await waitFor(() => textsOf(stream).some((t) => t.includes('Version 0.3.0')), 'the second notice');
  });

  it('says nothing when the installed release is the newest, and after a restart within a day it does not ask again', async () => {
    agentYaml();
    answer = { ok: true, current: '0.2.0', latest: '0.2.0', newer: false };
    const h = withCheck();
    await h.start();
    await waitFor(() => checks === 1, 'the check');
    expect(h.store.getState(STATE_KEYS.releaseNoticed)).toBeUndefined();
    await h.stop();

    const again = withCheck();
    await again.start();
    await new Promise((r) => setTimeout(r, 80));
    expect(checks).toBe(1);
  });

  it('logs once why a check got no answer, and tries again at the next look', async () => {
    agentYaml();
    answer = { ok: false, reason: 'git could not read the releases: offline' };
    const h = withCheck();
    await h.start();
    await waitFor(() => checks >= 3, 'three checks');
    expect(logs.filter((l) => l.includes('got no answer'))).toEqual([
      'The check for a newer release got no answer: git could not read the releases: offline',
    ]);
    expect(h.store.getState(STATE_KEYS.releaseCheckedAt)).toBeUndefined();
  });

  it('never looks when no check is given, and reports the version of the program', async () => {
    agentYaml();
    const h = make();
    await h.start();
    expect(h.status().version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(h.store.getState(STATE_KEYS.releaseCheckedAt)).toBeUndefined();
  });
});
