import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serviceLabel } from '../service/plist.js';
import { dropWorld, installed, maint, makeWorld, type World } from './test-helpers.js';
import { runUninstall } from './uninstall.js';
import { runUpdate } from './update.js';

/** The uninstall (chapter 7.3). The agent's data is kept, unless a person answers two questions. */

let w: World;
beforeEach(() => {
  w = makeWorld();
  installed(w, 'v0.1.0');
});
afterEach(() => dropWorld(w));

const output = () => w.lines.join('\n');

describe('the uninstall', () => {
  it('removes the program, the maintenance program, app.previous, the files and the service, and keeps the data', async () => {
    expect(await runUpdate(maint(w), { root: w.root, yes: true })).toBe(0);
    expect(existsSync(w.layout.previous)).toBe(true);
    expect(await runUninstall(maint(w), { wipeData: false, yes: true })).toBe(0);
    for (const p of [w.layout.app, w.layout.previous, w.layout.maintenance, w.layout.command, w.layout.installInfo, w.layout.home]) {
      expect(existsSync(p), p).toBe(false);
    }
    expect(w.loaded.has(serviceLabel(w.root))).toBe(false);
    expect(existsSync(join(w.launchAgents, `${serviceLabel(w.root)}.plist`))).toBe(false);
    expect(readFileSync(join(w.root, 'agent.yaml'), 'utf8')).toBe('agent_name: Ada\n');
    expect(output()).toContain("the agent's root folder");
  });

  it('asks without --yes, and removes nothing when nobody can answer or the answer is no', async () => {
    expect(await runUninstall(maint(w), { wipeData: false, yes: false })).toBe(1);
    expect(output()).toContain('Nobody can confirm the uninstall.');
    // A no is an answer, as in the old script: exit code 0, nothing removed.
    w.answers = ['n'];
    expect(await runUninstall(maint(w), { wipeData: false, yes: false })).toBe(0);
    expect(existsSync(w.layout.app)).toBe(true);
    expect(w.loaded.has(serviceLabel(w.root))).toBe(true);
  });

  it('refuses to delete the data with --yes, or when nobody can answer', async () => {
    expect(await runUninstall(maint(w), { wipeData: true, yes: true })).toBe(1);
    expect(output()).toContain("--yes does not cover the deletion of the agent's data");
    expect(await runUninstall(maint(w), { wipeData: true, yes: false })).toBe(1);
    expect(output()).toContain('needs a person to answer two questions, and nobody can be asked');
    expect(existsSync(w.layout.app)).toBe(true);
    expect(existsSync(w.root)).toBe(true);
  });

  it('deletes the data only after yes and then the word delete', async () => {
    w.answers = ['y', 'no'];
    expect(await runUninstall(maint(w), { wipeData: true, yes: false })).toBe(0);
    expect(output()).toContain('Nothing was removed.');
    expect(existsSync(w.root)).toBe(true);
    expect(existsSync(w.layout.app)).toBe(true);
    w.answers = ['y', 'delete'];
    w.questions = [];
    expect(await runUninstall(maint(w), { wipeData: true, yes: false })).toBe(0);
    expect(w.questions.length).toBe(2);
    expect(existsSync(w.root)).toBe(false);
    expect(existsSync(w.layout.app)).toBe(false);
  });

  it('refuses while another run holds the lock', async () => {
    w.alive.add(4242);
    writeFileSync(w.layout.lock, JSON.stringify({ pid: 4242 }));
    expect(await runUninstall(maint(w), { wipeData: false, yes: true })).toBe(1);
    expect(output()).toContain('(process 4242)');
    expect(existsSync(w.layout.app)).toBe(true);
  });
});
