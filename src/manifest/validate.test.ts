import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { defaultConfig } from '../config/defaults.js';
import type { AgentConfig, Manifest } from '../types.js';
import { generateMissionId, isValidMissionId } from './ids.js';
import { checkManifestData, parseManifest } from './schema.js';
import { MISSION_ADMIN_MANIFEST } from './system.js';
import { EXAMPLE_YAML, exampleManifest, fakeCatalog } from './test-helpers.js';
import { validateManifest } from './validate.js';
import { manifestToPlain } from './yaml-write.js';

const config = defaultConfig('Ada');

/** Every problem of a manifest object: schema first, then the catalog and configuration rules. */
function problems(data: Record<string, unknown>, cfg: AgentConfig = config): string[] {
  const parsed = checkManifestData(data);
  if (!parsed.ok) return parsed.errors;
  return validateManifest(parsed.manifest, { catalog: fakeCatalog(), config: cfg });
}

function withField(key: string, value: unknown): Record<string, unknown> {
  const data = manifestToPlain(exampleManifest());
  if (value === undefined) delete data[key];
  else data[key] = value;
  return data;
}

describe('parseManifest', () => {
  it('reads the example of §A.4', () => {
    const result = parseManifest(EXAMPLE_YAML, 'missions/m_k7q3zp2xw9ha/manifest.yaml');
    expect(result).toEqual({ ok: true, manifest: exampleManifest() });
  });

  it('names the source in each error', () => {
    const result = parseManifest('id: m_k7q3zp2xw9ha\n', 'missions/x/manifest.yaml');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(1);
      for (const e of result.errors) expect(e.startsWith('missions/x/manifest.yaml: ')).toBe(true);
      expect(result.errors).toContain('missions/x/manifest.yaml: name is required.');
    }
  });

  it('reports invalid YAML, duplicate keys and a file that is not a mapping', () => {
    for (const text of ['id: [x\n', 'id: a\nid: b\n', '- a\n', '']) {
      const result = parseManifest(text, 'f');
      expect(result.ok, text).toBe(false);
    }
  });

  it('applies empty lists for triggers, tools, signals and gates', () => {
    const result = checkManifestData({
      id: 'm_k7q3zp2xw9ha',
      name: 'x',
      description: 'd',
      version: 1,
      status: 'active',
      context: { instructions: 'i' },
    });
    expect(result.ok && result.manifest).toMatchObject({ triggers: [], tools: [], signals: [], gates: [] });
  });

  it('rejects unknown keys at every level', () => {
    expect(problems({ ...withField('owner', 'me') })).toEqual(['Unknown key "owner".']);
    expect(problems(withField('context', { instructions: 'x', notes: 'y' }))).toEqual(['Unknown key "notes" in context.']);
    expect(problems(withField('limits', { max_turns: 3 }))).toEqual(['Unknown key "max_turns" in limits.']);
    expect(problems(withField('gates', [{ use: 'gate:deny', for: 'action:email.delete', why: 'x' }]))).toEqual([
      'Unknown key "why" in gates[0].',
    ]);
  });
});

describe('id rules', () => {
  it('accepts m_ plus 12 base32 characters and the reserved system ids', () => {
    expect(isValidMissionId('m_k7q3zp2xw9ha')).toBe(true);
    expect(isValidMissionId('m_2vx8qm4rt6pc')).toBe(true);
    for (const id of ['sys-general', 'sys-mission-admin', 'sys-self-improve']) expect(isValidMissionId(id)).toBe(true);
    for (const id of ['m_K7Q3ZP2XW9HA', 'm_k7q3zp2xw9h', 'm_k7q3zp2xw9hab', 'm_k7q3zp2xw9hi', 'sys-other', 'core', 'x']) {
      expect(isValidMissionId(id), id).toBe(false);
    }
  });

  it('generates valid ids', () => {
    for (let i = 0; i < 50; i++) expect(isValidMissionId(generateMissionId())).toBe(true);
  });

  it('rejects a wrong id with a message, and core with its own message', () => {
    expect(problems(withField('id', 'M_ABC'))[0]).toMatch(/^id must be "m_" plus 12 lowercase base32 characters/);
    expect(problems(withField('id', 'core'))).toEqual(['id must not be "core": that id is reserved for the core folder.']);
    expect(problems(withField('id', 'sys-other'))[0]).toMatch(/^id must be "m_"/);
  });
});

