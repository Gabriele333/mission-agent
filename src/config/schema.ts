/**
 * The keys of `agent.yaml` (§A.1). Only `agent_name` is required. A missing key takes its default.
 *
 *   agent_name                  Free text, such as "Ada". Replaces {agent name} in the core text.
 *   default_surface             telegram or terminal. Default: telegram when telegram_user_id is set,
 *                               terminal otherwise.
 *   telegram_user_id            The numeric id of the user's Telegram account. Unset when Telegram is not used.
 *   model_login                 api_key (default) or subscription.
 *   max_index_line_chars        Longest line in a memory index. Default 200.
 *   max_note_bytes              Largest note file, in bytes. Default 4096.
 *   core_memory_max_lines       Lines kept in core memory. Default 50.
 *   core_memory_max_line_chars  Longest line in core memory. Default 200.
 *   max_instructions_chars      Longest mission instructions. Default 4000.
 *   max_description_chars       Longest mission description. Default 200.
 *   run_limits                  Limits of one run. A manifest can only lower them.
 *     max_steps                 Model calls per run. Default 50.
 *     max_cost_usd              Cost per run, in dollars. Default 2.
 *     max_minutes               Time per run, in minutes. Default 30.
 *   max_cost_per_day_usd        Cost per day for the whole agent, in dollars. Default 20.
 *   approval_wait_hours         Time an action waits for approval before it is cancelled. Default 24.
 *   triage_switch_confidence    Confidence triage needs to switch mission, between 0 and 1. Default 0.8.
 *   retries_after_failure       Retries after a failed run. Default 1.
 *   default_model               Model of a mission whose manifest sets none. Default claude-opus-5-5.
 *   default_effort              low, medium, high, xhigh or max. Default high.
 *   triage_model                Model of the triage classifier. Default claude-haiku-5-5.
 *   triage_effort               Effort of the triage classifier. Default low.
 */
import { z } from 'zod';
import type { AgentConfig, Effort } from '../types.js';
import { defaultConfig } from './defaults.js';

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const effort = z.enum(EFFORTS as [Effort, ...Effort[]]);
const text = z.string().refine((s) => s.trim() !== '', { message: 'must not be empty.' });
const count = z.number().int().positive();
const amount = z.number().positive();

export const agentFileSchema = z.strictObject({
  agent_name: text,
  default_surface: z.enum(['telegram', 'terminal']).optional(),
  telegram_user_id: count.optional(),
  model_login: z.enum(['api_key', 'subscription']).optional(),
  max_index_line_chars: count.optional(),
  max_note_bytes: count.optional(),
  core_memory_max_lines: count.optional(),
  core_memory_max_line_chars: count.optional(),
  max_instructions_chars: count.optional(),
  max_description_chars: count.optional(),
  run_limits: z
    .strictObject({
      max_steps: count.optional(),
      max_cost_usd: amount.optional(),
      max_minutes: amount.optional(),
    })
    .optional(),
  max_cost_per_day_usd: amount.optional(),
  approval_wait_hours: amount.optional(),
  triage_switch_confidence: z.number().min(0).max(1).optional(),
  retries_after_failure: z.number().int().min(0).optional(),
  default_model: text.optional(),
  default_effort: effort.optional(),
  triage_model: text.optional(),
  triage_effort: effort.optional(),
});

export type AgentFile = z.infer<typeof agentFileSchema>;

