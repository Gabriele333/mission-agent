import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKeychainStore } from './keychain.js';

// Uses the real login Keychain. Runs only with MISSION_AGENT_LIVE=1.
const live = process.env.MISSION_AGENT_LIVE === '1';
const ID = 'credential:live_test.value';

describe.skipIf(!live)('Keychain store, live', () => {
  const store = createKeychainStore({ service: 'mission-agent-test' });

  const cleanUp = async () => {
    await store.delete(ID).catch(() => false);
  };
  beforeAll(cleanUp);
  afterAll(cleanUp);

  it('writes, reads, replaces and deletes one item', async () => {
    const first = 'first value with spaces, "double quotes", \'single\' and a backslash \\ here';
    const second = 'second "value" \\ with a newline\nand héllo €';

    expect(await store.get(ID)).toBeUndefined();
    expect(await store.has(ID)).toBe(false);

    await store.set(ID, first);
    expect(await store.has(ID)).toBe(true);
    expect(await store.get(ID)).toBe(first);

    await store.set(ID, second);
    expect(await store.get(ID)).toBe(second);

    expect(await store.delete(ID)).toBe(true);
    expect(await store.get(ID)).toBeUndefined();
    expect(await store.delete(ID)).toBe(false);
  });

  it('keeps a value made only of hex digits as text', async () => {
    await store.set(ID, '414243deadbeef');
    expect(await store.get(ID)).toBe('414243deadbeef');
  });
});
