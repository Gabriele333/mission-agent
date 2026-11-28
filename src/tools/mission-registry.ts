import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { EFFORTS } from '../config/index.js';
import { findLibraryMission, readLibrary, type Library } from '../library/index.js';
import {
  GATE_KINDS,
  isValidMissionId,
  ManifestValidationError,
  MissionNotFoundError,
  SystemMissionError,
} from '../manifest/index.js';
import {
  SYS_MISSION_ADMIN,
  type AgentConfig,
  type Effort,
  type GateKind,
  type Manifest,
  type ManifestDraft,
  type MissionId,
  type MissionRegistry,
  type ToolCatalog,
  type ToolContext,
  type ToolDefinition,
  type TriggerDefinition,
} from '../types.js';
import { libraryDir as programLibraryDir } from '../program.js';
import { mcpToolName, MISSION_REGISTRY_SERVER, MISSION_REGISTRY_TOOL_ID, REGISTRY_ACTION_IDS, REGISTRY_TOOLS } from './ids.js';
import { errorResult, errorText, okResult, type ToolResult } from './results.js';

/** The registry tool of the mission admin (§4.2, §4.2.1). */

export interface MissionRegistryToolDeps {
  config: () => AgentConfig;
  /** Read when `list_catalog` runs. A getter, because the catalog is built after this tool. */
  catalog: () => ToolCatalog;
  /** Read when `list_catalog` runs. */
  triggers: () => readonly TriggerDefinition[];
  /** The folder of the mission library. Default: the one that comes with the program. */
  libraryDir?: () => string;
}

// ---------------------------------------------------------------- input shapes

// The shapes check the structure only. The registry checks formats, ids and limits,
// so the model receives every problem of a draft in one answer.

const missionRef = z
  .string()
  .min(1)
  .describe('The id of the mission (such as "m_k7q3zp2xw9ha") or its name (such as "inbox-curator").');

const triggerSchema = z
  .looseObject({
    use: z.string().describe('A trigger id from list_catalog, such as "trigger:cron" or "trigger:chat".'),
  })
  .describe('One trigger subscription. Every key other than "use" is a parameter of the trigger, such as "at" for trigger:cron.');

const gateSchema = z
  .strictObject({
    use: z.enum(GATE_KINDS as [GateKind, ...GateKind[]]).describe('The kind of gate.'),
    for: z.string().describe('The action id the gate applies to, such as "action:email.send".'),
    note: z.string().optional().describe('Optional. The sentence shown to the user in the approval request.'),
  })
  .describe('One gate: it changes the default approval rule for one action.');

const limitsSchema = z
  .strictObject({
    max_steps: z.number().optional().describe('Maximum model calls per run. Lower than the harness limit.'),
    max_cost_usd: z.number().optional().describe('Maximum cost per run in dollars. Lower than the harness limit.'),
    max_minutes: z.number().optional().describe('Maximum minutes per run. Lower than the harness limit.'),
  })
  .describe('Run limits. Each one must be lower than the harness limit that list_catalog shows.');

const fields = {
  name: z.string().describe('Short, lowercase, words joined by hyphens, unique, such as "news-curator". Must not start with "sys-".'),
  description: z.string().describe('One line that says what the mission is for. Triage reads it to route chat messages.'),
  triggers: z.array(triggerSchema).describe('What starts a run of the mission. List "trigger:chat" so the user can talk to it.'),
  tools: z.array(z.string()).describe('Tool ids from list_catalog. The message tool, the delete tool and the file tools are always there: do not list them.'),
  context: z
    .strictObject({ instructions: z.string().describe('What the mission is, what it is for, and what a good result is.') })
    .describe('What the model of the mission reads on every run.'),
  signals: z.array(z.string()).describe('Signal ids. No signal is available yet: give an empty list.'),
  gates: z.array(gateSchema).describe('Gates. Leave empty to keep the default rule: a reading action runs, a changing action waits for approval.'),
  model: z.string().describe('A model id, or "default" for the harness default.'),
  effort: z.enum(EFFORTS as [Effort, ...Effort[]]).describe('The effort of the model.'),
  limits: limitsSchema,
};

