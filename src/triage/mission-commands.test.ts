import { describe, expect, it } from 'vitest';
import { exampleManifest } from '../manifest/test-helpers.js';
import { SYS_GENERAL, SYS_MISSION_ADMIN } from '../types.js';
import {
  COMMAND_MAX_CHARS,
  commandOf,
  commandProblem,
  MENU_DESCRIPTION_MAX_CHARS,
  MENU_MAX_COMMANDS,
  menuCommands,
  missionOfCommand,
  RESERVED_COMMANDS,
} from './mission-commands.js';

const m = (id: string, name: string) => ({ id, name });

describe('the command of a mission', () => {
  it('is the name with each hyphen as an underscore; the system missions drop sys-', () => {
    expect(commandOf(m('m_k7q3zp2xw9ha', 'inbox-curator'))).toBe('inbox_curator');
    expect(commandOf(m('m_k7q3zp2xw9ha', 'plan-2027'))).toBe('plan_2027');
    expect(commandOf(m(SYS_GENERAL, SYS_GENERAL))).toBe('general');
    expect(commandOf(m(SYS_MISSION_ADMIN, SYS_MISSION_ADMIN))).toBe('mission_admin');
    expect(commandOf(m('sys-self-improve', 'sys-self-improve'))).toBe('self_improve');
  });

  it('is missing for a name longer than 32 characters, or one that clashes', () => {
    const at32 = 'a'.repeat(COMMAND_MAX_CHARS);
    expect(commandOf(m('m_k7q3zp2xw9ha', at32))).toBe(at32);
    expect(commandOf(m('m_k7q3zp2xw9ha', `${at32}b`))).toBeUndefined();
    expect(commandOf(m('m_k7q3zp2xw9ha', 'x'.repeat(40)))).toBeUndefined();
    for (const name of ['mission', 'stop', 'pause', 'resume', 'improve', 'start', 'general', 'mission-admin', 'self-improve']) {
      expect(commandOf(m('m_k7q3zp2xw9ha', name))).toBeUndefined();
    }
    expect(RESERVED_COMMANDS).toEqual(['mission', 'stop', 'pause', 'resume', 'improve', 'start', 'general', 'mission_admin', 'self_improve']);
  });

  it('finds the mission of a command, in any case', () => {
    const list = [m(SYS_GENERAL, SYS_GENERAL), m('m_k7q3zp2xw9ha', 'inbox-curator'), m('m_2vx8qm4rt6pc', 'general')];
    expect(missionOfCommand('Inbox_Curator', list)?.name).toBe('inbox-curator');
    // A user mission named general has no command: /general is the general mission's.
    expect(missionOfCommand('general', list)?.id).toBe(SYS_GENERAL);
    expect(missionOfCommand('nope', list)).toBeUndefined();
  });

  it('commandProblem refuses a long or clashing name with a clear message, and accepts the rest', () => {
    expect(commandProblem('inbox-curator')).toBeUndefined();
    expect(commandProblem('a'.repeat(32))).toBeUndefined();
    expect(commandProblem('a'.repeat(33))).toBe(
      `name "${'a'.repeat(33)}" is too long for a chat command: /${'a'.repeat(33)} would have 33 characters, and Telegram allows 32. Choose a name of at most 32 characters.`,
    );
    expect(commandProblem('stop')).toBe('name "stop" would give the chat command /stop, which the harness already uses. Choose another name.');
    expect(commandProblem('mission-admin')).toContain('/mission_admin, which the harness already uses');
  });
});

describe('menuCommands', () => {
  it('lists the harness commands, then the general mission and each active mission that takes chat', () => {
    const general = exampleManifest({ id: SYS_GENERAL, name: SYS_GENERAL, description: 'Anything else' });
    const inbox = exampleManifest({ id: 'm_k7q3zp2xw9ha', name: 'inbox-curator', description: `Sorts my inbox.\n${'x'.repeat(300)}` });
    const frozen = exampleManifest({ id: 'm_aaaaaaaaaaaa', name: 'frozen-one', status: 'frozen' });
    const timer = exampleManifest({ id: 'm_bbbbbbbbbbbb', name: 'timer-only', triggers: [{ use: 'trigger:cron', at: '0 7 * * *' }] });
    const long = exampleManifest({ id: 'm_cccccccccccc', name: 'x'.repeat(40) });
    const { commands, left } = menuCommands([inbox, frozen, timer, long, general]);
    expect(commands.map((c) => c.command)).toEqual(['mission', 'stop', 'pause', 'resume', 'general', 'inbox_curator']);
    expect(left).toBe(0);
    expect(commands[4]!.description).toBe('Anything else');
    const cut = commands[5]!.description;
    expect(cut.length).toBe(MENU_DESCRIPTION_MAX_CHARS);
    expect(cut.startsWith('Sorts my inbox. xxx')).toBe(true);
    for (const c of commands) expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
  });

  it('keeps the first 100 commands and counts the rest', () => {
    const many = Array.from({ length: 120 }, (_, i) => exampleManifest({ id: `m_${String(i).padStart(12, 'a')}`, name: `mission-${i}` }));
    const { commands, left } = menuCommands(many);
    expect(commands).toHaveLength(MENU_MAX_COMMANDS);
    expect(left).toBe(24);
  });
});
