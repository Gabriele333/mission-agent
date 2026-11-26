import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore } from '../db/index.js';
import { describeApproval } from '../safety/index.js';
import { makeHarness } from '../tools/test-helpers.js';
import type { ApprovalRequest, Store } from '../types.js';
import { approvalDetails, type ApprovalDetailsContext } from './approval-details.js';

let h: ReturnType<typeof makeHarness>;
let store: Store;
let ctx: ApprovalDetailsContext;
let missing: Set<string>;
let id: string;

beforeEach(() => {
  h = makeHarness();
  store = createMemoryStore();
  missing = new Set();
  ctx = {
    registry: h.registry,
    store,
    paths: h.paths,
    pendingApprovals: () => [],
    // Every trigger:cron subscription needs a made-up credential in this test.
    credentialIdsOf: (m) => (m.triggers.some((t) => t.use === 'trigger:cron') ? ['credential:clock.key'] : []),
    hasSecret: async (cid) => !missing.has(cid),
  };
  id = h.registry.create({
    name: 'news',
    description: 'Curates the news',
    triggers: [{ use: 'trigger:chat' }],
    tools: [],
    context: { instructions: 'Curate the news.' },
    signals: [],
    gates: [],
  }).id;
});

afterEach(() => h.cleanUp());

function req(action: string, input: Record<string, unknown>): ApprovalRequest {
  return {
    id: 'apr_1',
    missionId: 'sys-mission-admin',
    action,
    toolName: 'mcp__mission_registry__x',
    input,
    createdAt: '2026-11-25T10:00:00.000Z',
    expiresAt: '2026-11-26T10:00:00.000Z',
  };
}

describe('approval details (§4.2, §4.2.1)', () => {
  it('shows the current value next to the new value of each changed field of an edit', async () => {
    missing.add('credential:clock.key');
    const text = await approvalDetails(
      req('action:registry.edit', {
        mission: 'news',
        changes: { description: 'Curates tech news', triggers: [{ use: 'trigger:cron', at: '0 7 * * *' }], context: { instructions: 'Curate the news.' } },
      }),
      ctx,
    );
    expect(text).toContain(`Changes to the mission news (${id}), now at version 1:`);
    expect(text).toContain('- description\n  now:\n    Curates the news\n  new:\n    Curates tech news');
    expect(text).toContain('- triggers\n  now:\n    [{"use":"trigger:chat"}]\n  new:\n    [{"use":"trigger:cron","at":"0 7 * * *"}]');
    expect(text).toContain('- context: unchanged');
    expect(text).toContain('- credential:clock.key');
  });

  it('lists everything a deletion removes', async () => {
    writeFileSync(join(h.paths.memoryDir(id), 'note.md'), 'a note');
    writeFileSync(join(h.paths.dataDir(id), 'report.pdf'), 'x');
    store.setSession(id, 'sess');
    store.setThread(id, 7);
    store.enqueueEvent(id, { triggerId: 'trigger:cron', key: 'k', time: '2026-11-25T10:00:00.000Z', summary: 's', data: {} });
    ctx.pendingApprovals = () => [{ ...req('action:email.send', {}), missionId: id }];
    const text = (await approvalDetails(req('action:registry.delete', { mission: id }), ctx)) ?? '';
    expect(text).toContain(`Deleting the mission news (${id}) removes everything below:`);
    expect(text).toContain('memory/: the index and 1 note');
    expect(text).toContain('data/: 1 file');
    expect(text).toContain('its session: the whole conversation');
    expect(text).toContain('its waiting approvals: 1');
    expect(text).toContain('its queued events: 1');
    expect(text).toContain('its Telegram thread with the messages in it: yes');
    expect(text).toContain('It keeps the logbook rows');
  });

  it('names the missing credentials of a new mission', async () => {
    missing.add('credential:clock.key');
    const text = await approvalDetails(
      req('action:registry.create', { manifest: { name: 'daily', triggers: [{ use: 'trigger:cron', at: '0 7 * * *' }], tools: [] } }),
      ctx,
    );
    expect(text).toContain('Creates the mission daily');
    expect(text).toContain('- credential:clock.key');
  });

  it('adds nothing to other actions, and describeApproval shows the details before the input', async () => {
    expect(await approvalDetails(req('action:email.send', {}), ctx)).toBeUndefined();
    const shown = describeApproval({ ...req('action:registry.delete', { mission: 'news' }), details: 'Removes all.' }, 'sys-mission-admin');
    expect(shown).toBe('Mission: sys-mission-admin\nAction: action:registry.delete\nRemoves all.\nInput:\n{\n  "mission": "news"\n}');
  });
});
