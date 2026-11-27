import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPlist, serviceLabel, xmlEscape } from './plist.js';
import {
  installService,
  otherServiceFiles,
  ServiceError,
  servicePlan,
  serviceStatus,
  stableNodePath,
  uninstallService,
  type LaunchctlResult,
  type ServiceOptions,
} from './service.js';

let tmp: string;
let root: string;
let agentsDir: string;
let cliPath: string;
let calls: string[][];
/** What the fake launchctl answers to `print`. */
let printAnswer: LaunchctlResult;
let bootstrapAnswer: LaunchctlResult;

const UID = 501;
const NOT_FOUND: LaunchctlResult = { code: 113, stdout: '', stderr: 'Could not find service' };
const OK: LaunchctlResult = { code: 0, stdout: '', stderr: '' };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mission-agent-service-'));
  // A root path with every character that XML must escape.
  root = join(tmp, `my "agent" & <co> 'x'`);
  mkdirSync(root);
  agentsDir = join(tmp, 'LaunchAgents');
  cliPath = join(tmp, 'dist', 'cli.js');
  mkdirSync(join(tmp, 'dist'));
  writeFileSync(cliPath, '// the built program\n');
  calls = [];
  printAnswer = NOT_FOUND;
  bootstrapAnswer = OK;
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function options(extra: Partial<ServiceOptions> = {}): ServiceOptions {
  return {
    root,
    cliPath,
    uid: UID,
    envPath: '/opt/homebrew/bin:/usr/bin:/bin',
    launchAgentsDir: agentsDir,
    findHarness: async () => undefined,
    launchctl: async (args) => {
      calls.push(args);
      if (args[0] === 'print') return printAnswer;
      if (args[0] === 'bootstrap') return bootstrapAnswer;
      // After a bootout, launchd no longer knows the service.
      if (args[0] === 'bootout') printAnswer = NOT_FOUND;
      return OK;
    },
    ...extra,
  };
}

const label = () => serviceLabel(root);
const plistFile = () => join(agentsDir, `${label()}.plist`);

describe('the plist', () => {
  it('escapes every value of a root path with spaces, quotes, & and <', () => {
    const plan = servicePlan(options());
    const text = plan.plistText;
    expect(text).toContain('my &quot;agent&quot; &amp; &lt;co&gt; &apos;x&apos;');
    expect(text).not.toContain('<co>');
    expect(text).not.toContain('"agent"');
    expect(text).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(text).toContain('<key>SuccessfulExit</key>\n    <false/>');
  });

  it('is a valid property list with the right values, as plutil reads it', () => {
    const plan = servicePlan(options());
    const file = join(tmp, 'check.plist');
    writeFileSync(file, plan.plistText);
    const json = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' })) as Record<
      string,
      unknown
    >;
    expect(json).toEqual({
      Label: label(),
      ProgramArguments: [stableNodePath(process.execPath, '/opt/homebrew/bin:/usr/bin:/bin'), cliPath, 'start', '--root', root],
      WorkingDirectory: root,
      EnvironmentVariables: { PATH: '/opt/homebrew/bin:/usr/bin:/bin' },
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
      ExitTimeOut: 30,
      StandardOutPath: join(root, 'state', 'logs', 'harness.out.log'),
      StandardErrorPath: join(root, 'state', 'logs', 'harness.err.log'),
    });
  });

  it('refuses a control character, which XML cannot hold', () => {
    expect(() => xmlEscape('a\u0001b')).toThrow(/control character/);
    expect(() =>
      buildPlist({ label: 'x', programArguments: ['a\u0000'], workingDirectory: '/', stdoutPath: '/o', stderrPath: '/e', envPath: '/bin' }),
    ).toThrow();
  });

  it('uses a label with a short hash of the root, the same for the same root and different for another', () => {
    expect(label()).toMatch(/^local\.mission-agent\.[0-9a-f]{12}$/);
    expect(serviceLabel(root)).toBe(serviceLabel(join(root, '.')));
    expect(serviceLabel(join(tmp, 'other'))).not.toBe(label());
  });

  it('holds nothing but PATH in the environment', () => {
    const text = servicePlan(options()).plistText;
    const env = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)?.[1] ?? '';
    expect(env.match(/<key>/g)).toHaveLength(1);
    expect(env).toContain('<key>PATH</key>');
  });
});

