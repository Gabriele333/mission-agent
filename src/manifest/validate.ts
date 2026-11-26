import type { AgentConfig, CodeCatalog, Manifest } from '../types.js';
import { isSystemMissionId } from './ids.js';

export interface ValidationContext {
  catalog: CodeCatalog;
  config: AgentConfig;
}

/**
 * The rules of §A.4 and chapter 4 that need the code catalog or the configuration.
 * The structure is already checked by the schema. Returns every problem found.
 */
export function validateManifest(m: Manifest, ctx: ValidationContext): string[] {
  const { catalog, config } = ctx;
  const problems: string[] = [];

  if (isSystemMissionId(m.id)) {
    if (m.name !== m.id) problems.push(`name must be "${m.id}", the same as the id of this system mission.`);
    if (m.status !== 'active') problems.push(`status must be active: the system mission ${m.id} cannot be frozen.`);
  } else if (m.name.startsWith('sys-')) {
    problems.push(`name "${m.name}" starts with "sys-", which is reserved for the system missions.`);
  }

  if (m.description.length > config.maxDescriptionChars) {
    problems.push(
      `description has ${m.description.length} characters. The limit is ${config.maxDescriptionChars}.`,
    );
  }
  const instructions = m.context.instructions;
  if (instructions.length > config.maxInstructionsChars) {
    problems.push(
      `context.instructions has ${instructions.length} characters. The limit is ${config.maxInstructionsChars}.`,
    );
  }

  const toolIds = new Set(catalog.toolIds());
  const seenTools = new Set<string>();
  m.tools.forEach((tool, i) => {
    if (seenTools.has(tool)) problems.push(`tools[${i}] "${tool}" is listed twice.`);
    seenTools.add(tool);
    if (!toolIds.has(tool)) {
      problems.push(`tools[${i}] "${tool}" does not exist in the harness.`);
      return;
    }
    const reserved = catalog.toolReservedFor(tool);
    if (reserved !== undefined && !reserved.includes(m.id)) {
      const owners = reserved.length > 0 ? reserved.join(', ') : 'no mission';
      problems.push(`tools[${i}] "${tool}" is reserved for ${owners}.`);
    }
  });

  const triggerIds = new Set(catalog.triggerIds());
  const seenTriggers = new Set<string>();
  m.triggers.forEach((sub, i) => {
    if (!triggerIds.has(sub.use)) {
      problems.push(`triggers[${i}] "${sub.use}" does not exist in the harness.`);
      return;
    }
    // A trigger with no parameters can be listed once. A timer can be listed several times with different times.
    const key = JSON.stringify(sub);
    if (seenTriggers.has(key)) problems.push(`triggers[${i}] "${sub.use}" is listed twice with the same parameters.`);
    seenTriggers.add(key);
    const error = catalog.validateTriggerParams(sub);
    if (error !== null) problems.push(`triggers[${i}] "${sub.use}": ${error}`);
  });

  const actionIds = new Set(catalog.actionIds());
  const seenActions = new Set<string>();
  m.gates.forEach((gate, i) => {
    if (!actionIds.has(gate.for)) problems.push(`gates[${i}].for "${gate.for}" is not an action of any tool in the harness.`);
    if (seenActions.has(gate.for)) problems.push(`gates[${i}]: there is already a gate for "${gate.for}".`);
    seenActions.add(gate.for);
  });

  const limits = m.limits ?? {};
  const max = config.runLimits;
  if (limits.max_steps !== undefined && limits.max_steps > max.maxSteps) {
    problems.push(`limits.max_steps is ${limits.max_steps}. It cannot be higher than the harness limit, ${max.maxSteps}.`);
  }
  if (limits.max_cost_usd !== undefined && limits.max_cost_usd > max.maxCostUsd) {
    problems.push(
      `limits.max_cost_usd is ${limits.max_cost_usd}. It cannot be higher than the harness limit, ${max.maxCostUsd}.`,
    );
  }
  if (limits.max_minutes !== undefined && limits.max_minutes > max.maxMinutes) {
    problems.push(
      `limits.max_minutes is ${limits.max_minutes}. It cannot be higher than the harness limit, ${max.maxMinutes}.`,
    );
  }

  return problems;
}
