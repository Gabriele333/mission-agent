import { describe, expect, it } from 'vitest';
import { parseCommand } from './commands.js';

describe('parseCommand', () => {
  it('returns null for a chat message', () => {
    expect(parseCommand('hello')).toBeNull();
    expect(parseCommand('what does /stop do?')).toBeNull();
    expect(parseCommand('')).toBeNull();
  });

  it('reads the five commands, case-insensitive, with extra spaces', () => {
    expect(parseCommand('/mission inbox-curator')).toEqual({ name: 'mission', arg: 'inbox-curator' });
    expect(parseCommand('  /MISSION    inbox-curator   ')).toEqual({ name: 'mission', arg: 'inbox-curator' });
    expect(parseCommand('/mission')).toEqual({ name: 'mission', arg: '' });
    expect(parseCommand('/stop')).toEqual({ name: 'stop', arg: '' });
    expect(parseCommand('/Pause ')).toEqual({ name: 'pause', arg: '' });
    expect(parseCommand('/resume')).toEqual({ name: 'resume', arg: '' });
    expect(parseCommand('/improve')).toEqual({ name: 'improve', arg: '' });
  });

  it('ignores a bot name after the command', () => {
    expect(parseCommand('/stop@ada_bot')).toEqual({ name: 'stop', arg: '' });
  });

  it('keeps the argument of a command that takes none, for the harness to judge', () => {
    expect(parseCommand('/stop now')).toEqual({ name: 'stop', arg: 'now' });
  });

  it('returns unknown for any other text that starts with a slash', () => {
    expect(parseCommand('/missions')).toEqual({ name: 'unknown', arg: '/missions' });
    expect(parseCommand('/help me')).toEqual({ name: 'unknown', arg: '/help me' });
    expect(parseCommand('/')).toEqual({ name: 'unknown', arg: '/' });
    expect(parseCommand(' /Users/ada/file.txt ')).toEqual({ name: 'unknown', arg: '/Users/ada/file.txt' });
  });
});
