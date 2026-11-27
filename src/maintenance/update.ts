import { existsSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathsFor } from '../paths.js';
import { shellQuote } from '../shell.js';
import { failureText } from '../update/command.js';
import { copyRootFolder, pruneRootCopies, restoreRootFolder, updateCopiesDir } from '../update/update.js';
import { errorText, yesNo, type Maint } from './context.js';
import {
  copyMaintenance,
  folderVersion,
  MaintenanceError,
  readInstallInfo,
  removeProgramFolder,
  writeCommandFile,
  writeInstallInfo,
} from './files.js';
import { journalUnreadable, readJournal, releaseLock, removeJournal, stageAtLeast, takeLock, writeJournal, type Journal, type Stage } from './journal.js';
import {
  buildRelease,
  hasService,
  isLoaded,
  isNewer,
  newest,
  originUrl,
  releaseNotes,
  releaseTags,
  serviceFileOf,
  servicesOf,
  startService,
  stopService,
  tagOf,
  testProgram,
  waitForHarness,
} from './ops.js';

/**
 * The update (chapter 7.4). The new release is built and tested in `app.installing` before the
 * running agent is touched. The swap is two renames, and the program that `app` held stays in
 * `app.previous`, so going back is a rename too. Every step that can fail is a hook point, listed
 * in `UPDATE_STEPS`. The failure table test fails each one in turn.
 */

/** The hook points of an update, in the order the update reaches them. */
export const UPDATE_STEPS = [
  'clone',
  'npm-ci',
  'build',
  'test-version',
  'self-test',
  'stop',
  'copy-root',
  'swap-remove-previous',
  'swap-app-to-previous',
  'swap-installing-to-app',
  'start',
  'check-version',
  'maintenance-copy',
  'command-file',
  'install-info',
] as const;

/** The hook points of going back, in order. */
export const BACK_STEPS = ['back-stop', 'back-rename', 'back-restore', 'back-start'] as const;

export interface UpdateOptions {
  root: string;
  yes: boolean;
  /** A release tag such as `v0.2.0`. It must be newer than the installed version. */
  version?: string;
}

/** The parts of an update that the progress page shows, in order. */
export const UPDATE_PARTS = [
  ['check', 'Check what is installed'],
  ['build', 'Get and build the new version'],
  ['test', 'Test the new program'],
  ['stop', 'Stop the harness'],
  ['copy', 'Copy the root folder'],
  ['swap', 'Put the new program in place'],
  ['start', 'Start the harness and check its version'],
  ['finish', 'Finish'],
] as const;

function part(m: Maint, id: string, state: 'running' | 'done' | 'failed' | 'skipped'): void {
  const title = UPDATE_PARTS.find((p) => p[0] === id)?.[1] ?? (id === 'back' ? 'Go back to the old version' : id);
  m.report?.step(id, title, state);
}

function save(m: Maint, j: Journal, stage: Stage): void {
  j.stage = stage;
  writeJournal(m.layout, j);
}

/** Runs the update. Returns the exit code. */
export async function runUpdate(m: Maint, o: UpdateOptions): Promise<number> {
  const lock = takeLock(m.layout, m.pid, m.alive);
  if (!lock.ok) {
    m.out(`Another run of the maintenance program is in progress (process ${lock.pid}). Wait until it ends, then run this again.`);
    return 1;
  }
  if (lock.tookOver !== undefined) m.log(`The lock of process ${lock.tookOver}, which is gone, was taken over.`);
  try {
    return await updateLocked(m, o);
  } finally {
    releaseLock(m.layout, m.pid);
  }
}

