import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config/index.js';
import { MODEL_API_KEY, TELEGRAM_BOT_TOKEN } from '../secrets/index.js';
import type { Manifest, ToolDefinition } from '../types.js';
import { missingCredentialText, requiredCredentialIds, type CredentialSources } from './credentials.js';

const gmail: ToolDefinition = { id: 'tool:gmail', operations: [], credentials: ['credential:gmail.token'], provide: () => ({}) };
const sources: CredentialSources = {
  tools: { get: (id) => (id === 'tool:gmail' ? gmail : undefined), alwaysOn: () => [] },
  triggers: {
    get: (id) =>
      id === 'trigger:email.received'
        ? { id, credentials: ['credential:gmail.token', 'credential:gmail.push'], validateParams: () => null, create: () => null }
        : undefined,
  },
};

function mission(id: string, status: Manifest['status'], tools: string[], triggers: string[]): Manifest {
  return {
    id,
    name: id,
    description: '',
    version: 1,
    status,
    triggers: triggers.map((use) => ({ use })),
    tools,
    context: { instructions: '' },
    signals: [],
    gates: [],
  };
}

describe('required credentials (§A.5)', () => {
  it('holds the harness credentials, then those of the tools and triggers of active missions only', () => {
    const config = { ...defaultConfig('Ada'), telegramUserId: 1 };
    const ids = requiredCredentialIds(
      config,
      [mission('m_a', 'active', ['tool:gmail'], ['trigger:email.received']), mission('m_b', 'frozen', [], ['trigger:other.thing'])],
      sources,
    );
    expect(ids).toEqual([MODEL_API_KEY, TELEGRAM_BOT_TOKEN, 'credential:gmail.token', 'credential:gmail.push']);
  });

  it('has no model credential with the subscription login and no bot token without Telegram', () => {
    expect(requiredCredentialIds({ ...defaultConfig('Ada'), modelLogin: 'subscription' }, [], sources)).toEqual([]);
  });

  it('writes one message per credential with the command, never a value', () => {
    expect(missingCredentialText('credential:gmail.token', 'inbox')).toBe(
      'The credential credential:gmail.token has no value. The mission inbox needs it. ' +
        'Enter it in a shell on this machine with: mission-agent secret set credential:gmail.token',
    );
  });
});
