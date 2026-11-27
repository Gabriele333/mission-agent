import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Harness } from '../harness/index.js';
import { selfHeal } from '../maintenance/heal.js';
import { lockHolder } from '../maintenance/journal.js';
import { layoutFor } from '../maintenance/layout.js';
import { pageUrl, readServerFile, type RouteHandler } from '../server/index.js';
import { otherServiceFiles, serviceStatus, type ServiceOptions } from '../service/index.js';
import { shellQuote } from '../shell.js';
import { execCommand, failureText, isReleaseTag, type CommandRunner } from '../update/index.js';
import { bodyObject, errorText, fail } from './http.js';
import type { PageRoute } from './setup-routes.js';

/**
 * The Version part of the dashboard (chapter 6): what is installed, the newest release, and two
 * buttons. "Check for updates" runs the release check now. "Install" starts the maintenance
 * program as a separate process, which serves its own progress page (chapter 7.5). These are page
 * routes behind the page token, like the routes of the setup page, so no tool of the agent reaches them.
 */

export interface UpdateRoutesOptions {
  /** The folder of the program that runs. */
  programDir: string;
  /** The home folder of the installation. Null: the program is a development copy. */
  home: string | null;
  /** Runs git, for the check that the program is a release. Default: the real git. */
  run?: CommandRunner;
  /** Default: the node program that runs now. */
  nodePath?: string;
  /** Starts the maintenance program as a separate process. Default: node, detached, its output to `maintenance.log`. */
  spawnMaintenance?: (nodePath: string, args: string[], logFile: string, cwd: string) => { pid: number | undefined };
  /** How long to wait for the progress page of the maintenance program to answer. Default 20 seconds. */
  serverWaitMs?: number;
}

/**
 * Starts the maintenance program so that it outlives this harness. The update stops the service,
 * and launchd then ends the processes of the service, but not one that runs in its own session.
 */
export function spawnDetached(nodePath: string, args: string[], logFile: string, cwd: string): { pid: number | undefined } {
  const fd = openSync(logFile, 'a', 0o600);
  try {
    const child = spawn(nodePath, args, { detached: true, stdio: ['ignore', fd, fd], cwd, env: process.env });
    child.on('error', () => undefined);
    child.unref();
    return { pid: child.pid };
  } finally {
    closeSync(fd);
  }
}

const RELEASE_CHECK_CACHE_MS = 60_000;

