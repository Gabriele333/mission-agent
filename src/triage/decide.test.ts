import { describe, expect, it } from 'vitest';
import { exampleManifest } from '../manifest/test-helpers.js';
import { chatMissions, decideChatMission, type DecideInput } from './decide.js';

const G = 'sys-general';
const A = 'm_aaaaaaaaaaaa';
const B = 'm_bbbbbbbbbbbb';
const OLD = 'm_cccccccccccc';

function input(over: Partial<DecideInput>): DecideInput {
  return {
    result: { missionId: A, confidence: 0 },
    currentMissionId: A,
    threshold: 0.8,
    isGeneralThread: false,
    chatMissionIds: [G, A, B],
    ...over,
  };
}

describe('decideChatMission', () => {
  it('stays on the current mission when the classifier picks it', () => {
    const d = decideChatMission(input({ result: { missionId: A, confidence: 0.95 } }));
    expect(d).toMatchObject({ missionId: A, switched: false });
  });

  it('switches when another mission is picked above the threshold', () => {
    const d = decideChatMission(input({ result: { missionId: B, confidence: 0.81 } }));
    expect(d).toMatchObject({ missionId: B, switched: true });
    expect(d.reason).toContain('above 0.8');
  });

  it('stays when another mission is picked at or below the threshold', () => {
    expect(decideChatMission(input({ result: { missionId: B, confidence: 0.8 } }))).toMatchObject({ missionId: A, switched: false });
    expect(decideChatMission(input({ result: { missionId: B, confidence: 0.2 } }))).toMatchObject({ missionId: A, switched: false });
  });

  it('switches to the general mission when it is picked above the threshold', () => {
    expect(decideChatMission(input({ result: { missionId: G, confidence: 0.9 } }))).toMatchObject({ missionId: G, switched: true });
  });

  it('does not switch to a mission that does not take chat messages', () => {
    const d = decideChatMission(input({ result: { missionId: OLD, confidence: 0.99 } }));
    expect(d).toMatchObject({ missionId: A, switched: false });
    expect(d.reason).toContain('does not take chat messages');
  });

  it('falls back to the general mission when the current mission no longer takes chat messages', () => {
    const d = decideChatMission(input({ currentMissionId: OLD, result: { missionId: OLD, confidence: 0.99 } }));
    expect(d).toMatchObject({ missionId: G, switched: true });
    expect(d.reason).toContain(`current mission ${OLD} no longer exists`);
  });

  it('switches from a fallen-back mission to another one above the threshold', () => {
    expect(decideChatMission(input({ currentMissionId: OLD, result: { missionId: B, confidence: 0.9 } }))).toMatchObject({
      missionId: B,
      switched: true,
    });
  });

  it('uses the general mission as the default in the general thread', () => {
    expect(decideChatMission(input({ isGeneralThread: true, currentMissionId: A, result: { missionId: A, confidence: 0.5 } }))).toMatchObject({
      missionId: G,
      switched: false,
    });
    expect(decideChatMission(input({ isGeneralThread: true, currentMissionId: A, result: { missionId: A, confidence: 0.9 } }))).toMatchObject({
      missionId: A,
      switched: true,
    });
    expect(decideChatMission(input({ isGeneralThread: true, result: { missionId: G, confidence: 1 } }))).toMatchObject({
      missionId: G,
      switched: false,
    });
  });

  it('stays on the general mission when it is current and triage failed', () => {
    expect(decideChatMission(input({ currentMissionId: G, result: { missionId: G, confidence: 0 } }))).toMatchObject({
      missionId: G,
      switched: false,
    });
  });
});

describe('chatMissions', () => {
  it('keeps the active missions that list trigger:chat', () => {
    const a = exampleManifest();
    const frozen = exampleManifest({ id: B, name: 'frozen-one', status: 'frozen' });
    const noChat = exampleManifest({ id: OLD, name: 'no-chat', triggers: [{ use: 'trigger:cron', at: '0 7 * * *' }] });
    expect(chatMissions([a, frozen, noChat]).map((m) => m.id)).toEqual([a.id]);
  });
});