export const createMissionShape = {
  manifest: z
    .strictObject({
      name: fields.name,
      description: fields.description,
      triggers: fields.triggers,
      tools: fields.tools,
      context: fields.context,
      signals: fields.signals.optional(),
      gates: fields.gates,
      model: fields.model.optional(),
      effort: fields.effort.optional(),
      limits: limitsSchema.optional(),
    })
    .describe('The full manifest of the new mission. The harness sets its id and version, and its status is active.'),
};

export const editMissionShape = {
  mission: missionRef,
  changes: z
    .strictObject({
      name: fields.name.optional(),
      description: fields.description.optional(),
      triggers: fields.triggers.optional().describe('Replaces the whole list of triggers.'),
      tools: fields.tools.optional().describe('Replaces the whole list of tools.'),
      context: fields.context.optional().describe('Replaces the instructions.'),
      signals: fields.signals.optional().describe('Replaces the whole list of signals.'),
      gates: fields.gates.optional().describe('Replaces the whole list of gates.'),
      model: fields.model.nullable().optional().describe('A model id or "default". null removes the field.'),
      effort: fields.effort.nullable().optional().describe('The effort. null removes the field.'),
      limits: limitsSchema.nullable().optional().describe('Replaces the whole limits section. null removes it.'),
    })
    .describe('Only the fields that change, each with its new value. A field that is left out stays as it is.'),
};

export const freezeMissionShape = {
  mission: missionRef,
  frozen: z.boolean().describe('true freezes the mission: it no longer runs, and its folder is kept. false makes a frozen mission active again.'),
};

export const missionRefShape = { mission: missionRef };

const libraryRef = z.string().min(1).describe('The name of a mission of the mission library, as list_library shows it, such as "morning-news".');

export const libraryMissionShape = { library_mission: libraryRef };

type CreateArgs = z.infer<z.ZodObject<typeof createMissionShape>>;
type EditArgs = z.infer<z.ZodObject<typeof editMissionShape>>;

// ---------------------------------------------------------------- helpers

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

type Resolved = { ok: true; id: MissionId; manifest?: Manifest } | { ok: false; result: ToolResult };

/** Finds a mission by id, then by name. An id that is not loaded goes to the registry, which says why. */
function resolveMission(registry: MissionRegistry, ref: string): Resolved {
  const manifest = registry.get(ref) ?? registry.getByName(ref);
  if (manifest !== undefined) return { ok: true, id: manifest.id, manifest };
  if (isValidMissionId(ref)) return { ok: true, id: ref };
  return {
    ok: false,
    result: errorResult(`There is no mission with the id or name "${ref}". Call ${REGISTRY_TOOLS.listMissions} to see the missions.`),
  };
}

function registryError(err: unknown, what: string): ToolResult {
  if (err instanceof ManifestValidationError) {
    return errorResult(
      `${what} was not saved, because the manifest has these problems. Fix every one and call the tool again:\n` +
        err.problems.map((p) => `- ${p}`).join('\n'),
    );
  }
  // The registry's own text, as it is (§4).
  if (err instanceof SystemMissionError || err instanceof MissionNotFoundError) return errorResult(err.message);
  return errorResult(`${what} failed: ${errorText(err)}`);
}

/** Tells the harness about a change. A failure here does not undo the change, so it is reported, not returned as an error. */
async function notifyChanged(ctx: ToolContext, id: MissionId): Promise<string> {
  try {
    await ctx.host.missionChanged(id);
    return '';
  } catch (err) {
    return ` The change is saved, but the harness could not update the list of chat commands: ${errorText(err)}`;
  }
}

