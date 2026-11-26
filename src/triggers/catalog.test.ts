import { describe, expect, it } from 'vitest';
import type { TriggerDefinition } from '../types.js';
import { createTriggerCatalog } from './catalog.js';
import { chatTrigger } from './chat.js';
import { cronTrigger } from './cron.js';

describe('chatTrigger', () => {
  it('watches nothing and takes no parameters', () => {
    expect(chatTrigger.id).toBe('trigger:chat');
    expect(chatTrigger.create({ emit: () => {}, credentials: {} })).toBeNull();
    expect(chatTrigger.validateParams({})).toBeNull();
    expect(chatTrigger.validateParams({ at: 'x' })).toBe('takes no parameters, but has at.');
  });
});

describe('createTriggerCatalog', () => {
  const catalog = createTriggerCatalog([cronTrigger, chatTrigger]);

  it('lists and finds the triggers', () => {
    expect(catalog.ids()).toEqual(['trigger:cron', 'trigger:chat']);
    expect(catalog.triggerIds()).toEqual(['trigger:cron', 'trigger:chat']);
    expect(catalog.get('trigger:cron')).toBe(cronTrigger);
    expect(catalog.get('trigger:none')).toBeUndefined();
  });

  it('validates a subscription', () => {
    expect(catalog.validateParams({ use: 'trigger:cron', at: '0 7 * * *' })).toBeNull();
    expect(catalog.validateParams({ use: 'trigger:cron' })).toMatch(/needs "at"/);
    expect(catalog.validateParams({ use: 'trigger:chat' })).toBeNull();
    expect(catalog.validateTriggerParams({ use: 'trigger:chat', x: 1 })).toMatch(/takes no parameters/);
    expect(catalog.validateParams({ use: 'trigger:none' })).toBe('"trigger:none" does not exist in the harness.');
  });

  it('turns a throwing validation into an error text', () => {
    const bad: TriggerDefinition = {
      id: 'trigger:bad.thing',
      credentials: [],
      validateParams: () => {
        throw new Error('boom');
      },
      create: () => null,
    };
    expect(createTriggerCatalog([bad]).validateParams({ use: 'trigger:bad.thing' })).toMatch(/boom/);
  });

  it('rejects two definitions with the same id', () => {
    expect(() => createTriggerCatalog([cronTrigger, { ...cronTrigger }])).toThrow(/same id, trigger:cron/);
  });
});
