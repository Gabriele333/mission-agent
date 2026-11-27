import { existsSync, lstatSync, readdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathsFor } from '../paths.js';
import { shellQuote } from '../shell.js';
import { restoreRootFolder, updateCopiesDir } from '../update/update.js';
import { errorText, yesNo, type Maint } from './context.js';
import {
  commandFileIsCurrent,
  copyMaintenance,
  folderVersion,
  hasMaintenanceProgram,
  maintenanceMatches,
  readInstallInfo,
  removeProgramFolder,
  writeCommandFile,
  writeInstallInfo,
} from './files.js';
import { journalUnreadable, readJournal, releaseLock, removeJournal, takeLock } from './journal.js';
import {
  buildRelease,
  isLoaded,
  newest,
  originUrl,
  releaseTags,
  servicesOf,
  startService,
  stopService,
  tagOf,
  testProgram,
} from './ops.js';
import { recover } from './update.js';

/**
 * Repair (chapter 7.5). It looks, says what it found, and fixes with consent. It never puts a
 * copy of the root folder back by itself: a person answers that question each time.
 */

export interface RepairOptions {
  /** Fix without a question. It does not cover putting a copy of the root folder back. */
  yes: boolean;
  root?: string;
}

/** The parts of a repair that the progress page shows. */
export const REPAIR_PARTS = [
  ['tools', 'Node.js, git and npm'],
  ['journal', 'An operation that stopped half way'],
  ['leftovers', 'Folders left by a past run'],
  ['program', 'The program'],
  ['command', 'The command and its link'],
  ['maintenance', 'The maintenance program'],
  ['services', 'The services'],
  ['data', 'The data'],
] as const;

const COPY_NAME_RE = /^(\d+\.\d+\.\d+)-(\d{4}-\d{2}-\d{2}-\d{6})$/;

/** The newest copy of the root folder that an update made, or undefined. */
export function newestRootCopy(root: string): { dir: string; version: string } | undefined {
  const dir = updateCopiesDir(pathsFor(root));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const copies = names
    .map((n) => ({ n, m: COPY_NAME_RE.exec(n) }))
    .filter((c): c is { n: string; m: RegExpExecArray } => c.m !== null)
    .sort((a, b) => ((a.m[2] as string) < (b.m[2] as string) ? -1 : 1));
  const last = copies[copies.length - 1];
  return last === undefined ? undefined : { dir: join(dir, last.n), version: last.m[1] as string };
}

