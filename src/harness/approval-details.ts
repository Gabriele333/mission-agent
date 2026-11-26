import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Paths } from '../paths.js';
import { REGISTRY_ACTION_IDS } from '../tools/index.js';
import type { ApprovalRequest, Manifest, MissionRegistry, Store } from '../types.js';

/**
 * The text the harness adds to an approval request of the mission admin (§4.2, §4.2.1):
 * what an edit changes, what a deletion removes, and which credentials a new mission lacks (§A.5).
 */

export interface ApprovalDetailsContext {
  registry: Pick<MissionRegistry, 'get' | 'getByName'>;
  store: Pick<Store, 'getSession' | 'getThread' | 'peekEvents' | 'listRuns'>;
  paths: Pick<Paths, 'missionDir' | 'memoryDir' | 'dataDir' | 'skillsDir'>;
  pendingApprovals(): ApprovalRequest[];
  credentialIdsOf(manifest: Pick<Manifest, 'tools' | 'triggers'>): string[];
  hasSecret(id: string): Promise<boolean>;
}

/** Undefined for a request that needs nothing beyond its input. */
export async function approvalDetails(req: ApprovalRequest, ctx: ApprovalDetailsContext): Promise<string | undefined> {
  switch (req.action) {
    case REGISTRY_ACTION_IDS.create:
      return createDetails(req.input, ctx);
    case REGISTRY_ACTION_IDS.edit:
      return editDetails(req.input, ctx);
    case REGISTRY_ACTION_IDS.freeze:
      return freezeDetails(req.input, ctx);
    case REGISTRY_ACTION_IDS.delete:
      return deleteDetails(req.input, ctx);
    default:
      return undefined;
  }
}

function findMission(ref: unknown, ctx: ApprovalDetailsContext): Manifest | undefined {
  if (typeof ref !== 'string') return undefined;
  return ctx.registry.get(ref) ?? ctx.registry.getByName(ref);
}

async function missingOf(manifest: Pick<Manifest, 'tools' | 'triggers'>, ctx: ApprovalDetailsContext): Promise<string[]> {
  const missing: string[] = [];
  for (const id of ctx.credentialIdsOf(manifest)) {
    try {
      if (!(await ctx.hasSecret(id))) missing.push(id);
    } catch {
      // The Keychain could not be asked. The request is still shown.
    }
  }
  return missing;
}

function missingText(missing: string[]): string {
  if (missing.length === 0) return 'Credentials: none is missing.';
  return [
    'Credentials that have no value yet. A run of the mission does not start until each one is entered with "mission-agent secret set <id>":',
    ...missing.map((id) => `- ${id}`),
  ].join('\n');
}

function asList<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

async function createDetails(input: Record<string, unknown>, ctx: ApprovalDetailsContext): Promise<string> {
  const draft = (input.manifest ?? {}) as Record<string, unknown>;
  const name = typeof draft.name === 'string' ? draft.name : '(no name)';
  const missing = await missingOf({ tools: asList<string>(draft.tools), triggers: asList(draft.triggers) }, ctx);
  return [`Creates the mission ${name} with the manifest below.`, missingText(missing)].join('\n');
}

/** A value as the user reads it: a text as it is, anything else as JSON. */
function show(value: unknown): string {
  if (value === undefined || value === null) return '(not set, the default applies)';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}

async function editDetails(input: Record<string, unknown>, ctx: ApprovalDetailsContext): Promise<string> {
  const current = findMission(input.mission, ctx);
  if (current === undefined) return `There is no loaded mission "${show(input.mission)}". The edit will fail.`;
  const changes = (input.changes ?? {}) as Record<string, unknown>;
  const lines = [`Changes to the mission ${current.name} (${current.id}), now at version ${current.version}:`];
  const record = current as unknown as Record<string, unknown>;
  for (const [field, next] of Object.entries(changes)) {
    if (next === undefined) continue;
    const now = field === 'context' ? current.context.instructions : record[field];
    const after = field === 'context' && next !== null && typeof next === 'object' ? (next as { instructions?: unknown }).instructions : next;
    if (JSON.stringify(now) === JSON.stringify(after)) {
      lines.push(`- ${field}: unchanged`);
      continue;
    }
    const label = field === 'context' ? 'context.instructions' : field;
    lines.push(`- ${label}`, '  now:', indent(show(now)), '  new:', indent(show(after)));
  }
  const tools = changes.tools !== undefined && changes.tools !== null ? asList<string>(changes.tools) : current.tools;
  const triggers = changes.triggers !== undefined && changes.triggers !== null ? asList(changes.triggers) : current.triggers;
  lines.push(missingText(await missingOf({ tools, triggers: triggers as Manifest['triggers'] }, ctx)));
  return lines.join('\n');
}

function freezeDetails(input: Record<string, unknown>, ctx: ApprovalDetailsContext): string {
  const current = findMission(input.mission, ctx);
  const name = current?.name ?? show(input.mission);
  if (input.frozen === false) return `Makes the frozen mission ${name} active again.`;
  return `Freezes the mission ${name}: it no longer runs, its waiting approvals are cancelled, and its folder is kept.`;
}

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
    else if (entry.isFile()) n += 1;
  }
  return n;
}

function countDirs(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function deleteDetails(input: Record<string, unknown>, ctx: ApprovalDetailsContext): string {
  const current = findMission(input.mission, ctx);
  if (current === undefined) return `There is no loaded mission "${show(input.mission)}". The deletion may fail.`;
  const id = current.id;
  // The memory index is a file of the memory folder, but not a note.
  const notes = Math.max(0, countFiles(ctx.paths.memoryDir(id)) - 1);
  const approvals = ctx.pendingApprovals().filter((r) => r.missionId === id).length;
  const events = ctx.store.peekEvents(id).length;
  const lines = [
    `Deleting the mission ${current.name} (${id}) removes everything below:`,
    `- its folder missions/${id}/, with:`,
    '  - manifest.yaml, its gates included',
    `  - memory/: the index and ${plural(notes, 'note', 'notes')}`,
    `  - skills/: ${plural(countDirs(ctx.paths.skillsDir(id)), 'skill', 'skills')}`,
    `  - data/: ${plural(countFiles(ctx.paths.dataDir(id)), 'file', 'files')}`,
    `- its session: ${ctx.store.getSession(id) === undefined ? 'none yet' : 'the whole conversation'}`,
    `- its waiting approvals: ${approvals}`,
    `- its queued events: ${events}`,
    `- its Telegram thread with the messages in it: ${ctx.store.getThread(id) === undefined ? 'none' : 'yes'}`,
    'It keeps the logbook rows of its runs, so the cost history stays complete.',
    'It removes no tool, no trigger and no credential, and leaves untouched what the mission created in outside systems.',
  ];
  return lines.join('\n');
}