function draftFromInput(m: CreateArgs['manifest']): ManifestDraft {
  const draft: ManifestDraft = {
    name: m.name,
    description: m.description,
    triggers: m.triggers,
    tools: m.tools,
    context: { instructions: m.context.instructions },
    signals: m.signals ?? [],
    gates: m.gates,
  };
  if (m.model !== undefined) draft.model = m.model;
  if (m.effort !== undefined) draft.effort = m.effort;
  if (m.limits !== undefined) draft.limits = m.limits;
  return draft;
}

/** The patch holds exactly the fields given. A null value becomes undefined, which the registry removes. */
function patchFromInput(changes: EditArgs['changes']): Partial<ManifestDraft> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    patch[key] = value === null ? undefined : value;
  }
  return patch as Partial<ManifestDraft>;
}

// ---------------------------------------------------------------- operations

export function listMissions(ctx: ToolContext): ToolResult {
  const registry = ctx.host.registry;
  const missions = registry.list().map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    status: m.status,
    version: m.version,
  }));
  return okResult(json({ missions, errors: registry.errors() }));
}

export function readMission(ctx: ToolContext, args: { mission: string }): ToolResult {
  const registry = ctx.host.registry;
  const manifest = registry.get(args.mission) ?? registry.getByName(args.mission);
  if (manifest !== undefined) return okResult(json(manifest));
  const problems = registry.errors().filter((e) => e.source.split('/').includes(args.mission));
  if (problems.length > 0) {
    return errorResult(
      `The manifest of ${args.mission} is not loaded because it is invalid:\n` + problems.map((p) => `- ${p.message}`).join('\n'),
    );
  }
  return errorResult(`There is no mission with the id or name "${args.mission}".`);
}

export function listCatalog(deps: MissionRegistryToolDeps): ToolResult {
  const catalog = deps.catalog();
  const config = deps.config();
  const operations = (t: ToolDefinition) => t.operations.map((o) => ({ action: o.action, effect: o.effect }));
  const tools = catalog.toolIds().flatMap((id) => {
    const t = catalog.get(id);
    if (t === undefined) return [];
    const reservedFor = catalog.toolReservedFor(id);
    return [{ id, ...(reservedFor === undefined ? {} : { reservedFor }), credentials: t.credentials, operations: operations(t) }];
  });
  const alwaysOn = catalog.alwaysOn().flatMap(operations);
  const triggers = deps.triggers().map((t) => {
    let withoutParameters: string;
    try {
      withoutParameters = t.validateParams({}) ?? 'valid';
    } catch (err) {
      withoutParameters = `the check failed: ${errorText(err)}`;
    }
    return { id: t.id, credentials: t.credentials, withoutParameters };
  });
  return okResult(
    json({
      tools,
      toolsNote:
        'List tools by id. A tool with reservedFor can only be listed by those missions. ' +
        'effect "read" only reads; "change" changes something outside the agent. Gates name the action ids.',
      alwaysOnActions: alwaysOn,
      alwaysOnNote:
        'Every mission has the message tool, the delete tool and the file tools without listing them. ' +
        'Their actions can still be named in gates.',
      triggers,
      triggersNote:
        'withoutParameters is "valid" when the trigger needs no parameter. Otherwise it says which parameters the trigger needs. ' +
        'Parameters are extra keys next to "use", such as {"use": "trigger:cron", "at": "0 7 * * *"}.',
      gateKinds: {
        'gate:allow': 'A changing action runs without asking.',
        'gate:require_approval': 'The action waits for the user\'s approval. A note is shown in the request.',
        'gate:deny': 'The action never runs.',
      },
      defaultRule: 'With no gate, a reading action runs and a changing action waits for the user\'s approval.',
      signals: [],
      signalsNote: 'No signal is available yet. Give an empty list.',
      rules: {
        name:
          'Lowercase letters and digits, words joined by hyphens, at most 32 characters, unique, not starting with "sys-". ' +
          'The name gives the mission its chat command, with each hyphen replaced by an underscore, so it cannot be ' +
          'general, mission, stop, pause, resume, improve, start, mission-admin or self-improve.',
        descriptionMaxChars: config.maxDescriptionChars,
        instructionsMaxChars: config.maxInstructionsChars,
        limitsMax: {
          max_steps: config.runLimits.maxSteps,
          max_cost_usd: config.runLimits.maxCostUsd,
          max_minutes: config.runLimits.maxMinutes,
        },
        efforts: EFFORTS,
        model: `"default" uses ${config.defaultModel}. Any other value is a model id.`,
      },
    }),
  );
}

