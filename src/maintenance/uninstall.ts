import { existsSync, lstatSync, readlinkSync, realpathSync, rmdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { bootoutAndWait } from '../service/service.js';
import { errorText, yesNo, type Maint } from './context.js';
import { MaintenanceError, readInstallInfo, removeProgramFolder } from './files.js';
import { lockHolder, releaseLock, takeLock } from './journal.js';
import { homeProblem, PROGRAM_FOLDERS } from './layout.js';
import { servicesOf, type ServiceFile } from './ops.js';

/**
 * The uninstall (chapter 7.5). It removes the program, the maintenance program and the services,
 * and keeps the agent's data. With `wipeData`, it also deletes the agent's root folders and its
 * secrets, after two questions that a person must answer.
 */

export interface UninstallOptions {
  wipeData: boolean;
  yes: boolean;
  root?: string;
}

/** The folders of the PATH where the install links the command. */
export function linkFolders(userHome: string): string[] {
  return ['/opt/homebrew/bin', '/usr/local/bin', join(userHome, '.local', 'bin'), join(userHome, 'bin')];
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The real path of a folder when it looks like an agent's root folder, else undefined. It must be
 * an absolute path, not /, not the home folder or a folder above it, and hold both a missions
 * folder and a state folder.
 */
export function agentRootPath(path: string, userHome: string): string | undefined {
  if (!isAbsolute(path) || !isDir(path)) return undefined;
  let real: string;
  let homeReal: string;
  try {
    real = realpathSync(path);
    homeReal = realpathSync(userHome);
  } catch {
    return undefined;
  }
  if (real === '/' || `${homeReal}/`.startsWith(`${real}/`) || `${userHome}/`.startsWith(`${real}/`)) return undefined;
  return isDir(join(real, 'missions')) && isDir(join(real, 'state')) ? real : undefined;
}

/** Stops one service, then removes its file. It needs nothing of the program, which may be broken. */
async function removeService(m: Maint, s: ServiceFile): Promise<void> {
  if (!/^local\.mission-agent\.[A-Za-z0-9._-]+$/.test(s.label) || basename(s.plist) !== `${s.label}.plist`) {
    throw new MaintenanceError(`The service file ${s.plist} has an unexpected name. Nothing more was removed.`);
  }
  // The service may not be loaded. Then there is nothing to stop.
  if ((await m.launchctl(['print', `gui/${m.uid}/${s.label}`])).code === 0) {
    try {
      await bootoutAndWait({ launchctl: m.launchctl, removalWaitMs: 40_000 }, { domain: `gui/${m.uid}`, label: s.label }, `the service ${s.label}`);
    } catch (err) {
      throw new MaintenanceError(`The service ${s.label} did not stop: ${errorText(err)} Nothing more was removed.`);
    }
  }
  rmSync(s.plist, { force: true });
  m.out(`Removed the service ${s.label} (${s.plist}).`);
}

function isLinkTo(path: string, target: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path) === target;
  } catch {
    return false;
  }
}

