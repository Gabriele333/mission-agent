import type { TriggerDefinition } from '../types.js';

export const CHAT_TRIGGER_ID = 'trigger:chat';

/**
 * Marks a mission that receives chat messages (§B.2, §B.3). It watches nothing:
 * the harness assigns a chat message to a mission by a command, by a Telegram reply or by triage.
 */
export const chatTrigger: TriggerDefinition = {
  id: CHAT_TRIGGER_ID,
  credentials: [],
  validateParams(params) {
    const keys = Object.keys(params);
    return keys.length > 0 ? `takes no parameters, but has ${keys.join(', ')}.` : null;
  },
  create: () => null,
};