describe('installService', () => {
  it('writes the plist, creates the log folder, loads it with launchctl bootstrap and starts it with kickstart', async () => {
    const result = await installService(options());
    expect(calls).toEqual([
      ['print', `gui/${UID}/${label()}`],
      ['bootstrap', `gui/${UID}`, plistFile()],
      ['print', `gui/${UID}/${label()}`],
      ['kickstart', `gui/${UID}/${label()}`],
    ]);
    expect(result).toEqual({ plan: result.plan, replaced: false, handover: false, heldBack: false });
    expect(readFileSync(plistFile(), 'utf8')).toBe(result.plan.plistText);
    expect(statSync(plistFile()).mode & 0o777).toBe(0o644);
    expect(existsSync(join(root, 'state', 'logs'))).toBe(true);
  });

  it('removes a loaded service first with launchctl bootout', async () => {
    printAnswer = { code: 0, stdout: `${label()} = {\n\tstate = running\n\tpid = 4321\n}\n`, stderr: '' };
    const result = await installService(options());
    expect(calls).toEqual([
      ['print', `gui/${UID}/${label()}`],
      ['bootout', `gui/${UID}/${label()}`],
      ['print', `gui/${UID}/${label()}`],
      ['bootstrap', `gui/${UID}`, plistFile()],
      ['print', `gui/${UID}/${label()}`],
      ['kickstart', `gui/${UID}/${label()}`],
    ]);
    expect(result.replaced).toBe(true);
  });

  it('waits until launchd has removed the old service, and gives up after the wait', async () => {
    const loaded = { code: 0, stdout: '\tstate = running\n\tpid = 4321\n', stderr: '' };
    let printsAfterBootout = 0;
    let booted = false;
    const slow = (removedAfter: number) =>
      options({
        removalWaitMs: 500,
        launchctl: async (args) => {
          calls.push(args);
          if (args[0] === 'bootout') booted = true;
          if (args[0] === 'print') return booted && (printsAfterBootout += 1) > removedAfter ? NOT_FOUND : loaded;
          return OK;
        },
      });
    // launchd still knows the service at the first check, and no longer at the second.
    await installService(slow(1));
    expect(calls.map((c) => c[0])).toEqual(['print', 'bootout', 'print', 'print', 'bootstrap', 'print', 'kickstart']);

    calls = [];
    booted = false;
    printsAfterBootout = 0;
    await expect(uninstallService(slow(1000))).rejects.toThrow(/launchd did not remove the service in time/);
    expect(existsSync(plistFile())).toBe(true);
  });

  it('reports a start that launchd held back, and a start that could not be asked for', async () => {
    // What launchctl prints while the login session is in on-demand-only mode.
    const held = `${label()} = {\n\tstate = not running\n\truns = 0\n\tpended nondemand spawn = speculative\n}\n`;
    let prints = 0;
    const result = await installService(
      options({
        launchctl: async (args) => {
          calls.push(args);
          if (args[0] === 'print') return (prints += 1) === 1 ? NOT_FOUND : { code: 0, stdout: held, stderr: '' };
          if (args[0] === 'kickstart') return { code: 3, stdout: '', stderr: 'Could not kickstart service' };
          return OK;
        },
      }),
    );
    expect(result.heldBack).toBe(true);
    expect(result.startError).toBe('Could not kickstart service');
    expect(await serviceStatus(options({ launchctl: async () => ({ code: 0, stdout: held, stderr: '' }) }))).toMatchObject({
      loaded: true,
      state: 'not running',
      heldBack: 'speculative',
    });
    // A service that runs is not held back, whatever else launchctl prints.
    const running = held.replace('state = not running', 'state = running\n\tpid = 12');
    expect((await serviceStatus(options({ launchctl: async () => ({ code: 0, stdout: running, stderr: '' }) }))).heldBack).toBeUndefined();
  });

  it('refuses when the built cli.js cannot be found, and writes nothing', async () => {
    await expect(installService(options({ cliPath: join(tmp, 'missing', 'cli.js') }))).rejects.toThrow(/cannot be found/);
    expect(calls).toEqual([]);
    expect(existsSync(agentsDir)).toBe(false);
  });

  it('refuses when a harness for the root runs in the foreground', async () => {
    const err = await installService(options({ findHarness: async () => ({ pid: 999 }) })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as Error).message).toContain('runs in the foreground (process 999). Stop it first');
    expect(calls.some((c) => c[0] === 'bootstrap')).toBe(false);
    expect(existsSync(plistFile())).toBe(false);
  });

  it('lets the foreground harness that serves the setup page install it, as a handover', async () => {
    const result = await installService({ ...options({ findHarness: async () => ({ pid: 999 }) }), callerPid: 999 });
    expect(result.handover).toBe(true);
    expect(existsSync(plistFile())).toBe(true);
  });

  it('refuses when the caller is the harness that the service runs, because it would stop itself', async () => {
    printAnswer = { code: 0, stdout: '\tstate = running\n\tpid = 777\n', stderr: '' };
    const err = await installService({ ...options({ findHarness: async () => ({ pid: 777 }) }), callerPid: 777 }).catch((e: unknown) => e);
    expect((err as Error).message).toContain('already runs as the service');
    expect(calls).toEqual([['print', `gui/${UID}/${label()}`]]);
  });

  it('removes the plist again when launchctl refuses to load it', async () => {
    bootstrapAnswer = { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
    await expect(installService(options())).rejects.toThrow(/could not load the service: Bootstrap failed/);
    expect(existsSync(plistFile())).toBe(false);
  });
});

