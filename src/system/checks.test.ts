import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathsFor } from '../paths.js';
import { installService, type LaunchctlResult, type ServiceOptions } from '../service/index.js';
import type { CommandResult } from '../update/index.js';
import { openChecks, runSystemChecks, SETTINGS, type SystemCheck, type SystemCheckDeps } from './checks.js';

/** A computer made of fakes: launchctl, the system commands and a home folder. Every test starts with all in order. */
let tmp: string;
let home: string;
let root: string;
let cliPath: string;
let launchd: { service: LaunchctlResult; session: string; disabled: string };
let commands: Record<string, CommandResult>;
let ran: string[];
let keychain: () => Promise<unknown>;

const NOT_FOUND: LaunchctlResult = { code: 113, stdout: '', stderr: 'Could not find service' };
const out = (stdout: string, stderr = ''): CommandResult => ({ code: 0, stdout, stderr });

const DESKTOP_POWER = ['AC Power:', ' Sleep On Power Button 1', ' autorestart          1', ' sleep                0', ' womp                 1', ''].join('\n');
const LAPTOP_POWER = ['Battery Power:', ' sleep                1', 'AC Power:', ' powermode            0', ' sleep                10', ''].join('\n');

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mission-agent-system-')));
  home = join(tmp, 'home');
  root = join(home, 'mission-agent');
  mkdirSync(root, { recursive: true });
  mkdirSync(join(home, 'Documents'));
  cliPath = join(tmp, 'dist', 'cli.js');
  mkdirSync(join(tmp, 'dist'));
  writeFileSync(cliPath, '');
  launchd = { service: NOT_FOUND, session: 'gui/501 = {\n\ttype = login\n\ton-demand count = 0\n}\n', disabled: '\tdisabled services = {\n\t}\n' };
  commands = {
    git: out('git version 2.50.0\n'),
    defaults: out('ada\n'),
    pmset: out(DESKTOP_POWER),
    sysadminctl: out('', '2026-01-01 sysadminctl[1:2] screenLock delay is immediate\n'),
    fdesetup: out('FileVault is Off.\n'),
  };
  ran = [];
  keychain = async () => true;
});

afterEach(() => {
  chmodSync(root, 0o700);
  rmSync(tmp, { recursive: true, force: true });
});

