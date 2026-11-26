import type { CanUseTool, HookCallback, McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk';
import { homedir, userInfo } from 'node:os';
import type { Paths } from '../paths.js';
import { DENIED_SDK_TOOLS, FILE_TOOL_NAMES, SKILL_TOOL_NAME } from '../safety/index.js';
import type {
  AgentConfig,
  Effort,
  LoadedConfig,
  Manifest,
  RunInput,
  RunLimits,
  ToolProvision,
} from '../types.js';

/** The options builder of §2.1: turns a manifest and the agent configuration into one `query()` call. */

/** The three variables of the machine that a run gets (§A.5 "How a value is read"). */
export interface HostEnv {
  PATH?: string;
  HOME?: string;
  USER?: string;
}

export interface RunHooks {
  preToolUse: HookCallback;
  canUseTool: CanUseTool;
}

export interface BuildRunOptionsInput {
  manifest: Manifest;
  loaded: LoadedConfig;
  /** Paths with the real path of the root, so the SDK compares the same spelling as the gate. */
  paths: Paths;
  provisions: ToolProvision[];
  /** The session to resume. */
  resume?: string;
  /** The value of `credential:model.api_key`. Used only with the `api_key` login. */
  modelApiKey?: string;
  /** The SDK's configuration folder. Null leaves `CLAUDE_CONFIG_DIR` out (live tests only). */
  sdkConfigDir: string | null;
  /** The content of `core/memory.md`, or an empty text. */
  coreMemoryText: string;
  hostEnv: HostEnv;
  hooks: RunHooks;
  input: RunInput;
  notices: string[];
  now: Date;
  /** An IANA time zone, such as `Europe/Rome`. */
  timeZone: string;
}

export interface BuiltRun {
  options: Options;
  /** The run's input text (§C.4). */
  prompt: string;
  /** The text appended to the SDK's standard prompt (§C.1). */
  systemAppend: string;
  tools: string[];
  limits: RunLimits;
  model: string;
  effort: Effort;
}

export function buildRunOptions(input: BuildRunOptionsInput): BuiltRun {
  const { manifest, loaded, paths, provisions } = input;
  const cfg = loaded.config;
  const missionDir = paths.missionDir(manifest.id);
  const systemAppend = buildSystemAppend(loaded, manifest, input.coreMemoryText);
  const tools = builtInTools(provisions);
  const mcpServers = mcpServersOf(provisions);
  const limits = resolveLimits(cfg.runLimits, manifest);
  const model = resolveModel(cfg, manifest);
  const effort = resolveEffort(cfg, manifest);
  const env = buildRunEnv(cfg.modelLogin, input.hostEnv, input.sdkConfigDir, input.modelApiKey);

  const options: Options = {
    cwd: missionDir,
    additionalDirectories: [paths.coreDir],
    plugins: [
      // skipMcpDiscovery: a file in the folder must not add an MCP server to the run.
      { type: 'local', path: missionDir, skipMcpDiscovery: true },
      { type: 'local', path: paths.coreDir, skipMcpDiscovery: true },
    ],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend, snapshot: false },
    settingSources: [],
    settings: {
      autoMemoryEnabled: true,
      autoMemoryDirectory: paths.memoryDir(manifest.id),
      autoDreamEnabled: false,
      permissions: {
        blockReadsOutsideWorkingDirectories: true,
        blockWritesOutsideWorkingDirectories: true,
      },
    },
    tools,
    disallowedTools: [...DENIED_SDK_TOOLS],
    mcpServers,
    strictMcpConfig: true,
    // Without it the SDK may start in auto mode, where a classifier answers instead of the user.
    permissionMode: 'default',
    model,
    effort,
    maxTurns: limits.maxSteps,
    maxBudgetUsd: limits.maxCostUsd,
    env,
    hooks: { PreToolUse: [{ onFailure: 'block', hooks: [input.hooks.preToolUse] }] },
    canUseTool: input.hooks.canUseTool,
  };
  if (input.resume !== undefined) options.resume = input.resume;

  return {
    options,
    prompt: buildInputText(input.input, input.notices, input.now, input.timeZone),
    systemAppend,
    tools,
    limits,
    model,
    effort,
  };
}

/** Core text, core memory, the mission's instructions, the note paragraph (§C.1). No per-run value. */
export function buildSystemAppend(loaded: LoadedConfig, manifest: Manifest, coreMemoryText: string): string {
  const parts = [loaded.coreText.trim()];
  const core = coreMemoryLines(coreMemoryText, loaded.config.coreMemoryMaxLines);
  if (core !== '') parts.push(`# Core memory\n\n${core}`);
  parts.push(`# Mission: ${manifest.name}\n\n${manifest.context.instructions.trim()}`);
  const note = loaded.noteParagraph.trim();
  if (note !== '') parts.push(note);
  return parts.join('\n\n');
}

