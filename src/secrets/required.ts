import type { SecretStore } from '../types.js';
import { MODEL_API_KEY, TELEGRAM_BOT_TOKEN, assertCredentialId } from './ids.js';

export interface RequiredCredentialsInput {
  modelLogin: 'api_key' | 'subscription';
  telegramUsed: boolean;
  /** Ids named by the tools, triggers and surfaces that active missions use. */
  declared: string[];
}

/**
 * The credentials the harness requires (§A.5 "How the harness asks for a credential").
 * Order: the model key, the bot token, then the declared ids in the order given. No duplicates.
 * With the `subscription` login there is no model credential: Claude Code keeps that sign-in.
 */
export function requiredCredentials(input: RequiredCredentialsInput): string[] {
  const ids: string[] = [];
  if (input.modelLogin === 'api_key') ids.push(MODEL_API_KEY);
  if (input.telegramUsed) ids.push(TELEGRAM_BOT_TOKEN);
  for (const id of input.declared) {
    assertCredentialId(id);
    ids.push(id);
  }
  return [...new Set(ids)];
}

/** The ids among `ids` that have no value in the store, in the same order. */
export async function missingCredentials(store: SecretStore, ids: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    if (!(await store.has(id))) missing.push(id);
  }
  return missing;
}
