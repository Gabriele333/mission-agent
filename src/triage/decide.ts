import { SYS_GENERAL, type Manifest, type MissionId, type TriageResult } from '../types.js';
import { CHAT_TRIGGER_ID } from '../triggers/chat.js';

export interface DecideInput {
  result: TriageResult;
  /** The mission that last wrote to the user in chat or was last addressed by the user, or the general mission. */
  currentMissionId: MissionId;
  /** Usually `config.triageSwitchConfidence`. Triage switches only above it. */
  threshold: number;
  /** The active missions that list `trigger:chat`. */
  chatMissionIds: MissionId[];
}

export interface ChatDecision {
  missionId: MissionId;
  /** True when the message goes to another mission than the current one. */
  switched: boolean;
  /** One sentence in plain words, for the logs. */
  reason: string;
}

/**
 * The rule of §B.3: stay on the current mission unless the classifier picked another one with a
 * confidence above the threshold. The terminal and Telegram use the same rule.
 */
export function decideChatMission(input: DecideInput): ChatDecision {
  const { result, currentMissionId, threshold } = input;
  const takesChat = (id: MissionId) => id === SYS_GENERAL || input.chatMissionIds.includes(id);

  let base: MissionId;
  let baseReason: string;
  if (takesChat(currentMissionId)) {
    base = currentMissionId;
    baseReason = `The current mission is ${currentMissionId}.`;
  } else {
    base = SYS_GENERAL;
    baseReason = `The current mission ${currentMissionId} no longer exists or no longer takes chat messages, so the default is the general mission.`;
  }
  const defaultId = currentMissionId;

  const picked = result.missionId;
  if (picked !== base && takesChat(picked) && result.confidence > threshold) {
    return {
      missionId: picked,
      switched: picked !== defaultId,
      reason: `${baseReason} The classifier picked ${picked} with confidence ${result.confidence}, above ${threshold}.`,
    };
  }

  let why: string;
  if (picked === base) why = `The classifier also picked ${picked}.`;
  else if (!takesChat(picked)) why = `The classifier picked ${picked}, which does not take chat messages.`;
  else why = `The classifier picked ${picked} with confidence ${result.confidence}, not above ${threshold}.`;
  return { missionId: base, switched: base !== defaultId, reason: `${baseReason} ${why}` };
}

/** The active missions that list `trigger:chat`: the candidates of triage (§B.3). */
export function chatMissions(manifests: Manifest[]): Manifest[] {
  return manifests.filter((m) => m.status === 'active' && m.triggers.some((t) => t.use === CHAT_TRIGGER_ID));
}