/** The first `maxLines` lines of core memory. Blank lines at the end are dropped. */
export function coreMemoryLines(text: string, maxLines: number): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n').slice(0, Math.max(0, maxLines));
  return lines.join('\n').trimEnd();
}

/** The run's input in the fixed order of §C.4: date and time, what started the run, notices. */
export function buildInputText(input: RunInput, notices: string[], now: Date, timeZone: string): string {
  const parts = [`Date and time: ${formatLocalTime(now, timeZone)}`];
  if (input.kind === 'chat') {
    parts.push(`Chat message from the user (${input.surface}):\n${input.text}`);
  } else {
    const count = input.events.length;
    const records = input.events.map((e, i) => {
      const data = Object.keys(e.data ?? {}).length > 0 ? `\nData: ${JSON.stringify(e.data)}` : '';
      return `${i + 1}. ${e.triggerId}, at ${e.time}: ${e.summary}${data}`;
    });
    parts.push(`${count === 1 ? 'Event' : `Events (${count})`} that started this run:\n${records.join('\n')}`);
  }
  if (notices.length > 0) {
    parts.push(`Notices from the harness:\n${notices.map((n) => `- ${n}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

/** For example `2026-11-25 14:03, Wednesday, time zone Europe/Rome (UTC+01:00)`. */
export function formatLocalTime(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'long',
    timeZoneName: 'longOffset',
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const offset = get('timeZoneName').replace(/^GMT/, 'UTC') || 'UTC';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}, ${get('weekday')}, time zone ${timeZone} (${offset})`;
}

/** The file tools and the skill tool, then the built-in tools that provisions add, sorted (§C.1, §C.5). */
export function builtInTools(provisions: ToolProvision[]): string[] {
  const base: string[] = [...FILE_TOOL_NAMES, SKILL_TOOL_NAME];
  const denied = new Set<string>(DENIED_SDK_TOOLS);
  const extra = new Set<string>();
  for (const p of provisions) {
    for (const name of p.sdkTools ?? []) {
      if (!base.includes(name) && !denied.has(name)) extra.add(name);
    }
  }
  return [...base, ...[...extra].sort()];
}

/** The MCP servers of all provisions, keyed in sorted order. Two servers with one name is an error. */
export function mcpServersOf(provisions: ToolProvision[]): Record<string, McpServerConfig> {
  const all = new Map<string, McpServerConfig>();
  for (const p of provisions) {
    for (const [name, server] of Object.entries(p.mcpServers ?? {})) {
      if (all.has(name)) throw new Error(`two tools provide an MCP server named "${name}"`);
      all.set(name, server as McpServerConfig);
    }
  }
  const out: Record<string, McpServerConfig> = {};
  for (const name of [...all.keys()].sort()) out[name] = all.get(name) as McpServerConfig;
  return out;
}

export function resolveModel(cfg: AgentConfig, manifest: Manifest): string {
  const m = manifest.model;
  return typeof m === 'string' && m !== '' && m !== 'default' ? m : cfg.defaultModel;
}

export function resolveEffort(cfg: AgentConfig, manifest: Manifest): Effort {
  const e = manifest.effort as string | undefined;
  return typeof e === 'string' && e !== '' && e !== 'default' ? (e as Effort) : cfg.defaultEffort;
}

/** A manifest can only lower a limit (§D). A value that is not a positive number is ignored. */
export function resolveLimits(defaults: RunLimits, manifest: Manifest): RunLimits {
  const l = manifest.limits ?? {};
  const lower = (def: number, v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 && v < def ? v : def;
  return {
    maxSteps: Math.max(1, Math.floor(lower(defaults.maxSteps, l.max_steps))),
    maxCostUsd: lower(defaults.maxCostUsd, l.max_cost_usd),
    maxMinutes: lower(defaults.maxMinutes, l.max_minutes),
  };
}

/**
 * The whole environment of a run: `PATH`, `HOME`, `USER`, `CLAUDE_CONFIG_DIR`, and
 * `ANTHROPIC_API_KEY` with the `api_key` login only (§A.5). Nothing else.
 */
export function buildRunEnv(
  login: AgentConfig['modelLogin'],
  host: HostEnv,
  sdkConfigDir: string | null,
  apiKey: string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (host.PATH) env.PATH = host.PATH;
  if (host.HOME) env.HOME = host.HOME;
  if (host.USER) env.USER = host.USER;
  if (sdkConfigDir !== null) env.CLAUDE_CONFIG_DIR = sdkConfigDir;
  if (login === 'api_key' && apiKey) env.ANTHROPIC_API_KEY = apiKey;
  return env;
}

/** Reads the three variables from the harness's own process, with fallbacks. */
export function hostEnvFromProcess(): HostEnv {
  let user = process.env.USER;
  if (!user) {
    try {
      user = userInfo().username;
    } catch {
      user = undefined;
    }
  }
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: process.env.HOME || homedir(),
    USER: user,
  };
}
