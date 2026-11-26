import type { CodeCatalog, TriggerDefinition, TriggerSubscription } from '../types.js';

/**
 * The triggers of the harness, by id. It also has the two trigger functions of `CodeCatalog`,
 * so the code that builds the registry's catalog can use it directly.
 */
export interface TriggerCatalog extends Pick<CodeCatalog, 'triggerIds' | 'validateTriggerParams'> {
  ids(): string[];
  get(id: string): TriggerDefinition | undefined;
  /** Returns an error text, or null when the trigger exists and the parameters are valid. */
  validateParams(sub: TriggerSubscription): string | null;
}

export function createTriggerCatalog(definitions: TriggerDefinition[]): TriggerCatalog {
  const byId = new Map<string, TriggerDefinition>();
  for (const def of definitions) {
    if (byId.has(def.id)) throw new Error(`Two triggers have the same id, ${def.id}.`);
    byId.set(def.id, def);
  }
  const ids = () => [...byId.keys()];

  function validateParams(sub: TriggerSubscription): string | null {
    const { use, ...params } = sub;
    const def = byId.get(use);
    if (def === undefined) return `"${use}" does not exist in the harness.`;
    try {
      return def.validateParams(params);
    } catch (e) {
      return `the parameters could not be checked: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return {
    ids,
    get: (id) => byId.get(id),
    validateParams,
    triggerIds: ids,
    validateTriggerParams: validateParams,
  };
}
