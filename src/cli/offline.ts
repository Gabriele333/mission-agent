import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfig } from '../config/index.js';
import { requiredCredentialIds, type CredentialSources } from '../harness/index.js';
import { isSystemMissionId, MISSION_ADMIN_MANIFEST, parseManifest } from '../manifest/index.js';
import type { Paths } from '../paths.js';
import { builtinTools, createToolCatalog } from '../tools/index.js';
import { chatTrigger, createTriggerCatalog, cronTrigger } from '../triggers/index.js';
import type { AgentConfig, Manifest } from '../types.js';

/**
 * What the command line program reads from the files when the harness is not running.
 * It only reads: no manifest version is raised and no index is written.
 */

export interface FileMissions {
  manifests: Manifest[];
  /** One line per manifest that could not be read. */
  problems: string[];
}

export function readMissionsFromFiles(paths: Pick<Paths, 'missionsDir'>): FileMissions {
  const manifests: Manifest[] = [MISSION_ADMIN_MANIFEST];
  const problems: string[] = [];
  if (!existsSync(paths.missionsDir)) return { manifests, problems };
  const dirs = readdirSync(paths.missionsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const dir of dirs) {
    const file = join(paths.missionsDir, dir, 'manifest.yaml');
    if (!existsSync(file)) {
      if (!isSystemMissionId(dir)) problems.push(`missions/${dir} has no manifest.yaml.`);
      continue;
    }
    const parsed = parseManifest(readFileSync(file, 'utf8'), `missions/${dir}/manifest.yaml`);
    if (parsed.ok) manifests.push(parsed.manifest);
    else problems.push(...parsed.errors);
  }
  return { manifests, problems };
}

/** The tool and trigger declarations, built the same way as in the harness. */
export function codeSources(paths: Paths, config: AgentConfig = defaultConfig('mission-agent')): CredentialSources {
  const triggers = [cronTrigger, chatTrigger];
  const tools = createToolCatalog(
    builtinTools({
      paths,
      config: () => config,
      catalog: () => tools,
      triggers: () => triggers,
    }),
  );
  return { tools, triggers: createTriggerCatalog(triggers) };
}

/** The required credentials, computed from agent.yaml and the manifest files (§A.5). */
export function requiredFromFiles(paths: Paths, config: AgentConfig): string[] {
  const { manifests } = readMissionsFromFiles(paths);
  return requiredCredentialIds(config, manifests, codeSources(paths, config));
}