export async function createMission(ctx: ToolContext, args: CreateArgs): Promise<ToolResult> {
  let created: Manifest;
  try {
    created = ctx.host.registry.create(draftFromInput(args.manifest));
  } catch (err) {
    return registryError(err, 'The mission');
  }
  const notice = await notifyChanged(ctx, created.id);
  return okResult(`Created mission ${created.name} with id ${created.id}, version ${created.version}.${notice}`);
}

export async function editMission(ctx: ToolContext, args: EditArgs): Promise<ToolResult> {
  const patch = patchFromInput(args.changes);
  if (Object.keys(patch).length === 0) return errorResult('changes is empty. Give at least one field to change.');
  const resolved = resolveMission(ctx.host.registry, args.mission);
  if (!resolved.ok) return resolved.result;
  const before = resolved.manifest?.version;
  let edited: Manifest;
  try {
    edited = ctx.host.registry.edit(resolved.id, patch);
  } catch (err) {
    return registryError(err, 'The change');
  }
  if (edited.version === before) return okResult(`Mission ${edited.name} already had these values. Nothing changed.`);
  const notice = await notifyChanged(ctx, edited.id);
  return okResult(
    `Edited mission ${edited.name} (${edited.id}). Changed: ${Object.keys(patch).join(', ')}. It is now version ${edited.version}.${notice}`,
  );
}

export async function freezeMission(ctx: ToolContext, args: { mission: string; frozen: boolean }): Promise<ToolResult> {
  const resolved = resolveMission(ctx.host.registry, args.mission);
  if (!resolved.ok) return resolved.result;
  const status = args.frozen ? 'frozen' : 'active';
  const before = resolved.manifest?.status;
  let result: Manifest;
  try {
    result = ctx.host.registry.setStatus(resolved.id, status);
  } catch (err) {
    return registryError(err, 'The status change');
  }
  if (before === status) return okResult(`Mission ${result.name} is already ${status}. Nothing changed.`);
  const notice = await notifyChanged(ctx, result.id);
  return okResult(`Mission ${result.name} (${result.id}) is now ${status}, version ${result.version}.${notice}`);
}

export async function deleteMission(ctx: ToolContext, args: { mission: string }): Promise<ToolResult> {
  const resolved = resolveMission(ctx.host.registry, args.mission);
  if (!resolved.ok) return resolved.result;
  const { id } = resolved;
  const name = resolved.manifest?.name ?? id;
  try {
    ctx.host.registry.remove(id);
  } catch (err) {
    return registryError(err, 'The deletion');
  }
  let cleanUp = '';
  try {
    await ctx.host.cleanUpDeletedMission(id);
  } catch (err) {
    cleanUp = ` Its folder is removed, but removing its session and waiting approvals failed: ${errorText(err)}`;
  }
  return okResult(
    `Deleted mission ${name} (${id}). Its folder, session and waiting approvals are removed. ` +
      `Its logbook rows are kept.${cleanUp} ` +
      'Tell the user that what the mission created in outside systems, such as labels, drafts or files, is left untouched.',
  );
}

// ---------------------------------------------------------------- the mission library

type LibraryRead = { ok: true; library: Library } | { ok: false; result: ToolResult };

function openLibrary(deps: MissionRegistryToolDeps): LibraryRead {
  try {
    return { ok: true, library: readLibrary((deps.libraryDir ?? programLibraryDir)()) };
  } catch (err) {
    return { ok: false, result: errorResult(`The mission library cannot be read: ${errorText(err)}`) };
  }
}

