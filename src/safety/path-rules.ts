import { lstatSync, readlinkSync, realpathSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, sep } from 'node:path';
import type { Paths } from '../paths.js';
import type { MissionId } from '../types.js';

/** The path rules of §E.2.1 for the file tools, the delete tool and files sent with the message tool. */

export type PathAccess = 'read' | 'write';

export type PathCheck =
  | {
      ok: true;
      /** The real path, with every symbolic link resolved and the letter case of the disk. */
      realPath: string;
      /** True when the path is inside the mission's `memory/` folder. */
      inMemory: boolean;
    }
  | { ok: false; message: string };

/** The real folders of one mission, computed again on every check so a moved root is seen. */
export interface MissionAreas {
  mission: string;
  core: string;
  /** Undefined when the folder resolves outside the mission's folder. */
  memory?: string;
  data?: string;
}

const MAX_LINKS = 40;

/**
 * Resolves a path the way the operating system would: relative to `baseDir`,
 * following each symbolic link where it appears, and applying `..` after the
 * link is followed. Parts that do not exist yet are kept as given.
 * Existing parts get the letter case they have on disk, so on a case-insensitive
 * file system a spelling such as `../M_OTHER/DATA` cannot pass a string comparison
 * that the real folder would fail.
 * Throws on a loop of links, on a `~user` path and on any file system error other than a missing file.
 */
export function resolveRealPath(input: string, baseDir: string): string {
  if (input.includes('\0')) throw new Error('the path holds a null character');
  const expanded = expandHome(input);
  const start = isAbsolute(expanded) ? expanded : baseDir + sep + expanded;
  let current = parse(start).root;
  let pending = segments(start.slice(current.length));
  let links = 0;
  while (pending.length > 0) {
    const seg = pending.shift() as string;
    if (seg === '..') {
      current = dirname(current);
      continue;
    }
    const candidate = join(current, seg);
    const st = lstatOrUndefined(candidate);
    if (st === undefined) {
      current = candidate;
    } else if (st.isSymbolicLink()) {
      links += 1;
      if (links > MAX_LINKS) throw new Error('the path has too many symbolic links');
      const target = readlinkSync(candidate);
      if (isAbsolute(target)) {
        const root = parse(target).root;
        current = root;
        pending = [...segments(target.slice(root.length)), ...pending];
      } else {
        pending = [...segments(target), ...pending];
      }
    } else {
      current = realpathSync.native(candidate);
    }
  }
  return current;
}

/** True when `child` is `parent` or lies inside it. Both must be real paths. */
export function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

export function missionAreas(paths: Paths, missionId: MissionId): MissionAreas {
  const mission = resolveRealPath(paths.missionDir(missionId), sep);
  const inMission = (p: string) => {
    const real = resolveRealPath(p, sep);
    return real !== mission && isInside(real, mission) ? real : undefined;
  };
  return {
    mission,
    core: resolveRealPath(paths.coreDir, sep),
    memory: inMission(paths.memoryDir(missionId)),
    data: inMission(paths.dataDir(missionId)),
  };
}

/**
 * Checks one path against the rules of §E.2.1.
 * Read: the mission's own folder, its `manifest.yaml` included, and `core/`.
 * Write: only inside the mission's `memory/` and `data/` folders, so never `manifest.yaml`,
 * `skills/` or `core/`.
 */
export function checkFilePath(paths: Paths, missionId: MissionId, input: string, access: PathAccess): PathCheck {
  const verb = access === 'read' ? 'Reading' : 'Writing';
  let areas: MissionAreas;
  let real: string;
  try {
    areas = missionAreas(paths, missionId);
    real = resolveRealPath(input, paths.missionDir(missionId));
  } catch (err) {
    return { ok: false, message: `${verb} "${input}" is refused: the path could not be checked (${errorText(err)}).` };
  }
  const where = real === input ? '' : ` The path leads to ${real}.`;
  const inMemory = areas.memory !== undefined && real !== areas.memory && isInside(real, areas.memory);
  const inData = areas.data !== undefined && real !== areas.data && isInside(real, areas.data);

  if (access === 'write') {
    if (inMemory || inData) return { ok: true, realPath: real, inMemory };
    return {
      ok: false,
      message:
        `Writing "${input}" is refused: a mission can write only inside its own memory/ and data/ folders.` +
        `${where} Save working files in the data/ folder.`,
    };
  }

  if (isInside(real, areas.mission) || isInside(real, areas.core)) {
    return { ok: true, realPath: real, inMemory };
  }
  return {
    ok: false,
    message: `Reading "${input}" is refused: a mission can read only its own folder and the core folder.${where}`,
  };
}

function segments(p: string): string[] {
  return p.split(sep).filter((s) => s !== '' && s !== '.');
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p.startsWith('~')) throw new Error('a path that starts with ~ and a user name is not accepted');
  return p;
}

function lstatOrUndefined(p: string): Stats | undefined {
  try {
    return lstatSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw err;
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
