/** The five commands of the harness (§B.1). */
export const COMMAND_NAMES = ['mission', 'stop', 'pause', 'resume', 'improve'] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

export interface ParsedCommand {
  /** One of the five names, or `unknown` for any other text that starts with `/`. */
  name: CommandName | 'unknown';
  /** The text after the name, trimmed. For `unknown`, the whole text, trimmed. */
  arg: string;
  /**
   * For `unknown` only: the command word in lowercase, when the text has the form of a command
   * (`/` and letters, digits or underscores). It can be the command of a mission (§B.1).
   */
  word?: string;
  /** For `unknown` with a `word`: the text after the word, trimmed. */
  rest?: string;
}

/**
 * Reads a command (§B.1). Returns null for a text that does not start with `/`, which is a chat message.
 * Names are case-insensitive. A `@botname` right after the name, as Telegram can add, is ignored.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(trimmed);
  const name = match?.[1]?.toLowerCase();
  if (match === null || name === undefined) return { name: 'unknown', arg: trimmed };
  const rest = (match[2] ?? '').trim();
  if (!(COMMAND_NAMES as readonly string[]).includes(name)) return { name: 'unknown', arg: trimmed, word: name, rest };
  return { name: name as CommandName, arg: rest };
}
