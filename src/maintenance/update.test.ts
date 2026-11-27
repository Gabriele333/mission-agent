import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serviceLabel } from '../service/plist.js';
import { folderVersion, readInstallInfo } from './files.js';
import { readJournal } from './journal.js';
import { runRepair } from './repair.js';
import { dropWorld, installed, maint, makeWorld, rootContent, runOrKilled, versionIn, type World } from './test-helpers.js';
import { BACK_STEPS, runUpdate, UPDATE_STEPS } from './update.js';

/**
 * The update and its recovery (chapter 7.4, 7.5). The main requirement: the agent is never left
 * broken. Each hook point of the update is failed in turn, then stopped in turn as a kill would,
 * and every time the same invariant must hold.
 */

let w: World;
let before: Record<string, string>;

beforeEach(() => {
  w = makeWorld();
  installed(w, 'v0.1.0');
  before = rootContent(w);
});
afterEach(() => dropWorld(w));

const output = () => w.lines.join('\n');
const update = (extra: { version?: string; yes?: boolean } = {}) => runUpdate(maint(w), { root: w.root, yes: extra.yes ?? true, ...(extra.version !== undefined ? { version: extra.version } : {}) });

/**
 * The invariant of the update. Afterwards either the new version is installed and its harness
 * answers, or the old version is in `app`, its harness answers again, the root folder holds its
 * old content and the exit code is 1. In both cases no `app.installing` is left.
 */
async function expectAgentInOrder(code: number | 'killed', versions: { old: string; new: string }, options: { service?: boolean } = {}): Promise<'old' | 'new'> {
  const service = options.service !== false;
  const app = await versionIn(w, w.layout.app);
  expect(existsSync(w.layout.installing), 'no app.installing is left').toBe(false);
  if (app === versions.new) {
    if (service) {
      expect(w.harness.get(w.root)?.version, 'the new harness answers').toBe(versions.new);
      expect(w.loaded.has(serviceLabel(w.root))).toBe(true);
    }
    return 'new';
  }
  expect(app, `app/dist/cli.js is the old version. The output was:\n${output()}`).toBe(versions.old);
  if (code !== 'killed') expect(code).toBe(1);
  if (service) {
    expect(w.harness.get(w.root)?.version, 'the old harness answers again').toBe(versions.old);
    expect(w.loaded.has(serviceLabel(w.root)), 'the service was started again').toBe(true);
  }
  expect(rootContent(w), 'the root folder holds its old content').toEqual(before);
  return 'old';
}

