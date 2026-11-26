import type { SecretStore } from '../types.js';
import { assertCredentialId } from './ids.js';

/** Thrown when a tool, a trigger or a surface needs a credential that has no value. */
export class MissingCredentialError extends Error {
  readonly ids: string[];
  constructor(ids: string[]) {
    super(
      `Missing ${ids.length === 1 ? 'credential' : 'credentials'}: ${ids.join(', ')}. ` +
        'Enter each one with the command: mission-agent secret set <id>',
    );
    this.name = 'MissingCredentialError';
    this.ids = ids;
  }
}

/** The values the harness holds in memory (§A.5 "How a value is read"). */
export interface SecretCache {
  /** Reads the named credentials from the store. Ids not named keep their cached value. */
  load(ids: string[]): Promise<void>;
  get(id: string): string | undefined;
  /**
   * A map from secret value to credential id, for `createRedactor`.
   * It also holds values that were replaced or deleted since the harness started,
   * because a run that started before the change can still print them.
   */
  valuesForRedaction(): Map<string, string>;
  /** Reads one credential again, after `secret set` or `secret delete`. */
  refresh(id: string): Promise<void>;
  /** Returns only the named credentials. Throws MissingCredentialError when one has no value. */
  pick(ids: string[]): Record<string, string>;
}

export function createSecretCache(store: SecretStore): SecretCache {
  const current = new Map<string, string>();
  const retired = new Map<string, string>();

  async function read(id: string): Promise<void> {
    const value = await store.get(id);
    const old = current.get(id);
    if (old !== undefined && old !== value) retired.set(old, id);
    if (value === undefined) current.delete(id);
    else current.set(id, value);
  }

  return {
    async load(ids) {
      for (const id of ids) assertCredentialId(id);
      for (const id of new Set(ids)) await read(id);
    },

    get(id) {
      return current.get(id);
    },

    valuesForRedaction() {
      const map = new Map(retired);
      // Current values are set last, so their id wins when a value was moved to another id.
      for (const [id, value] of current) map.set(value, id);
      return map;
    },

    async refresh(id) {
      assertCredentialId(id);
      await read(id);
    },

    pick(ids) {
      const picked: Record<string, string> = {};
      const missing: string[] = [];
      for (const id of ids) {
        assertCredentialId(id);
        const value = current.get(id);
        if (value === undefined) {
          if (!missing.includes(id)) missing.push(id);
        } else {
          picked[id] = value;
        }
      }
      if (missing.length > 0) throw new MissingCredentialError(missing);
      return picked;
    },
  };
}
