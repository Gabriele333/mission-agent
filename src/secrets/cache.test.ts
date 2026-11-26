import { describe, expect, it } from 'vitest';
import { MissingCredentialError, createSecretCache } from './cache.js';
import { createMemorySecretStore } from './memory.js';
import { createRedactor } from './redactor.js';

const KEY = 'credential:model.api_key';
const BOT = 'credential:telegram.bot_token';
const MAIL = 'credential:gmail.oauth_token';

describe('createSecretCache', () => {
  it('loads the named values and returns them from memory', async () => {
    const store = createMemorySecretStore({ [KEY]: 'sk-ant-key-1', [BOT]: 'bot-token-1' });
    const cache = createSecretCache(store);
    await cache.load([KEY, MAIL]);
    expect(cache.get(KEY)).toBe('sk-ant-key-1');
    expect(cache.get(MAIL)).toBeUndefined();
    // Not loaded, so not in memory even though the store has it.
    expect(cache.get(BOT)).toBeUndefined();
  });

  it('does not read the store again on get', async () => {
    const store = createMemorySecretStore({ [KEY]: 'sk-ant-key-1' });
    const cache = createSecretCache(store);
    await cache.load([KEY]);
    await store.set(KEY, 'sk-ant-key-2');
    expect(cache.get(KEY)).toBe('sk-ant-key-1');
    await cache.refresh(KEY);
    expect(cache.get(KEY)).toBe('sk-ant-key-2');
  });

  it('forgets a value deleted from the store after refresh', async () => {
    const store = createMemorySecretStore({ [KEY]: 'sk-ant-key-1' });
    const cache = createSecretCache(store);
    await cache.load([KEY]);
    await store.delete(KEY);
    await cache.refresh(KEY);
    expect(cache.get(KEY)).toBeUndefined();
  });

  it('pick returns only the named credentials', async () => {
    const store = createMemorySecretStore({ [KEY]: 'sk-ant-key-1', [BOT]: 'bot-token-1', [MAIL]: 'mail-token-1' });
    const cache = createSecretCache(store);
    await cache.load([KEY, BOT, MAIL]);
    expect(cache.pick([MAIL])).toEqual({ [MAIL]: 'mail-token-1' });
    expect(cache.pick([])).toEqual({});
  });

  it('pick throws MissingCredentialError that lists every missing id once', async () => {
    const store = createMemorySecretStore({ [KEY]: 'sk-ant-key-1' });
    const cache = createSecretCache(store);
    await cache.load([KEY, BOT, MAIL]);
    const error = (() => {
      try {
        cache.pick([BOT, KEY, MAIL, BOT]);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(MissingCredentialError);
    expect((error as MissingCredentialError).ids).toEqual([BOT, MAIL]);
    expect((error as Error).message).toContain(`${BOT}, ${MAIL}`);
    expect((error as Error).message).toContain('secret set');
    expect((error as Error).message).not.toContain('sk-ant-key-1');
  });

  it('rejects an invalid id', async () => {
    const cache = createSecretCache(createMemorySecretStore());
    await expect(cache.load(['bad'])).rejects.toThrow(/not valid/);
    await expect(cache.refresh('bad')).rejects.toThrow(/not valid/);
    expect(() => cache.pick(['bad'])).toThrow(/not valid/);
  });

  it('gives a map from value to id for redaction, also for a replaced value', async () => {
    const store = createMemorySecretStore({ [KEY]: 'sk-ant-key-old', [BOT]: 'bot-token-12345' });
    const cache = createSecretCache(store);
    await cache.load([KEY, BOT]);
    await store.set(KEY, 'sk-ant-key-new');
    await cache.refresh(KEY);
    const map = cache.valuesForRedaction();
    expect(map.get('sk-ant-key-new')).toBe(KEY);
    expect(map.get('sk-ant-key-old')).toBe(KEY);
    expect(map.get('bot-token-12345')).toBe(BOT);

    const redactor = createRedactor(() => cache.valuesForRedaction());
    expect(redactor.redact('old sk-ant-key-old new sk-ant-key-new')).toBe(`old [${KEY}] new [${KEY}]`);
  });
});
