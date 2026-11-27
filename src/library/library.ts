import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseManifest } from '../manifest/index.js';
import type { Manifest } from '../types.js';

/**
 * The mission library that comes with the program: `mission-library/`, one folder per published
 * mission. The harness only reads it. A mission is copied from it into the agent's `missions/`
 * folder, and from then on the copy belongs to the agent.
 */

export interface LibraryMission {
  /** The folder name, which is the mission's name. */
  folder: string;
  /** The absolute path of the folder. */
  dir: string;
  manifest: Manifest;
  /** The text of the mission's `README.md`, when it has one. */
  readme?: string;
  /** The names of the folders in its `skills/` folder. */
  skills: string[];
}

export interface Library {
  missions: LibraryMission[];
  /** One line per folder that holds no usable manifest. */
  problems: string[];
}

/** The library folder does not exist, so the program was installed without it. */
export class LibraryMissingError extends Error {
  constructor(dir: string) {
    super(`The mission library ${dir} does not exist.`);
    this.name = 'LibraryMissingError';
  }
}

export function readLibrary(dir: string): Library {
  if (!existsSync(dir)) throw new LibraryMissingError(dir);
  const missions: LibraryMission[] = [];
  const problems: string[] = [];
  const folders = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
  for (const folder of folders) {
    const missionDir = join(dir, folder);
    const file = join(missionDir, 'manifest.yaml');
    if (!existsSync(file)) {
      problems.push(`mission-library/${folder} has no manifest.yaml.`);
      continue;
    }
    try {
      const parsed = parseManifest(readFileSync(file, 'utf8'), `mission-library/${folder}/manifest.yaml`);
      if (!parsed.ok) {
        problems.push(...parsed.errors);
        continue;
      }
      if (parsed.manifest.name !== folder) {
        problems.push(`mission-library/${folder}: the folder name must be the name in the manifest, "${parsed.manifest.name}".`);
        continue;
      }
      const mission: LibraryMission = { folder, dir: missionDir, manifest: parsed.manifest, skills: [] };
      const readme = join(missionDir, 'README.md');
      if (existsSync(readme)) mission.readme = readFileSync(readme, 'utf8');
      const skills = join(missionDir, 'skills');
      if (existsSync(skills)) {
        mission.skills = readdirSync(skills, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort();
      }
      missions.push(mission);
    } catch (err) {
      problems.push(`mission-library/${folder} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { missions, problems };
}

/** Finds a published mission by its name or by its id. */
export function findLibraryMission(library: Library, ref: string): LibraryMission | undefined {
  return library.missions.find((m) => m.folder === ref || m.manifest.id === ref);
}