async function updateLocked(m: Maint, o: UpdateOptions): Promise<number> {
  const L = m.layout;
  const root = resolve(o.root);

  // ---------------------------------------------------------- 1. a run that stopped half way

  part(m, 'check', 'running');
  if (journalUnreadable(L)) {
    m.out(`${L.journal} cannot be read, so it is not known how a past run ended. Run "mission-agent repair".`);
    part(m, 'check', 'failed');
    return 1;
  }
  const past = readJournal(L);
  if (past !== undefined) {
    if (!(await recover(m, past))) {
      part(m, 'check', 'failed');
      return 1;
    }
    m.out('');
  }

  // ---------------------------------------------------------- 2. what is installed, and what runs

  const refuse = (text: string): number => {
    m.out(text);
    part(m, 'check', 'failed');
    return 1;
  };
  const installed = await testProgram(m, L.app);
  if (!installed.ok) {
    return refuse(`The installed program in ${L.app} does not work: ${installed.reason}\nNothing was changed. Run "mission-agent repair" first.`);
  }
  const oldVersion = installed.version;
  const byHand = 'Update it by hand: see docs/update.md.';
  if (!existsSync(join(L.app, '.git'))) {
    return refuse(`The program in ${L.app} was not installed with git, so it cannot be updated. ${byHand}`);
  }
  const changed = await m.run('git', ['status', '--porcelain'], { cwd: L.app, timeoutMs: 60_000 });
  if (changed.code !== 0) return refuse(`git could not read the state of the program folder:\n${failureText(changed, 4)}`);
  if (changed.stdout.trim() !== '') {
    return refuse(`The program folder ${L.app} holds changes that are in no release, so it is a development copy. ${byHand}`);
  }
  const described = await m.run('git', ['describe', '--tags', '--exact-match', 'HEAD'], { cwd: L.app, timeoutMs: 60_000 });
  const headTags = described.code === 0 ? described.stdout.trim().split('\n') : [];
  if (!headTags.includes(tagOf(oldVersion))) {
    return refuse(`The program in ${L.app} is not at the release ${tagOf(oldVersion)}, so it is a development copy. ${byHand}`);
  }
  const own = serviceFileOf(m, root);
  const others = servicesOf(m, L.app).filter((s) => s.label !== own.label);
  if (others.length > 0) {
    return refuse(
      `Other agents run this same program as a service: ${others.map((s) => s.plist).join(', ')}. ` +
        'An update would replace the program under them. Remove each of these services with "mission-agent service uninstall", ' +
        'run the update for each agent, and install the services again.',
    );
  }
  const printed = await m.launchctl(['print', `gui/${m.uid}/${own.label}`]);
  const servicePid = printed.code === 0 ? Number(/^\s*pid = (\d+)\s*$/m.exec(printed.stdout)?.[1] ?? NaN) : NaN;
  const running = await m.findHarness(root);
  if (running !== undefined && running.pid !== servicePid) {
    return refuse(`A harness for ${root} runs in a terminal (process ${running.pid}), not as the service. Stop it with Ctrl+C, then run the update again.`);
  }
  const wasService = await hasService(m, root);

  // ---------------------------------------------------------- 3. the release

  const url = (await originUrl(m, L.app)) ?? readInstallInfo(L)?.repo;
  if (url === undefined) return refuse(`The program in ${L.app} names no repository, so no release can be looked up. ${byHand}`);
  let tags: string[];
  try {
    tags = await releaseTags(m, 'origin', L.app);
  } catch (err) {
    return refuse(errorText(err));
  }
  let tag: string;
  if (o.version !== undefined) {
    let wanted: string;
    try {
      wanted = tagOf(o.version);
    } catch (err) {
      return refuse(errorText(err));
    }
    if (!tags.includes(wanted)) return refuse(`The repository has no release ${wanted}. Nothing was changed.`);
    if (!isNewer(wanted, oldVersion)) return refuse(`Release ${wanted} is not newer than the installed version ${oldVersion}. Nothing was changed.`);
    tag = wanted;
  } else {
    const latest = newest(tags);
    if (latest === undefined || !isNewer(latest, oldVersion)) {
      m.out(`You have the newest release, ${oldVersion}. Nothing was changed.`);
      part(m, 'check', 'done');
      return 0;
    }
    tag = latest;
  }
  const newVersion = tag.slice(1);
  const notes = await releaseNotes(m, L.app, tag);
  m.out(`Version ${newVersion} is available. You have ${oldVersion}.`);
  if (notes === '') m.out('This release has no notes.');
  else {
    m.out('Release notes:');
    for (const line of notes.split('\n')) m.out(`  ${line}`);
  }
  m.out('');
  m.out('The update does these steps:');
  m.out(`  1. It gets version ${newVersion}, builds it beside the installed program, and tests it. Nothing is stopped yet.`);
  m.out(wasService ? '  2. It stops the harness, which runs as a service.' : '  2. No harness runs for this root folder, so nothing is stopped.');
  m.out(`  3. It copies ${root} to ${join(updateCopiesDir(pathsFor(root)), `${oldVersion}-<date>`)}.`);
  m.out(`  4. It puts the new program in ${L.app}, and keeps the old one in ${L.previous}.`);
  m.out(wasService ? '  5. It starts the harness and checks that it reports the new version.' : '  5. It checks that the new program starts.');
  m.out(`If a step fails, version ${oldVersion} runs again.`);
  if (!o.yes) {
    const answer = await yesNo(m, `Install version ${newVersion}? [y/N] `, false);
    if (answer === undefined) return refuse('Nobody can confirm the update. Run it with --yes to update without a question. Nothing was changed.');
    if (!answer) {
      m.out('Nothing was changed.');
      part(m, 'check', 'done');
      return 0;
    }
  }
  part(m, 'check', 'done');

  // ---------------------------------------------------------- 4. build and test, while the agent runs

  const j: Journal = {
    operation: 'update',
    stage: 'building',
    oldVersion,
    newVersion,
    root,
    pid: m.pid,
    startedAt: m.now().toISOString(),
    wasService,
  };
  writeJournal(L, j);
  try {
    part(m, 'build', 'running');
    await buildRelease(m, url, tag);
    part(m, 'build', 'done');
    part(m, 'test', 'running');
    m.out('Testing the new program.');
    const tested = await testProgram(m, L.installing, newVersion, true);
    if (!tested.ok) throw new MaintenanceError(tested.reason);
    part(m, 'test', 'done');
  } catch (err) {
    m.out('');
    m.out(`The update failed: ${errorText(err)}`);
    removeProgramFolder(L, L.installing);
    removeJournal(L);
    m.out(`Nothing was changed. The agent was not stopped, and version ${oldVersion} is still installed.`);
    failRest(m, 'build');
    return 1;
  }

  // ---------------------------------------------------------- 5 and 6. stop, copy

  try {
    save(m, j, 'stopping');
    part(m, 'stop', 'running');
    await m.checkpoint('stop');
    if (wasService) {
      m.out('Stopping the harness.');
      await stopService(m, root);
    }
    part(m, 'stop', 'done');
    save(m, j, 'copying');
    part(m, 'copy', 'running');
    await m.checkpoint('copy-root');
    const copyDir = copyRootFolder(pathsFor(root), oldVersion, m.now());
    if (copyDir !== undefined) {
      j.copyDir = copyDir;
      m.out(`Copied the root folder to ${copyDir}.`);
    }
    part(m, 'copy', 'done');
  } catch (err) {
    // The old program is still in place, and no new harness ran.
    m.out('');
    m.out(`The update failed: ${errorText(err)}`);
    failRest(m, 'stop');
    j.reason = errorText(err);
    await backOrRepair(m, j);
    return 1;
  }

  // ---------------------------------------------------------- 7 and 8. swap, start

  try {
    save(m, j, 'swapping');
    part(m, 'swap', 'running');
    await m.checkpoint('swap-remove-previous');
    removeProgramFolder(L, L.previous);
    await m.checkpoint('swap-app-to-previous');
    renameSync(L.app, L.previous);
    await m.checkpoint('swap-installing-to-app');
    renameSync(L.installing, L.app);
    m.out(`Version ${newVersion} is in ${L.app}. Version ${oldVersion} is kept in ${L.previous}.`);
    part(m, 'swap', 'done');

    j.newStarted = true;
    save(m, j, 'starting');
    part(m, 'start', 'running');
    await m.checkpoint('start');
    if (wasService) {
      m.out('Starting the harness.');
      const r = await m.run(m.nodePath, [join(L.app, 'dist', 'cli.js'), 'service', 'install', '--root', root], {
        cwd: L.home,
        timeoutMs: 120_000,
      });
      if (r.code !== 0) throw new MaintenanceError(`The service could not be started:\n${failureText(r, 8)}`);
      await m.checkpoint('check-version');
      await waitForHarness(m, root, newVersion);
      m.out(`The harness answers, with version ${newVersion}.`);
    } else {
      await m.checkpoint('check-version');
      const t = await testProgram(m, L.app, newVersion);
      if (!t.ok) throw new MaintenanceError(t.reason);
    }
    part(m, 'start', 'done');
  } catch (err) {
    m.out('');
    m.out(`The update failed: ${errorText(err)}`);
    failRest(m, j.newStarted === true ? 'start' : 'swap');
    j.reason = errorText(err);
    await backOrRepair(m, j);
    return 1;
  }

  // ---------------------------------------------------------- 9. finish

  save(m, j, 'finishing');
  part(m, 'finish', 'running');
  try {
    await finish(m, j, url);
  } catch (err) {
    m.out('');
    m.out(`Version ${newVersion} is installed${wasService ? ' and runs' : ''}, but a last step failed: ${errorText(err)}`);
    m.out('Run "mission-agent repair" to finish it.');
    part(m, 'finish', 'failed');
    return 1;
  }
  removeJournal(L);
  part(m, 'finish', 'done');
  m.out('');
  m.out(`Version ${newVersion} is installed.${wasService ? ' The harness runs.' : ''}`);
  if (!wasService) m.out(`Start the harness with: mission-agent start --root ${shellQuote(root)}`);
  if (j.copyDir !== undefined) m.out(`The copy of the root folder made before the update is ${j.copyDir}.`);
  m.out(`Version ${oldVersion} is kept in ${L.previous}. See "Go back to the old version" in docs/update.md.`);
  return 0;
}

