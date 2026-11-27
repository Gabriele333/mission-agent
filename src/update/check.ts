import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { programDir, programVersion } from '../program.js';
import { execCommand, failureText, type CommandRunner } from './command.js';
import { compareVersions, formatVersion, newestReleaseTag, parseVersion, tagsOfLsRemote } from './version.js';

/**
 * Looks for a newer release (chapter 7.4). It asks the repository that the program was installed
 * from for its tag names, and sends nothing else.
 */

export type ReleaseCheck =
  | { ok: true; current: string; latest: string; newer: boolean; notes?: string }
  | { ok: false; reason: string };

export interface ReleaseCheckOptions {
  /** Default: the folder of the program that runs. */
  programDir?: string;
  run?: CommandRunner;
  /**
   * Also read the notes of a newer release: its tag is fetched into the program's own `.git`, and
   * its message read. Nothing else of the program folder changes.
   */
  notes?: boolean;
}

export async function checkForRelease(options: ReleaseCheckOptions = {}): Promise<ReleaseCheck> {
  const dir = options.programDir ?? programDir();
  const run = options.run ?? execCommand;
  const currentText = programVersion(dir);
  const current = currentText === undefined ? undefined : parseVersion(currentText);
  if (current === undefined) return { ok: false, reason: `The version of the program in ${dir} cannot be read.` };
  if (!existsSync(join(dir, '.git'))) {
    return { ok: false, reason: `The program in ${dir} was not installed with git, so no release can be looked up.` };
  }
  const listed = await run('git', ['ls-remote', '--tags', '--refs', 'origin'], { cwd: dir, timeoutMs: 30_000 });
  if (listed.code !== 0) return { ok: false, reason: `git could not read the releases: ${failureText(listed, 3)}` };
  const tag = newestReleaseTag(tagsOfLsRemote(listed.stdout));
  const latest = tag === undefined ? undefined : parseVersion(tag);
  if (latest === undefined) return { ok: true, current: formatVersion(current), latest: formatVersion(current), newer: false };
  const newer = compareVersions(latest, current) > 0;
  const result: ReleaseCheck = { ok: true, current: formatVersion(current), latest: formatVersion(latest), newer };
  if (newer && options.notes === true && tag !== undefined) {
    const fetched = await run('git', ['fetch', '--quiet', '--no-tags', 'origin', `+refs/tags/${tag}:refs/tags/${tag}`], { cwd: dir, timeoutMs: 60_000 });
    if (fetched.code === 0) {
      const read = await run('git', ['for-each-ref', '--format=%(contents)', `refs/tags/${tag}`], { cwd: dir, timeoutMs: 30_000 });
      if (read.code === 0) result.notes = read.stdout.trim();
    }
  }
  return result;
}