export function listLibrary(ctx: ToolContext, deps: MissionRegistryToolDeps): ToolResult {
  const opened = openLibrary(deps);
  if (!opened.ok) return opened.result;
  const registry = ctx.host.registry;
  const missions = opened.library.missions.map((m) => ({
    name: m.folder,
    description: m.manifest.description,
    triggers: m.manifest.triggers,
    tools: m.manifest.tools,
    // A mission of the library keeps its id, so the id tells whether this agent has it.
    inThisAgent: registry.get(m.manifest.id) !== undefined,
  }));
  return okResult(
    json({
      missions,
      problems: opened.library.problems,
      note:
        'These are published missions that come with the harness. They are not part of this agent until one is added. ' +
        `${REGISTRY_TOOLS.readLibraryMission} returns the full manifest of one. ${REGISTRY_TOOLS.addLibraryMission} adds one as it is published.`,
    }),
  );
}

export function readLibraryMission(deps: MissionRegistryToolDeps, args: { library_mission: string }): ToolResult {
  const opened = openLibrary(deps);
  if (!opened.ok) return opened.result;
  const found = findLibraryMission(opened.library, args.library_mission);
  if (found === undefined) {
    return errorResult(`The mission library has no mission "${args.library_mission}". Call ${REGISTRY_TOOLS.listLibrary} to see the missions.`);
  }
  return okResult(json({ manifest: found.manifest, skills: found.skills, readme: found.readme ?? '' }));
}

export async function addLibraryMission(
  ctx: ToolContext,
  deps: MissionRegistryToolDeps,
  args: { library_mission: string },
): Promise<ToolResult> {
  const opened = openLibrary(deps);
  if (!opened.ok) return opened.result;
  const found = findLibraryMission(opened.library, args.library_mission);
  if (found === undefined) {
    return errorResult(`The mission library has no mission "${args.library_mission}". Call ${REGISTRY_TOOLS.listLibrary} to see the missions.`);
  }
  let added: Manifest;
  try {
    added = ctx.host.registry.install(found.dir);
  } catch (err) {
    return registryError(err, 'The mission');
  }
  const notice = await notifyChanged(ctx, added.id);
  return okResult(
    `Added the mission ${added.name} from the mission library, with id ${added.id}, version ${added.version}. ` +
      `It now belongs to this agent, and it can be edited like any other mission.${notice}`,
  );
}

// ---------------------------------------------------------------- tool definition

/** Shown with each change operation, so the model writes the input for the user who approves it. */
const APPROVAL_NOTE = 'The call waits for the user\'s approval, and the user sees this input in full.';

/** The SDK tool definitions of the `mission_registry` server for one run. */
export function missionRegistrySdkTools(ctx: ToolContext, deps: MissionRegistryToolDeps) {
  return {
    listMissions: tool(
      REGISTRY_TOOLS.listMissions,
      'Lists every mission: id, name, description, status and version, and the manifests that could not be loaded, with their errors.',
      {},
      async () => listMissions(ctx),
    ),
    readMission: tool(
      REGISTRY_TOOLS.readMission,
      'Returns the full manifest of one mission.',
      missionRefShape,
      async (args) => readMission(ctx, args),
    ),
    listCatalog: tool(
      REGISTRY_TOOLS.listCatalog,
      'Lists the ids a manifest can use: tools with their actions, triggers with their parameters, gate kinds, and the limits of each field.',
      {},
      async () => listCatalog(deps),
    ),
    createMission: tool(
      REGISTRY_TOOLS.createMission,
      `Creates a mission from a full manifest. ${APPROVAL_NOTE}`,
      createMissionShape,
      (args) => createMission(ctx, args),
    ),
    editMission: tool(
      REGISTRY_TOOLS.editMission,
      `Changes some fields of a mission's manifest. Give only the fields that change. ${APPROVAL_NOTE}`,
      editMissionShape,
      (args) => editMission(ctx, args),
    ),
    freezeMission: tool(
      REGISTRY_TOOLS.freezeMission,
      `Freezes a mission, or makes a frozen mission active again. ${APPROVAL_NOTE}`,
      freezeMissionShape,
      (args) => freezeMission(ctx, args),
    ),
    deleteMission: tool(
      REGISTRY_TOOLS.deleteMission,
      'Deletes a mission: its folder with manifest, memory, skills and data, its session and its waiting approvals. ' +
        `Its logbook rows are kept. What it created in outside systems is left untouched. ${APPROVAL_NOTE}`,
      missionRefShape,
      (args) => deleteMission(ctx, args),
    ),
    listLibrary: tool(
      REGISTRY_TOOLS.listLibrary,
      'Lists the missions of the mission library: published missions that come with the harness and that the user can add to this agent. ' +
        'Each one has a name, a description, its triggers and tools, and whether this agent already has it.',
      {},
      async () => listLibrary(ctx, deps),
    ),
    readLibraryMission: tool(
      REGISTRY_TOOLS.readLibraryMission,
      'Returns the full manifest of one mission of the mission library, the names of its skills, and the text that its author wrote about it.',
      libraryMissionShape,
      async (args) => readLibraryMission(deps, args),
    ),
    addLibraryMission: tool(
      REGISTRY_TOOLS.addLibraryMission,
      'Adds one mission of the mission library to this agent, as it is published: its manifest, with the id written in it, and its skills. ' +
        'The call waits for the user\'s approval, and the user sees the whole manifest.',
      libraryMissionShape,
      (args) => addLibraryMission(ctx, deps, args),
    ),
  };
}

