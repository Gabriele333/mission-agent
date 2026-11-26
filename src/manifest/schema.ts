import YAML from 'yaml';
import { z } from 'zod';
import { formatIssues } from '../config/issues.js';
import { EFFORTS } from '../config/schema.js';
import type { Effort, GateKind, Manifest } from '../types.js';
import {
  ACTION_ID_RE,
  CORE_ID,
  isValidMissionId,
  MAX_NAME_CHARS,
  MISSION_NAME_RE,
  SIGNAL_ID_RE,
  TOOL_ID_RE,
  TRIGGER_ID_RE,
} from './ids.js';

export const GATE_KINDS: readonly GateKind[] = ['gate:allow', 'gate:require_approval', 'gate:deny'];

const nonEmpty = z.string().refine((s) => s.trim() !== '', { message: 'must not be empty.' });

function idOf(re: RegExp, example: string) {
  return z.string().regex(re, { message: `must be an id such as "${example}".` });
}

const missionId = z.string().superRefine((id, ctx) => {
  if (id === CORE_ID) {
    ctx.addIssue({ code: 'custom', message: 'must not be "core": that id is reserved for the core folder.' });
  } else if (!isValidMissionId(id)) {
    ctx.addIssue({
      code: 'custom',
      message: `must be "m_" plus 12 lowercase base32 characters, such as "m_k7q3zp2xw9ha", or the id of a system mission. It is "${id}".`,
    });
  }
});

const missionName = z
  .string()
  .max(MAX_NAME_CHARS)
  .regex(MISSION_NAME_RE, {
    message: 'must be short and lowercase, with words joined by hyphens, such as "inbox-curator".',
  });

const positiveLimit = z.number().positive();

/** The structure of a `manifest.yaml` file (§A.4). Rules that need the code catalog or the configuration are in validate.ts. */
export const manifestSchema = z.strictObject({
  id: missionId,
  name: missionName,
  description: nonEmpty.refine((s) => !s.includes('\n'), { message: 'must be one line.' }),
  version: z.number().int().positive(),
  status: z.enum(['active', 'frozen']),
  triggers: z.array(z.looseObject({ use: idOf(TRIGGER_ID_RE, 'trigger:email.received') })).default([]),
  tools: z.array(idOf(TOOL_ID_RE, 'tool:gmail')).default([]),
  context: z.strictObject({ instructions: nonEmpty }),
  signals: z.array(idOf(SIGNAL_ID_RE, 'signal:message.rated')).default([]),
  gates: z
    .array(
      z.strictObject({
        use: z.enum(GATE_KINDS as [GateKind, ...GateKind[]]),
        for: idOf(ACTION_ID_RE, 'action:email.send'),
        note: nonEmpty.optional(),
      }),
    )
    .default([]),
  model: nonEmpty.optional(),
  effort: z.enum(EFFORTS as [Effort, ...Effort[]]).optional(),
  limits: z
    .strictObject({
      max_steps: positiveLimit.int().optional(),
      max_cost_usd: positiveLimit.optional(),
      max_minutes: positiveLimit.optional(),
    })
    .optional(),
});

export type ParseResult = { ok: true; manifest: Manifest } | { ok: false; errors: string[] };

/** Same as parseManifest, with messages that do not name the file. */
export function parseManifestText(yamlText: string): ParseResult {
  const doc = YAML.parseDocument(yamlText);
  if (doc.errors.length > 0) {
    return { ok: false, errors: doc.errors.map((e) => `The file is not valid YAML: ${e.message.split('\n')[0]}`) };
  }
  const data: unknown = doc.toJS();
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, errors: ['The file must be a mapping of keys to values, starting with "id:".'] };
  }
  return checkManifestData(data);
}

/** Checks a manifest object, from a file or from code, against the schema. */
export function checkManifestData(data: unknown): ParseResult {
  const result = manifestSchema.safeParse(data);
  if (!result.success) return { ok: false, errors: formatIssues(result.error.issues, data) };
  const m = result.data;
  const manifest: Manifest = {
    id: m.id,
    name: m.name,
    description: m.description,
    version: m.version,
    status: m.status,
    triggers: m.triggers,
    tools: m.tools,
    context: { instructions: m.context.instructions },
    signals: m.signals,
    gates: m.gates.map((g) => (g.note === undefined ? { use: g.use, for: g.for } : { use: g.use, for: g.for, note: g.note })),
  };
  if (m.model !== undefined) manifest.model = m.model;
  if (m.effort !== undefined) manifest.effort = m.effort;
  if (m.limits !== undefined) {
    const limits: NonNullable<Manifest['limits']> = {};
    if (m.limits.max_steps !== undefined) limits.max_steps = m.limits.max_steps;
    if (m.limits.max_cost_usd !== undefined) limits.max_cost_usd = m.limits.max_cost_usd;
    if (m.limits.max_minutes !== undefined) limits.max_minutes = m.limits.max_minutes;
    manifest.limits = limits;
  }
  return { ok: true, manifest };
}

/**
 * Reads a manifest file and checks its structure and id formats (§A.4).
 * Each error starts with `source`. The registry adds the checks against the code catalog and the configuration.
 */
export function parseManifest(yamlText: string, source: string): ParseResult {
  const result = parseManifestText(yamlText);
  if (result.ok) return result;
  return { ok: false, errors: result.errors.map((e) => `${source}: ${e}`) };
}
