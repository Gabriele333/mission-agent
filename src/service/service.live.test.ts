import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { pathsFor } from '../paths.js';
import { isServerAlive, readServerFile } from '../server/index.js';
import { xmlEscape } from './plist.js';
import { bootoutAndWait, installService, serviceStatus, uninstallService, type ServiceOptions } from './service.js';

// Uses the real launchctl, and the real ~/Library/LaunchAgents unless MISSION_AGENT_LAUNCH_AGENTS
// names another folder. Runs only with MISSION_AGENT_LIVE=1, after "npm run build". macOS shows a
// notice that a background item was added.
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

/**
 * The Install button of the dashboard starts the maintenance program from the harness, and the
 * update then stops the service of that harness. launchd ends every process of a service at its
 * bootout, except one in its own session. This checks that the program that the button starts,
 * through spawnDetached, outlives the bootout. It uses a scratch label and a plist in a temporary
 * folder, never a file in ~/Library/LaunchAgents.
 */
describe.skipIf(!live)('a detached child of a service, with the real launchctl', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mission-agent-detached-live-')));
  const label = `local.mission-agent-scratch.detached-${process.pid}`;
  const uid = process.getuid?.() ?? 0;
  const pidsFile = join(dir, 'pids.json');
  const routes = join(dirname(cliPath), 'pages', 'update-routes.js');
  let pids: { parent: number; detached: number; attached: number } | undefined;

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  afterAll(async () => {
    await bootoutAndWait({}, { domain: `gui/${uid}`, label }, 'the scratch service').catch(() => undefined);
    for (const pid of [pids?.detached, pids?.attached, pids?.parent]) if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the program that spawnDetached started running after the bootout of the service', async () => {
    expect(existsSync(routes), 'run "npm run build" first').toBe(true);
    const script = join(dir, 'service.mjs');
    const sleep = "setTimeout(() => {}, 120000)";
    writeFileSync(
      script,
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        `import { spawnDetached } from ${JSON.stringify(routes)};`,
        `const d = spawnDetached(process.execPath, ['-e', ${JSON.stringify(sleep)}], ${JSON.stringify(join(dir, 'child.log'))}, ${JSON.stringify(dir)});`,
        `const a = spawn(process.execPath, ['-e', ${JSON.stringify(sleep)}], { stdio: 'ignore' });`,
        `writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ parent: process.pid, detached: d.pid, attached: a.pid }));`,
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
    );
    const plist = join(dir, `${label}.plist`);
    writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xmlEscape(process.execPath)}</string><string>${xmlEscape(script)}</string></array>
<key>RunAtLoad</key><true/>
<key>StandardErrorPath</key><string>${xmlEscape(join(dir, 'service.err'))}</string>
</dict></plist>
`,
    );
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plist]);
    // In on-demand-only mode RunAtLoad is held back, so the service is started by hand too.
    execFileSync('launchctl', ['kickstart', `gui/${uid}/${label}`]);
    const deadline = Date.now() + 30_000;
    while (!existsSync(pidsFile)) {
      if (Date.now() > deadline) throw new Error(`The service did not start. ${existsSync(join(dir, 'service.err')) ? readFileSync(join(dir, 'service.err'), 'utf8') : ''}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    pids = JSON.parse(readFileSync(pidsFile, 'utf8')) as { parent: number; detached: number; attached: number };
    expect(alive(pids.detached) && alive(pids.attached)).toBe(true);

    await bootoutAndWait({}, { domain: `gui/${uid}`, label }, 'the scratch service');
    const gone = Date.now() + 15_000;
    while (alive(pids.parent) || alive(pids.attached)) {
      if (Date.now() > gone) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(alive(pids.parent), 'the service process ended').toBe(false);
    expect(alive(pids.attached), 'a child in the session of the service ended with it').toBe(false);
    expect(alive(pids.detached), 'the detached child still runs').toBe(true);
  });
});