const RESERVED_FOR: MissionId[] = [SYS_MISSION_ADMIN];

export function missionRegistryTool(deps: MissionRegistryToolDeps): ToolDefinition {
  const name = (t: string) => mcpToolName(MISSION_REGISTRY_SERVER, t);
  return {
    id: MISSION_REGISTRY_TOOL_ID,
    operations: [
      { sdkToolName: name(REGISTRY_TOOLS.listMissions), action: REGISTRY_ACTION_IDS.list, effect: 'read' },
      { sdkToolName: name(REGISTRY_TOOLS.readMission), action: REGISTRY_ACTION_IDS.read, effect: 'read' },
      { sdkToolName: name(REGISTRY_TOOLS.listCatalog), action: REGISTRY_ACTION_IDS.catalog, effect: 'read' },
      { sdkToolName: name(REGISTRY_TOOLS.createMission), action: REGISTRY_ACTION_IDS.create, effect: 'change' },
      { sdkToolName: name(REGISTRY_TOOLS.editMission), action: REGISTRY_ACTION_IDS.edit, effect: 'change' },
      { sdkToolName: name(REGISTRY_TOOLS.freezeMission), action: REGISTRY_ACTION_IDS.freeze, effect: 'change' },
      { sdkToolName: name(REGISTRY_TOOLS.deleteMission), action: REGISTRY_ACTION_IDS.delete, effect: 'change' },
      { sdkToolName: name(REGISTRY_TOOLS.listLibrary), action: REGISTRY_ACTION_IDS.libraryList, effect: 'read' },
      { sdkToolName: name(REGISTRY_TOOLS.readLibraryMission), action: REGISTRY_ACTION_IDS.libraryRead, effect: 'read' },
      // Adding a published mission creates a mission, so it is the create action and waits for approval (§4.2).
      { sdkToolName: name(REGISTRY_TOOLS.addLibraryMission), action: REGISTRY_ACTION_IDS.create, effect: 'change' },
    ],
    credentials: [],
    reservedFor: [...RESERVED_FOR],
    provide(ctx) {
      // The registry already rejects the tool in other manifests. This is a second check.
      if (!RESERVED_FOR.includes(ctx.missionId)) return {};
      const t = missionRegistrySdkTools(ctx, deps);
      const server = createSdkMcpServer({ name: MISSION_REGISTRY_SERVER, version: '1.0.0', tools: Object.values(t) });
      return { mcpServers: { [MISSION_REGISTRY_SERVER]: server } };
    },
  };
}