describe('the update', () => {
  it('builds and tests the release before it stops the agent, then swaps, starts and finishes', async () => {
    expect(await update()).toBe(0);
    expect(output()).toContain('Version 0.2.0 is available. You have 0.1.0.');
    expect(output()).toContain('  Adds the maintenance program.');
    // The order of chapter 7.4: build and test while the old harness runs, then stop.
    const order = w.commands.filter((c) => /clone|npm ci|npm run build|self-test|service install/.test(c));
    expect(order.map((c) => c.split(' ').slice(0, 3).join(' '))).toEqual([
      // First the installed program is tested: an update of a broken program is refused.
      `/fake/node ${join(w.layout.app, 'dist', 'cli.js')} self-test`,
      'git -c advice.detachedHead=false',
      'npm ci --no-audit',
      'npm run build',
      `/fake/node ${join(w.layout.installing, 'dist', 'cli.js')} self-test`,
      `/fake/node ${join(w.layout.app, 'dist', 'cli.js')} service`,
    ]);
    expect(UPDATE_STEPS.filter((s) => w.hits.includes(s))).toEqual([...UPDATE_STEPS]);
    // Every hook point that the update reaches is in the list, so each one has a row in the tables below.
    expect(w.hits.filter((s) => !(UPDATE_STEPS as readonly string[]).includes(s))).toEqual([]);

    expect(await versionIn(w, w.layout.app)).toBe('0.2.0');
    expect(await versionIn(w, w.layout.previous)).toBe('0.1.0');
    expect(w.harness.get(w.root)?.version).toBe('0.2.0');
    expect(folderVersion(w.layout.maintenance)).toBe('0.2.0');
    expect(readInstallInfo(w.layout)?.version).toBe('0.2.0');
    expect(readJournal(w.layout)).toBeUndefined();
    expect(existsSync(w.layout.lock)).toBe(false);
    const copies = readdirSync(join(w.root, 'backups', 'update'));
    expect(copies).toEqual(['0.1.0-2026-03-04-050607']);
    expect(readFileSync(join(w.root, 'backups', 'update', copies[0] as string, 'state', 'agent.db'), 'utf8')).toBe('the database\n');
    expect(output()).toContain('Version 0.2.0 is installed. The harness runs.');
  });

  it('changes nothing when the installed release is the newest', async () => {
    delete w.releases['v0.2.0'];
    expect(await update()).toBe(0);
    expect(output()).toContain('You have the newest release, 0.1.0. Nothing was changed.');
    expect(w.commands.some((c) => c.includes('clone'))).toBe(false);
  });

  it('refuses, and changes nothing, for a development copy, a harness in a terminal and other services', async () => {
    w.dirty = true;
    expect(await update()).toBe(1);
    expect(output()).toContain('is a development copy');
    w.dirty = false;
    writeFileSync(join(w.layout.app, '.git', 'tag'), 'some-branch');
    expect(await update()).toBe(1);
    expect(output()).toContain('is not at the release v0.1.0, so it is a development copy');
    writeFileSync(join(w.layout.app, '.git', 'tag'), 'v0.1.0');

    w.foreground = { root: w.root, pid: 77 };
    expect(await update()).toBe(1);
    expect(output()).toContain('runs in a terminal (process 77), not as the service');
    delete w.foreground;

    writeFileSync(join(w.launchAgents, 'local.mission-agent.other.plist'), `<string>${join(w.layout.app, 'dist', 'cli.js')}</string>`);
    expect(await update()).toBe(1);
    expect(output()).toContain('Other agents run this same program as a service');
    rmSync(join(w.launchAgents, 'local.mission-agent.other.plist'));

    expect(w.commands.some((c) => c.includes('clone'))).toBe(false);
    expect(await expectAgentInOrder(1, { old: '0.1.0', new: '0.2.0' })).toBe('old');
  });

  it('refuses a version that is not newer, and asks unless --yes', async () => {
    expect(await update({ version: 'v0.1.0' })).toBe(1);
    expect(output()).toContain('is not newer than the installed version 0.1.0');
    expect(await update({ version: 'v9.9.9' })).toBe(1);
    expect(output()).toContain('The repository has no release v9.9.9.');
    expect(await update({ yes: false })).toBe(1);
    expect(output()).toContain('Nobody can confirm the update.');
    w.answers = ['n'];
    expect(await update({ yes: false })).toBe(0);
    expect(w.questions).toEqual(['Install version 0.2.0? [y/N] ']);
    expect(await versionIn(w, w.layout.app)).toBe('0.1.0');
  });

  it('refuses while another run holds the lock, and takes over the lock of a run that is gone', async () => {
    w.alive.add(4242);
    writeFileSync(w.layout.lock, JSON.stringify({ pid: 4242 }));
    expect(await update()).toBe(1);
    expect(output()).toContain('Another run of the maintenance program is in progress (process 4242)');
    writeFileSync(w.layout.lock, JSON.stringify({ pid: 999_999 }));
    expect(await update()).toBe(0);
  });

  it('without a service, only tests the new program', async () => {
    w.loaded.clear();
    w.harness.clear();
    rmSync(join(w.launchAgents, `${serviceLabel(w.root)}.plist`));
    expect(await update()).toBe(0);
    expect(w.commands.some((c) => c.includes('service install'))).toBe(false);
    expect(output()).toContain('Start the harness with: mission-agent start --root');
  });

  it('refuses when the installed program does not work, and names repair', async () => {
    rmSync(join(w.layout.app, 'dist'), { recursive: true });
    expect(await update()).toBe(1);
    expect(output()).toContain('Run "mission-agent repair" first.');
  });
});

/** One row per way an update can fail: a hook point, or a release that misbehaves. */
const failures: { name: string; set: (w: World) => void }[] = [
  ...UPDATE_STEPS.map((step) => ({ name: `the step ${step} fails`, set: (x: World) => void (x.hook = (s) => (s === step ? 'fail' : undefined)) })),
  { name: 'git cannot get the release', set: (x: World) => void ((x.releases['v0.2.0'] as { fails?: string }).fails = 'clone') },
  { name: 'npm ci fails', set: (x: World) => void ((x.releases['v0.2.0'] as { fails?: string }).fails = 'npm-ci') },
  { name: 'the build fails', set: (x: World) => void ((x.releases['v0.2.0'] as { fails?: string }).fails = 'build') },
  { name: 'the new program reports another version', set: (x: World) => void ((x.releases['v0.2.0'] as { reports?: string }).reports = '0.1.9') },
  { name: 'the self-test of the new program fails', set: (x: World) => void ((x.releases['v0.2.0'] as { selfTestFails?: boolean }).selfTestFails = true) },
  { name: 'the new harness never answers', set: (x: World) => void ((x.releases['v0.2.0'] as { silent?: boolean }).silent = true) },
  { name: 'the new harness reports the wrong version', set: (x: World) => void ((x.releases['v0.2.0'] as { harnessReports?: string }).harnessReports = '0.1.9') },
];

