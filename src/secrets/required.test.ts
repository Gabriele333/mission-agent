import { describe, expect, it } from 'vitest';
import { createMemorySecretStore } from './memory.js';
import { missingCredentials, requiredCredentials } from './required.js';

const KEY = 'credential:model.api_key';
const BOT = 'credential:telegram.bot_token';
const MAIL = 'credential:gmail.oauth_token';
const CAL = 'credential:calendar.token';

describe('requiredCredentials', () => {
  it('holds the model key with the api_key login', () => {
    expect(requiredCredentials({ modelLogin: 'api_key', telegramUsed: false, declared: [] })).toEqual([KEY]);
  });

  it('holds no model credential with the subscription login', () => {
    expect(requiredCredentials({ modelLogin: 'subscription', telegramUsed: false, declared: [] })).toEqual([]);
    expect(requiredCredentials({ modelLogin: 'subscription', telegramUsed: true, declared: [MAIL] })).toEqual([BOT, MAIL]);
  });

  it('holds the bot token when Telegram is used', () => {
    expect(requiredCredentials({ modelLogin: 'api_key', telegramUsed: true, declared: [] })).toEqual([KEY, BOT]);
  });

  it('keeps a stable order with no duplicates', () => {
    const ids = requiredCredentials({ modelLogin: 'api_key', telegramUsed: true, declared: [MAIL, BOT, CAL, MAIL, KEY] });
    expect(ids).toEqual([KEY, BOT, MAIL, CAL]);
  });

  it('rejects an invalid declared id', () => {
    expect(() => requiredCredentials({ modelLogin: 'api_key', telegramUsed: false, declared: ['gmail.token'] })).toThrow(/not valid/);
  });
});

describe('missingCredentials', () => {
  it('returns the ids with no value, in order', async () => {
    const store = createMemorySecretStore({ [BOT]: 'bot-token-1' });
    expect(await missingCredentials(store, [KEY, BOT, MAIL, KEY])).toEqual([KEY, MAIL]);
    expect(await missingCredentials(store, [])).toEqual([]);
  });
});
