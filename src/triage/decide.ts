import { SYS_GENERAL, type Manifest, type MissionId, type TriageResult } from '../types.js';
import { CHAT_TRIGGER_ID } from '../triggers/chat.js';

export interface DecideInput {
  result: TriageResult;
  /** The mission of the last chat message, or the general mission. */
  currentMissionId: MissionId;
  /** Usually `config.triageSwitchConfidence`. Triage switches only above it. */
  threshold: number;
  /** True for a message sent in the general mission's thread on Telegram: there the default is always the general mission. */
  isGeneralThread: boolean;
  /** The active missions that list `trigger:chat`. */
  chatMissionIds: MissionId[];
}

export interface ChatDecision {
  missionId: MissionId;
  /** True when the message goes to another mission than the default one (the current mission, or the general mission in its thread). */
  switched: boolean;
  /** One sentence in plain words, for the logs. */
  reason: string;
}

/** The rule of §B.3: stay on the default mission unless the classifier picked another one with a confidence above the threshold. */
export function decideChatMission(input: DecideInput): ChatDecision {
  const { result, currentMissionId, threshold, isGeneralThread } = input;
  const takesChat = (id: MissionId) => id === SYS_GENERAL || input.chatMissionIds.includes(id);

  let base: MissionId;
  let baseReason: string;
  if (isGeneralThread) {
    base = SYS_GENERAL;
    baseReason = 'The message was sent in the general thread, where the default is the general mission.';
  } else if (takesChat(currentMissionId)) {
    base = currentMissionId;
    baseReason = `The current mission is ${currentMissionId}.`;
  } else {
    base = SYS_GENERAL;
    baseReason = `The current mission ${currentMissionId} no longer exists or no longer takes chat messages, so the default is the general mission.`;
  }
  // The mission the message goes to when the classifier does not decide.
  const defaultId = isGeneralThread ? SYS_GENERAL : currentMissionId;

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
