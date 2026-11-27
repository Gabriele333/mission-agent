import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serviceLabel } from '../service/plist.js';
import { commandFileIsCurrent, folderVersion, readInstallInfo } from './files.js';
import { runRepair } from './repair.js';
import { dropWorld, installed, maint, makeWorld, versionIn, writeProgram, type World } from './test-helpers.js';
import { runUpdate } from './update.js';

/** Repair (chapter 7.5): it finds what is wrong with the installed program and fixes it. */

let w: World;
beforeEach(() => {
  w = makeWorld();
  installed(w, 'v0.1.0');
});
afterEach(() => dropWorld(w));

const output = () => w.lines.join('\n');
const repair = (yes = true) => runRepair(maint(w), { yes });

async function expectWorking(version: string): Promise<void> {
  expect(await versionIn(w, w.layout.app), output()).toBe(version);
  expect(w.harness.get(w.root)?.version).toBe(version);
  expect(commandFileIsCurrent(w.layout)).toBe(true);
  expect(folderVersion(w.layout.maintenance)).toBe(version);
  expect(existsSync(w.layout.installing)).toBe(false);
  expect(existsSync(w.layout.broken)).toBe(false);
}

describe('repair', () => {
  it('finds everything in order and changes nothing', async () => {
    expect(await repair()).toBe(0);
    expect(output()).toContain('The program in');
    expect(output()).toContain('passes its tests');
    expect(output()).toContain('Everything is in order.');
    expect(w.commands.some((c) => c.includes('clone') || c.includes('service install'))).toBe(false);
  });

  it('builds the installed version again when dist/ is deleted', async () => {
    rmSync(join(w.layout.app, 'dist'), { recursive: true });
    expect(await repair()).toBe(0);
    expect(w.commands.some((c) => c.includes('clone --quiet --branch v0.1.0'))).toBe(true);
    await expectWorking('0.1.0');
  });

  it('builds the installed version again when node_modules/ is deleted', async () => {
    rmSync(join(w.layout.app, 'node_modules'), { recursive: true });
    expect(await repair()).toBe(0);
    await expectWorking('0.1.0');
  });

  it('builds the installed version again when app/ is deleted', async () => {
    rmSync(w.layout.app, { recursive: true });
    w.harness.clear();
    expect(await repair()).toBe(0);
    await expectWorking('0.1.0');
  });

  it('builds the newest release when app/ and install.json are both gone', async () => {
    rmSync(w.layout.app, { recursive: true });
    rmSync(w.layout.installInfo);
    w.harness.clear();
    expect(await repair()).toBe(0);
    await expectWorking('0.2.0');
    expect(readInstallInfo(w.layout)?.version).toBe('0.2.0');
  });

  it('offers app.previous when it passes, so no network is needed', async () => {
    expect(await runUpdate(maint(w), { root: w.root, yes: true })).toBe(0);
    rmSync(join(w.layout.app, 'dist'), { recursive: true });
    w.commands = [];
    expect(await repair()).toBe(0);
    expect(output()).toContain('the version before the last update, and it passes its tests');
    expect(w.commands.some((c) => c.includes('clone'))).toBe(false);
    expect(await versionIn(w, w.layout.app)).toBe('0.1.0');
    expect(w.harness.get(w.root)?.version).toBe('0.1.0');
    expect(folderVersion(w.layout.maintenance)).toBe('0.1.0');
  });

  it('keeps the broken program when the new build fails, and says what is still wrong', async () => {
    rmSync(join(w.layout.app, 'dist'), { recursive: true });
    (w.releases['v0.1.0'] as { fails?: string }).fails = 'build';
    expect(await repair()).toBe(1);
    expect(existsSync(w.layout.app)).toBe(true);
    expect(existsSync(w.layout.installing)).toBe(false);
    expect(output()).toContain('The program could not be built again');
    expect(output()).toContain('Still wrong:');
  });

  it('writes the command file again, and copies the maintenance program again', async () => {
    rmSync(w.layout.command);
    rmSync(w.layout.maintenance, { recursive: true });
    expect(await repair()).toBe(0);
    await expectWorking('0.1.0');
  });

  it('removes a leftover app.installing, and uses it when app/ does not work', async () => {
    writeProgram(w, w.layout.installing, 'v0.2.0', { built: false });
    expect(await repair()).toBe(0);
    expect(existsSync(w.layout.installing)).toBe(false);

    writeProgram(w, w.layout.installing, 'v0.2.0');
    rmSync(join(w.layout.app, 'dist'), { recursive: true });
    expect(await repair()).toBe(0);
    expect(output()).toContain('holds a built program of version 0.2.0 that passes its tests');
    await expectWorking('0.2.0');
  });

  it('installs the service again when it is not loaded or its harness does not answer', async () => {
    w.loaded.clear();
    w.harness.clear();
    expect(await repair()).toBe(0);
    expect(output()).toContain('is not loaded');
    expect(w.loaded.has(serviceLabel(w.root))).toBe(true);
    expect(w.harness.get(w.root)?.version).toBe('0.1.0');
  });

  it('asks before each fix without --yes, and changes nothing when nobody can answer', async () => {
    rmSync(w.layout.command);
    expect(await repair(false)).toBe(1);
    expect(existsSync(w.layout.command)).toBe(false);
    expect(output()).toContain('Nobody could confirm the fixes');
    w.answers = ['y'];
    expect(await repair(false)).toBe(0);
    expect(w.questions).toEqual(['Write it again? [Y/n] ']);
    expect(existsSync(w.layout.command)).toBe(true);
  });

  it('never puts the data back by itself: it asks each time, even with --yes', async () => {
    expect(await runUpdate(maint(w), { root: w.root, yes: true })).toBe(0);
    // The new harness stops answering, for a reason in the data.
    (w.releases['v0.2.0'] as { silent?: boolean }).silent = true;
    w.harness.clear();
    expect(await repair(true)).toBe(1);
    expect(output()).toContain('Run "mission-agent repair" where a person can answer');
    expect(readFileSync(join(w.root, 'state', 'agent.db'), 'utf8')).toBe('migrated by 0.2.0\n');

    // The person says no.
    w.answers = ['y', 'n'];
    w.questions = [];
    expect(await repair(false)).toBe(1);
    expect(w.questions).toContain('Put this copy back? [y/N] ');
    expect(readFileSync(join(w.root, 'state', 'agent.db'), 'utf8')).toBe('migrated by 0.2.0\n');

    // With --yes and a person at the terminal, only the question about the data is asked.
    // The person says yes. The harness still does not answer in this test, but the copy is back.
    w.answers = ['y'];
    w.questions = [];
    expect(await repair(true)).toBe(1);
    expect(w.questions).toEqual(['Put this copy back? [y/N] ']);
    expect(readFileSync(join(w.root, 'state', 'agent.db'), 'utf8')).toBe('the database\n');
  });

  it('refuses while another run holds the lock', async () => {
    w.alive.add(4242);
    mkdirSync(w.layout.home, { recursive: true });
    writeFileSync(w.layout.lock, JSON.stringify({ pid: 4242 }));
    expect(await repair()).toBe(1);
    expect(output()).toContain('Another run of the maintenance program is in progress (process 4242)');
  });
});
