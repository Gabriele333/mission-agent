import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import YAML from 'yaml';
import { ConfigError, DEFAULT_CORE_TEXT, defaultConfig, loadConfig, parseConfig, writeConfig } from '../config/index.js';
import { toAgentFile } from '../config/schema.js';
import type { Paths } from '../paths.js';
import type { AgentConfig } from '../types.js';

/**
 * What the setup page reads and writes in the agent configuration (§A.1, §5.2).
 * Keys are the keys of agent.yaml. A key of `run_limits` is written with a dot, as `run_limits.max_steps`.
 * The configuration module checks every value. Its error texts are shown next to the field.
 */

/** Every key the setup page can change. */
export const CONFIG_FIELDS = [
  'agent_name',
  'default_surface',
  'telegram_user_id',
  'model_login',
  'default_model',
  'default_effort',
  'triage_model',
  'triage_effort',
  'max_index_line_chars',
  'max_note_bytes',
  'core_memory_max_lines',
  'core_memory_max_line_chars',
  'max_instructions_chars',
  'max_description_chars',
  'run_limits.max_steps',
  'run_limits.max_cost_usd',
  'run_limits.max_minutes',
  'max_cost_per_day_usd',
  'approval_wait_hours',
  'triage_switch_confidence',
  'retries_after_failure',
] as const;

export type ConfigField = (typeof CONFIG_FIELDS)[number];
const FIELD_SET = new Set<string>(CONFIG_FIELDS);

export type FieldErrors = Record<string, string[]>;

export interface ConfigView {
  /** agent.yaml exists. */
  exists: boolean;
  /** The values to show: those of the file, and the default for a key the file does not set. */
  values: Record<string, unknown>;
  /** The default of each key (§A.1). */
  defaults: Record<string, unknown>;
  /** The error of the configuration module when the file is invalid. */
  error?: string;
  fieldErrors: FieldErrors;
  /** Problems that belong to no field. */
  generalErrors: string[];
}

export type PatchResult =
  | { ok: true; config: AgentConfig }
  | { ok: false; fieldErrors: FieldErrors; generalErrors: string[] };

