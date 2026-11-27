import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { serviceLabel, xmlEscape } from '../service/plist.js';
import { bootoutAndWait } from '../service/service.js';
import { failureText } from '../update/command.js';
import { compareVersions, formatVersion, isReleaseTag, newestReleaseTag, parseVersion, tagsOfLsRemote } from '../update/version.js';
import type { HarnessFound, Maint } from './context.js';
import { MaintenanceError, removeProgramFolder } from './files.js';

/** The operations that install, update and repair share (chapter 7.5). */

// ---------------------------------------------------------------- the program

export type ProgramTest = { ok: true; version: string } | { ok: false; reason: string };

/**
 * Tests a program folder: `dist/cli.js` exists, `--version` prints the expected version, and
 * `self-test` passes. With `checkpoints`, each test is a hook point of the update.
 */
export async function testProgram(m: Maint, dir: string, expected?: string, checkpoints = false): Promise<ProgramTest> {
  const cli = join(dir, 'dist', 'cli.js');
  if (!existsSync(cli)) return { ok: false, reason: `${cli} does not exist.` };
  if (checkpoints) await m.checkpoint('test-version');
  const shown = await m.run(m.nodePath, [cli, '--version'], { cwd: dir, timeoutMs: 60_000 });
  if (shown.code !== 0) return { ok: false, reason: `The program does not start:\n${failureText(shown, 8)}` };
  const version = shown.stdout.trim().split('\n')[0]?.trim() ?? '';
  if (parseVersion(version) === undefined) return { ok: false, reason: `The program reports no version, but "${version}".` };
  if (expected !== undefined && version !== expected) {
    return { ok: false, reason: `The program reports version ${version} and not ${expected}.` };
  }
  if (checkpoints) await m.checkpoint('self-test');
  const tested = await m.run(m.nodePath, [cli, 'self-test'], { cwd: dir, timeoutMs: 60_000 });
  if (tested.code !== 0) return { ok: false, reason: `The self-test of the program failed:\n${failureText(tested, 8)}` };
  return { ok: true, version };
}

/** The release tags of a repository, by `git ls-remote`. `source` is a URL, or `origin` with `cwd` in a clone. */
export async function releaseTags(m: Maint, source: string, cwd: string): Promise<string[]> {
  const listed = await m.run('git', ['ls-remote', '--tags', '--refs', source], { cwd, timeoutMs: 60_000 });
  if (listed.code !== 0) {
    throw new MaintenanceError(
      `git could not read the releases of ${source === 'origin' ? 'the repository' : source}. ` +
        `If the repository is private, sign in to it with git first.\n${failureText(listed, 4)}`,
    );
  }
  return tagsOfLsRemote(listed.stdout).filter(isReleaseTag);
}

/** The newest release tag, or undefined when the repository has none. */
export function newest(tags: string[]): string | undefined {
  return newestReleaseTag(tags);
}

/** True when the version `a` is newer than `b`. */
export function isNewer(a: string, b: string): boolean {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  return va !== undefined && vb !== undefined && compareVersions(va, vb) > 0;
}

/** The tag of a version: `0.2.0` gives `v0.2.0`. */
export function tagOf(version: string): string {
  const v = parseVersion(version);
  if (v === undefined) throw new MaintenanceError(`"${version}" is not a release. A release is a tag such as v0.2.0.`);
  return `v${formatVersion(v)}`;
}

/** The message of a release tag: its notes. It fetches that one tag into the clone in `dir`. */
export async function releaseNotes(m: Maint, dir: string, tag: string): Promise<string> {
  await m.run('git', ['fetch', '--quiet', '--no-tags', 'origin', `+refs/tags/${tag}:refs/tags/${tag}`], { cwd: dir, timeoutMs: 120_000 });
  const r = await m.run('git', ['for-each-ref', '--format=%(contents)', `refs/tags/${tag}`], { cwd: dir, timeoutMs: 30_000 });
  return r.code === 0 ? r.stdout.trim() : '';
}

/** The URL of the repository that a clone came from. */
export async function originUrl(m: Maint, dir: string): Promise<string | undefined> {
  if (!existsSync(join(dir, '.git'))) return undefined;
  const r = await m.run('git', ['remote', 'get-url', 'origin'], { cwd: dir, timeoutMs: 30_000 });
  const url = r.stdout.trim();
  return r.code === 0 && url !== '' ? url : undefined;
}

/**
 * Gets a release into `app.installing` and builds it: `git clone`, `npm ci`, `npm run build`.
 * Each of the three is a hook point. A folder left by an earlier run is removed first.
 */