describe('name rules', () => {
  it('accepts short lowercase words joined by hyphens', () => {
    expect(problems(withField('name', 'sell-the-flat2'))).toEqual([]);
  });

  it('rejects other forms', () => {
    for (const name of ['Inbox', 'inbox_curator', 'inbox--curator', '-inbox', 'inbox curator', '2inbox', '', 'a'.repeat(41)]) {
      expect(problems(withField('name', name)).length, name).toBe(1);
    }
    expect(problems(withField('name', 'Inbox'))[0]).toContain('lowercase, with words joined by hyphens');
  });

  it('keeps sys- names for system missions, whose name is their id', () => {
    expect(problems(withField('name', 'sys-mail'))).toEqual([
      'name "sys-mail" starts with "sys-", which is reserved for the system missions.',
    ]);
    const general = { ...withField('id', 'sys-general'), name: 'general', tools: [], limits: undefined };
    delete general.limits;
    expect(problems(general)).toEqual(['name must be "sys-general", the same as the id of this system mission.']);
  });

  it('keeps a system mission active', () => {
    const data = { ...manifestToPlain(exampleManifest({ id: 'sys-general', name: 'sys-general' })), status: 'frozen' };
    expect(problems(data)).toEqual(['status must be active: the system mission sys-general cannot be frozen.']);
  });
});

describe('text limits', () => {
  it('limits the description to maxDescriptionChars and one line', () => {
    expect(problems(withField('description', 'x'.repeat(200)))).toEqual([]);
    expect(problems(withField('description', 'x'.repeat(201)))).toEqual(['description has 201 characters. The limit is 200.']);
    expect(problems(withField('description', 'x'.repeat(30)), { ...config, maxDescriptionChars: 20 })).toHaveLength(1);
    expect(problems(withField('description', 'two\nlines'))).toEqual(['description must be one line.']);
    expect(problems(withField('description', ' '))).toEqual(['description must not be empty.']);
  });

  it('limits the instructions to maxInstructionsChars', () => {
    expect(problems(withField('context', { instructions: 'x'.repeat(4000) }))).toEqual([]);
    expect(problems(withField('context', { instructions: 'x'.repeat(4001) }))).toEqual([
      'context.instructions has 4001 characters. The limit is 4000.',
    ]);
    expect(problems(withField('context', { instructions: '' }))).toEqual(['context.instructions must not be empty.']);
    expect(problems(withField('context', undefined))).toEqual(['context is required.']);
  });
});

describe('tools', () => {
  it('rejects a tool that does not exist, a wrong id and a duplicate', () => {
    expect(problems(withField('tools', ['tool:fax']))).toEqual(['tools[0] "tool:fax" does not exist in the harness.']);
    expect(problems(withField('tools', ['gmail']))).toEqual(['tools[0] must be an id such as "tool:gmail".']);
    expect(problems(withField('tools', ['tool:gmail', 'tool:gmail']))).toEqual(['tools[1] "tool:gmail" is listed twice.']);
  });

  it('applies the reserved rule', () => {
    expect(problems(withField('tools', ['tool:mission_registry']))).toEqual([
      'tools[0] "tool:mission_registry" is reserved for sys-mission-admin.',
    ]);
    expect(problems(manifestToPlain(MISSION_ADMIN_MANIFEST))).toEqual([]);
  });
});

describe('triggers', () => {
  it('rejects a trigger that does not exist and a wrong id', () => {
    expect(problems(withField('triggers', [{ use: 'trigger:sms.received' }]))).toEqual([
      'triggers[0] "trigger:sms.received" does not exist in the harness.',
    ]);
    expect(problems(withField('triggers', [{ use: 'cron' }]))).toEqual([
      'triggers[0].use must be an id such as "trigger:email.received".',
    ]);
    expect(problems(withField('triggers', [{ at: '0 7 * * *' }]))).toEqual(['triggers[0].use is required.']);
  });

  it('checks the parameters through the catalog', () => {
    expect(problems(withField('triggers', [{ use: 'trigger:cron' }]))).toEqual([
      'triggers[0] "trigger:cron": needs "at", a cron expression such as "0 7 * * *".',
    ]);
    expect(problems(withField('triggers', [{ use: 'trigger:chat', at: 'x' }]))).toEqual([
      'triggers[0] "trigger:chat": takes no parameters, but has at.',
    ]);
  });

  it('allows two timers but not the same subscription twice', () => {
    const two = [
      { use: 'trigger:cron', at: '0 7 * * *' },
      { use: 'trigger:cron', at: '0 19 * * *' },
    ];
    expect(problems(withField('triggers', two))).toEqual([]);
    expect(problems(withField('triggers', [{ use: 'trigger:chat' }, { use: 'trigger:chat' }]))).toEqual([
      'triggers[1] "trigger:chat" is listed twice with the same parameters.',
    ]);
  });
});

