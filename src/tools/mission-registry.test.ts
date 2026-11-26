import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { z } from 'zod';
import { MISSION_ID_RE } from '../manifest/ids.js';
import { SystemMissionError } from '../manifest/index.js';
import { SYS_GENERAL, SYS_MISSION_ADMIN, type Manifest, type ToolContext } from '../types.js';
import {
  createMission,
  createMissionShape,
  deleteMission,
  editMission,
  editMissionShape,
  freezeMission,
  freezeMissionShape,
  listCatalog,
  listMissions,
  readMission,
} from './mission-registry.js';
import { makeHarness, textOf, type Harness } from './test-helpers.js';

type CreateInput = Parameters<typeof createMission>[1];
type Draft = CreateInput['manifest'];

let h: Harness;
let ctx: ToolContext;

beforeEach(() => {
  h = makeHarness();
  ctx = h.ctx(SYS_MISSION_ADMIN);
});
afterEach(() => h.cleanUp());

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    name: 'news-curator',
    description: 'Curates my news every morning',
    triggers: [{ use: 'trigger:cron', at: '0 7 * * *' }, { use: 'trigger:chat' }],
    tools: ['tool:web_search', 'tool:web_fetch'],
    context: { instructions: 'You curate my news.\nDone well means: five good links.\n' },
    gates: [],
    ...overrides,
  };
}

async function created(overrides: Partial<Draft> = {}): Promise<Manifest> {
  const result = await createMission(ctx, { manifest: draft(overrides) });
  expect(result.isError, textOf(result)).toBeUndefined();
  const id = /id (m_[0-9a-z]{12})/.exec(textOf(result))?.[1] as string;
  return h.registry.get(id) as Manifest;
}

function json(result: Parameters<typeof textOf>[0]): any {
  return JSON.parse(textOf(result));
}

describe('list_missions', () => {
  it('lists every mission with id, name, description, status and version, and the registry errors', async () => {
    const m = await created();
    mkdirSync(h.paths.missionDir('m_aaaaaaaaaaaa'), { recursive: true });
    writeFileSync(h.paths.manifestFile('m_aaaaaaaaaaaa'), 'id: m_aaaaaaaaaaaa\n');
    h.registry.reload();
    const out = json(listMissions(ctx));
    expect(out.missions).toEqual([
      { id: SYS_GENERAL, name: SYS_GENERAL, description: 'Handles any request that no other mission covers', status: 'active', version: 1 },
      { id: SYS_MISSION_ADMIN, name: SYS_MISSION_ADMIN, description: 'Creates, edits, freezes and deletes missions', status: 'active', version: 1 },
      { id: m.id, name: 'news-curator', description: 'Curates my news every morning', status: 'active', version: 1 },
    ]);
    expect(out.errors.length).toBeGreaterThan(0);
    expect(out.errors[0].source).toBe('missions/m_aaaaaaaaaaaa/manifest.yaml');
  });
});