export function updateRoutes(h: Harness, options: UpdateRoutesOptions, service: Omit<ServiceOptions, 'root'>): PageRoute[] {
  const run = options.run ?? execCommand;
  const command = `mission-agent update --root ${shellQuote(h.paths.root)}`;
  const serviceOptions = (): ServiceOptions => ({ ...service, root: h.paths.root, cliPath: service.cliPath ?? join(options.programDir, 'dist', 'cli.js') });
  let releaseCopy: { at: number; refusal: string | undefined } | undefined;

  /** Why this program is not an installed release, or undefined. The answer of git is kept for a minute. */
  async function developmentCopy(): Promise<string | undefined> {
    const byHand = 'Update it with git.';
    if (options.home === null) return `The program in ${options.programDir} is a development copy, not an installed release. ${byHand}`;
    if (releaseCopy !== undefined && Date.now() - releaseCopy.at < RELEASE_CHECK_CACHE_MS) return releaseCopy.refusal;
    let refusal: string | undefined;
    if (!existsSync(join(options.programDir, '.git'))) refusal = `The program in ${options.programDir} was not installed with git. ${byHand}`;
    else {
      const status = await run('git', ['status', '--porcelain'], { cwd: options.programDir, timeoutMs: 30_000 });
      const described = await run('git', ['describe', '--tags', '--exact-match', 'HEAD'], { cwd: options.programDir, timeoutMs: 30_000 });
      if (status.code !== 0) refusal = `git could not read the program folder: ${failureText(status, 2)}`;
      else if (status.stdout.trim() !== '') refusal = `The program folder ${options.programDir} holds changes that are in no release, so it is a development copy. ${byHand}`;
      else if (described.code !== 0 || !described.stdout.trim().split('\n').some(isReleaseTag)) {
        refusal = `The program in ${options.programDir} is not at a release, so it is a development copy. ${byHand}`;
      }
    }
    releaseCopy = { at: Date.now(), refusal };
    return refusal;
  }

  /** Why the button cannot start an update, or undefined. These are the cases where the update refuses. */
  async function refusal(): Promise<string | undefined> {
    const dev = await developmentCopy();
    if (dev !== undefined) return dev;
    const others = otherServiceFiles(serviceOptions());
    if (others.length > 0) {
      return (
        `Other agents run this same program as a service: ${others.join(', ')}. An update would replace the program under them. ` +
        'Remove each of these services, run the update for each agent in a terminal, and install the services again.'
      );
    }
    const st = await serviceStatus(serviceOptions());
    if (st.pid !== process.pid) {
      return `This harness runs in a terminal, not as the service. Stop it with Ctrl+C, then run the update in a terminal: ${command}`;
    }
    return undefined;
  }

  const getVersion: RouteHandler = async (_req, res) => {
    const last = h.release.last();
    res.json({
      installed: last.installed ?? null,
      latest: last.latest ?? null,
      checkedAt: last.checkedAt ?? null,
      newer: last.newer,
      notes: last.notes ?? null,
      refusal: (await refusal()) ?? null,
      command,
    });
  };

  const postCheck: RouteHandler = async (_req, res) => {
    const result = await h.release.checkNow();
    if (!result.ok) return fail(res, 502, `The check for a newer release got no answer: ${h.redact(result.reason)}`);
    res.json({
      ok: true,
      installed: result.current,
      latest: result.latest,
      newer: result.newer,
      notes: result.newer ? (result.notes ?? null) : null,
      checkedAt: result.checkedAt ?? null,
    });
  };

  const postStart: RouteHandler = async (req, res) => {
    const wanted = bodyObject(req.body)?.version;
    if (typeof wanted !== 'string' || !/^\d+\.\d+\.\d+$/.test(wanted)) return fail(res, 400, 'The body must be {"version": "X.Y.Z"}.');
    const why = await refusal();
    if (why !== undefined) return fail(res, 409, why);
    const last = h.release.last();
    if (!last.newer || last.latest !== wanted) {
      return fail(res, 409, `The page showed version ${wanted}, but the newest release that the last check found is ${last.latest ?? 'unknown'}. Check for updates again.`);
    }
    const home = options.home as string;
    const layout = layoutFor(home);
    const busy = lockHolder(layout);
    if (busy !== undefined) return fail(res, 409, `An update or a repair runs already (process ${busy}).`);
    try {
      selfHeal(options.programDir, last.installed, home);
    } catch (err) {
      return fail(res, 500, `The maintenance program could not be written: ${errorText(err)}. Run in a terminal: ${command}`);
    }
    if (!existsSync(layout.maintenanceMain)) return fail(res, 500, `The maintenance program is missing in ${layout.maintenance}. Run in a terminal: mission-agent repair`);

    const args = [layout.maintenanceMain, '--home', home, 'update', '--root', h.paths.root, '--yes', '--version', `v${wanted}`, '--serve'];
    let pid: number | undefined;
    try {
      pid = (options.spawnMaintenance ?? spawnDetached)(options.nodePath ?? process.execPath, args, layout.log, home).pid;
    } catch (err) {
      return fail(res, 500, `The maintenance program could not be started: ${errorText(err)}`);
    }
    if (pid === undefined) return fail(res, 500, 'The maintenance program could not be started.');

    // It writes where its page answers once it listens.
    const deadline = Date.now() + (options.serverWaitMs ?? 20_000);
    for (;;) {
      const info = readServerFile({ serverFile: layout.server });
      if (info !== undefined && info.pid === pid) return res.json({ ok: true, url: pageUrl(info, '/'), pid });
      if (Date.now() > deadline) {
        let tail = '';
        try {
          tail = readFileSync(layout.log, 'utf8').trimEnd().split('\n').slice(-5).join('\n');
        } catch {
          tail = '';
        }
        return fail(res, 500, `The maintenance program started (process ${pid}), but its page does not answer. The end of ${layout.log}:\n${h.redact(tail)}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  return [
    { method: 'GET', path: '/api/dashboard/version', handler: getVersion },
    { method: 'POST', path: '/api/update/check', handler: postCheck },
    { method: 'POST', path: '/api/update/start', handler: postStart },
  ];
}
