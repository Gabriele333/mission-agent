import { accessSync, constants, existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { shellQuote } from '../shell.js';
import { failureText } from '../update/command.js';
import { errorText, yesNo, type Maint } from './context.js';
import {
  copyMaintenance,
  hasMaintenanceProgram,
  readInstallInfo,
  removeProgramFolder,
  writeCommandFile,
  writeInstallInfo,
} from './files.js';
import { releaseLock, takeLock } from './journal.js';
import { homeProblem } from './layout.js';
import { buildRelease, newest, originUrl, releaseTags, servicesOf, tagOf, testProgram } from './ops.js';
import { linkFolders, runUninstall } from './uninstall.js';

/**
 * The install (chapter 7.2): everything after the program is built. The install script builds a
 * release in `app.installing` when no maintenance program can run, and hands it over with `staged`.
 */

export interface InstallOptions {
  root?: string;
  /** A release tag such as `v0.2.0`. Default: the newest release. */
  version?: string;
  service: 'ask' | 'yes' | 'no';
  link: boolean;
  open: boolean;
  reinstall: boolean;
  yes: boolean;
  /** A built release that the install script hands over. It must be `<home>/app.installing`. */
  staged?: string;
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function writableDir(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function expand(m: Maint, path: string): string {
  if (path === '~') return m.userHome;
  if (path.startsWith('~/')) return join(m.userHome, path.slice(2));
  return resolve(path);
}

export async function runInstall(m: Maint, o: InstallOptions): Promise<number> {
  const L = m.layout;
  const problem = homeProblem(L.home);
  if (problem !== undefined) {
    m.out(problem);
    return 1;
  }
  mkdirSync(L.home, { recursive: true });
  const lock = takeLock(L, m.pid, m.alive);
  if (!lock.ok) {
    m.out(`Another run of the maintenance program is in progress (process ${lock.pid}). Wait until it ends, then run this again.`);
    return 1;
  }
  let locked = true;
  const unlock = () => {
    if (locked) releaseLock(L, m.pid);
    locked = false;
  };
  try {
    return await installLocked(m, o, unlock);
  } catch (err) {
    m.out(errorText(err));
    return 1;
  } finally {
    unlock();
  }
}

async function installLocked(m: Maint, o: InstallOptions, unlock: () => void): Promise<number> {
  const L = m.layout;
  // As in the install script, --yes means that nobody is asked.
  const canAsk = () => !o.yes && m.ask.canAsk();
  const fail = (text: string): number => {
    m.out(text);
    return 1;
  };
  if (o.staged !== undefined && resolve(o.staged) !== L.installing) {
    return fail(`--staged must be ${L.installing}, the folder where the install script builds a release. Nothing was changed.`);
  }
  const staged = o.staged !== undefined;

  // ---------------------------------------------------------------- the program

  // A past install is continued, or removed and installed again (from scratch). With nobody to
  // ask, it is continued, unless --reinstall says otherwise.
  let fresh = false;
  if (present(L.app)) {
    if (o.reinstall) fresh = true;
    else if (existsSync(join(L.app, 'dist', 'cli.js'))) {
      if (canAsk()) {
        const shown = await m.run(m.nodePath, [join(L.app, 'dist', 'cli.js'), '--version'], { cwd: L.home, timeoutMs: 60_000 });
        const found = shown.code === 0 ? shown.stdout.trim().split('\n')[0] : undefined;
        m.out('');
        m.out(found !== undefined && found !== '' && found !== 'unknown' ? `A past install was found in ${L.app}. It is version ${found} of the program.` : `A past install was found in ${L.app}.`);
        m.out('  1. Continue the setup with this program.');
        m.out('  2. Remove the program and install it again from scratch.');
        m.out("  3. Uninstall the program and its services. The agent's data is kept.");
        m.out("  4. Uninstall, and delete the agent's data too.");
        for (;;) {
          const answer = (await m.ask.line('Which one? Press Enter for 1: '))?.trim();
          if (answer === undefined || answer === '' || answer === '1') break;
          if (answer === '2') {
            fresh = true;
            break;
          }
          if (answer === '3' || answer === '4') {
            unlock();
            return runUninstall(m, { wipeData: answer === '4', yes: false, ...(o.root !== undefined ? { root: o.root } : {}) });
          }
          m.out('Type 1, 2, 3 or 4.');
        }
      }
    } else if (canAsk()) {
      m.out('');
      m.out(`${L.app} exists, but it holds no built program, so the setup cannot continue with it.`);
      if ((await yesNo(m, 'Remove it and install the program again? [Y/n] ', true)) === false) {
        return fail(`Remove the folder ${L.app}, then run this again.`);
      }
      fresh = true;
    } else {
      return fail(`${L.app} exists, but it holds no built program. Remove the folder, then run this again.`);
    }
  }

  if (fresh) {
    // A service that runs this program would break when the program is removed.
    const services = servicesOf(m, L.app);
    if (services.length > 0) {
      m.out(`A service runs the program in ${L.app}. Removing the program would break the agent.`);
      m.out('The service files:');
      for (const s of services) m.out(`  ${s.plist}`);
      m.out('Remove each service first with: mission-agent service uninstall --root <its root folder>');
      m.out('Or get a newer release with: mission-agent update --root <the agent\'s root folder>');
      m.out('If the program does not work, run: mission-agent repair');
      return fail('Nothing was removed.');
    }
    m.out(`The program in ${L.app} is removed and installed again. The agent's root folder is not touched.`);
  }

  if (!fresh && present(L.app)) {
    m.out(`The program is already installed in ${L.app}. It is left as it is.`);
    m.out("To install a newer release, run: mission-agent update --root <the agent's root folder>");
    if (staged) removeProgramFolder(L, L.installing);
  } else {
    if (!staged) {
      if (existsSync(L.installing)) m.out(`An install that stopped half way was found in ${L.installing}. It starts again.`);
      let tag: string;
      if (o.version !== undefined) tag = tagOf(o.version);
      else {
        m.out(`Looking for the newest release of ${m.repo}.`);
        const latest = newest(await releaseTags(m, m.repo, L.home));
        if (latest === undefined) return fail(`${m.repo} has no release yet. A release is a tag such as v0.2.0.`);
        tag = latest;
      }
      try {
        await buildRelease(m, m.repo, tag);
      } catch (err) {
        removeProgramFolder(L, L.installing);
        return fail(errorText(err));
      }
    }
    const tested = await testProgram(m, L.installing, o.version === undefined ? undefined : tagOf(o.version).slice(1));
    if (!tested.ok) {
      removeProgramFolder(L, L.installing);
      return fail(`The new program does not pass its tests: ${tested.reason}\nNothing was installed. The output is in ${L.log}.`);
    }
    if (fresh) {
      removeProgramFolder(L, L.app);
      removeProgramFolder(L, L.previous);
    }
    renameSync(L.installing, L.app);
    m.out(`Installed release v${tested.version} in ${L.app}.`);
  }

  // ---------------------------------------------------------------- the maintenance program and the command

  const appTest = await testProgram(m, L.app);
  const version = appTest.ok ? appTest.version : undefined;
  if (!appTest.ok) m.out(`The program in ${L.app} does not pass its tests: ${appTest.reason}\nRun "mission-agent repair" after the install.`);
  if (hasMaintenanceProgram(L.app)) copyMaintenance(L, L.app);
  else m.out(`The program in ${L.app} has no maintenance program. An update brings one.`);
  writeCommandFile(L);

  let name = L.command;
  let linked: string | undefined;
  if (o.link) {
    const onPath = m.envPath.split(':');
    for (const dir of linkFolders(m.userHome)) {
      if (!onPath.includes(dir) || !writableDir(dir)) continue;
      const path = join(dir, 'mission-agent');
      // A command of the same name that the install did not write is left alone.
      if (present(path)) {
        let target = '';
        try {
          target = readlinkSync(path);
        } catch {
          continue;
        }
        if (target !== L.command) continue;
        unlinkSync(path);
      }
      symlinkSync(L.command, path);
      linked = path;
      name = 'mission-agent';
      break;
    }
    if (linked !== undefined) m.out(`The command is mission-agent (${linked}).`);
    else {
      m.out(`The command is ${L.command}.`);
      m.out('To type only "mission-agent", add this line to ~/.zshrc and open a new terminal:');
      m.out(`  export PATH="${L.bin}:$PATH"`);
    }
  } else m.out(`The command is ${L.command}.`);

  const before = readInstallInfo(L);
  const link = linked ?? before?.link;
  writeInstallInfo(L, {
    repo: (await originUrl(m, L.app)) ?? before?.repo ?? m.repo,
    version: version ?? before?.version ?? 'unknown',
    installedAt: m.now().toISOString(),
    ...(link !== undefined ? { link } : {}),
  });
  unlock();

  // ---------------------------------------------------------------- the agent's root folder

  const cli = join(L.app, 'dist', 'cli.js');
  let root = o.root;
  if (root === undefined || root === '') {
    if (canAsk()) {
      m.out('');
      m.out('The agent keeps its data in one folder: its configuration, its missions, their memory and its database.');
      root = (await m.ask.line('Which folder? Press Enter for ~/mission-agent: '))?.trim() ?? '';
    }
    if (root === undefined || root === '') {
      if (o.yes || canAsk()) root = join(m.userHome, 'mission-agent');
      else {
        m.out('');
        m.out('No root folder was given, and nobody can be asked, so the agent is not started.');
        m.out('Choose a folder, then run:');
        m.out(`  ${name} service install --root <folder>`);
        m.out(`  ${name} setup --root <folder>`);
        return 0;
      }
    }
  }
  root = expand(m, root);
  const q = shellQuote(root);

  // ---------------------------------------------------------------- the service

  let service = o.service;
  if (service === 'ask') {
    if (o.yes) service = 'yes';
    else if (canAsk()) {
      m.out('');
      m.out('The service makes macOS start the agent at login and after a crash. It needs no password.');
      m.out('It writes one file in ~/Library/LaunchAgents. Switch it off in System Settings, General, Login Items.');
      service = (await yesNo(m, 'Install the service? [Y/n] ', true)) === false ? 'no' : 'yes';
    } else service = 'no';
  }

  if (service !== 'yes') {
    m.out('');
    m.out('The service is not installed. To run the agent until Ctrl+C:');
    m.out(`  ${name} start --root ${q}`);
    m.out('To install the service later:');
    m.out(`  ${name} service install --root ${q}`);
    m.out('To check the settings of this computer that the agent depends on:');
    m.out(`  ${name} check --root ${q}`);
    return 0;
  }

  m.out('');
  // The whole output goes to the log. The terminal shows it only when the install fails.
  const installed = await m.run(m.nodePath, [cli, 'service', 'install', '--root', root], { cwd: L.home, timeoutMs: 120_000 });
  const serviceOut = `${installed.stdout}${installed.stderr}`;
  if (installed.code !== 0) {
    m.out(failureText(installed, 30));
    return fail('The service could not be installed. The program itself is installed.');
  }
  const plistPath = /^ {2}File: +(.+)$/m.exec(serviceOut)?.[1]?.trim();
  m.out('The service is installed. It starts the agent now, at each login and after a crash.');
  m.out(`Its file is ${plistPath ?? 'in ~/Library/LaunchAgents'}. The details are in ${L.log}.`);
  // A start that launchd held back, or that failed, is still shown in full.
  const lines = serviceOut.split('\n');
  const from = lines.findIndex((l) => l.startsWith('launchctl could not start it now') || l.startsWith('Warning:'));
  if (from !== -1) for (const l of lines.slice(from)) if (l !== '') m.out(l);

  // The service starts the harness. It answers within a few seconds.
  const deadline = m.now().getTime() + 30_000;
  while ((await m.findHarness(root)) === undefined) {
    if (m.now().getTime() >= deadline) {
      await m.runAttached(m.nodePath, [cli, 'service', 'status', '--root', root]);
      return fail(`The service is installed, but the agent does not answer. Its log is ${join(root, 'state', 'logs', 'harness.err.log')}.`);
    }
    await m.sleep(1000);
  }
  await m.run(m.nodePath, [cli, 'service', 'status', '--root', root], { cwd: L.home, timeoutMs: 60_000 });
  m.out('');
  m.out('The agent runs as a service.');

  // ---------------------------------------------------------------- the settings of the computer

  // The setup continues in the browser when the page may open, a person can be asked, and this is
  // not an SSH session. Over SSH, the browser would open on the screen of this computer, and the
  // page answers only on this computer. The terminal checks the settings in the other cases.
  const ssh = (m.env.SSH_CONNECTION ?? '') !== '' || (m.env.SSH_TTY ?? '') !== '';
  const inBrowser = o.open && canAsk() && !ssh;
  m.out('');
  if (inBrowser) {
    m.out('The setup continues in the browser. The setup page also checks the settings of this computer.');
    m.out(`To check them again later: ${name} check --root ${q}`);
  } else {
    // The check only reads. With a person to ask, it goes through each setting that is not in order.
    m.out('Checking the settings of this computer that the agent depends on.');
    await m.runAttached(m.nodePath, canAsk() ? [cli, 'check', '--guide', '--root', root] : [cli, 'check', '--root', root]);
    m.out(`To check again later: ${name} check --root ${q}`);
    m.out('The setup page shows the same checks, under Computer.');
  }
  m.out('');

  // ---------------------------------------------------------------- the setup page

  if (inBrowser) {
    m.out('Opening the setup page, where you enter the model login and the rest of the configuration.');
    if ((await m.runAttached(m.nodePath, [cli, 'setup', '--root', root])) === 0) m.out(`To open it again: ${name} setup --root ${q}`);
    else m.out(`Open it with: ${name} setup --root ${q}`);
  } else {
    m.out(`Configure it on the setup page: ${name} setup --root ${q}`);
  }
  m.out(`Chat with it: ${name} chat --root ${q}`);
  return 0;
}
