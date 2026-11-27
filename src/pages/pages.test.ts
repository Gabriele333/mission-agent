import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, Script } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore } from '../db/index.js';
import { STATE_KEYS } from '../harness/index.js';
import { pathsFor } from '../paths.js';
import { SYS_GENERAL, type RunRow } from '../types.js';
import { COMMON_JS } from './assets/common.js';
import { DASHBOARD_JS } from './assets/dashboard.js';
import { DASHBOARD_HTML, PROGRESS_HTML, SETUP_HTML } from './assets/html.js';
import { PROGRESS_JS } from './assets/progress.js';
import { SETUP_JS } from './assets/setup.js';
import { STYLE_CSS } from './assets/style.js';
import { PAGE_CSP } from './index.js';
import { pagesRig, type PagesRig, type RigOptions } from './test-helpers.js';

let rigs: PagesRig[] = [];
afterEach(async () => {
  for (const r of rigs) await r.stop();
  rigs = [];
});

async function rig(options: RigOptions = { agentYaml: 'agent_name: Ada\nmodel_login: subscription\n' }): Promise<PagesRig> {
  const r = await pagesRig(options);
  rigs.push(r);
  return r;
}

const HOSTILE = `<img src=x onerror=alert(1)></script><script>alert("x")</script> 'single' "double" & done`;