describe('the failure table: a step fails', () => {
  for (const f of failures) {
    it(`${f.name}: the agent is in order, and a repair afterwards finds everything in order`, async () => {
      f.set(w);
      const code = await update();
      const state = await expectAgentInOrder(code, { old: '0.1.0', new: '0.2.0' });
      if (state === 'old') expect(output()).toMatch(/The update failed: /);
      // A failure after the new version runs leaves the journal, and repair finishes the update.
      delete w.hook;
      const repaired = await runRepair(maint(w), { yes: true });
      expect(repaired, w.lines.slice(-12).join('\n')).toBe(0);
      expect(readJournal(w.layout)).toBeUndefined();
      expect(await expectAgentInOrder(1, { old: '0.1.0', new: '0.2.0' })).toBe(state);
      expect(folderVersion(w.layout.maintenance)).toBe(await versionIn(w, w.layout.app));
    });
  }

  it('going back fails too: the journal says needs-repair, and repair then recovers', async () => {
    w.hook = (s) => (s === 'check-version' || s === 'back-start' ? 'fail' : undefined);
    expect(await update()).toBe(1);
    expect(readJournal(w.layout)?.stage).toBe('needs-repair');
    expect(output()).toContain('Going back failed too: injected failure at back-start');
    expect(output()).toContain('Run: mission-agent repair');
    delete w.hook;
    expect(await runRepair(maint(w), { yes: true })).toBe(0);
    expect(readJournal(w.layout)).toBeUndefined();
    expect(await expectAgentInOrder(1, { old: '0.1.0', new: '0.2.0' })).toBe('old');
  });

  for (const back of BACK_STEPS) {
    it(`going back fails at ${back}: repair then recovers`, async () => {
      w.hook = (s) => (s === 'check-version' || s === back ? 'fail' : undefined);
      expect(await update()).toBe(1);
      expect(readJournal(w.layout)?.stage).toBe('needs-repair');
      delete w.hook;
      expect(await runRepair(maint(w), { yes: true })).toBe(0);
      expect(await expectAgentInOrder(1, { old: '0.1.0', new: '0.2.0' })).toBe('old');
    });
  }
});

describe('the failure table: the process is killed at a step', () => {
  const kills = [
    ...UPDATE_STEPS.map((step) => ({ name: step, hook: (s: string) => (s === step ? ('kill' as const) : undefined) })),
    ...BACK_STEPS.map((step) => ({
      name: `${step}, while going back`,
      hook: (s: string) => (s === 'check-version' ? ('fail' as const) : s === step ? ('kill' as const) : undefined),
    })),
  ];
  for (const k of kills) {
    it(`killed at ${k.name}: a repair afterwards gives a working program`, async () => {
      w.hook = k.hook;
      expect(await runOrKilled(w, update())).toBe('killed');
      // The run left its journal and its lock behind. Its process is gone.
      expect(existsSync(w.layout.lock)).toBe(true);
      delete w.hook;
      const repaired = await runRepair(maint(w), { yes: true });
      expect(repaired, w.lines.slice(-15).join('\n')).toBe(0);
      expect(readJournal(w.layout)).toBeUndefined();
      expect(existsSync(w.layout.lock)).toBe(false);
      const state = await expectAgentInOrder('killed', { old: '0.1.0', new: '0.2.0' });
      expect(folderVersion(w.layout.maintenance)).toBe(state === 'new' ? '0.2.0' : '0.1.0');
    });

    it(`killed at ${k.name}: the next update finishes or undoes it first`, async () => {
      w.hook = k.hook;
      expect(await runOrKilled(w, update())).toBe('killed');
      delete w.hook;
      const code = await update();
      expect(output()).toContain('stopped half way');
      expect(code, w.lines.slice(-12).join('\n')).toBe(0);
      expect(await versionIn(w, w.layout.app)).toBe('0.2.0');
      expect(w.harness.get(w.root)?.version).toBe('0.2.0');
      expect(existsSync(w.layout.installing)).toBe(false);
    });
  }
});
