import { ACTION_ID_RE, TOOL_ID_RE } from '../manifest/ids.js';
import type {
  CodeCatalog,
  OperationDeclaration,
  ToolCatalog,
  ToolDefinition,
  TriggerSubscription,
} from '../types.js';

/** The tool declarations are inconsistent. The harness must not start with them. */
export class ToolCatalogError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`The tool catalog is invalid:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    this.name = 'ToolCatalogError';
    this.problems = problems;
  }
}

function label(tool: ToolDefinition, index: number): string {
  return tool.id === undefined ? `tool #${index} (always on)` : `tool ${tool.id}`;
}

/** Returns every problem of the declarations (§A.4 "Ids", §A.5). */
function checkDefinitions(definitions: ToolDefinition[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const sdkNames = new Map<string, string>();

  definitions.forEach((tool, i) => {
    const name = label(tool, i);
    if (tool.id !== undefined) {
      if (!TOOL_ID_RE.test(tool.id)) problems.push(`${name}: the id must look like "tool:gmail".`);
      if (ids.has(tool.id)) problems.push(`${name}: the id is declared twice.`);
      ids.add(tool.id);
    }
    // An always-on tool with no operation could only add undeclared tools, which the gate denies.
    if (tool.operations.length === 0) problems.push(`${name}: it declares no operation.`);
    for (const op of tool.operations) {
      if (!ACTION_ID_RE.test(op.action)) {
        problems.push(`${name}: action "${op.action}" must look like "action:email.send".`);
      }
      if (op.effect !== 'read' && op.effect !== 'change') {
        problems.push(`${name}: operation ${op.sdkToolName} has effect "${String(op.effect)}", not read or change.`);
      }
      if (typeof op.sdkToolName !== 'string' || op.sdkToolName === '') {
        problems.push(`${name}: an operation has no sdkToolName.`);
        continue;
      }
      const owner = sdkNames.get(op.sdkToolName);
      if (owner !== undefined) {
        problems.push(`${name}: sdkToolName "${op.sdkToolName}" is already declared by ${owner}.`);
      } else {
        sdkNames.set(op.sdkToolName, name);
      }
    }
  });
  return problems;
}

/**
 * The catalog of every tool of the harness. Tools without an id are the always-on tools.
 * Throws a ToolCatalogError that lists every problem of the declarations.
 */
export function createToolCatalog(definitions: ToolDefinition[]): ToolCatalog {
  const problems = checkDefinitions(definitions);
  if (problems.length > 0) throw new ToolCatalogError(problems);

  const tools = [...definitions];
  const byId = new Map<string, ToolDefinition>();
  const byName = new Map<string, { tool: ToolDefinition; operation: OperationDeclaration }>();
  for (const tool of tools) {
    if (tool.id !== undefined) byId.set(tool.id, tool);
    for (const operation of tool.operations) byName.set(operation.sdkToolName, { tool, operation });
  }
  const toolIds = tools.flatMap((t) => (t.id === undefined ? [] : [t.id]));
  // Two tools may declare the same action id (§A.5). Gates of a manifest may also name the actions of always-on tools.
  const actionIds = [...new Set(tools.flatMap((t) => t.operations.map((o) => o.action)))];
  const alwaysOn = tools.filter((t) => t.id === undefined);

  return {
    toolIds: () => [...toolIds],
    actionIds: () => [...actionIds],
    toolReservedFor: (toolId) => {
      const reserved = byId.get(toolId)?.reservedFor;
      return reserved === undefined ? undefined : [...reserved];
    },
    get: (toolId) => byId.get(toolId),
    // The same objects as in the definitions: the gate compares them by reference.
    alwaysOn: () => [...alwaysOn],
    findOperation: (sdkToolName) => byName.get(sdkToolName),
  };
}

/** What the code catalog needs from the triggers. */
export interface TriggerIds {
  ids(): string[];
  validateParams(sub: TriggerSubscription): string | null;
}

/** The ids that a manifest can refer to. The mission registry validates manifests against it. */
export function createCodeCatalog(tools: ToolCatalog, triggers: TriggerIds): CodeCatalog {
  return {
    toolIds: () => tools.toolIds(),
    triggerIds: () => triggers.ids(),
    actionIds: () => tools.actionIds(),
    toolReservedFor: (toolId) => tools.toolReservedFor(toolId),
    validateTriggerParams: (sub) => triggers.validateParams(sub),
  };
}