function flatten(file: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(file)) {
    if (key === 'run_limits' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[`run_limits.${k}`] = v;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function defaultsView(): Record<string, unknown> {
  const d = flatten(toAgentFile(defaultConfig('')) as Record<string, unknown>);
  d.agent_name = '';
  // Without telegram_user_id, the configuration module uses the terminal (§5.1).
  d.default_surface = 'terminal';
  return d;
}

/** Puts each problem of the configuration module next to the key it names. */
export function sortProblems(problems: string[]): { fieldErrors: FieldErrors; generalErrors: string[] } {
  const fieldErrors: FieldErrors = {};
  const generalErrors: string[] = [];
  for (const p of problems) {
    const key = /^([a-z_]+(?:\.[a-z_]+)?) /.exec(p)?.[1];
    if (key !== undefined && FIELD_SET.has(key)) (fieldErrors[key] ??= []).push(p);
    else generalErrors.push(p);
  }
  return { fieldErrors, generalErrors };
}

function problemsOf(err: unknown): string[] {
  if (err instanceof ConfigError) return err.problems;
  return [err instanceof Error ? err.message : String(err)];
}

type RawRead = { ok: true; data: Record<string, unknown> } | { ok: false; problem: string };

/** The mapping of agent.yaml as written, or an empty mapping when the file does not exist. */
function readRaw(paths: Paths): RawRead {
  if (!existsSync(paths.agentYaml)) return { ok: true, data: {} };
  const doc = YAML.parseDocument(readFileSync(paths.agentYaml, 'utf8'));
  if (doc.errors.length > 0) {
    return {
      ok: false,
      problem:
        `agent.yaml is not valid YAML, so the page cannot change it. Fix the file by hand. ` +
        `The first problem: ${doc.errors[0]?.message.split('\n')[0] ?? ''}`,
    };
  }
  const data: unknown = doc.toJS();
  if (data === null || data === undefined) return { ok: true, data: {} };
  if (typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, problem: 'agent.yaml is not a mapping of keys to values, so the page cannot change it. Fix the file by hand.' };
  }
  return { ok: true, data: data as Record<string, unknown> };
}

/** What the setup page shows of agent.yaml. An invalid file shows its own values and its errors. */
export function readConfigView(paths: Paths): ConfigView {
  const defaults = defaultsView();
  if (!existsSync(paths.agentYaml)) {
    return { exists: false, values: { ...defaults }, defaults, fieldErrors: {}, generalErrors: [] };
  }
  try {
    const { config } = loadConfig(paths);
    return {
      exists: true,
      values: { ...defaults, ...flatten(toAgentFile(config) as Record<string, unknown>) },
      defaults,
      fieldErrors: {},
      generalErrors: [],
    };
  } catch (err) {
    const sorted = sortProblems(problemsOf(err));
    const raw = readRaw(paths);
    const values = raw.ok ? { ...defaults, ...flatten(raw.data) } : { ...defaults };
    // Only the keys the page knows are sent back. An unknown key is named in the errors.
    for (const key of Object.keys(values)) if (!FIELD_SET.has(key)) delete values[key];
    return {
      exists: true,
      values,
      defaults,
      error: err instanceof Error ? err.message : String(err),
      fieldErrors: sorted.fieldErrors,
      generalErrors: sorted.generalErrors,
    };
  }
}

/**
 * Applies the changed keys to agent.yaml. A null value removes the key, so its default applies.
 * The configuration module checks the whole result first. Nothing is written when it finds a problem.
 */
export function applyConfigPatch(paths: Paths, patch: Record<string, unknown>): PatchResult {
  const unknown = Object.keys(patch).filter((k) => !FIELD_SET.has(k));
  if (unknown.length > 0) {
    return { ok: false, fieldErrors: {}, generalErrors: unknown.map((k) => `The page cannot change the key "${k}".`) };
  }
  const raw = readRaw(paths);
  if (!raw.ok) return { ok: false, fieldErrors: {}, generalErrors: [raw.problem] };
  const data = raw.data;
  for (const [key, value] of Object.entries(patch)) {
    if (key.startsWith('run_limits.')) {
      const sub = key.slice('run_limits.'.length);
      const current = data.run_limits;
      const limits =
        current !== null && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
      if (value === null) delete limits[sub];
      else limits[sub] = value;
      data.run_limits = limits;
    } else if (value === null) {
      delete data[key];
    } else {
      data[key] = value;
    }
  }
  let config: AgentConfig;
  try {
    config = parseConfig(YAML.stringify(data));
  } catch (err) {
    return { ok: false, ...sortProblems(problemsOf(err)) };
  }
  writeConfig(paths, config);
  return { ok: true, config };
}

// ---------------------------------------------------------------- the two text files (§A.2, §I.1)

/** The longest text the page writes to one of the two files. */
export const MAX_TEXT_CHARS = 64 * 1024;

export interface TextsView {
  /** The core text as written, with `{agent name}` not replaced. The default text when the file does not exist. */
  corePrompt: string;
  corePromptIsDefault: boolean;
  /** Empty when the file does not exist. */
  noteParagraph: string;
}

function readText(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8').trimEnd() : undefined;
}

export function readTexts(paths: Paths): TextsView {
  const core = readText(paths.corePromptFile);
  return {
    corePrompt: core ?? DEFAULT_CORE_TEXT,
    corePromptIsDefault: core === undefined,
    noteParagraph: readText(paths.noteParagraphFile) ?? '',
  };
}

function writeOrRemove(path: string, text: string | undefined): void {
  if (text === undefined) {
    try {
      unlinkSync(path);
    } catch {
      // The file did not exist.
    }
    return;
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${text}\n`);
  renameSync(tmp, path);
}

const normal = (t: string) => t.replace(/\r\n/g, '\n').trimEnd();

/**
 * Writes the core text and the paragraph about saving notes. An empty value removes the file:
 * the core text then is the default text, and there is no paragraph. A core text equal to the
 * default also removes the file. Returns an error text, or undefined.
 */
export function writeTexts(paths: Paths, texts: { corePrompt?: unknown; noteParagraph?: unknown }): string | undefined {
  for (const [name, value] of Object.entries(texts)) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return `${name} must be a text.`;
    if (value.length > MAX_TEXT_CHARS) return `${name} must have at most ${MAX_TEXT_CHARS} characters. It has ${value.length}.`;
  }
  if (texts.corePrompt !== undefined) {
    const text = normal(typeof texts.corePrompt === 'string' ? texts.corePrompt : '');
    writeOrRemove(paths.corePromptFile, text === '' || text === normal(DEFAULT_CORE_TEXT) ? undefined : text);
  }
  if (texts.noteParagraph !== undefined) {
    const text = normal(typeof texts.noteParagraph === 'string' ? texts.noteParagraph : '');
    writeOrRemove(paths.noteParagraphFile, text === '' ? undefined : text);
  }
  return undefined;
}