/** Marks the part that failed, and the parts after it as skipped. */
function failRest(m: Maint, failed: string): void {
  let after = false;
  for (const [id] of UPDATE_PARTS) {
    if (id === failed) {
      part(m, id, 'failed');
      after = true;
    } else if (after) part(m, id, 'skipped');
  }
}

/**
 * Step 9: the maintenance program and the command file of the new release, and `install.json`.
 * The root copies are pruned last.
 */
async function finish(m: Maint, j: Journal, url?: string): Promise<void> {
  const L = m.layout;
  await m.checkpoint('maintenance-copy');
  copyMaintenance(L, L.app);
  await m.checkpoint('command-file');
  writeCommandFile(L);
  await m.checkpoint('install-info');
  const before = readInstallInfo(L);
  const repo = url ?? (await originUrl(m, L.app)) ?? before?.repo ?? m.repo;
  writeInstallInfo(L, { repo, version: j.newVersion, installedAt: m.now().toISOString(), ...(before?.link !== undefined ? { link: before.link } : {}) });
  if (j.copyDir !== undefined) pruneRootCopies(pathsFor(j.root));
}

/** Goes back, or leaves the journal as `needs-repair` and says what to do. Returns true when the old version runs again. */
async function backOrRepair(m: Maint, j: Journal): Promise<boolean> {
  m.out(`Going back to version ${j.oldVersion}.`);
  save(m, j, 'going-back');
  part(m, 'back', 'running');
  try {
    await goBack(m, j);
  } catch (err) {
    j.reason = `${j.reason ?? ''} Going back failed too: ${errorText(err)}`.trim();
    save(m, j, 'needs-repair');
    part(m, 'back', 'failed');
    m.out(`Going back failed too: ${errorText(err)}`);
    m.out('The agent may not run now. Run: mission-agent repair');
    if (j.copyDir !== undefined) m.out(`The copy of the root folder made before the update is ${j.copyDir}.`);
    return false;
  }
  removeJournal(m.layout);
  part(m, 'back', 'done');
  m.out(`Version ${j.oldVersion} runs again.${j.wasService ? ' The harness runs.' : ''}`);
  return true;
}

