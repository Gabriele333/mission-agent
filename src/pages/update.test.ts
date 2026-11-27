import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeServerFile } from '../server/index.js';
import type { ReleaseCheck } from '../update/index.js';
import { COMMON_JS } from './assets/common.js';
import { DASHBOARD_JS } from './assets/dashboard.js';
import { pagesRig, runPageScript, type PagesRig } from './test-helpers.js';
import type { UpdateRoutesOptions } from './update-routes.js';

/** The Version part of the dashboard and its two buttons (chapter 6, 7.5). */

let rig: PagesRig | undefined;
afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

/** A newer release than the program that runs, whatever its version. */
const newer: () => Promise<ReleaseCheck> = async () => ({ ok: true, current: '0.0.1', latest: '99.0.0', newer: true, notes: 'The notes of 99.0.0.' });

interface Spawned {
  node: string;
  args: string[];
  log: string;
  cwd: string;
}

/** A rig whose program is an installed release, in `<tmp>/home/app`, run as the service. */
async function installedRig(options: { dirty?: boolean; spawn?: (s: Spawned) => number | undefined } = {}): Promise<{ r: PagesRig; spawned: Spawned[]; home: string }> {
  const spawned: Spawned[] = [];
  let home = '';
  const update = {} as UpdateRoutesOptions;
  const r = await pagesRig({
    agentYaml: 'agent_name: Ada\n',
    releaseCheck: newer,
    update,
    before: (root) => {
      home = join(root, '..', 'home');
      const app = join(home, 'app');
      mkdirSync(join(app, '.git'), { recursive: true });
      mkdirSync(join(app, 'dist', 'maintenance'), { recursive: true });
      writeFileSync(join(app, 'package.json'), JSON.stringify({ version: '0.0.1' }));
      writeFileSync(join(app, 'dist', 'maintenance', 'main.js'), '');
      Object.assign(update, {
        programDir: app,
        home,
        nodePath: '/fake/node',
        serverWaitMs: 1500,
        run: async (_program: string, args: string[]) => {
          if (args[0] === 'status') return { code: 0, stdout: options.dirty === true ? ' M src/cli.ts\n' : '', stderr: '' };
          if (args[0] === 'describe') return { code: 0, stdout: 'v0.0.1\n', stderr: '' };
          return { code: 1, stdout: '', stderr: 'unexpected' };
        },
        spawnMaintenance: (node: string, args: string[], log: string, cwd: string) => {
          const s = { node, args, log, cwd };
          spawned.push(s);
          return { pid: options.spawn ? options.spawn(s) : 4321 };
        },
      } satisfies UpdateRoutesOptions);
    },
  });
  // The harness runs as the service: launchctl names this process.
  r.printAnswer = { code: 0, stdout: `\tpid = ${process.pid}\n\tstate = running\n`, stderr: '' };
  mkdirSync(r.launchAgentsDir, { recursive: true });
  return { r, spawned, home };
}