export async function runUninstall(m: Maint, o: UninstallOptions): Promise<number> {
  const L = m.layout;
  const problem = homeProblem(L.home);
  if (problem !== undefined) {
    m.out(`${problem} Nothing was removed.`);
    return 1;
  }
  const busy = lockHolder(L, m.alive);
  if (busy !== undefined && busy !== m.pid) {
    m.out(`Another run of the maintenance program is in progress (process ${busy}). Wait until it ends. Nothing was removed.`);
    return 1;
  }

  // The services of this program, and the root folder that each one runs.
  const services = servicesOf(m, L.app);
  const candidates: string[] = [];
  const addCandidate = (r: string | undefined) => {
    if (r !== undefined && r !== '' && !candidates.includes(r)) candidates.push(r);
  };
  for (const s of services) addCandidate(s.root);
  if (o.root !== undefined) addCandidate(o.root === '~' ? m.userHome : o.root.startsWith('~/') ? join(m.userHome, o.root.slice(2)) : resolve(o.root));
  const defaultRoot = join(m.userHome, 'mission-agent');
  if (existsSync(defaultRoot)) addCandidate(defaultRoot);

  // The links to the command that the install made.
  const links = linkFolders(m.userHome)
    .map((d) => join(d, 'mission-agent'))
    .filter((p) => isLinkTo(p, L.command));
  const recorded = readInstallInfo(L)?.link;
  if (recorded !== undefined && isLinkTo(recorded, L.command) && !links.includes(recorded)) links.push(recorded);

  // What is removed of the program.
  const remove: string[] = [];
  for (const s of services) remove.push(`the service file ${s.plist}`);
  const folderText: Record<string, string> = {
    app: 'the program folder',
    'app.installing': 'the folder of an install or update that stopped half way,',
    'app.previous': 'the program of the version before the last update,',
    'app.broken': 'a program folder that a repair moved aside,',
    maintenance: 'the maintenance program',
    'maintenance.installing': 'a copy of the maintenance program that was not finished,',
    'maintenance.old': 'an old copy of the maintenance program,',
  };
  const folders = PROGRAM_FOLDERS.map((f) => join(L.home, f)).filter(present);
  for (const f of folders) remove.push(`${folderText[basename(f)] ?? 'the folder'} ${f}`);
  const files = [L.command, L.installInfo, L.journal, L.lock, L.log, L.server, L.oldLog].filter(present);
  for (const f of files) remove.push(f === L.command ? `the command ${f}` : `the file ${f}`);
  for (const l of links) remove.push(`the link to the command ${l}`);

  // With --wipe-data: the root folders that look like an agent's, and the others, which are left alone.
  const roots: string[] = [];
  const alone: string[] = [];
  let secrets = false;
  if (o.wipeData) {
    for (const r of candidates) {
      const real = agentRootPath(r, m.userHome);
      if (real !== undefined) {
        if (!roots.includes(real)) roots.push(real);
      } else alone.push(r);
    }
    secrets = (await m.security(['find-generic-password', '-s', m.keychainService])).code === 0;
  }

  if (remove.length === 0 && roots.length === 0 && !secrets) {
    m.out(`Nothing of mission-agent was found in ${L.home}. Nothing was removed.`);
    return 0;
  }

  m.out('');
  if (o.wipeData) {
    if (o.yes || !m.ask.canAsk()) {
      if (o.yes) {
        m.out("--yes does not cover the deletion of the agent's data. Run it without --yes, and answer the two questions. Nothing was removed.");
        return 1;
      }
      m.out("Deleting the agent's data needs a person to answer two questions, and nobody can be asked. Nothing was removed.");
      return 1;
    }
    m.out("This removes the program and its services, and deletes the agent's data:");
    for (const r of remove) m.out(`  ${r}`);
    for (const r of roots) m.out(`  the agent's root folder ${r}, with everything in it`);
    if (secrets) m.out(`  every item of the Keychain service ${m.keychainService}: the agent's secrets`);
    if (alone.length > 0) {
      m.out("Left alone, because they are not agent root folders. An agent's root folder holds a missions folder and a state folder:");
      for (const a of alone) m.out(`  ${a}`);
    }
    m.out('This cannot be undone. The copies in backups/ inside each root folder are deleted too.');
    if ((await yesNo(m, 'Delete all of this? [y/N] ', false)) !== true) {
      m.out('Nothing was removed.');
      return 0;
    }
    const typed = await m.ask.line('To confirm, type the word delete: ');
    if (typed?.trim() !== 'delete') {
      m.out('Nothing was removed.');
      return 0;
    }
  } else {
    m.out('This removes the program and its services:');
    for (const r of remove) m.out(`  ${r}`);
    if (!o.yes) {
      const answer = await yesNo(m, 'Remove these? [y/N] ', false);
      if (answer === undefined) {
        m.out('Nobody can confirm the uninstall. Run it with --yes to uninstall without a question. Nothing was removed.');
        return 1;
      }
      if (!answer) {
        m.out('Nothing was removed.');
        return 0;
      }
    }
  }

  const lock = takeLock(L, m.pid, m.alive);
  if (!lock.ok) {
    m.out(`Another run of the maintenance program started (process ${lock.pid}). Nothing was removed.`);
    return 1;
  }
  try {
    // The services first: this stops the agent.
    for (const s of services) await removeService(m, s);

    if (o.wipeData) {
      for (const r of roots) {
        // Checked again just before, so that only the folder that was shown is deleted.
        if (agentRootPath(r, m.userHome) !== r) throw new MaintenanceError(`${r} changed since the question. It was not deleted. Nothing more was removed.`);
        rmSync(r, { recursive: true, force: true });
        m.out(`Deleted the agent's root folder ${r}.`);
      }
      let deleted = 0;
      while (deleted < 200 && (await m.security(['delete-generic-password', '-s', m.keychainService])).code === 0) deleted++;
      m.out(`Deleted ${deleted === 1 ? '1 item' : `${deleted} items`} of the Keychain service ${m.keychainService}.`);
    }

    for (const l of links) if (isLinkTo(l, L.command)) unlinkSync(l);
    for (const f of folders) removeProgramFolder(L, f);
    for (const f of files) if (f !== L.lock) rmSync(f, { force: true });
  } catch (err) {
    m.out(errorText(err));
    return 1;
  } finally {
    releaseLock(L, m.pid);
  }
  // rmdir removes a folder only when it is empty, so a folder that holds anything else stays.
  for (const d of [L.bin, L.home]) {
    try {
      rmdirSync(d);
    } catch {
      // Not empty, or already gone.
    }
  }
  m.out('Removed the program.');

  m.out('');
  if (existsSync(L.home)) m.out(`${L.home} holds other files, so it is kept.`);
  if (o.wipeData) {
    if (alone.length > 0) {
      m.out("Kept, because it is not an agent's root folder:");
      for (const a of alone) m.out(`  ${a}`);
    }
    m.out('Kept: Node.js and git.');
    m.out('A sign-in with a Claude plan belongs to Claude Code. The uninstall does not remove it.');
  } else {
    m.out('Kept:');
    for (const r of candidates) if (existsSync(r)) m.out(`  the agent's root folder ${r}`);
    m.out("  the agent's secrets in the Keychain");
    m.out('  Node.js and git');
    m.out("To delete the agent's data later, delete its root folder. Then, in the Keychain Access app,");
    m.out(`delete each item of the service ${m.keychainService}.`);
  }
  return 0;
}

/** True when the path exists, a link that leads nowhere included. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