describe('uninstallService and serviceStatus', () => {
  it('reports a service that is not loaded', async () => {
    expect(await serviceStatus(options())).toEqual({ label: label(), plistPath: plistFile(), installed: false, loaded: false });
    expect(calls).toEqual([['print', `gui/${UID}/${label()}`]]);
  });

  it('reads the pid and the state of a loaded service', async () => {
    await installService(options());
    printAnswer = { code: 0, stdout: `gui/501/${label()} = {\n\tactive count = 1\n\tstate = running\n\tpid = 4321\n}\n`, stderr: '' };
    expect(await serviceStatus(options())).toEqual({
      label: label(),
      plistPath: plistFile(),
      installed: true,
      loaded: true,
      pid: 4321,
      state: 'running',
    });
  });

  it('removes a loaded service with launchctl bootout and deletes the plist', async () => {
    await installService(options());
    calls = [];
    printAnswer = { code: 0, stdout: '\tstate = running\n', stderr: '' };
    const result = await uninstallService(options());
    // The print after the bootout checks that launchd has removed the service.
    expect(calls).toEqual([
      ['print', `gui/${UID}/${label()}`],
      ['bootout', `gui/${UID}/${label()}`],
      ['print', `gui/${UID}/${label()}`],
    ]);
    expect(result).toEqual({ plan: { label: label(), plistPath: plistFile(), domain: `gui/${UID}` }, wasLoaded: true, removedFile: true });
    expect(existsSync(plistFile())).toBe(false);
  });

  it('does nothing for a service that is not installed', async () => {
    const result = await uninstallService(options());
    expect(result).toMatchObject({ wasLoaded: false, removedFile: false });
    expect(calls).toEqual([['print', `gui/${UID}/${label()}`]]);
  });
});

describe('the node path of the service', () => {
  it('is a node in a folder of the PATH that leads to the program that runs, so an upgrade of node keeps it valid', () => {
    const real = realpathSync(process.execPath);
    const other = join(tmp, 'other');
    const bin = join(tmp, 'bin');
    mkdirSync(other);
    mkdirSync(bin);
    writeFileSync(join(other, 'node'), '#!/bin/sh\n');
    symlinkSync(real, join(bin, 'node'));
    expect(stableNodePath(real, `relative:${join(tmp, 'missing')}:${other}:${bin}`)).toBe(join(bin, 'node'));
  });

  it('is the program that runs when no folder of the PATH leads to it', () => {
    expect(stableNodePath(process.execPath, join(tmp, 'missing'))).toBe(process.execPath);
    expect(stableNodePath(process.execPath, '')).toBe(process.execPath);
    expect(stableNodePath(join(tmp, 'no-such-node'), '/usr/bin')).toBe(join(tmp, 'no-such-node'));
  });
});

describe('other services of the same program', () => {
  it('lists the service files of other root folders that run this built program, and not its own', async () => {
    await installService(options());
    const second = join(tmp, 'second');
    mkdirSync(second);
    await installService(options({ root: second }));
    // A service of another copy of the program does not count.
    const elsewhere = join(tmp, 'elsewhere');
    mkdirSync(join(elsewhere, 'dist'), { recursive: true });
    writeFileSync(join(elsewhere, 'dist', 'cli.js'), '// another copy\n');
    const third = join(tmp, 'third');
    mkdirSync(third);
    await installService(options({ root: third, cliPath: join(elsewhere, 'dist', 'cli.js') }));
    writeFileSync(join(agentsDir, 'com.example.other.plist'), cliPath);

    expect(otherServiceFiles(options())).toEqual([join(agentsDir, `${serviceLabel(second)}.plist`)]);
    expect(otherServiceFiles(options({ launchAgentsDir: join(tmp, 'none') }))).toEqual([]);
  });
});
