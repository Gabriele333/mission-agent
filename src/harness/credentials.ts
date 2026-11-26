import { requiredCredentials, TELEGRAM_BOT_TOKEN } from '../secrets/index.js';
import type { AgentConfig, Manifest, ToolCatalog } from '../types.js';
import type { TriggerCatalog } from '../triggers/index.js';

/** The list of required credentials of §A.5 ("How the harness asks for a credential"). */

export interface CredentialSources {
  tools: Pick<ToolCatalog, 'get' | 'alwaysOn'>;
  triggers: Pick<TriggerCatalog, 'get'>;
}

/** True when the agent uses Telegram: the user's account is set, or Telegram is the default surface. */
export function telegramUsed(config: AgentConfig): boolean {
  return config.telegramUserId !== undefined || config.defaultSurface === 'telegram';
}

/** The credentials named by the tools and triggers of one mission, and by the tools every mission has. */
export function missionCredentialIds(manifest: Pick<Manifest, 'tools' | 'triggers'>, sources: CredentialSources): string[] {
  const ids: string[] = [];
  const add = (list: readonly string[] | undefined) => {
    for (const id of list ?? []) if (!ids.includes(id)) ids.push(id);
  };
  for (const tool of sources.tools.alwaysOn()) add(tool.credentials);
  for (const toolId of manifest.tools) add(sources.tools.get(toolId)?.credentials);
  for (const sub of manifest.triggers) add(sources.triggers.get(sub.use)?.credentials);
  return ids;
}

/**
 * The harness's own credentials, those of the tools and triggers that active missions use,
 * and those of the surfaces in use. Frozen missions do not count.
 */
export function requiredCredentialIds(config: AgentConfig, manifests: Manifest[], sources: CredentialSources): string[] {
  const declared: string[] = [];
  for (const m of manifests) {
    if (m.status !== 'active') continue;
    for (const id of missionCredentialIds(m, sources)) if (!declared.includes(id)) declared.push(id);
  }
  return requiredCredentials({ modelLogin: config.modelLogin, telegramUsed: telegramUsed(config), declared });
}

/** The one message per missing credential (§A.5). It names the id and the command, never a value. */
export function missingCredentialText(id: string, usedBy?: string): string {
  const who = usedBy === undefined ? '' : ` The mission ${usedBy} needs it.`;
  return `The credential ${id} has no value.${who} Enter it in a shell on this machine with: mission-agent secret set ${id}`;
}

/** The bot token is shown in the terminal only (§A.5), because Telegram cannot work without it. */
export function isTerminalOnlyCredential(id: string): boolean {
  return id === TELEGRAM_BOT_TOKEN;
}