/** Applies the defaults of §A.1 to the values read from the file. */
export function toAgentConfig(file: AgentFile): AgentConfig {
  const d = defaultConfig(file.agent_name.trim());
  const config: AgentConfig = {
    agentName: d.agentName,
    defaultSurface: file.default_surface ?? (file.telegram_user_id !== undefined ? 'telegram' : 'terminal'),
    modelLogin: file.model_login ?? d.modelLogin,
    maxIndexLineChars: file.max_index_line_chars ?? d.maxIndexLineChars,
    maxNoteBytes: file.max_note_bytes ?? d.maxNoteBytes,
    coreMemoryMaxLines: file.core_memory_max_lines ?? d.coreMemoryMaxLines,
    coreMemoryMaxLineChars: file.core_memory_max_line_chars ?? d.coreMemoryMaxLineChars,
    maxInstructionsChars: file.max_instructions_chars ?? d.maxInstructionsChars,
    maxDescriptionChars: file.max_description_chars ?? d.maxDescriptionChars,
    runLimits: {
      maxSteps: file.run_limits?.max_steps ?? d.runLimits.maxSteps,
      maxCostUsd: file.run_limits?.max_cost_usd ?? d.runLimits.maxCostUsd,
      maxMinutes: file.run_limits?.max_minutes ?? d.runLimits.maxMinutes,
    },
    maxCostPerDayUsd: file.max_cost_per_day_usd ?? d.maxCostPerDayUsd,
    approvalWaitHours: file.approval_wait_hours ?? d.approvalWaitHours,
    triageSwitchConfidence: file.triage_switch_confidence ?? d.triageSwitchConfidence,
    retriesAfterFailure: file.retries_after_failure ?? d.retriesAfterFailure,
    defaultModel: file.default_model ?? d.defaultModel,
    defaultEffort: file.default_effort ?? d.defaultEffort,
    triageModel: file.triage_model ?? d.triageModel,
    triageEffort: file.triage_effort ?? d.triageEffort,
  };
  if (file.telegram_user_id !== undefined) config.telegramUserId = file.telegram_user_id;
  return config;
}

/** The file form of a configuration. Only the keys above are written, so no other value reaches the file. */
export function toAgentFile(config: AgentConfig): AgentFile {
  const file: AgentFile = {
    agent_name: config.agentName,
    default_surface: config.defaultSurface,
    telegram_user_id: config.telegramUserId,
    model_login: config.modelLogin,
    max_index_line_chars: config.maxIndexLineChars,
    max_note_bytes: config.maxNoteBytes,
    core_memory_max_lines: config.coreMemoryMaxLines,
    core_memory_max_line_chars: config.coreMemoryMaxLineChars,
    max_instructions_chars: config.maxInstructionsChars,
    max_description_chars: config.maxDescriptionChars,
    run_limits: {
      max_steps: config.runLimits.maxSteps,
      max_cost_usd: config.runLimits.maxCostUsd,
      max_minutes: config.runLimits.maxMinutes,
    },
    max_cost_per_day_usd: config.maxCostPerDayUsd,
    approval_wait_hours: config.approvalWaitHours,
    triage_switch_confidence: config.triageSwitchConfidence,
    retries_after_failure: config.retriesAfterFailure,
    default_model: config.defaultModel,
    default_effort: config.defaultEffort,
    triage_model: config.triageModel,
    triage_effort: config.triageEffort,
  };
  if (file.telegram_user_id === undefined) delete file.telegram_user_id;
  return file;
}

/** One line per key, written above the key by `writeConfig`. */
export const KEY_COMMENTS: Record<keyof AgentFile, string> = {
  agent_name: 'Free text. Replaces {agent name} in the core text.',
  default_surface: 'telegram or terminal.',
  telegram_user_id: "The numeric id of the user's Telegram account.",
  model_login: 'api_key or subscription.',
  max_index_line_chars: 'Longest line in a memory index, in characters.',
  max_note_bytes: 'Largest note file, in bytes.',
  core_memory_max_lines: 'Lines kept in core memory.',
  core_memory_max_line_chars: 'Longest line in core memory, in characters.',
  max_instructions_chars: 'Longest mission instructions, in characters.',
  max_description_chars: 'Longest mission description, in characters.',
  run_limits: 'Limits of one run: model calls, dollars, minutes. A manifest can only lower them.',
  max_cost_per_day_usd: 'Cost per day for the whole agent, in dollars.',
  approval_wait_hours: 'Hours an action waits for approval before it is cancelled.',
  triage_switch_confidence: 'Confidence triage needs to switch mission, between 0 and 1.',
  retries_after_failure: 'Retries after a failed run.',
  default_model: 'Model of a mission whose manifest sets none.',
  default_effort: 'low, medium, high, xhigh or max.',
  triage_model: 'Model of the triage classifier.',
  triage_effort: 'Effort of the triage classifier.',
};
