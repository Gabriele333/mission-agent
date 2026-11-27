import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Paths } from '../paths.js';
import { failureText, type CommandRunner } from './command.js';
import { compareVersions, formatVersion, isReleaseTag, newestReleaseTag, parseVersion } from './version.js';

/**
 * The `update` command (chapter 7.4). It replaces the installed program with a newer release.
 * The program that runs the command is the old one. It stays in memory until the end, so it
 * can install the old release again when a step fails.
 */

/** An expected refusal or failure. The message is for the user. */
export class UpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateError';
  }
}

export interface UpdateDeps {
  /** The folder of the installed program: a git clone at a release tag. */
  programDir: string;
  /** The agent's root folder. */
  paths: Pick<Paths, 'root' | 'backupsDir'>;
  /** Runs `git`, `npm` and `node`. */
  run: CommandRunner;
  /** The node program that checks the new version when no service runs it. */
  nodePath: string;
  service: {
    /** Whether the service of this root is installed, and the process it runs. */
    status(): Promise<{ installed: boolean; loaded: boolean; pid?: number }>;
    install(): Promise<void>;
    uninstall(): Promise<void>;
    /** The service files of other agents that run this same program. */
    others(): string[];
  };
  /** The harness that answers for this root, with the version it reports. */
  findHarness(): Promise<{ pid: number; version?: string } | undefined>;
  /** Asks the user a yes or no question. */
  confirm(question: string): Promise<boolean>;
  out(line: string): void;
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** How long to wait for the harness to stop, and to answer after a start. Defaults: 30 and 90 seconds. */
  stopWaitMs?: number;
  startWaitMs?: number;
}

/** How many copies of the root folder the update keeps (placeholder, chapter 7.4). */
export const UPDATE_COPIES_KEPT = 2;
const COPY_NAME_RE = /-(\d{4}-\d{2}-\d{2}-\d{6})$/;
const POLL_MS = 500;

function stamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** The folder that holds the copies of the root folder: `backups/update/`. */
export function updateCopiesDir(paths: Pick<Paths, 'backupsDir'>): string {
  return join(paths.backupsDir, 'update');
}

/**
 * Copies the root folder to `backups/update/<old version>-<date>/`, without `backups/` itself.
 * Returns the copy's folder, or undefined when the root folder does not exist.
 */
