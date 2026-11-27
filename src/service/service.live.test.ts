import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { pathsFor } from '../paths.js';
import { isServerAlive, readServerFile } from '../server/index.js';
import { installService, serviceStatus, uninstallService, type ServiceOptions } from './service.js';

// Uses the real launchctl and the real ~/Library/LaunchAgents. Runs only with MISSION_AGENT_LIVE=1,
// after "npm run build". macOS shows a notice that a background item was added.
const live = process.env.MISSION_AGENT_LIVE === '1';
const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'cli.js');

describe.skipIf(!live)('the service, with the real launchctl', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mission-agent-service-live-')));
  const paths = pathsFor(root);
  const options: ServiceOptions = { root, cliPath };
  let first: number | undefined;
  let heldBack = false;

  afterAll(async () => {
    await uninstallService(options).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  /** The process id of the harness that answers for the root folder. */
  async function harnessPid(): Promise<number | undefined> {
    const info = readServerFile(paths);
    return info !== undefined && (await isServerAlive(info)) ? info.pid : undefined;
  }

  async function waitFor<T>(what: string, seconds: number, read: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      const value = await read();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error(`Waited ${seconds} seconds for ${what}.`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  it('starts the harness when the service is installed', async () => {
    expect(existsSync(cliPath), 'run "npm run build" first').toBe(true);
    const installed = await installService(options);
    expect(existsSync(installed.plan.plistPath)).toBe(true);
    expect(installed.startError).toBeUndefined();
    heldBack = installed.heldBack;

    first = await waitFor('the harness to answer', 30, harnessPid);
    expect(await serviceStatus(options)).toMatchObject({ installed: true, loaded: true, pid: first, state: 'running' });
  });

  it('starts the harness again after a crash, and leaves it stopped after a clean stop', async () => {
    expect(first, 'the first test must have started the harness').toBeDefined();
    // In on-demand-only mode launchd starts nothing by itself, so this part cannot pass.
    expect(heldBack, 'launchd holds back starts in this login session (on-demand-only mode). Log out and in, then run this again').toBe(false);

    // A crash: the process is killed, and launchd starts a new one.
    process.kill(first as number, 'SIGKILL');
    const second = await waitFor('launchd to start the harness again', 60, async () => {
      const pid = await harnessPid();
      return pid !== undefined && pid !== first ? pid : undefined;
    });
    expect((await serviceStatus(options)).pid).toBe(second);

    // A clean stop ends with exit code 0, and launchd leaves the harness stopped.
    process.kill(second, 'SIGTERM');
    await waitFor('the harness to stop', 30, async () => ((await harnessPid()) === undefined ? true : undefined));
    await new Promise((r) => setTimeout(r, 15_000));
    expect(await harnessPid()).toBeUndefined();
    const stopped = await serviceStatus(options);
    expect(stopped.loaded).toBe(true);
    expect(stopped.pid).toBeUndefined();
  });

  it('removes the service and its file', async () => {
    const before = await serviceStatus(options);
    const removed = await uninstallService(options);
    expect(removed).toMatchObject({ wasLoaded: true, removedFile: true });
    expect(existsSync(before.plistPath)).toBe(false);
    expect((await serviceStatus(options)).loaded).toBe(false);
    expect(await harnessPid()).toBeUndefined();
  });
});
