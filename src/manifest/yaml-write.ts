import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';
import type { Manifest } from '../types.js';

/** Keys that get an empty line before them, as in the example of §A.4. */
const SECTION_KEYS = new Set(['triggers', 'tools', 'context', 'signals', 'gates', 'model', 'limits']);

/** The manifest as a plain object, with the key order of the example in §A.4. */
export function manifestToPlain(m: Manifest): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: m.id,
    name: m.name,
    description: m.description,
    version: m.version,
    status: m.status,
    triggers: m.triggers.map(({ use, ...params }) => ({ use, ...params })),
    tools: [...m.tools],
    context: { instructions: m.context.instructions },
    signals: [...m.signals],
    gates: m.gates.map((g) => (g.note === undefined ? { use: g.use, for: g.for } : { use: g.use, for: g.for, note: g.note })),
  };
  if (m.model !== undefined) out.model = m.model;
  if (m.effort !== undefined) out.effort = m.effort;
  if (m.limits !== undefined) {
    const limits: Record<string, number> = {};
    if (m.limits.max_steps !== undefined) limits.max_steps = m.limits.max_steps;
    if (m.limits.max_cost_usd !== undefined) limits.max_cost_usd = m.limits.max_cost_usd;
    if (m.limits.max_minutes !== undefined) limits.max_minutes = m.limits.max_minutes;
    out.limits = limits;
  }
  return out;
}

function createNode(doc: YAML.Document, key: string, value: unknown): YAML.Node {
  const node = doc.createNode(value) as YAML.Node;
  if (key === 'context' && YAML.isMap(node)) {
    const instructions = node.get('instructions', true);
    if (YAML.isScalar(instructions)) instructions.type = 'BLOCK_LITERAL';
  }
  return node;
}

/** Writes a manifest as a new file. */
export function serializeManifest(m: Manifest): string {
  const plain = manifestToPlain(m);
  const doc = new YAML.Document({});
  for (const [key, value] of Object.entries(plain)) {
    const pair = doc.createPair(key, createNode(doc, key, value));
    if (SECTION_KEYS.has(key) && YAML.isScalar(pair.key)) pair.key.spaceBefore = true;
    (doc.contents as YAML.YAMLMap).items.push(pair);
  }
  return doc.toString({ lineWidth: 0 });
}

function parsesTo(text: string, plain: Record<string, unknown>): boolean {
  const doc = YAML.parseDocument(text);
  return doc.errors.length === 0 && isDeepStrictEqual(doc.toJS(), plain);
}

/**
 * Replaces the values of top-level scalar keys in the source text and changes nothing else,
 * so comments and formatting stay as the user wrote them. Returns null when that is not possible.
 */
export function replaceTopLevelScalars(text: string, changes: Record<string, string | number>): string | null {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0 || !YAML.isMap(doc.contents)) return null;
  const edits: { start: number; end: number; text: string }[] = [];
  for (const [key, value] of Object.entries(changes)) {
    const node = doc.contents.get(key, true);
    if (!YAML.isScalar(node) || node.range === undefined || node.range === null) return null;
    const rendered = YAML.stringify(value, { lineWidth: 0 }).trimEnd();
    if (rendered.includes('\n')) return null;
    edits.push({ start: node.range[0], end: node.range[1], text: rendered });
  }
  // Apply from the end of the text, so the earlier offsets stay valid.
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  const expected = { ...(doc.toJS() as Record<string, unknown>), ...changes };
  return parsesTo(out, expected) ? out : null;
}

/** Sets `version` in a manifest file and keeps the rest of the text as it is (§A.4). */
export function bumpVersionText(text: string, version: number): string | null {
  return replaceTopLevelScalars(text, { version });
}

/**
 * The text of a manifest file after a programmatic change. It keeps as much of the old text as it can:
 * the exact text when only scalar values change, the comments of untouched keys when the keys stay the same,
 * and a new file otherwise.
 */
export function updateManifestText(oldText: string | undefined, m: Manifest): string {
  const plain = manifestToPlain(m);
  if (oldText === undefined) return serializeManifest(m);
  const doc = YAML.parseDocument(oldText);
  if (doc.errors.length > 0 || !YAML.isMap(doc.contents)) return serializeManifest(m);
  const old = doc.toJS() as Record<string, unknown>;
  const newKeys = Object.keys(plain);
  if (!isDeepStrictEqual(Object.keys(old).sort(), [...newKeys].sort())) return serializeManifest(m);

  const changed = newKeys.filter((k) => !isDeepStrictEqual(old[k], plain[k]));
  if (changed.length === 0) return oldText;

  const scalarChanges: Record<string, string | number> = {};
  let allScalar = true;
  for (const k of changed) {
    const v = plain[k];
    if (typeof v === 'string' || typeof v === 'number') scalarChanges[k] = v;
    else allScalar = false;
  }
  if (allScalar) {
    const spliced = replaceTopLevelScalars(oldText, scalarChanges);
    if (spliced !== null) return spliced;
  }

  for (const k of changed) doc.set(k, createNode(doc, k, plain[k]));
  const out = doc.toString({ lineWidth: 0 });
  return parsesTo(out, plain) ? out : serializeManifest(m);
}
