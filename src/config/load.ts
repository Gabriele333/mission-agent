import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import YAML from 'yaml';
import type { Paths } from '../paths.js';
import type { AgentConfig, LoadedConfig } from '../types.js';
import { AGENT_NAME_PLACEHOLDER, DEFAULT_CORE_TEXT } from './defaults.js';
import { formatIssues } from './issues.js';
import { agentFileSchema, KEY_COMMENTS, toAgentConfig, toAgentFile } from './schema.js';

/** The agent configuration cannot be used. `problems` lists every problem found. */
export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`The agent configuration (agent.yaml) is invalid:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Checks the content of `agent.yaml` and applies the defaults. Throws a ConfigError. */
export function parseConfig(yamlText: string): AgentConfig {
  const doc = YAML.parseDocument(yamlText);
  if (doc.errors.length > 0) {
    throw new ConfigError(doc.errors.map((e) => `The file is not valid YAML: ${e.message.split('\n')[0]}`));
  }
  const data: unknown = doc.toJS();
  if (data === null || data === undefined) throw new ConfigError(['The file is empty. agent_name is required.']);
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new ConfigError(['The file must be a mapping of keys to values, such as "agent_name: Ada".']);
  }
  const result = agentFileSchema.safeParse(data);
  if (!result.success) throw new ConfigError(formatIssues(result.error.issues, data));
  const file = result.data;
  if (file.default_surface === 'telegram' && file.telegram_user_id === undefined) {
    throw new ConfigError(['default_surface is telegram, but telegram_user_id is not set.']);
  }
  return toAgentConfig(file);
}

function readOptionalText(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf8').trimEnd();
}

/** Reads `agent.yaml`, `core-prompt.md` and `note-paragraph.md` (§A.1, §A.2). Throws a ConfigError. */
export function loadConfig(paths: Paths): LoadedConfig {
  if (!existsSync(paths.agentYaml)) {
    throw new ConfigError([`agent.yaml does not exist in the root folder ${paths.root}.`]);
  }
  const config = parseConfig(readFileSync(paths.agentYaml, 'utf8'));
  const core = readOptionalText(paths.corePromptFile) ?? DEFAULT_CORE_TEXT;
  return {
    config,
    coreText: core.split(AGENT_NAME_PLACEHOLDER).join(config.agentName),
    noteParagraph: readOptionalText(paths.noteParagraphFile) ?? '',
  };
}

const FILE_HEADER = [
  ' The agent configuration (§A.1). The setup page writes this file, and you can edit it by hand.',
  ' Only agent_name is required. A missing key takes its default.',
  ' This file holds no secret value and no absolute path. Secrets are in the Keychain.',
].join('\n');

/** Writes `agent.yaml` in snake_case, with one comment per key. Throws a ConfigError on an invalid value. */
export function writeConfig(paths: Paths, config: AgentConfig): void {
  const file = toAgentFile(config);
  // Check the values first, so that the file written always loads again.
  parseConfig(YAML.stringify(file));
  const doc = new YAML.Document(file);
  doc.commentBefore = FILE_HEADER;
  if (YAML.isMap(doc.contents)) {
    for (const pair of doc.contents.items) {
      if (YAML.isScalar(pair.key)) {
        const key = String(pair.key.value) as keyof typeof KEY_COMMENTS;
        pair.key.commentBefore = ` ${KEY_COMMENTS[key]}`;
      }
    }
  }
  const tmp = `${paths.agentYaml}.tmp`;
  writeFileSync(tmp, doc.toString({ lineWidth: 0 }));
  renameSync(tmp, paths.agentYaml);
}

export interface ConfigHolder {
  /** The last valid configuration. Loads the file on the first call. Throws a ConfigError if it was never valid. */
  current(): LoadedConfig;
  /** Reads the files again. On an error the last valid values stay in use. */
  reload(): { ok: true } | { ok: false; error: string };
  /** True when `agent.yaml` exists. */
  exists(): boolean;
  /** The error of the last load, or undefined when it succeeded. */
  lastError(): string | undefined;
}

/** Keeps the last valid configuration while the file is invalid (§H, "An invalid configuration"). */
export function createConfigHolder(paths: Paths): ConfigHolder {
  let loaded: LoadedConfig | undefined;
  let error: string | undefined;

  const reload = (): { ok: true } | { ok: false; error: string } => {
    try {
      loaded = loadConfig(paths);
      error = undefined;
      return { ok: true };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return { ok: false, error };
    }
  };

  return {
    current() {
      if (loaded !== undefined) return loaded;
      try {
        loaded = loadConfig(paths);
        error = undefined;
        return loaded;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        throw e;
      }
    },
    reload,
    exists: () => existsSync(paths.agentYaml),
    lastError: () => error,
  };
}