describe('the rules of both pages (§J.3)', () => {
  it('answers 401 without the token for every route the pages add', async () => {
    const r = await rig();
    expect(r.pages.routes.length).toBeGreaterThan(20);
    for (const route of r.pages.routes) {
      const res = await fetch(`${r.base}${route.path}`, {
        method: route.method,
        ...(route.method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
      });
      expect(res.status, `${route.method} ${route.path}`).toBe(401);
      // A wrong token is refused too.
      const wrong = await fetch(`${r.base}${route.path}`, { method: route.method, headers: { authorization: 'Bearer nope' } });
      expect(wrong.status, `${route.method} ${route.path} with a wrong token`).toBe(401);
    }
  });

  it('opens a page through the token in the address, which sets the cookie, then serves it with the cookie', async () => {
    const r = await rig();
    for (const path of ['/setup', '/dashboard']) {
      const first = await fetch(`${r.base}${path}?token=${encodeURIComponent(r.token)}`, { redirect: 'manual' });
      expect(first.status).toBe(303);
      expect(first.headers.get('location')).toBe(path);
      const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const page = await fetch(`${r.base}${path}`, { headers: { cookie } });
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(page.headers.get('content-security-policy')).toBe(PAGE_CSP);
    }
  });

  it('sends the strict policy with every page file, and the pages hold no inline script, style or handler', async () => {
    const r = await rig();
    const files = r.pages.routes.filter((x) => x.page === 'file');
    expect(files.map((f) => f.path).sort()).toEqual(
      ['/dashboard', '/pages/common.js', '/pages/dashboard.js', '/pages/setup.js', '/pages/style.css', '/setup'].sort(),
    );
    for (const f of files) {
      const res = await r.get(f.path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-security-policy')).toBe(PAGE_CSP);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      const body = await res.text();
      if (f.path.endsWith('.js')) expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
      if (f.path.endsWith('.css')) expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
      // Nothing is loaded from outside: no address with a scheme.
      expect(body).not.toMatch(/(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i);
      expect(body).not.toMatch(/@import|url\(/i);
    }
    expect(PAGE_CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    for (const html of [SETUP_HTML, DASHBOARD_HTML, PROGRESS_HTML]) {
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
      expect(scripts.length).toBe(2);
      for (const s of scripts) {
        expect(s[1]).toMatch(/\bsrc="\/pages\/[a-z]+\.js"/);
        expect(s[2]).toBe('');
      }
      expect(html).not.toMatch(/<style\b/i);
      expect(html).not.toMatch(/\sstyle\s*=/i);
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    }
  });

  it('builds the DOM without HTML parsing or code from text in its own scripts', () => {
    for (const [name, code] of [
      ['common.js', COMMON_JS],
      ['setup.js', SETUP_JS],
      ['dashboard.js', DASHBOARD_JS],
      ['progress.js', PROGRESS_JS],
    ] as const) {
      // A backtick would start a template text in the TypeScript file that holds the script.
      expect(code.includes('`'), `${name} holds a backtick`).toBe(false);
      for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval', 'new Function', 'setAttribute(\'on', 'javascript:']) {
        expect(code.includes(banned), `${name} uses ${banned}`).toBe(false);
      }
      // setTimeout and setInterval take functions only, never a text to run.
      expect(code).not.toMatch(/set(Timeout|Interval)\(\s*['"]/);
      // The scripts are valid JavaScript.
      expect(() => new Script(code, { filename: name })).not.toThrow();
    }
    expect(STYLE_CSS).toContain('prefers-color-scheme: dark');
  });

  it('allows a link to a Telegram chat as the only outside link, opened in a new tab', () => {
    const attrs = (node: { a: Record<string, string> }) => node.a;
    const document = {
      createElement: () => ({ a: {} as Record<string, string>, setAttribute(this: { a: Record<string, string> }, k: string, v: string) { this.a[k] = v; }, appendChild() {} }),
      createTextNode: (t: string) => t,
    };
    const ctx: Record<string, unknown> = { document, navigator: {} };
    ctx.window = ctx;
    createContext(ctx);
    new Script(COMMON_JS).runInContext(ctx);
    const el = (ctx.MA as { el: (tag: string, props: Record<string, unknown>) => { a: Record<string, string> } }).el;
    expect(attrs(el('a', { href: '/setup' }))).toEqual({ href: '/setup' });
    expect(attrs(el('a', { href: 'https://t.me/ada_bot?start=123456' }))).toEqual({ href: 'https://t.me/ada_bot?start=123456', target: '_blank', rel: 'noopener noreferrer' });
    expect(attrs(el('a', { href: 'https://t.me/BotFather' }))).toMatchObject({ target: '_blank' });
    for (const bad of [
      'https://example.com/',
      'http://t.me/ada_bot',
      'https://t.me/ada_bot?start=12345',
      'https://t.me/ada_bot?start=123456&x=1',
      'https://t.me.example.com/ada_bot',
      'https://t.me/ada',
      'https://t.me/ada_bot/../x',
      'javascript:alert(1)',
      'http://127.0.0.1:4999/other',
      'http://127.0.0.1:4999/dashboard?token=a&x=1',
      'http://localhost:4999/dashboard',
      'http://127.0.0.1.example.com:4999/dashboard',
    ]) {
      expect(() => el('a', { href: bad }), bad).toThrow('an outside link is not allowed');
    }
    // The progress page of an update links to the dashboard of the new harness, on this computer, in the same tab.
    expect(attrs(el('a', { href: 'http://127.0.0.1:4999/dashboard?token=abc_DEF-1' }))).toEqual({ href: 'http://127.0.0.1:4999/dashboard?token=abc_DEF-1', rel: 'noreferrer' });
  });

  it('has exactly two routes that change something from the dashboard: the buttons of the Version part', async () => {
    const r = await rig();
    expect(r.pages.routes.filter((x) => x.page === 'update').map((x) => `${x.method} ${x.path}`)).toEqual(['POST /api/update/check', 'POST /api/update/start']);
  });

  it('refuses a POST to every dashboard route: the dashboard only reads', async () => {
    const r = await rig();
    const dashboard = r.pages.routes.filter((x) => x.page === 'dashboard');
    expect(dashboard.length).toBe(8);
    for (const route of dashboard) {
      expect(route.method).toBe('GET');
      const res = await r.post(route.path, {});
      expect(res.status, route.path).toBe(405);
      expect(res.headers.get('allow')).toBe('GET');
    }
  });

  it('accepts a changing setup route as POST with JSON only, and refuses another origin', async () => {
    const r = await rig();
    const res = await fetch(`${r.base}/api/setup/config`, {
      method: 'POST',
      headers: { authorization: `Bearer ${r.token}`, 'content-type': 'text/plain' },
      body: '{"values":{"agent_name":"Eve"}}',
    });
    expect(res.status).toBe(415);
    const cross = await fetch(`${r.base}/api/setup/config`, {
      method: 'POST',
      headers: { authorization: `Bearer ${r.token}`, 'content-type': 'application/json', origin: 'http://evil.example' },
      body: '{"values":{"agent_name":"Eve"}}',
    });
    expect(cross.status).toBe(403);
    expect(r.harness.config()?.config.agentName).toBe('Ada');
  });
});

// ---------------------------------------------------------------- dashboard data (chapter 6)

const DAILY_ID = 'm_abcdefghjkmn';
const DAILY_MANIFEST = `id: ${DAILY_ID}
name: daily
description: ${JSON.stringify(HOSTILE)}
version: 3
status: active
triggers:
  - use: trigger:cron
    at: "0 7 * * *"
  - use: trigger:chat
tools:
  - tool:web_search
context:
  instructions: Do the job.
signals: []
gates: []
`;

function seedRoot(root: string): void {
  const paths = pathsFor(root);
  mkdirSync(paths.memoryDir(DAILY_ID), { recursive: true });
  writeFileSync(paths.manifestFile(DAILY_ID), DAILY_MANIFEST);
  writeFileSync(paths.memoryIndexFile(DAILY_ID), '- [a](a.md) one\n- [b](b.md) two\n- [c](c.md) three\n');
  for (const n of ['a', 'b', 'c']) writeFileSync(join(paths.memoryDir(DAILY_ID), `${n}.md`), `note ${n}\n`);
  mkdirSync(paths.coreDir, { recursive: true });
  writeFileSync(paths.coreMemoryFile, `The user lives in Rome.\n${'x'.repeat(250)}\n`);
  // The harness last wrote that it was alive two days ago, so the 07:00 timer was missed.
  const store = openStore(paths.dbFile);
  store.setState(STATE_KEYS.lastAliveAt, new Date(Date.now() - 2 * 86_400_000).toISOString());
  store.close();
}

function run(fields: Partial<RunRow>): RunRow {
  const now = new Date().toISOString();
  return {
    missionId: SYS_GENERAL,
    manifestVersion: 1,
    startedAt: now,
    endedAt: now,
    input: 'hello',
    toolsCalled: [],
    inputTokens: 10,
    outputTokens: 20,
    costUsd: 0.01,
    status: 'success',
    finalText: 'done',
    ...fields,
  };
}

async function dashboardRig(): Promise<PagesRig> {
  const r = await rig({ agentYaml: 'agent_name: Ada\nmodel_login: subscription\n', before: seedRoot });
  await r.harness.settle();
  const store = r.harness.store;
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
  store.insertRun(run({ startedAt: tenDaysAgo, endedAt: tenDaysAgo, costUsd: 1 }));
  store.insertRun(run({ missionId: DAILY_ID, manifestVersion: 3, input: HOSTILE, toolsCalled: [HOSTILE, 'WebSearch'], status: 'failed', error: HOSTILE, costUsd: 0.25 }));
  // A deleted mission keeps its logbook rows. Its id is shown in place of a name.
  store.insertRun(run({ missionId: HOSTILE, costUsd: 0.5 }));
  return r;
}

describe('the dashboard routes (chapter 6)', () => {
  it('returns the harness: name, state, start time and the missed timer runs', async () => {
    const r = await dashboardRig();
    const res = await r.get('/api/dashboard/harness');
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const d = await r.json<Record<string, unknown> & { missedTimerRuns: Record<string, unknown>[] }>(res);
    expect(d).toMatchObject({ agentName: 'Ada', running: true, paused: false, pauseReason: '', configError: null, defaultSurface: 'terminal' });
    expect(typeof d.startedAt).toBe('string');
    expect(d.missedTimerRuns).toHaveLength(1);
    expect(d.missedTimerRuns[0]).toMatchObject({ missionId: DAILY_ID, missionName: 'daily', expression: '0 7 * * *' });
    expect(Number(d.missedTimerRuns[0]?.count)).toBeGreaterThanOrEqual(1);
  });

  it('returns the missions with the last run and the next timer run, and hostile text as data', async () => {
    const r = await dashboardRig();
    const d = await r.json<{ missions: Record<string, unknown>[]; invalid: unknown[] }>(await r.get('/api/dashboard/missions'));
    const daily = d.missions.find((m) => m.id === DAILY_ID);
    expect(daily).toMatchObject({ name: 'daily', description: HOSTILE, status: 'active', version: 3, system: false, timers: ['0 7 * * *'] });
    expect(daily?.lastRun).toMatchObject({ status: 'failed', error: HOSTILE });
    const next = new Date(String(daily?.nextTimerRun));
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getHours()).toBe(7);
    const general = d.missions.find((m) => m.id === SYS_GENERAL);
    expect(general).toMatchObject({ system: true, nextTimerRun: null });
    expect(d.invalid).toEqual([]);
  });

  it('returns the runs with input, tools, tokens, cost and outcome, failed runs marked', async () => {
    const r = await dashboardRig();
    const d = await r.json<{ runs: Record<string, unknown>[] }>(await r.get('/api/dashboard/runs'));
    const failed = d.runs.find((x) => x.missionId === DAILY_ID);
    expect(failed).toMatchObject({
      missionName: 'daily',
      manifestVersion: 3,
      input: HOSTILE,
      toolsCalled: [HOSTILE, 'WebSearch'],
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.25,
      status: 'failed',
      failed: true,
      error: HOSTILE,
    });
    expect(d.runs.find((x) => x.missionId === HOSTILE)?.missionName).toBe(HOSTILE);
    const only = await r.json<{ runs: Record<string, unknown>[] }>(await r.get(`/api/dashboard/runs?mission=${DAILY_ID}&limit=5`));
    // The missed timer run ran once at the start, so the mission has two runs.
    expect(only.runs.map((x) => x.missionId)).toEqual([DAILY_ID, DAILY_ID]);
    // The raw JSON escapes nothing into markup: the text is the same string, as data.
    const raw = await (await r.get('/api/dashboard/runs')).text();
    expect(JSON.parse(raw).runs.some((x: { input: string }) => x.input === HOSTILE)).toBe(true);
  });

  it('returns the cost per mission and per period', async () => {
    const r = await dashboardRig();
    const d = await r.json<{
      periods: { key: string }[];
      total: Record<string, number>;
      missions: { id: string; name: string; deleted: boolean; cost: Record<string, number> }[];
    }>(await r.get('/api/dashboard/cost'));
    expect(d.periods.map((p) => p.key)).toEqual(['today', 'week', 'month', 'all']);
    // 0.25 and 0.5 today, 0.001 for the missed timer run at the start, and 1 ten days ago.
    expect(d.total.today).toBeCloseTo(0.751, 6);
    expect(d.total.week).toBeCloseTo(0.751, 6);
    expect(d.total.month).toBeCloseTo(1.751, 6);
    expect(d.total.all).toBeCloseTo(1.751, 6);
    expect(d.missions.find((m) => m.id === SYS_GENERAL)?.cost).toMatchObject({ today: 0, month: 1 });
    expect(d.missions.find((m) => m.id === HOSTILE)).toMatchObject({ name: HOSTILE, deleted: true });
  });

  it('returns the approvals that wait, with the time left', async () => {
    const r = await dashboardRig();
    void r.harness.approvals.request({ missionId: DAILY_ID, action: 'action:email.send', toolName: HOSTILE, input: { to: HOSTILE }, note: HOSTILE });
    const d = await r.json<{ approvals: Record<string, unknown>[] }>(await r.get('/api/dashboard/approvals'));
    expect(d.approvals).toHaveLength(1);
    const a = d.approvals[0];
    expect(a).toMatchObject({ missionName: 'daily', action: 'action:email.send', toolName: HOSTILE, note: HOSTILE, input: JSON.stringify({ to: HOSTILE }) });
    expect(Number(a?.msLeft)).toBeGreaterThan(23 * 3_600_000);
    expect(Number(a?.msLeft)).toBeLessThanOrEqual(24 * 3_600_000);
    r.harness.approvals.cancelAll('test');
  });

  it('returns the memory of each mission and of core against the limits', async () => {
    const r = await dashboardRig();
    const d = await r.json<{
      index: { maxLines: number; maxBytes: number };
      core: Record<string, number>;
      missions: Record<string, unknown>[];
    }>(await r.get('/api/dashboard/memory'));
    expect(d.index).toEqual({ maxLines: 200, maxBytes: 25 * 1024 });
    expect(d.core).toEqual({ lines: 2, maxLines: 50, maxLineChars: 200, longLines: 1 });
    expect(d.missions.find((m) => m.id === DAILY_ID)).toMatchObject({ notes: 3, indexLines: 3 });
    expect(d.missions.find((m) => m.id === SYS_GENERAL)).toMatchObject({ notes: 0, indexLines: 0, indexBytes: 0 });
  });

  it('returns each tool and trigger with the missions that use it and whether its credentials are present', async () => {
    const r = await dashboardRig();
    const d = await r.json<{
      tools: { id: string; missions: { id: string }[]; credentials: unknown[]; reservedFor: string[] | null }[];
      triggers: { id: string; missions: { id: string }[] }[];
    }>(await r.get('/api/dashboard/code'));
    const search = d.tools.find((t) => t.id === 'tool:web_search');
    expect(search?.missions.map((m) => m.id).sort()).toEqual([DAILY_ID, SYS_GENERAL].sort());
    expect(search?.credentials).toEqual([]);
    expect(d.tools.find((t) => t.id === 'tool:mission_registry')?.reservedFor).toEqual(['sys-mission-admin']);
    expect(d.triggers.find((t) => t.id === 'trigger:cron')?.missions.map((m) => m.id)).toEqual([DAILY_ID]);
    expect(d.triggers.map((t) => t.id).sort()).toEqual(['trigger:chat', 'trigger:cron']);
  });

  it('changes nothing in the database when every dashboard route is read', async () => {
    const r = await dashboardRig();
    const before = JSON.stringify([r.harness.store.listRuns({ limit: 500 }), r.harness.store.listApprovals()]);
    for (const route of r.pages.routes.filter((x) => x.page === 'dashboard')) expect((await r.get(route.path)).status).toBe(200);
    expect(JSON.stringify([r.harness.store.listRuns({ limit: 500 }), r.harness.store.listApprovals()])).toBe(before);
  });
});
