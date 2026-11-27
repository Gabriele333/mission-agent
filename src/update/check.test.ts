import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkForRelease } from './check.js';
import type { CommandResult, CommandRunner } from './command.js';

let dir: string;
let calls: { program: string; args: string[]; cwd: string }[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mission-agent-check-'));
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  calls = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runner(answer: CommandResult): CommandRunner {
  return async (program, args, options) => {
    calls.push({ program, args, cwd: options.cwd });
    return answer;
  };
}

const tags = (...names: string[]) => ({ code: 0, stdout: names.map((n) => `${'a'.repeat(40)}\trefs/tags/${n}`).join('\n'), stderr: '' });

describe('the check for a newer release', () => {
  it('asks the repository of the program for its tags and nothing else', async () => {
    const r = await checkForRelease({ programDir: dir, run: runner(tags('v0.1.0', 'v0.3.0', 'v0.2.0')) });
    expect(r).toEqual({ ok: true, current: '0.2.0', latest: '0.3.0', newer: true });
    expect(calls).toEqual([{ program: 'git', args: ['ls-remote', '--tags', '--refs', 'origin'], cwd: dir }]);
  });

  it('finds nothing newer when the installed release is the newest, or when there is no release', async () => {
    expect(await checkForRelease({ programDir: dir, run: runner(tags('v0.1.0', 'v0.2.0')) })).toEqual({
      ok: true,
      current: '0.2.0',
      latest: '0.2.0',
      newer: false,
    });
    expect(await checkForRelease({ programDir: dir, run: runner(tags()) })).toMatchObject({ ok: true, newer: false });
  });

  it('says why it got no answer', async () => {
    const failed = await checkForRelease({ programDir: dir, run: runner({ code: 128, stdout: '', stderr: 'fatal: could not read Username' }) });
    expect(failed).toEqual({ ok: false, reason: 'git could not read the releases: fatal: could not read Username' });

    rmSync(join(dir, '.git'), { recursive: true });
    const noGit = await checkForRelease({ programDir: dir, run: runner(tags('v9.0.0')) });
    expect(noGit.ok).toBe(false);
    expect(calls).toHaveLength(1);

    writeFileSync(join(dir, 'package.json'), '{}');
    expect(await checkForRelease({ programDir: dir, run: runner(tags('v9.0.0')) })).toMatchObject({ ok: false });
  });
});

describe('the text of a failed command', () => {
  it('holds what the program wrote to either output, and the exit code when it wrote nothing', async () => {
    const { execCommand, failureText } = await import('./command.js');
    expect(failureText({ code: 2, stdout: 'src/a.ts(1,1): error TS1: wrong\n', stderr: '' })).toBe('src/a.ts(1,1): error TS1: wrong');
    expect(failureText({ code: 2, stdout: 'out', stderr: 'err\n' })).toBe('out\nerr');
    expect(failureText({ code: 7, stdout: '', stderr: '' })).toBe('exit code 7');
    expect(failureText({ code: 1, stdout: 'a\nb\nc', stderr: '' }, 2)).toBe('b\nc');

    const wrote = await execCommand(process.execPath, ['-e', 'console.log("to out"); process.exit(3)'], { cwd: dir });
    expect(wrote).toEqual({ code: 3, stdout: 'to out\n', stderr: '' });
    const missing = await execCommand(join(dir, 'no-such-program'), [], { cwd: dir });
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('ENOENT');
  });
});
