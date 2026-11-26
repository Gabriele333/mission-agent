import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { MissionId } from './types.js';

/** The default root folder of the agent (§J.3). */
export const DEFAULT_ROOT = join(homedir(), 'mission-agent');

/** Every path inside the agent's root folder (§E.2.3). Paths are absolute. */
export interface Paths {
  root: string;
  agentYaml: string;
  corePromptFile: string;
  noteParagraphFile: string;
  coreDir: string;
  coreMemoryFile: string;
  coreSkillsDir: string;
  missionsDir: string;
  missionsIndexFile: string;
  backupsDir: string;
  stateDir: string;
  dbFile: string;
  /** The SDK's configuration folder, which holds the sessions (§3.3). */
  sdkConfigDir: string;
  /** The port and the token of the local connection (§J.3). */
  serverFile: string;
  missionDir(id: MissionId): string;
  manifestFile(id: MissionId): string;
  memoryDir(id: MissionId): string;
  memoryIndexFile(id: MissionId): string;
  dataDir(id: MissionId): string;
  skillsDir(id: MissionId): string;
}

export function pathsFor(root: string): Paths {
  const r = resolve(root);
  const missionsDir = join(r, 'missions');
  const stateDir = join(r, 'state');
  const coreDir = join(r, 'core');
  const missionDir = (id: MissionId) => join(missionsDir, id);
  return {
    root: r,
    agentYaml: join(r, 'agent.yaml'),
    corePromptFile: join(r, 'core-prompt.md'),
    noteParagraphFile: join(r, 'note-paragraph.md'),
    coreDir,
    coreMemoryFile: join(coreDir, 'memory.md'),
    coreSkillsDir: join(coreDir, 'skills'),
    missionsDir,
    missionsIndexFile: join(missionsDir, 'INDEX.md'),
    backupsDir: join(r, 'backups'),
    stateDir,
    dbFile: join(stateDir, 'agent.db'),
    sdkConfigDir: join(stateDir, 'claude'),
    serverFile: join(stateDir, 'server'),
    missionDir,
    manifestFile: (id) => join(missionDir(id), 'manifest.yaml'),
    memoryDir: (id) => join(missionDir(id), 'memory'),
    memoryIndexFile: (id) => join(missionDir(id), 'memory', 'MEMORY.md'),
    dataDir: (id) => join(missionDir(id), 'data'),
    skillsDir: (id) => join(missionDir(id), 'skills'),
  };
}
