import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

/**
 * The LaunchAgent property list of one agent root (§H "Keeping the harness running").
 * The plist is the one place where absolute paths are stored. It belongs to the machine and
 * is not part of the portable configuration (§A.1).
 */

export interface PlistInput {
  label: string;
  /** Absolute paths: the node program, then the built cli.js, then the arguments. */
  programArguments: string[];
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  /** The PATH the harness and its runs use. Nothing secret goes here. */
  envPath: string;
}

/** A label that holds a short hash of the root path, so two agents on one machine do not collide. */
export function serviceLabel(root: string): string {
  const hash = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 12);
  return `local.mission-agent.${hash}`;
}

/** The two log files of the service, in `state/logs/`. */
export function serviceLogPaths(root: string): { dir: string; stdout: string; stderr: string } {
  const dir = join(resolve(root), 'state', 'logs');
  return { dir, stdout: join(dir, 'harness.out.log'), stderr: join(dir, 'harness.err.log') };
}

/**
 * XML 1.0 allows tab, line feed, carriage return and the characters from U+0020 up, except
 * the surrogates and U+FFFE and U+FFFF. Any other character cannot be written, even escaped.
 */
const NOT_XML = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/u;

/** Escapes a value for an XML text node. Throws for a character that XML cannot hold. */
export function xmlEscape(value: string): string {
  if (NOT_XML.test(value)) throw new Error('A value of the service file holds a control character, which a plist cannot store.');
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const str = (value: string) => `<string>${xmlEscape(value)}</string>`;

/** The text of the plist. Every value is escaped. */
export function buildPlist(input: PlistInput): string {
  const args = input.programArguments.map((a) => `    ${str(a)}`).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${str(input.label)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    args,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  ${str(input.workingDirectory)}`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    `    ${str(input.envPath)}`,
    '  </dict>',
    // Starts the harness when the user logs in, and when the service is loaded.
    '  <key>RunAtLoad</key>',
    '  <true/>',
    // Starts it again when it exits with an error, such as a crash. A clean stop (exit code 0) stays stopped.
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>StandardOutPath</key>',
    `  ${str(input.stdoutPath)}`,
    '  <key>StandardErrorPath</key>',
    `  ${str(input.stderrPath)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}