export async function runRepair(m: Maint, o: RepairOptions): Promise<number> {
  const L = m.layout;
  const still: string[] = [];
  let nobody = false;
  const report = (id: string, state: 'running' | 'done' | 'failed' | 'skipped') =>
    m.report?.step(id, REPAIR_PARTS.find((p) => p[0] === id)?.[1] ?? id, state);

  /** Asks before a fix. With --yes it does not ask. */
  async function consent(question: string): Promise<boolean> {
    if (o.yes) return true;
    const answer = await yesNo(m, `${question} [Y/n] `, true);
    if (answer === undefined) {
      nobody = true;
      return false;
    }
    if (!answer) m.out('Left as it is.');
    return answer;
  }

  // ---------------------------------------------------------- 1. Node.js, git and npm

  report('tools', 'running');
  const major = Number(process.versions.node.split('.')[0]);
  if (!(major >= 24)) {
    m.out(`This computer has Node.js ${process.versions.node}. The agent needs Node.js 24 or later.`);
    m.out('Install it from https://nodejs.org, or with Homebrew: brew upgrade node. Then run "mission-agent repair" again.');
    report('tools', 'failed');
    return 1;
  }
  const gitOk = (await m.run('git', ['--version'], { cwd: L.home, timeoutMs: 30_000 })).code === 0;
  const npmOk = (await m.run('npm', ['--version'], { cwd: L.home, timeoutMs: 30_000 })).code === 0;
  if (!gitOk) {
    m.out('git does not run. It comes with Apple\'s command line tools. Run "xcode-select --install", and finish the window that opens.');
    still.push('git does not run. Run "xcode-select --install".');
  }
  if (!npmOk) {
    m.out('npm does not run. It comes with Node.js: install Node.js again.');
    still.push('npm does not run. Install Node.js again.');
  }
  if (gitOk && npmOk) m.out(`Node.js ${process.versions.node}, git and npm run.`);
  report('tools', gitOk && npmOk ? 'done' : 'failed');

  const lock = takeLock(L, m.pid, m.alive);
  if (!lock.ok) {
    m.out(`Another run of the maintenance program is in progress (process ${lock.pid}). Wait until it ends, then run "mission-agent repair" again.`);
    return 1;
  }
  if (lock.tookOver !== undefined) m.out(`A run of the maintenance program that is gone (process ${lock.tookOver}) left its lock. It is taken over.`);
  try {
    // ---------------------------------------------------------- 2. a run that stopped half way

    report('journal', 'running');
    const j = readJournal(L);
    if (j !== undefined) {
      if (await consent(`An update from version ${j.oldVersion} to ${j.newVersion} stopped half way. Finish or undo it now?`)) {
        if (!(await recover(m, j))) still.push(`The update from version ${j.oldVersion} to ${j.newVersion} could not be finished or undone.`);
      } else still.push(`An update from version ${j.oldVersion} to ${j.newVersion} stopped half way.`);
    } else if (journalUnreadable(L)) {
      m.out(`${L.journal} cannot be read. It is removed, and the program is checked as it is.`);
      removeJournal(L);
    } else m.out('No operation stopped half way.');
    report('journal', readJournal(L) === undefined ? 'done' : 'failed');

    // ---------------------------------------------------------- 3. folders left by a past run

    report('leftovers', 'running');
    let appTest = await testProgram(m, L.app);
    if (existsSync(L.installing)) {
      const staged = await testProgram(m, L.installing);
      if (!appTest.ok && staged.ok) {
        m.out(`${L.app} does not work, and ${L.installing} holds a built program of version ${staged.version} that passes its tests.`);
        if (await consent(`Put version ${staged.version} in ${L.app}?`)) {
          for (const s of servicesOf(m, L.app)) if (s.root !== undefined) await stopService(m, s.root).catch(() => undefined);
          swapIn(m, L.installing);
          appTest = await testProgram(m, L.app);
          m.out(`Version ${staged.version} is in ${L.app}.`);
        }
      } else {
        m.out(`${L.installing} holds what an install or update left half way.`);
        if (await consent('Remove it?')) removeProgramFolder(L, L.installing);
      }
    }
    for (const left of [L.broken, L.maintenanceNext, L.maintenanceOld]) {
      if (!existsSync(left)) continue;
      m.out(`${left} was left by a past run.`);
      if (await consent('Remove it?')) removeProgramFolder(L, left);
    }
    report('leftovers', 'done');

    // ---------------------------------------------------------- 4. the program

    report('program', 'running');
    const info = readInstallInfo(L);
    if (appTest.ok) {
      m.out(`The program in ${L.app} is version ${appTest.version}, and it passes its tests.`);
    } else {
      m.out(`The program in ${L.app} does not work: ${appTest.reason}`);
      const previous = existsSync(L.previous) ? await testProgram(m, L.previous) : undefined;
      if (previous?.ok === true) {
        m.out(`${L.previous} holds version ${previous.version}, the version before the last update, and it passes its tests.`);
        if (await consent(`Put version ${previous.version} back in ${L.app}? This needs no network.`)) {
          for (const s of servicesOf(m, L.app)) if (s.root !== undefined) await stopService(m, s.root).catch(() => undefined);
          swapIn(m, L.previous);
          appTest = await testProgram(m, L.app);
          if (appTest.ok) m.out(`Version ${appTest.version} is back in ${L.app}.`);
        }
      } else if (!gitOk || !npmOk) {
        m.out('The program cannot be built again without git and npm.');
      } else {
        try {
          const repo = info?.repo ?? (await originUrl(m, L.app)) ?? m.repo;
          let version = info?.version ?? folderVersion(L.app);
          if (version === undefined) {
            const latest = newest(await releaseTags(m, repo, L.home));
            if (latest === undefined) throw new Error(`${repo} has no release.`);
            version = latest.slice(1);
          }
          const tag = tagOf(version);
          if (await consent(`Get release ${tag} again from ${repo}, build it and put it in ${L.app}? This takes a minute or two.`)) {
            await buildRelease(m, repo, tag);
            const built = await testProgram(m, L.installing, version);
            if (!built.ok) throw new Error(`The new build does not pass its tests: ${built.reason}`);
            for (const s of servicesOf(m, L.app)) if (s.root !== undefined) await stopService(m, s.root).catch(() => undefined);
            swapIn(m, L.installing);
            appTest = await testProgram(m, L.app);
            if (appTest.ok) m.out(`Version ${appTest.version} is built again in ${L.app}.`);
          }
        } catch (err) {
          removeProgramFolder(L, L.installing);
          m.out(`The program could not be built again: ${errorText(err)}`);
        }
      }
    }
    if (appTest.ok) {
      const repo = info?.repo ?? (await originUrl(m, L.app)) ?? m.repo;
      if (info?.version !== appTest.version || info.repo !== repo) {
        writeInstallInfo(L, {
          repo,
          version: appTest.version,
          installedAt: info?.installedAt || m.now().toISOString(),
          ...(info?.link !== undefined ? { link: info.link } : {}),
        });
      }
      report('program', 'done');
    } else {
      still.push(`The program in ${L.app} does not work.`);
      report('program', 'failed');
    }

    // ---------------------------------------------------------- 5. the command and its link

    report('command', 'running');
    if (commandFileIsCurrent(L)) m.out(`The command ${L.command} is in order.`);
    else {
      m.out(`The command ${L.command} is missing or out of date.`);
      if (await consent('Write it again?')) {
        writeCommandFile(L);
        m.out(`Wrote ${L.command}.`);
      } else still.push(`The command ${L.command} is missing or out of date.`);
    }
    const link = readInstallInfo(L)?.link;
    if (link !== undefined) {
      const state = linkState(link, L.command);
      if (state === 'ours') m.out(`The link ${link} is in order.`);
      else if (state === 'other') m.out(`${link} is no longer a link to the command, so it is left alone.`);
      else if (existsSync(dirname(link))) {
        m.out(`The link ${link} to the command is missing.`);
        if (await consent('Make it again?')) {
          try {
            if (state === 'wrong') unlinkSync(link);
            symlinkSync(L.command, link);
            m.out(`Linked ${link} to ${L.command}.`);
          } catch (err) {
            m.out(`The link could not be made: ${errorText(err)}`);
          }
        }
      }
    }
    report('command', 'done');

    // ---------------------------------------------------------- 6. the maintenance program

    report('maintenance', 'running');
    if (appTest.ok) {
      if (maintenanceMatches(L, appTest.version)) m.out(`The maintenance program in ${L.maintenance} is version ${appTest.version}, like the program.`);
      else if (!hasMaintenanceProgram(L.app)) m.out(`The program of version ${appTest.version} has no maintenance program. An update brings one.`);
      else {
        m.out(`The maintenance program in ${L.maintenance} is ${folderVersion(L.maintenance) === undefined ? 'missing' : `version ${folderVersion(L.maintenance)}`}, not ${appTest.version}.`);
        if (await consent('Copy it again from the program?')) {
          copyMaintenance(L, L.app);
          m.out(`Copied the maintenance program of version ${appTest.version} to ${L.maintenance}.`);
        } else still.push('The maintenance program does not match the program.');
      }
    }
    report('maintenance', 'done');

    // ---------------------------------------------------------- 7. the services

    report('services', 'running');
    const services = servicesOf(m, L.app);
    const notRunning: { root: string; reason: string }[] = [];
    if (services.length === 0) m.out(`No service file in ${m.launchAgents} runs this program.`);
    for (const s of services) {
      if (s.root === undefined) {
        m.out(`The service file ${s.plist} names no root folder. It is left alone.`);
        continue;
      }
      if (!appTest.ok) {
        notRunning.push({ root: s.root, reason: 'the program does not work' });
        continue;
      }
      const h = await m.findHarness(s.root);
      const loaded = await isLoaded(m, s.label);
      if (loaded && h?.version === appTest.version) {
        m.out(`The service of ${s.root} runs, and its harness answers with version ${appTest.version}.`);
        continue;
      }
      m.out(`The service of ${s.root} ${!loaded ? 'is not loaded' : h === undefined ? 'is loaded, but its harness does not answer' : `runs a harness of version ${h.version ?? 'unknown'}`}.`);
      if (!(await consent('Install the service again and start it?'))) {
        notRunning.push({ root: s.root, reason: 'it was left as it is' });
        continue;
      }
      try {
        if (loaded || h !== undefined) await stopService(m, s.root);
        await startService(m, s.root, L.app, appTest.version);
        m.out(`The harness of ${s.root} runs, with version ${appTest.version}.`);
      } catch (err) {
        m.out(`The harness of ${s.root} does not start: ${errorText(err)}`);
        notRunning.push({ root: s.root, reason: errorText(err) });
      }
    }
    if (o.root !== undefined) {
      const given = resolve(o.root);
      if (!services.some((s) => s.root === given)) {
        m.out(`No service runs the agent of ${given}. Install it with: mission-agent service install --root ${shellQuote(given)}`);
      }
    }
    report('services', notRunning.length === 0 ? 'done' : 'failed');

    // ---------------------------------------------------------- 8. the data

    report('data', 'running');
    for (const r of notRunning) {
      if (!appTest.ok) {
        still.push(`The harness of ${r.root} cannot start while the program does not work.`);
        continue;
      }
      const copy = newestRootCopy(r.root);
      if (copy === undefined) {
        still.push(`The harness of ${r.root} does not start, and no copy of its root folder was made by an update. Its log is ${join(r.root, 'state', 'logs', 'harness.err.log')}.`);
        continue;
      }
      m.out(`The harness of ${r.root} still does not start. The newest copy of its root folder is ${copy.dir}, made before an update from version ${copy.version}.`);
      m.out('Putting it back replaces the content of the root folder, except backups/. What changed since the copy is lost.');
      // A person answers this each time. --yes does not cover it.
      const answer = await yesNo(m, 'Put this copy back? [y/N] ', false);
      if (answer !== true) {
        still.push(
          answer === undefined
            ? `The harness of ${r.root} does not start. Run "mission-agent repair" where a person can answer, to be asked about the copy ${copy.dir}.`
            : `The harness of ${r.root} does not start. The copy ${copy.dir} was not put back.`,
        );
        continue;
      }
      try {
        await stopService(m, r.root).catch(() => undefined);
        restoreRootFolder(pathsFor(r.root), copy.dir);
        m.out(`Put the copy ${copy.dir} back in ${r.root}.`);
        await startService(m, r.root, L.app, appTest.version);
        m.out(`The harness of ${r.root} runs, with version ${appTest.version}.`);
      } catch (err) {
        still.push(`The harness of ${r.root} does not start, even with the copy put back: ${errorText(err)}`);
      }
    }
    report('data', still.length === 0 ? 'done' : 'failed');
  } finally {
    releaseLock(L, m.pid);
  }

  m.out('');
  if (still.length === 0 && !nobody) {
    m.out('Everything is in order.');
    return 0;
  }
  if (nobody) m.out('Nobody could confirm the fixes, so some were not made. Run it with --yes to fix without a question.');
  if (still.length > 0) {
    m.out('Still wrong:');
    for (const s of still) m.out(`  ${s}`);
  }
  return 1;
}

/** Moves a tested program folder into `app`. A program already in `app` is moved aside first, and removed after. */
function swapIn(m: Maint, from: string): void {
  const L = m.layout;
  removeProgramFolder(L, L.broken);
  if (existsSync(L.app)) renameSync(L.app, L.broken);
  renameSync(from, L.app);
  removeProgramFolder(L, L.broken);
}

/** Whether a path is a link to the command, a link elsewhere or another file, or nothing. */
function linkState(path: string, command: string): 'ours' | 'wrong' | 'other' | 'missing' {
  try {
    const st = lstatSync(path);
    if (!st.isSymbolicLink()) return 'other';
    return readlinkSync(path) === command ? 'ours' : 'other';
  } catch {
    return 'missing';
  }
}
