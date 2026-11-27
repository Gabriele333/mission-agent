import { execFile } from 'node:child_process';

/** Runs `git` and `npm` for the release check and the update. An argument array and no shell. */

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  program: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number },
) => Promise<CommandResult>;

/** The real runner. It never rejects: a failed command gives its exit code. */
export const execCommand: CommandRunner = (program, args, options) =>
  new Promise((resolvePromise) => {
    execFile(
      program,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: 64 * 1024 * 1024,
        // git must fail, not wait for a typed password, when it has no login for the repository.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 1;
        // A program that could not run at all wrote nothing, so the reason is the error's own text.
        const wroteNothing = String(stdout).trim() === '' && String(stderr).trim() === '';
        resolvePromise({ code, stdout: String(stdout), stderr: wroteNothing ? (err?.message ?? '') : String(stderr) });
      },
    );
  });

/**
 * The last lines of what a failed command wrote, for an error message. Some programs write
 * their errors to standard output, so both outputs are used.
 */
export function failureText(result: CommandResult, maxLines = 12): string {
  const written = [result.stdout.trim(), result.stderr.trim()].filter((t) => t !== '').join('\n');
  const lines = (written === '' ? `exit code ${result.code}` : written).split('\n');
  return lines.slice(-maxLines).join('\n');
}