describe('read_mission', () => {
  it('returns the full manifest by id and by name', async () => {
    const m = await created();
    expect(json(readMission(ctx, { mission: m.id }))).toEqual(m);
    expect(json(readMission(ctx, { mission: 'news-curator' }))).toEqual(m);
    expect(json(readMission(ctx, { mission: SYS_MISSION_ADMIN })).tools).toEqual(['tool:mission_registry']);
  });

  it('returns an error for an unknown mission and the problems of an invalid one', () => {
    expect(readMission(ctx, { mission: 'nothing' }).isError).toBe(true);
    mkdirSync(h.paths.missionDir('m_aaaaaaaaaaaa'), { recursive: true });
    writeFileSync(h.paths.manifestFile('m_aaaaaaaaaaaa'), 'id: m_aaaaaaaaaaaa\n');
    h.registry.reload();
    const result = readMission(ctx, { mission: 'm_aaaaaaaaaaaa' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/is not loaded because it is invalid/);
  });
});

describe('list_catalog', () => {
  it('lists tools with actions and effects, triggers with their parameters, gate kinds and field limits', () => {
    const out = json(listCatalog(h.deps));
    expect(out.tools.map((t: { id: string }) => t.id)).toEqual([
      'tool:web_search',
      'tool:web_fetch',
      'tool:shell',
      'tool:mission_registry',
    ]);
    expect(out.tools[0]).toEqual({ id: 'tool:web_search', credentials: [], operations: [{ action: 'action:web.search', effect: 'read' }] });
    expect(out.tools[3].reservedFor).toEqual([SYS_MISSION_ADMIN]);
    expect(out.tools[3].operations).toContainEqual({ action: 'action:registry.create', effect: 'change' });
    expect(out.alwaysOnActions).toEqual([
      { action: 'action:message.send', effect: 'read' },
      { action: 'action:file.delete', effect: 'read' },
    ]);
    expect(out.triggers).toEqual([
      { id: 'trigger:chat', credentials: [], withoutParameters: 'valid' },
      { id: 'trigger:cron', credentials: [], withoutParameters: 'needs "at", a cron expression such as "0 7 * * *".' },
    ]);
    expect(Object.keys(out.gateKinds)).toEqual(['gate:allow', 'gate:require_approval', 'gate:deny']);
    expect(out.rules.descriptionMaxChars).toBe(h.config.maxDescriptionChars);
    expect(out.rules.instructionsMaxChars).toBe(h.config.maxInstructionsChars);
    expect(out.rules.limitsMax).toEqual({
      max_steps: h.config.runLimits.maxSteps,
      max_cost_usd: h.config.runLimits.maxCostUsd,
      max_minutes: h.config.runLimits.maxMinutes,
    });
  });

  it('is enough to draft a manifest that the registry accepts', async () => {
    const out = json(listCatalog(h.deps));
    const tool = out.tools.find((t: { reservedFor?: string[] }) => t.reservedFor === undefined);
    const gate = { use: Object.keys(out.gateKinds)[0], for: tool.operations[0].action };
    const m = await created({
      tools: [tool.id],
      triggers: out.triggers.filter((t: { withoutParameters: string }) => t.withoutParameters === 'valid').map((t: { id: string }) => ({ use: t.id })),
      gates: [gate as Draft['gates'][number]],
      limits: { max_steps: out.rules.limitsMax.max_steps - 1 },
      effort: out.rules.efforts[0],
    });
    expect(m.tools).toEqual([tool.id]);
  });
});

describe('create_mission', () => {
  it('creates the mission, writes its folder and tells the harness', async () => {
    const result = await createMission(ctx, { manifest: draft({ model: 'default', effort: 'low', limits: { max_steps: 10 } }) });
    expect(result.isError).toBeUndefined();
    const id = /id (m_[0-9a-z]{12})/.exec(textOf(result))?.[1] as string;
    expect(id).toMatch(MISSION_ID_RE);
    expect(textOf(result)).toBe(`Created mission news-curator with id ${id}, version 1.`);
    expect(h.host.changed).toEqual([id]);
    const file = YAML.parse(readFileSync(h.paths.manifestFile(id), 'utf8'));
    expect(file).toMatchObject({ id, name: 'news-curator', version: 1, status: 'active', signals: [], effort: 'low', limits: { max_steps: 10 } });
    expect(existsSync(h.paths.memoryIndexFile(id))).toBe(true);
  });

  it('returns every validation problem and writes nothing', async () => {
    const result = await createMission(ctx, {
      manifest: draft({
        name: 'News Curator',
        tools: ['tool:gmail'],
        triggers: [{ use: 'trigger:cron' }],
        gates: [{ use: 'gate:allow', for: 'action:email.send' }],
        limits: { max_steps: 500 },
      }),
    });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/^The mission was not saved, because the manifest has these problems/);
    expect(text).toMatch(/name/);
    expect(h.host.changed).toEqual([]);
    expect(h.registry.list()).toHaveLength(2);
  });

  it('lists all catalog problems of a draft whose structure is valid', async () => {
    const result = await createMission(ctx, {
      manifest: draft({
        tools: ['tool:gmail'],
        triggers: [{ use: 'trigger:cron' }],
        gates: [{ use: 'gate:allow', for: 'action:email.send' }],
        limits: { max_steps: 500 },
      }),
    });
    const lines = textOf(result).split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toEqual([
      '- tools[0] "tool:gmail" does not exist in the harness.',
      '- triggers[0] "trigger:cron": needs "at", a cron expression such as "0 7 * * *".',
      '- gates[0].for "action:email.send" is not an action of any tool in the harness.',
      `- limits.max_steps is 500. It cannot be higher than the harness limit, ${h.config.runLimits.maxSteps}.`,
    ]);
  });

  it('refuses a name that is already used', async () => {
    const first = await created();
    const result = await createMission(ctx, { manifest: draft() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(`name "news-curator" is already used by mission ${first.id}.`);
  });

  it('refuses tool:mission_registry in the manifest of another mission', async () => {
    const result = await createMission(ctx, { manifest: draft({ tools: ['tool:mission_registry'] }) });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch('tools[0] "tool:mission_registry" is reserved for sys-mission-admin.');
  });

  it('refuses a sys- name', async () => {
    const result = await createMission(ctx, { manifest: draft({ name: 'sys-news' }) });
    expect(textOf(result)).toMatch(/reserved for the system missions/);
  });
});

describe('edit_mission', () => {
  it('applies exactly the fields given, raises the version and tells the harness', async () => {
    const m = await created({ model: 'claude-haiku-5-5', effort: 'low' });
    h.host.changed.length = 0;
    const result = await editMission(ctx, {
      mission: 'news-curator',
      changes: { description: 'Curates my news twice a day', model: null },
    });
    expect(textOf(result)).toBe(`Edited mission news-curator (${m.id}). Changed: description, model. It is now version 2.`);
    const after = h.registry.get(m.id) as Manifest;
    const { description: _d, model: _m, version: _v, ...rest } = m;
    expect(after).toEqual({ ...rest, description: 'Curates my news twice a day', version: 2 });
    expect(after.model).toBeUndefined();
    expect(h.host.changed).toEqual([m.id]);
  });

  it('renames a mission by id', async () => {
    const m = await created();
    await editMission(ctx, { mission: m.id, changes: { name: 'daily-news' } });
    expect(h.registry.getByName('daily-news')?.id).toBe(m.id);
  });

  it('returns validation problems and changes nothing', async () => {
    const m = await created();
    h.host.changed.length = 0;
    const result = await editMission(ctx, { mission: m.id, changes: { tools: ['tool:mission_registry', 'tool:nothing'] } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/reserved for sys-mission-admin[\s\S]*"tool:nothing" does not exist/);
    expect(h.registry.get(m.id)).toEqual(m);
    expect(h.host.changed).toEqual([]);
  });

  it('refuses a name that another mission uses', async () => {
    await created();
    const other = await created({ name: 'other-mission' });
    const result = await editMission(ctx, { mission: other.id, changes: { name: 'news-curator' } });
    expect(textOf(result)).toMatch(/already used by mission/);
  });

  it('returns the registry error as it is for a system mission', async () => {
    for (const mission of [SYS_GENERAL, SYS_MISSION_ADMIN]) {
      const result = await editMission(ctx, { mission, changes: { description: 'x' } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(new SystemMissionError(mission, 'edited').message);
    }
    expect(h.host.changed).toEqual([]);
  });

  it('returns an error for an unknown mission and for an empty change', async () => {
    expect(textOf(await editMission(ctx, { mission: 'nothing', changes: { description: 'x' } }))).toMatch(
      'There is no mission with the id or name "nothing"',
    );
    expect(textOf(await editMission(ctx, { mission: 'm_aaaaaaaaaaaa', changes: { description: 'x' } }))).toBe(
      'There is no mission with id m_aaaaaaaaaaaa.',
    );
    const m = await created();
    expect((await editMission(ctx, { mission: m.id, changes: {} })).isError).toBe(true);
  });

  it('reports a change that changes nothing and does not tell the harness', async () => {
    const m = await created();
    h.host.changed.length = 0;
    const result = await editMission(ctx, { mission: m.id, changes: { description: m.description } });
    expect(textOf(result)).toMatch(/Nothing changed/);
    expect(h.registry.get(m.id)?.version).toBe(1);
    expect(h.host.changed).toEqual([]);
  });
});

describe('freeze_mission', () => {
  it('freezes and unfreezes a mission and tells the harness each time', async () => {
    const m = await created();
    h.host.changed.length = 0;
    expect(textOf(await freezeMission(ctx, { mission: 'news-curator', frozen: true }))).toBe(
      `Mission news-curator (${m.id}) is now frozen, version 2.`,
    );
    expect(h.registry.get(m.id)?.status).toBe('frozen');
    expect(textOf(await freezeMission(ctx, { mission: m.id, frozen: true }))).toMatch(/already frozen/);
    await freezeMission(ctx, { mission: m.id, frozen: false });
    expect(h.registry.get(m.id)?.status).toBe('active');
    expect(h.host.changed).toEqual([m.id, m.id]);
  });

  it('returns the registry error for a system mission', async () => {
    const result = await freezeMission(ctx, { mission: SYS_GENERAL, frozen: true });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(new SystemMissionError(SYS_GENERAL, 'frozen').message);
  });

  it('returns an error for an unknown mission', async () => {
    expect((await freezeMission(ctx, { mission: 'nothing', frozen: true })).isError).toBe(true);
  });
});

describe('delete_mission', () => {
  it('removes the folder, asks the harness to clean up, and reminds the model about outside systems', async () => {
    const m = await created();
    const result = await deleteMission(ctx, { mission: 'news-curator' });
    expect(result.isError).toBeUndefined();
    expect(existsSync(h.paths.missionDir(m.id))).toBe(false);
    expect(h.registry.get(m.id)).toBeUndefined();
    expect(h.host.cleanedUp).toEqual([m.id]);
    expect(textOf(result)).toMatch(/Tell the user that what the mission created in outside systems.*is left untouched/);
  });

  it('deletes a mission whose manifest is invalid, by id', async () => {
    mkdirSync(h.paths.missionDir('m_aaaaaaaaaaaa'), { recursive: true });
    writeFileSync(h.paths.manifestFile('m_aaaaaaaaaaaa'), 'id: m_aaaaaaaaaaaa\n');
    const result = await deleteMission(ctx, { mission: 'm_aaaaaaaaaaaa' });
    expect(result.isError).toBeUndefined();
    expect(existsSync(h.paths.missionDir('m_aaaaaaaaaaaa'))).toBe(false);
  });

  it('returns the registry error for a system mission and keeps its folder', async () => {
    for (const mission of [SYS_GENERAL, SYS_MISSION_ADMIN]) {
      const result = await deleteMission(ctx, { mission });
      expect(textOf(result)).toBe(new SystemMissionError(mission, 'removed').message);
      expect(existsSync(h.paths.missionDir(mission))).toBe(true);
    }
    expect(h.host.cleanedUp).toEqual([]);
  });

  it('returns an error for an unknown mission', async () => {
    expect((await deleteMission(ctx, { mission: 'nothing' })).isError).toBe(true);
    expect((await deleteMission(ctx, { mission: 'm_aaaaaaaaaaaa' })).isError).toBe(true);
    expect(h.host.cleanedUp).toEqual([]);
  });
});

describe('input shapes', () => {
  // The SDK wraps a shape in an object; the inner objects are strict, so an unknown key is rejected.
  const create = z.object(createMissionShape);
  const edit = z.object(editMissionShape);

  it('rejects an unknown key in the manifest and in the changes', () => {
    expect(create.safeParse({ manifest: { ...draft(), id: 'm_aaaaaaaaaaaa' } }).success).toBe(false);
    expect(create.safeParse({ manifest: { ...draft(), status: 'frozen' } }).success).toBe(false);
    expect(create.safeParse({ manifest: draft() }).success).toBe(true);
    expect(edit.safeParse({ mission: 'x', changes: { status: 'frozen' } }).success).toBe(false);
    expect(edit.safeParse({ mission: 'x', changes: { version: 9 } }).success).toBe(false);
    expect(edit.safeParse({ mission: 'x', changes: { model: null, limits: null } }).success).toBe(true);
  });

  it('rejects an unknown key in a gate, in context and in limits, and an unknown gate kind', () => {
    const bad = [
      { gates: [{ use: 'gate:allow', for: 'action:web.search', extra: 1 }] },
      { gates: [{ use: 'gate:maybe', for: 'action:web.search' }] },
      { context: { instructions: 'x', more: 'y' } },
      { limits: { max_steps: 1, max_tokens: 5 } },
    ];
    for (const overrides of bad) {
      expect(create.safeParse({ manifest: { ...draft(), ...overrides } }).success).toBe(false);
    }
  });

  it('keeps trigger parameters, so they are shown and saved as given', () => {
    const parsed = create.parse({ manifest: draft() });
    expect(parsed.manifest.triggers[0]).toEqual({ use: 'trigger:cron', at: '0 7 * * *' });
  });

  it('requires a boolean for frozen', () => {
    expect(z.object(freezeMissionShape).safeParse({ mission: 'x', frozen: 'yes' }).success).toBe(false);
  });
});
