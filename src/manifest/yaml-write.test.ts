import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { checkManifestData } from './schema.js';
import { EXAMPLE_YAML, exampleManifest } from './test-helpers.js';
import { bumpVersionText, manifestToPlain, serializeManifest, updateManifestText } from './yaml-write.js';

const reparse = (text: string) => {
  const r = checkManifestData(YAML.parse(text));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.manifest;
};

describe('serializeManifest', () => {
  it('keeps the key order of §A.4 and loads back to the same manifest', () => {
    const m = exampleManifest();
    const text = serializeManifest(m);
    const keys = Object.keys(YAML.parse(text) as object);
    expect(keys).toEqual([
      'id', 'name', 'description', 'version', 'status', 'triggers', 'tools',
      'context', 'signals', 'gates', 'model', 'effort', 'limits',
    ]);
    expect(reparse(text)).toEqual(m);
    expect(text).toContain('context:\n  instructions: |\n    You are my inbox curator.');
    expect(text).toContain('  - use: trigger:cron\n    at: 0 7 * * *');
    expect(text).toContain('limits:\n  max_steps: 20\n  max_cost_usd: 0.5\n  max_minutes: 10');
  });

  it('leaves out optional fields that are not set', () => {
    const m = exampleManifest();
    delete m.model;
    delete m.effort;
    delete m.limits;
    const text = serializeManifest(m);
    expect(text).not.toMatch(/^(model|effort|limits):/m);
    expect(reparse(text)).toEqual(m);
  });
});

describe('bumpVersionText', () => {
  it('changes only the version and keeps comments and spacing', () => {
    const out = bumpVersionText(EXAMPLE_YAML, 4);
    expect(out).toBe(
      EXAMPLE_YAML.replace('version: 3                             #', 'version: 4                             #'),
    );
  });
});

describe('updateManifestText', () => {
  it('keeps the exact text when only scalar values change', () => {
    const m = exampleManifest({ status: 'frozen', version: 4, description: 'Sorts my inbox: fast' });
    const out = updateManifestText(EXAMPLE_YAML, m);
    expect(out).toContain('status: frozen\n');
    expect(out).toContain('description: "Sorts my inbox: fast"   # one line, read by triage (§B.3)');
    expect(out).toContain('version: 4                             # increases on every edit');
    expect(reparse(out)).toEqual(m);
  });

  it('keeps the comments of untouched keys when a list changes', () => {
    const m = exampleManifest({ tools: ['tool:gmail'], version: 4 });
    const out = updateManifestText(EXAMPLE_YAML, m);
    expect(out).toContain('# a schedule is a trigger that fires on a timer');
    expect(out).toContain('# optional: a cheap model is enough for sorting mail');
    expect(reparse(out)).toEqual(m);
  });

  it('writes a new file in the order of §A.4 when a key is added or removed', () => {
    const m = exampleManifest({ version: 4 });
    delete m.effort;
    const out = updateManifestText(EXAMPLE_YAML, m);
    expect(out).toBe(serializeManifest(m));
    expect(manifestToPlain(reparse(out))).toEqual(manifestToPlain(m));
  });

  it('returns the old text when nothing changed', () => {
    expect(updateManifestText(EXAMPLE_YAML, exampleManifest())).toBe(EXAMPLE_YAML);
  });
});