function serviceOptions(): ServiceOptions {
  return {
    root,
    cliPath,
    nodePath: process.execPath,
    uid: 501,
    envPath: '/usr/bin:/bin',
    launchAgentsDir: join(tmp, 'LaunchAgents'),
    findHarness: async () => undefined,
    launchctl: async (args) => {
      if (args[0] === 'print' && args[1] === 'gui/501') return { code: 0, stdout: launchd.session, stderr: '' };
      if (args[0] === 'print-disabled') return { code: 0, stdout: launchd.disabled, stderr: '' };
      if (args[0] === 'print') return launchd.service;
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

function deps(extra: Partial<SystemCheckDeps> = {}): SystemCheckDeps {
  return {
    paths: pathsFor(root),
    service: serviceOptions(),
    keychain: () => keychain(),
    user: 'ada',
    home,
    run: async (program, args) => {
      const name = program.split('/').pop() as string;
      ran.push(`${name} ${args.join(' ')}`);
      return commands[name] ?? { code: 127, stdout: '', stderr: 'not found' };
    },
    ...extra,
  };
}

/** Installs the service in the fake launchd and makes it run. */
async function installed(): Promise<void> {
  await installService(serviceOptions());
  launchd.service = { code: 0, stdout: '\tstate = running\n\tpid = 4242\n', stderr: '' };
}

async function check(id: string, extra?: Partial<SystemCheckDeps>): Promise<SystemCheck> {
  const found = (await runSystemChecks(deps(extra))).find((c) => c.id === id);
  if (found === undefined) throw new Error(`There is no check ${id}.`);
  return found;
}

describe('the checks of the computer', () => {
  it('finds everything in order on a computer that is set up to run the agent with nobody at it', async () => {
    await installed();
    const checks = await runSystemChecks(deps());
    expect(checks.map((c) => [c.id, c.group, c.state])).toEqual([
      ['root-folder', 'needed', 'ok'],
      ['keychain', 'needed', 'ok'],
      ['git', 'needed', 'ok'],
      ['service', 'needed', 'ok'],
      ['launchd', 'needed', 'ok'],
      ['auto-login', 'unattended', 'ok'],
      ['screen-lock', 'unattended', 'ok'],
      ['sleep', 'unattended', 'ok'],
      ['power-failure', 'unattended', 'ok'],
    ]);
    expect(checks.every((c) => c.fix === undefined && c.command === undefined && c.settings === undefined)).toBe(true);
    expect(openChecks(checks, true)).toEqual([]);
  });

  it('only reads: it runs no command that changes a setting', async () => {
    await runSystemChecks(deps());
    expect(ran.sort()).toEqual([
      'defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser',
      'git --version',
      'pmset -g custom',
      'sysadminctl -screenLock status',
    ]);
  });
});

describe('what every agent needs', () => {
  it('reports a service that is not installed, not loaded, switched off, stopped, or that names a missing program', async () => {
    const install = `mission-agent service install --root ${root}`;
    expect(await check('service')).toMatchObject({ state: 'not_ok', command: install, detail: expect.stringContaining('The service is not installed') });

    await installService(serviceOptions());
    expect((await check('service')).detail).toContain('launchd has not loaded it');

    launchd.service = { code: 0, stdout: '\tstate = not running\n\tpended nondemand spawn = semaphore\n', stderr: '' };
    expect((await check('service')).detail).toContain('the agent does not run (launchd reports: not running, start held back: semaphore)');

    launchd.service = { code: 0, stdout: '\tstate = running\n\tpid = 7\n', stderr: '' };
    expect(await check('service')).toMatchObject({ state: 'ok', detail: 'The service is loaded, and the agent runs as process 7.' });

    const label = (await import('../service/index.js')).serviceLabel(root);
    launchd.disabled = `\tdisabled services = {\n\t\t"com.example.other" => disabled\n\t\t"${label}" => disabled\n\t}\n`;
    expect(await check('service')).toMatchObject({ state: 'not_ok', settings: SETTINGS.loginItems, detail: expect.stringContaining('switched off') });
    launchd.disabled = `\tdisabled services = {\n\t\t"${label}" => enabled\n\t}\n`;
    expect((await check('service')).state).toBe('ok');

    rmSync(cliPath);
    expect(await check('service')).toMatchObject({ state: 'not_ok', detail: expect.stringContaining(`no longer exists: ${cliPath}`) });
  });

  it('reports a login session in which launchd starts no service by itself', async () => {
    launchd.session = 'gui/501 = {\n\tactive count = 476\n\ton-demand count = 1\n}\n';
    expect(await check('launchd')).toMatchObject({
      state: 'not_ok',
      detail: expect.stringContaining('launchd reports "on-demand count = 1"'),
      fix: 'Log out of macOS and log in again, then check again.',
    });
    launchd.session = 'gui/501 = {\n}\n';
    expect((await check('launchd')).state).toBe('unknown');
  });

  it('reports a Keychain that does not answer, and git that is missing', async () => {
    keychain = async () => {
      throw new Error('User interaction is not allowed.');
    };
    expect(await check('keychain')).toMatchObject({ state: 'not_ok', detail: 'The login Keychain does not answer: User interaction is not allowed.' });
    delete commands.git;
    expect(await check('git')).toMatchObject({ state: 'not_ok', command: 'xcode-select --install' });
  });

  it('reports a root folder inside a folder that macOS protects, and one that cannot be written', async () => {
    const inDocuments = join(home, 'Documents', 'agent');
    const protectedRoot = await check('root-folder', { paths: pathsFor(inDocuments) });
    expect(protectedRoot).toMatchObject({ state: 'not_ok', detail: expect.stringContaining('is inside ~/Documents') });

    expect((await check('root-folder', { paths: pathsFor(join(home, 'not-there-yet')) })).state).toBe('ok');
    expect((await check('root-folder')).state).toBe('ok');
    // The owner of a folder can still read it as root, so this part needs an ordinary account.
    if (process.getuid?.() !== 0) {
      chmodSync(root, 0o500);
      expect(await check('root-folder')).toMatchObject({ state: 'not_ok', detail: expect.stringContaining('cannot read and write') });
    }
  });
});

describe('what a computer with nobody at it needs', () => {
  it('reports automatic login that is off, and names FileVault when it stands in the way', async () => {
    commands.defaults = { code: 1, stdout: '', stderr: "The domain/default pair of (/Library/Preferences/com.apple.loginwindow, autoLoginUser) does not exist\n" };
    const off = await check('auto-login');
    expect(off).toMatchObject({ state: 'not_ok', settings: SETTINGS.users, detail: expect.stringContaining('Automatic login is off.') });
    expect(off.fix).not.toContain('FileVault');
    // Without automatic login the screen lock is not this list's business.
    expect((await runSystemChecks(deps())).some((c) => c.id === 'screen-lock')).toBe(false);

    commands.fdesetup = out('FileVault is On.\n');
    expect((await check('auto-login')).fix).toContain('FileVault is on. With FileVault off, the disk is not encrypted.');

    commands.defaults = out('grace\n');
    expect((await check('auto-login')).detail).toContain('Automatic login is on for another account, grace.');

    commands.defaults = { code: 1, stdout: '', stderr: 'something else failed' };
    expect((await check('auto-login')).state).toBe('unknown');
  });

  it('reports a screen that does not lock at once, only when automatic login is on', async () => {
    commands.sysadminctl = out('', 'sysadminctl[1:2] screenLock delay is 300 seconds\n');
    expect(await check('screen-lock')).toMatchObject({
      state: 'not_ok',
      settings: SETTINGS.lockScreen,
      detail: expect.stringContaining('only 300 seconds after it turns off'),
    });
    commands.sysadminctl = out('', 'screenLock delay is off\n');
    expect((await check('screen-lock')).detail).toContain('never asks for the password');
    commands.sysadminctl = { code: 1, stdout: '', stderr: 'no answer' };
    expect((await check('screen-lock')).state).toBe('unknown');
  });

  it('reports sleep and the start after a power cut, with the pane of a desktop computer', async () => {
    commands.pmset = out(DESKTOP_POWER.replace('sleep                0', 'sleep                15').replace('autorestart          1', 'autorestart          0'));
    expect(await check('sleep')).toMatchObject({ state: 'not_ok', command: 'sudo pmset -c sleep 0', settings: SETTINGS.energy });
    expect(await check('power-failure')).toMatchObject({ state: 'not_ok', command: 'sudo pmset -a autorestart 1', settings: SETTINGS.energy });
  });

  it('reads the mains settings of a computer with a battery, which has no start after a power cut', async () => {
    commands.pmset = out(LAPTOP_POWER);
    const sleep = await check('sleep');
    expect(sleep).toMatchObject({ state: 'not_ok', settings: SETTINGS.battery });
    expect(sleep.detail).toContain('pmset reports sleep = 10');
    expect((await runSystemChecks(deps())).some((c) => c.id === 'power-failure')).toBe(false);

    commands.pmset = { code: 1, stdout: '', stderr: 'failed' };
    expect((await check('sleep')).state).toBe('unknown');
  });

  it('counts as open only when the user wants a computer that runs with nobody at it', async () => {
    await installed();
    commands.pmset = out(LAPTOP_POWER);
    const checks = await runSystemChecks(deps());
    expect(openChecks(checks, false)).toEqual([]);
    expect(openChecks(checks, true).map((c) => c.id)).toEqual(['sleep']);
  });
});
