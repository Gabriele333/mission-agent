import type { SecretStore } from '../types.js';
import { assertCredentialId, assertStorableValue } from './ids.js';

/** A store in memory, for tests. It checks ids and values the same way as the Keychain store. */
export function createMemorySecretStore(initial: Record<string, string> = {}): SecretStore {
  const values = new Map<string, string>();
  for (const [id, value] of Object.entries(initial)) {
    assertCredentialId(id);
    assertStorableValue(value);
    values.set(id, value);
  }
  return {
    async get(id) {
      assertCredentialId(id);
      return values.get(id);
    },
    async set(id, value) {
      assertCredentialId(id);
      assertStorableValue(value);
      values.set(id, value);
    },
    async delete(id) {
      assertCredentialId(id);
      return values.delete(id);
    },
    async has(id) {
      assertCredentialId(id);
      return values.has(id);
    },
  };
}
