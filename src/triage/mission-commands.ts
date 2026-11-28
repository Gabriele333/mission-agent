import { isSystemMissionId, SYSTEM_MISSION_IDS } from '../manifest/ids.js';
import { CHAT_TRIGGER_ID } from '../triggers/chat.js';
import { SYS_GENERAL, type Manifest } from '../types.js';
import { COMMAND_NAMES, type CommandName } from './commands.js';

/**
 * The command of each mission (§B.1, §F.1). It is the mission's name with each `-` replaced by
 * `_`. The general mission's command is `/general`. The other system missions drop the `sys-`
 * prefix in the same way, so `sys-mission-admin` has `/mission_admin`.
 */

/** Telegram's limit for a command: 1 to 32 characters of lowercase letters, digits and underscores. */
export const COMMAND_MAX_CHARS = 32;
/** Telegram's limit for the description of a command in the menu. */
export const MENU_DESCRIPTION_MAX_CHARS = 256;
/** Telegram's limit for the number of commands in the menu. */
export const MENU_MAX_COMMANDS = 100;

const COMMAND_RE = /^[a-z0-9_]{1,32}$/;

/** The harness commands that the menu of Telegram lists. `/improve` does nothing yet, so the menu leaves it out. */
export const MENU_HARNESS_COMMANDS = ['mission', 'stop', 'pause', 'resume'] as const satisfies readonly CommandName[];

/** What each listed harness command does, for the menu of Telegram. */
export const HARNESS_COMMAND_HELP: Record<(typeof MENU_HARNESS_COMMANDS)[number], string> = {
  mission: 'Show the current mission, or switch to another one',
  stop: 'Stop the run of the current mission, or of the mission you name',
  pause: 'Pause the agent: no run starts until /resume',
  resume: 'End the pause',
};

/** The command word that a mission's name gives, before any check. */
export function rawCommand(m: Pick<Manifest, 'id' | 'name'>): string {
  if (m.id === SYS_GENERAL) return 'general';
  const name = isSystemMissionId(m.id) && m.name.startsWith('sys-') ? m.name.slice(4) : m.name;
  return name.replaceAll('-', '_');
}

/** The commands of the system missions. No other mission may use one of them. */
export const SYSTEM_COMMANDS: readonly string[] = SYSTEM_MISSION_IDS.map((id) => rawCommand({ id, name: id }));

/** Commands that no mission may have: the harness commands, `start`, and the commands of the system missions. */
export const RESERVED_COMMANDS: readonly string[] = [...COMMAND_NAMES, 'start', ...SYSTEM_COMMANDS];

/**
 * Why a name cannot have a command: too long, or the same command as the harness or a system
 * mission. Undefined when the name is fine. Used where a mission is created or renamed.
 */
export function commandProblem(name: string): string | undefined {
  const cmd = name.replaceAll('-', '_');
  if (cmd.length > COMMAND_MAX_CHARS) {
    return (
      `name "${name}" is too long for a chat command: /${cmd} would have ${cmd.length} characters, ` +
      `and Telegram allows ${COMMAND_MAX_CHARS}. Choose a name of at most ${COMMAND_MAX_CHARS} characters.`
    );
  }
  if (RESERVED_COMMANDS.includes(cmd)) {
    return `name "${name}" would give the chat command /${cmd}, which the harness already uses. Choose another name.`;
  }
  return undefined;
}

/**
 * The command of a mission, or undefined when it has none: a name whose command would be longer
 * than 32 characters, or would be a reserved command. Such a mission is still loaded and can be
 * reached with `/mission <name>`.
 */
export function commandOf(m: Pick<Manifest, 'id' | 'name'>): string | undefined {
  const cmd = rawCommand(m);
  if (!COMMAND_RE.test(cmd)) return undefined;
  if (isSystemMissionId(m.id)) return cmd;
  return RESERVED_COMMANDS.includes(cmd) ? undefined : cmd;
}

/** The mission whose command is `word`, among all missions, frozen ones included. */
export function missionOfCommand<M extends Pick<Manifest, 'id' | 'name'>>(word: string, manifests: M[]): M | undefined {
  const w = word.toLowerCase();
  return manifests.find((m) => commandOf(m) === w);
}

export interface MenuCommand {
  command: string;
  description: string;
}

/**
 * The list of commands for the menu of Telegram (§F.1): the harness commands, then one command
 * for each active mission that takes chat, the general mission first. `left` counts the commands
 * that did not fit in Telegram's limit of 100.
 */
export function menuCommands(manifests: Manifest[]): { commands: MenuCommand[]; left: number } {
  const all: MenuCommand[] = MENU_HARNESS_COMMANDS.map((c) => ({ command: c, description: HARNESS_COMMAND_HELP[c] }));
  const chat = manifests.filter((m) => m.status === 'active' && m.triggers.some((t) => t.use === CHAT_TRIGGER_ID));
  chat.sort((a, b) => Number(b.id === SYS_GENERAL) - Number(a.id === SYS_GENERAL));
  for (const m of chat) {
    const command = commandOf(m);
    if (command === undefined) continue;
    all.push({ command, description: menuDescription(m) });
  }
  return { commands: all.slice(0, MENU_MAX_COMMANDS), left: Math.max(0, all.length - MENU_MAX_COMMANDS) };
}

function menuDescription(m: Pick<Manifest, 'name' | 'description'>): string {
  const text = m.description.replace(/\s+/g, ' ').trim() || m.name;
  return text.length <= MENU_DESCRIPTION_MAX_CHARS ? text : `${text.slice(0, MENU_DESCRIPTION_MAX_CHARS - 1)}…`;
}