describe('gates', () => {
  it('accepts the three kinds only', () => {
    expect(problems(withField('gates', [{ use: 'gate:maybe', for: 'action:email.send' }]))[0]).toMatch(
      /^gates\[0\]\.use must be one of "gate:allow", "gate:require_approval", "gate:deny"/,
    );
  });

  it('needs an action that exists', () => {
    expect(problems(withField('gates', [{ use: 'gate:deny', for: 'action:email.burn' }]))).toEqual([
      'gates[0].for "action:email.burn" is not an action of any tool in the harness.',
    ]);
    expect(problems(withField('gates', [{ use: 'gate:deny', for: 'email.send' }]))).toEqual([
      'gates[0].for must be an id such as "action:email.send".',
    ]);
    expect(problems(withField('gates', [{ use: 'gate:deny' }]))).toEqual(['gates[0].for is required.']);
  });

  it('rejects two gates for the same action', () => {
    const gates = [
      { use: 'gate:deny', for: 'action:email.send' },
      { use: 'gate:allow', for: 'action:email.send' },
    ];
    expect(problems(withField('gates', gates))).toEqual(['gates[1]: there is already a gate for "action:email.send".']);
  });
});

describe('signals', () => {
  it('accepts a list of signal ids, without checking that they exist', () => {
    expect(problems(withField('signals', ['signal:email.unarchived']))).toEqual([]);
    expect(problems(withField('signals', ['rated']))).toEqual(['signals[0] must be an id such as "signal:message.rated".']);
    expect(problems(withField('signals', 'signal:message.rated'))[0]).toBe(
      'signals must be a list, but it is "signal:message.rated".',
    );
  });
});

describe('status, version, model, effort and limits', () => {
  it('accepts active or frozen only', () => {
    expect(problems(withField('status', 'frozen'))).toEqual([]);
    expect(problems(withField('status', 'paused'))).toEqual([
      'status must be one of "active", "frozen", but it is "paused".',
    ]);
  });

  it('needs a positive whole version', () => {
    expect(problems(withField('version', 0))).toEqual(['version must be more than 0.']);
    expect(problems(withField('version', '2'))).toEqual(['version must be a number, but it is "2".']);
  });

  it('accepts a model as a non-empty text or no model', () => {
    expect(problems(withField('model', undefined))).toEqual([]);
    expect(problems(withField('model', 'default'))).toEqual([]);
    expect(problems(withField('model', ''))).toEqual(['model must not be empty.']);
    expect(problems(withField('model', null))).toEqual(['model must be a text, but it is null.']);
  });

  it('accepts the allowed efforts only', () => {
    expect(problems(withField('effort', 'xhigh'))).toEqual([]);
    expect(problems(withField('effort', 'extreme'))[0]).toMatch(/^effort must be one of "low", "medium", "high", "xhigh", "max"/);
  });

  it('needs positive limits that are not higher than the harness defaults', () => {
    expect(problems(withField('limits', { max_steps: 50, max_cost_usd: 2, max_minutes: 30 }))).toEqual([]);
    expect(problems(withField('limits', {}))).toEqual([]);
    expect(problems(withField('limits', { max_steps: 0 }))).toEqual(['limits.max_steps must be more than 0.']);
    expect(problems(withField('limits', { max_cost_usd: -1 }))).toEqual(['limits.max_cost_usd must be more than 0.']);
    expect(problems(withField('limits', { max_steps: 2.5 }))).toEqual(['limits.max_steps must be a whole number, but it is 2.5.']);
    expect(problems(withField('limits', { max_steps: 51, max_cost_usd: 3, max_minutes: 31 }))).toEqual([
      'limits.max_steps is 51. It cannot be higher than the harness limit, 50.',
      'limits.max_cost_usd is 3. It cannot be higher than the harness limit, 2.',
      'limits.max_minutes is 31. It cannot be higher than the harness limit, 30.',
    ]);
    const lower = { ...config, runLimits: { maxSteps: 10, maxCostUsd: 1, maxMinutes: 5 } };
    expect(problems(withField('limits', { max_steps: 20 }), lower)).toHaveLength(1);
  });
});

describe('several problems', () => {
  it('lists every problem at once', () => {
    const data = YAML.parse(EXAMPLE_YAML) as Record<string, unknown>;
    data.tools = ['tool:fax', 'tool:mission_registry'];
    data.description = 'y'.repeat(300);
    data.limits = { max_steps: 99 };
    expect(problems(data)).toHaveLength(4);
  });

  it('keeps the parsed manifest equal to the Manifest type', () => {
    const parsed = checkManifestData(manifestToPlain(exampleManifest()));
    expect(parsed.ok && (parsed.manifest satisfies Manifest)).toEqual(exampleManifest());
  });
});