export async function buildRelease(m: Maint, repo: string, tag: string): Promise<void> {
  const target = m.layout.installing;
  removeProgramFolder(m.layout, target);
  m.out(`Getting release ${tag}.`);
  await m.checkpoint('clone');
  const cloned = await m.run('git', ['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--branch', tag, repo, target], {
    cwd: m.layout.home,
    timeoutMs: 10 * 60_000,
  });
  if (cloned.code !== 0) throw new MaintenanceError(`git could not get release ${tag} of ${repo}:\n${failureText(cloned, 8)}`);
  m.out('Getting the packages it depends on. This takes a minute.');
  await m.checkpoint('npm-ci');
  const ci = await m.run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: target, timeoutMs: 15 * 60_000 });
  if (ci.code !== 0) throw new MaintenanceError(`npm could not install the packages of ${tag}. The whole output is in ${m.layout.log}.\n${failureText(ci, 8)}`);
  m.out('Building it.');
  await m.checkpoint('build');
  const built = await m.run('npm', ['run', 'build'], { cwd: target, timeoutMs: 15 * 60_000 });
  if (built.code !== 0) throw new MaintenanceError(`Release ${tag} could not be built. The whole output is in ${m.layout.log}.\n${failureText(built, 8)}`);
  if (!existsSync(join(target, 'dist', 'cli.js'))) throw new MaintenanceError(`The build of ${tag} did not write dist/cli.js.`);
}

// ---------------------------------------------------------------- the service

export interface ServiceFile {
  plist: string;
  label: string;
  /** The root folder after `--root`, when the file names one. */
  root?: string;
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** The root folder that a service file runs: the value after `--root`. */
export function rootOfServiceText(text: string): string | undefined {
  const m = /<string>--root<\/string>\s*<string>([^<]*)<\/string>/.exec(text);
  return m?.[1] === undefined ? undefined : xmlUnescape(m[1]);
}

/** The service files in the folder of service files that run the program in `programDir`. It only reads. */
export function servicesOf(m: Maint, programDir: string): ServiceFile[] {
  if (!existsSync(m.launchAgents)) return [];
  const needle = `<string>${xmlEscape(join(programDir, 'dist', 'cli.js'))}</string>`;
  const found: ServiceFile[] = [];
  for (const name of readdirSync(m.launchAgents).sort()) {
    if (!/^local\.mission-agent\..+\.plist$/.test(name)) continue;
    const plist = join(m.launchAgents, name);
    let text: string;
    try {
      text = readFileSync(plist, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes(needle)) continue;
    const file: ServiceFile = { plist, label: basename(name, '.plist') };
    const root = rootOfServiceText(text);
    if (root !== undefined) file.root = root;
    found.push(file);
  }
  return found;
}

export function serviceFileOf(m: Maint, root: string): { label: string; plist: string } {
  const label = serviceLabel(root);
  return { label, plist: join(m.launchAgents, `${label}.plist`) };
}

export async function isLoaded(m: Maint, label: string): Promise<boolean> {
  return (await m.launchctl(['print', `gui/${m.uid}/${label}`])).code === 0;
}

/** True when the root folder has a service: its file exists, or launchd knows it. */
export async function hasService(m: Maint, root: string): Promise<boolean> {
  const s = serviceFileOf(m, root);
  return existsSync(s.plist) || (await isLoaded(m, s.label));
}

/**
 * Stops the service of a root folder with `launchctl bootout`, and waits until its harness is gone.
 * It needs nothing of the program, which may be broken. The service file stays.
 */
export async function stopService(m: Maint, root: string): Promise<void> {
  const s = serviceFileOf(m, root);
  if (await isLoaded(m, s.label)) {
    try {
      await bootoutAndWait({ launchctl: m.launchctl, removalWaitMs: 40_000 }, { domain: `gui/${m.uid}`, label: s.label }, `the service ${s.label}`);
    } catch (err) {
      throw new MaintenanceError(err instanceof Error ? err.message : String(err));
    }
  }
  await waitHarnessGone(m, root);
}

/** Waits until no harness answers for the root folder. */
export async function waitHarnessGone(m: Maint, root: string): Promise<void> {
  const deadline = m.now().getTime() + m.waits.stopMs;
  for (;;) {
    if ((await m.findHarness(root)) === undefined) return;
    if (m.now().getTime() >= deadline) throw new MaintenanceError(`The harness for ${root} did not stop.`);
    await m.sleep(m.waits.pollMs);
  }
}

/** Waits until a harness answers for the root folder, and checks the version it reports. */
export async function waitForHarness(m: Maint, root: string, version: string): Promise<HarnessFound> {
  const deadline = m.now().getTime() + m.waits.startMs;
  for (;;) {
    const h = await m.findHarness(root);
    if (h !== undefined) {
      if (h.version !== version) {
        throw new MaintenanceError(`The harness answers, but it reports version ${h.version ?? 'unknown'} and not ${version}.`);
      }
      return h;
    }
    if (m.now().getTime() >= deadline) {
      throw new MaintenanceError(`The harness did not answer after its start. Its log is ${join(root, 'state', 'logs', 'harness.err.log')}.`);
    }
    await m.sleep(m.waits.pollMs);
  }
}

/**
 * Installs the service of a root folder with the program's own command, so the service file is the
 * one of that release. Then waits until the harness answers with the program's version.
 */
export async function startService(m: Maint, root: string, programDir: string, version: string): Promise<HarnessFound> {
  const r = await m.run(m.nodePath, [join(programDir, 'dist', 'cli.js'), 'service', 'install', '--root', root], {
    cwd: m.layout.home,
    timeoutMs: 120_000,
  });
  if (r.code !== 0) throw new MaintenanceError(`The service could not be started:\n${failureText(r, 8)}`);
  return waitForHarness(m, root, version);
}