describe('the Version part of the dashboard', () => {
  it('shows the installed version, and refuses the button for a development copy', async () => {
    rig = await pagesRig({ agentYaml: 'agent_name: Ada\n' });
    const res = await rig.get('/api/dashboard/version');
    const d = await rig.json<{ installed: string; refusal: string; command: string; newer: boolean }>(res);
    expect(d.installed).toMatch(/^\d+\.\d+\.\d+$/);
    expect(d.newer).toBe(false);
    expect(d.refusal).toContain('is a development copy');
    expect(d.command).toBe(`mission-agent update --root ${rig.root}`);
    const start = await rig.post('/api/update/start', { version: '99.0.0' });
    expect(start.status).toBe(409);
    expect((await rig.json<{ error: string }>(start)).error).toContain('is a development copy');
  });

  it('checks now, stores the time, and shows the notes of a newer release', async () => {
    const { r } = await installedRig();
    rig = r;
    const res = await r.post('/api/update/check', {});
    expect(res.status).toBe(200);
    const d = await r.json<{ latest: string; newer: boolean; notes: string; checkedAt: string }>(res);
    expect(d).toMatchObject({ latest: '99.0.0', newer: true, notes: 'The notes of 99.0.0.' });
    expect(Date.parse(d.checkedAt)).toBeGreaterThan(0);
    const v = await r.json<{ latest: string; checkedAt: string; refusal: string | null }>(await r.get('/api/dashboard/version'));
    expect(v.latest).toBe('99.0.0');
    expect(v.checkedAt).toBe(d.checkedAt);
    expect(v.refusal).toBeNull();
  });

  it('starts the maintenance program detached, with the fixed options, and returns the URL of its page', async () => {
    const { r, spawned, home } = await installedRig({
      spawn: () => {
        // The maintenance program writes where its page answers.
        writeServerFile({ stateDir: home, serverFile: join(home, 'maintenance.server') }, { port: 4999, token: 'progress-token', pid: 4321, startedAt: new Date().toISOString() });
        return 4321;
      },
    });
    rig = r;
    await r.post('/api/update/check', {});
    const res = await r.post('/api/update/start', { version: '99.0.0' });
    const d = await r.json<{ ok: boolean; url: string; error?: string }>(res);
    expect(res.status, d.error).toBe(200);
    expect(d.url).toBe('http://127.0.0.1:4999/?token=progress-token');
    expect(spawned).toEqual([
      {
        node: '/fake/node',
        args: [join(home, 'maintenance', 'dist', 'maintenance', 'main.js'), '--home', home, 'update', '--root', r.root, '--yes', '--version', 'v99.0.0', '--serve'],
        log: join(home, 'maintenance.log'),
        cwd: home,
      },
    ]);
  });

  it('refuses a version that is not the newest found, a body without a version, other services, a dirty program and a harness in a terminal', async () => {
    const { r, spawned } = await installedRig();
    rig = r;
    await r.post('/api/update/check', {});
    expect((await r.post('/api/update/start', { version: '98.0.0' })).status).toBe(409);
    expect((await r.post('/api/update/start', { version: 'v99.0.0; rm -rf /' })).status).toBe(400);
    expect((await r.post('/api/update/start', {})).status).toBe(400);

    writeFileSync(join(r.launchAgentsDir, 'local.mission-agent.other.plist'), `<string>${join(r.tmp, 'dist', 'cli.js')}</string>`);
    const other = await r.post('/api/update/start', { version: '99.0.0' });
    const otherError = (await r.json<{ error: string }>(other)).error;
    expect(other.status, otherError).toBe(409);
    expect(otherError).toContain('Other agents run this same program as a service');
    rmSync(join(r.launchAgentsDir, 'local.mission-agent.other.plist'));

    r.printAnswer = { code: 113, stdout: '', stderr: 'Could not find service' };
    const terminal = await r.post('/api/update/start', { version: '99.0.0' });
    expect(terminal.status).toBe(409);
    expect((await r.json<{ error: string }>(terminal)).error).toContain('runs in a terminal, not as the service');
    expect(spawned).toEqual([]);
  });

  it('refuses a program folder with changes', async () => {
    const { r } = await installedRig({ dirty: true });
    rig = r;
    await r.post('/api/update/check', {});
    const res = await r.post('/api/update/start', { version: '99.0.0' });
    expect(res.status).toBe(409);
    expect((await r.json<{ error: string }>(res)).error).toContain('holds changes that are in no release');
  });

  it('says so when the page of the maintenance program does not answer', async () => {
    const { r } = await installedRig({ spawn: () => 4321 });
    rig = r;
    await r.post('/api/update/check', {});
    const res = await r.post('/api/update/start', { version: '99.0.0' });
    expect(res.status).toBe(500);
    expect((await r.json<{ error: string }>(res)).error).toContain('but its page does not answer');
  });

  it('needs the page token, like every page route, and refuses another origin', async () => {
    const { r } = await installedRig();
    rig = r;
    for (const path of ['/api/update/check', '/api/update/start']) {
      const none = await fetch(`${r.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(none.status, path).toBe(401);
      const cross = await fetch(`${r.base}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${r.token}`, 'content-type': 'application/json', origin: 'http://evil.example' },
        body: '{}',
      });
      expect(cross.status, path).toBe(403);
    }
    expect((await r.get('/api/update/start')).status).toBe(405);
  });

  it('renders on the dashboard with its buttons, and goes to the progress page after Install', async () => {
    const { r, home } = await installedRig({
      spawn: () => {
        writeServerFile({ stateDir: home, serverFile: join(home, 'maintenance.server') }, { port: 4999, token: 'progress-token', pid: 4321, startedAt: new Date().toISOString() });
        return 4321;
      },
    });
    rig = r;
    const went: string[] = [];
    const page = await runPageScript(r, [COMMON_JS, DASHBOARD_JS], { location: { assign: (u: string) => went.push(u), href: '' } });
    await page.waitForText('Check for updates');
    await page.button('Check for updates').fire('click');
    await page.waitForText('Version 99.0.0 is available.');
    await page.waitForText('The notes of 99.0.0.');
    expect(page.text()).toContain(`The same in a terminal: mission-agent update --root ${r.root}`);
    await page.button('Install version 99.0.0').fire('click');
    for (let i = 0; i < 100 && went.length === 0; i++) await new Promise((x) => setTimeout(x, 20));
    expect(went).toEqual(['http://127.0.0.1:4999/?token=progress-token']);
  });
});