/**
 * Puts the old program back in `app`: the new harness is stopped, `app` is moved away and
 * `app.previous` renamed to `app`. The copy of the root folder is put back when the new harness
 * may have started, because only that harness can have changed the root folder.
 */
async function goBack(m: Maint, j: Journal): Promise<void> {
  const L = m.layout;
  await m.checkpoint('back-stop');
  if (j.wasService) await stopService(m, j.root);
  if (folderVersion(L.app) !== j.oldVersion || !existsSync(join(L.app, 'dist', 'cli.js'))) {
    if (!existsSync(L.previous) || folderVersion(L.previous) !== j.oldVersion) {
      throw new MaintenanceError(`The program of version ${j.oldVersion} is not in ${L.previous}, so it cannot be put back.`);
    }
    await m.checkpoint('back-rename');
    if (existsSync(L.app)) {
      removeProgramFolder(L, L.installing);
      renameSync(L.app, L.installing);
    }
    renameSync(L.previous, L.app);
  }
  removeProgramFolder(L, L.installing);
  if (j.newStarted === true && j.copyDir !== undefined && existsSync(j.copyDir)) {
    await m.checkpoint('back-restore');
    restoreRootFolder(pathsFor(j.root), j.copyDir);
    m.out(`Put the copy ${j.copyDir} back in ${j.root}.`);
  }
  await m.checkpoint('back-start');
  if (j.wasService) {
    await startService(m, j.root, L.app, j.oldVersion);
  } else {
    const t = await testProgram(m, L.app, j.oldVersion);
    if (!t.ok) throw new MaintenanceError(t.reason);
  }
}