export function copyRootFolder(paths: Pick<Paths, 'root' | 'backupsDir'>, oldVersion: string, now: Date): string | undefined {
  if (!existsSync(paths.root)) return undefined;
  const dest = join(updateCopiesDir(paths), `${oldVersion}-${stamp(now)}`);
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  try {
    for (const entry of readdirSync(paths.root)) {
      if (join(paths.root, entry) === paths.backupsDir) continue;
      cpSync(join(paths.root, entry), join(dest, entry), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    }
  } catch (err) {
    rmSync(dest, { recursive: true, force: true });
    throw err;
  }
  return dest;
}

/** Removes the oldest copies, so that `keep` copies are left. */
export function pruneRootCopies(paths: Pick<Paths, 'backupsDir'>, keep: number = UPDATE_COPIES_KEPT): void {
  const dir = updateCopiesDir(paths);
  if (!existsSync(dir)) return;
  const copies = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && COPY_NAME_RE.test(e.name))
    .map((e) => ({ name: e.name, at: (COPY_NAME_RE.exec(e.name) as RegExpExecArray)[1] as string }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const old of copies.slice(0, Math.max(0, copies.length - keep))) {
    rmSync(join(dir, old.name), { recursive: true, force: true });
  }
}

/** Puts a copy back: everything in the root folder except `backups/` is replaced by the copy. */
export function restoreRootFolder(paths: Pick<Paths, 'root' | 'backupsDir'>, copyDir: string): void {
  for (const entry of readdirSync(paths.root)) {
    if (join(paths.root, entry) === paths.backupsDir) continue;
    rmSync(join(paths.root, entry), { recursive: true, force: true });
  }
  for (const entry of readdirSync(copyDir)) {
    cpSync(join(copyDir, entry), join(paths.root, entry), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  }
}

/** Runs the update. Returns the exit code of the command. */
export async function runUpdate(deps: UpdateDeps): Promise<number> {
  const { programDir: dir, paths, run, out } = deps;
  const git = (args: string[], timeoutMs = 60_000) => run('git', args, { cwd: dir, timeoutMs });

  async function mustGit(args: string[], what: string, timeoutMs?: number): Promise<string> {
    const r = await git(args, timeoutMs);
    if (r.code !== 0) throw new UpdateError(`${what}: ${failureText(r)}`);
    return r.stdout;
  }

  // ---------------------------------------------------------- what is installed now

  const byHand = 'Update it by hand: see docs/update.md.';
  if (!existsSync(join(dir, '.git'))) {
    throw new UpdateError(`The program in ${dir} was not installed with git, so the update command cannot replace it. ${byHand}`);
  }
  const changed = await mustGit(['status', '--porcelain'], 'git could not read the state of the program folder');
  if (changed.trim() !== '') {
    throw new UpdateError(`The program folder ${dir} holds changes that are in no release, so it is a development copy. ${byHand}`);
  }
  const described = await git(['describe', '--tags', '--exact-match', 'HEAD']);
  const headTags = described.code === 0 ? described.stdout.trim().split('\n') : [];
  const oldTag = headTags.find(isReleaseTag);
  const oldVersion = oldTag === undefined ? undefined : parseVersion(oldTag);
  if (oldTag === undefined || oldVersion === undefined) {
    throw new UpdateError(`The program in ${dir} is not at a release, so it is a development copy. ${byHand}`);
  }
  const oldCommit = (await mustGit(['rev-parse', 'HEAD'], 'git could not read the installed version')).trim();
  const oldText = formatVersion(oldVersion);

  // ---------------------------------------------------------- step 1: look for a newer release

  await mustGit(['fetch', '--tags', 'origin'], 'git could not get the releases', 120_000);
  const tags = (await mustGit(['tag', '--list', 'v*'], 'git could not list the releases')).split('\n').map((t) => t.trim());
  const newTag = newestReleaseTag(tags);
  const newVersion = newTag === undefined ? undefined : parseVersion(newTag);
  if (newTag === undefined || newVersion === undefined || compareVersions(newVersion, oldVersion) <= 0) {
    out(`You have the newest release, ${oldText}. Nothing was changed.`);
    return 0;
  }
  const newText = formatVersion(newVersion);
  const notes = (await git(['tag', '--list', '--format=%(contents)', newTag])).stdout.trim();
  out(`Version ${newText} is available. You have ${oldText}.`);
  if (notes === '') out('This release has no notes.');
  else {
    out('Release notes:');
    for (const line of notes.split('\n')) out(`  ${line}`);
  }

  // ---------------------------------------------------------- what runs now

  const others = deps.service.others();
  if (others.length > 0) {
    throw new UpdateError(
      `Other agents run this same program as a service: ${others.join(', ')}. ` +
        'An update would replace the program under them. Remove each of these services with "mission-agent service uninstall", ' +
        'run the update for each agent, and install the services again.',
    );
  }
  const before = await deps.service.status();
  const running = await deps.findHarness();
  if (running !== undefined && before.pid !== running.pid) {
    throw new UpdateError(
      `A harness for ${paths.root} runs in the foreground (process ${running.pid}). Stop it with Ctrl+C, then run the update again.`,
    );
  }
  const wasService = before.installed || before.loaded;

  // ---------------------------------------------------------- step 2: ask

  out('');
  out('The update does these steps:');
  out(wasService ? '  1. It stops the harness, which runs as a service.' : '  1. No harness runs for this root folder, so nothing is stopped.');
  out(`  2. It copies ${paths.root} to ${join(updateCopiesDir(paths), `${oldText}-<date>`)}.`);
  out(`  3. It installs version ${newText} in ${dir}.`);
  out(wasService ? '  4. It starts the harness and checks that it answers.' : '  4. It checks that the new program starts.');
  out(`If a step fails, it installs version ${oldText} again.`);
  if (!(await deps.confirm(`Install version ${newText}? [y/N] `))) {
    out('Nothing was changed.');
    return 0;
  }

  // ---------------------------------------------------------- steps 3 to 8

  async function waitForHarness(wanted: 'gone' | 'up', waitMs: number): Promise<{ pid: number; version?: string } | undefined> {
    const deadline = deps.now().getTime() + waitMs;
    for (;;) {
      const h = await deps.findHarness();
      if (wanted === 'gone' ? h === undefined : h !== undefined) return h;
      if (deps.now().getTime() >= deadline) {
        throw new UpdateError(wanted === 'gone' ? 'The harness did not stop.' : 'The harness did not answer after its start.');
      }
      await deps.sleep(POLL_MS);
    }
  }

  async function installRelease(ref: string, label: string): Promise<void> {
    out(`Installing ${label}: getting the code.`);
    await mustGit(['-c', 'advice.detachedHead=false', 'checkout', '--detach', ref], `git could not switch to ${label}`);
    // Files of the release that is replaced must not stay in the built program.
    rmSync(join(dir, 'dist'), { recursive: true, force: true });
    out(`Installing ${label}: getting the packages it depends on.`);
    const ci = await run('npm', ['ci'], { cwd: dir, timeoutMs: 15 * 60_000 });
    if (ci.code !== 0) throw new UpdateError(`npm could not install the packages of ${label}:\n${failureText(ci)}`);
    out(`Installing ${label}: building it.`);
    const build = await run('npm', ['run', 'build'], { cwd: dir, timeoutMs: 15 * 60_000 });
    if (build.code !== 0) throw new UpdateError(`${label} could not be built:\n${failureText(build)}`);
    if (!existsSync(join(dir, 'dist', 'cli.js'))) throw new UpdateError(`The build of ${label} did not write dist/cli.js.`);
  }

  async function startAndCheck(version: string): Promise<void> {
    if (wasService) {
      await deps.service.install();
      const h = await waitForHarness('up', deps.startWaitMs ?? 90_000);
      if (h?.version !== version) {
        throw new UpdateError(`The harness answers, but it reports version ${h?.version ?? 'unknown'} and not ${version}.`);
      }
      return;
    }
    const shown = await run(deps.nodePath, [join(dir, 'dist', 'cli.js'), '--version'], { cwd: dir, timeoutMs: 60_000 });
    if (shown.code !== 0) throw new UpdateError(`The new program does not start:\n${failureText(shown)}`);
    if (shown.stdout.trim() !== version) {
      throw new UpdateError(`The new program reports version ${shown.stdout.trim() || 'unknown'} and not ${version}.`);
    }
  }

  let stage: 'stopped' | 'installing' | 'started' = 'stopped';
  let copyDir: string | undefined;
  try {
    if (wasService) {
      out('Stopping the harness.');
      await deps.service.uninstall();
      await waitForHarness('gone', deps.stopWaitMs ?? 30_000);
    }
    copyDir = copyRootFolder(paths, oldText, deps.now());
    if (copyDir !== undefined) out(`Copied the root folder to ${copyDir}.`);
    stage = 'installing';
    await installRelease(newTag, `version ${newText}`);
    stage = 'started';
    if (wasService) out('Starting the harness.');
    await startAndCheck(newText);
  } catch (err) {
    out('');
    out(`The update failed: ${err instanceof Error ? err.message : String(err)}`);
    out(`Going back to version ${oldText}.`);
    try {
      if (stage === 'started' && wasService) {
        await deps.service.uninstall().catch(() => undefined);
        await waitForHarness('gone', deps.stopWaitMs ?? 30_000);
      }
      if (stage !== 'stopped') await installRelease(oldCommit, `version ${oldText}`);
      // Only a harness of the new version can have changed the root folder.
      if (stage === 'started' && wasService && copyDir !== undefined) {
        restoreRootFolder(paths, copyDir);
        out(`Put the copy ${copyDir} back in ${paths.root}.`);
      }
      if (wasService) {
        await deps.service.install();
        await waitForHarness('up', deps.startWaitMs ?? 90_000);
      }
    } catch (back) {
      out(`Going back failed too: ${back instanceof Error ? back.message : String(back)}`);
      out(`The program folder is ${dir}. The version before the update is the commit ${oldCommit}.`);
      if (copyDir !== undefined) out(`The copy of the root folder made before the update is ${copyDir}.`);
      out('Follow "Go back to the old version" in docs/update.md.');
      return 1;
    }
    out(`Version ${oldText} is installed again.${wasService ? ' The harness runs.' : ''}`);
    return 1;
  }

  if (copyDir !== undefined) pruneRootCopies(paths);
  out('');
  out(`Version ${newText} is installed.${wasService ? ' The harness runs.' : ''}`);
  if (copyDir !== undefined) out(`The copy of the root folder made before the update is ${copyDir}. It is the only way back.`);
  return 0;
}
