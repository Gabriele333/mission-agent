import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { GENERAL_MANIFEST_YAML } from '../manifest/system.js';
import type { Paths } from '../paths.js';
import { SYS_GENERAL, SYS_MISSION_ADMIN, type MissionId } from '../types.js';

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function ensureFile(path: string, content: string): void {
  // The `wx` flag fails when the file exists, so a file is never overwritten.
  if (!existsSync(path)) writeFileSync(path, content, { flag: 'wx' });
}

function ensureMissionFolders(paths: Paths, id: MissionId): void {
  ensureDir(paths.memoryDir(id));
  ensureFile(paths.memoryIndexFile(id), '');
  ensureDir(paths.dataDir(id));
  ensureDir(paths.skillsDir(id));
}

/** Creates the folder tree of §E.2.3 where it is missing. Never overwrites a file. */
export function initRootFolder(paths: Paths): void {
  ensureDir(paths.root);
  ensureDir(paths.coreDir);
  ensureFile(paths.coreMemoryFile, '');
  ensureDir(paths.coreSkillsDir);
  ensureDir(paths.missionsDir);

  ensureMissionFolders(paths, SYS_GENERAL);
  ensureFile(paths.manifestFile(SYS_GENERAL), GENERAL_MANIFEST_YAML);

  // The mission admin's manifest is part of the code, so its folder has no manifest file.
  ensureMissionFolders(paths, SYS_MISSION_ADMIN);

  ensureDir(paths.stateDir);
  ensureDir(paths.backupsDir);
}