/**
 * Finishes or undoes an update that a killed run left behind, from its journal. Before the swap,
 * the new build is removed and the service started again. After the swap, the update is finished
 * when the new program passes its tests and its harness answers. Else it goes back.
 * Returns true when the agent is in order afterwards.
 */
export async function recover(m: Maint, j: Journal): Promise<boolean> {
  const L = m.layout;
  m.out(`An update from version ${j.oldVersion} to ${j.newVersion} stopped half way, at the stage "${j.stage}". It is finished or undone first.`);
  j.pid = m.pid;

  if (!stageAtLeast(j.stage, 'swapping')) {
    removeProgramFolder(L, L.installing);
    try {
      await ensureRuns(m, j.root, j.wasService, j.oldVersion);
    } catch (err) {
      j.reason = errorText(err);
      save(m, j, 'needs-repair');
      m.out(`The harness of version ${j.oldVersion} does not run again: ${errorText(err)}`);
      return false;
    }
    removeJournal(L);
    m.out(`Nothing of version ${j.newVersion} was kept. Version ${j.oldVersion} runs.`);
    return true;
  }

  if (j.stage === 'swapping' || j.stage === 'starting' || j.stage === 'finishing') {
    const appVersion = folderVersion(L.app);
    if (appVersion === j.newVersion && (await testProgram(m, L.app, j.newVersion)).ok) {
      try {
        if (j.wasService) {
          const h = await m.findHarness(j.root);
          if (h?.version !== j.newVersion) {
            j.newStarted = true;
            save(m, j, 'starting');
            await stopService(m, j.root);
            await startService(m, j.root, L.app, j.newVersion);
          }
        }
        save(m, j, 'finishing');
        await finish(m, j);
        removeJournal(L);
        m.out(`The update is finished. Version ${j.newVersion} is installed.`);
        return true;
      } catch (err) {
        m.out(`The update cannot be finished: ${errorText(err)}`);
        j.reason = errorText(err);
      }
    } else if (appVersion === j.oldVersion && !j.newStarted) {
      removeProgramFolder(L, L.installing);
      try {
        await ensureRuns(m, j.root, j.wasService, j.oldVersion);
      } catch (err) {
        j.reason = errorText(err);
        save(m, j, 'needs-repair');
        m.out(`The harness of version ${j.oldVersion} does not run again: ${errorText(err)}`);
        return false;
      }
      removeJournal(L);
      m.out(`Version ${j.oldVersion} runs.`);
      return true;
    }
  }
  return backOrRepair(m, j);
}

/** Starts the service of a root folder again when it had one and its harness does not answer with this version. */
async function ensureRuns(m: Maint, root: string, wasService: boolean, version: string): Promise<void> {
  if (!wasService) return;
  const h = await m.findHarness(root);
  if (h?.version === version && (await isLoaded(m, serviceFileOf(m, root).label))) return;
  if (h !== undefined) await stopService(m, root);
  await startService(m, root, m.layout.app, version);
}
