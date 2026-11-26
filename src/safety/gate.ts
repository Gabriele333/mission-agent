import { matchesGlob } from 'node:path';
import type { Paths } from '../paths.js';
import type {
  AgentConfig,
  Gate,
  GateDecision,
  GateKind,
  Manifest,
  ToolCall,
  ToolCatalog,
  ToolDefinition,
} from '../types.js';
import { checkMemoryContent, contentAfterEdit, memoryFileKind } from './memory-limits.js';
import { checkFilePath, errorText, missionAreas, type PathAccess } from './path-rules.js';

/** The SDK's file tools. The gate applies the path rules of §E.2.1 to these, never gates. */
export const FILE_TOOL_NAMES = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'] as const;
export type FileToolName = (typeof FILE_TOOL_NAMES)[number];

export const SKILL_TOOL_NAME = 'Skill';
export const SHELL_TOOL_NAME = 'Bash';
export const SHELL_TOOL_ID = 'tool:shell';
/** Used for a shell call when the catalog declares no action for `Bash`. */
export const SHELL_ACTION = 'action:shell.run';

/** SDK tools that the gate always denies, whatever the catalog declares (§C.5). */
export const DENIED_SDK_TOOLS = ['Task', 'Agent', 'PowerShell'] as const;

/** The four registry actions always wait for the user's approval (§4.2). */
export const REGISTRY_ACTIONS = [
  'action:registry.create',
  'action:registry.edit',
  'action:registry.freeze',
  'action:registry.delete',
] as const;

export interface GateOptions {
  paths: Paths;
  config: () => AgentConfig;
  catalog: ToolCatalog;
}

const FILE_TOOLS = new Set<string>(FILE_TOOL_NAMES);
const DENIED = new Set<string>(DENIED_SDK_TOOLS);
const REGISTRY = new Set<string>(REGISTRY_ACTIONS);
const STRICTNESS: Record<GateKind, number> = { 'gate:allow': 0, 'gate:require_approval': 1, 'gate:deny': 2 };

export function createGate(options: GateOptions): Gate {
  const { paths, config, catalog } = options;

  function check(call: ToolCall, manifest: Manifest): GateDecision {
    try {
      return decide(call, manifest);
    } catch (err) {
      // A failure of the check itself never lets the call run (§D.3).
      return deny(`The tool ${call.toolName} is refused: the safety check failed (${errorText(err)}).`);
    }
  }

  function decide(call: ToolCall, manifest: Manifest): GateDecision {
    if (!isSafeMissionId(manifest.id)) {
      return deny(`The tool call is refused: the mission id "${manifest.id}" is not valid.`);
    }
    if (manifest.status !== 'active') {
      return deny(`The tool call is refused: the mission is ${manifest.status}, so it cannot act.`);
    }
    const input = call.input ?? {};
    if (FILE_TOOLS.has(call.toolName)) return checkFileTool(call.toolName as FileToolName, input, manifest);
    if (call.toolName === SKILL_TOOL_NAME) return checkSkill(input, manifest);
    if (call.toolName === SHELL_TOOL_NAME) return checkShell(input, manifest);
    if (DENIED.has(call.toolName)) {
      return deny(`The tool ${call.toolName} is refused: it is not available to any mission.`);
    }
    return checkDeclared(call.toolName, manifest);
  }

  function checkFileTool(tool: FileToolName, input: Record<string, unknown>, manifest: Manifest): GateDecision {
    switch (tool) {
      case 'Read':
        return pathDecision(tool, input.file_path, 'read', manifest);
      case 'Glob': {
        const patternError = checkPattern('pattern', input.pattern);
        if (patternError) return deny(`${tool} is refused: ${patternError}`);
        return pathDecision(tool, input.path ?? '.', 'read', manifest);
      }
      case 'Grep':
        return checkGrep(input, manifest);
      case 'Write':
        return checkWrite(input, manifest);
      case 'Edit':
        return checkEdit(input, manifest);
      case 'NotebookEdit':
        return checkNotebookEdit(input, manifest);
    }
  }

  function pathDecision(tool: string, raw: unknown, access: PathAccess, manifest: Manifest): GateDecision {
    if (typeof raw !== 'string' || raw === '') return deny(`${tool} is refused: the call gives no path.`);
    const result = checkFilePath(paths, manifest.id, raw, access);
    return result.ok ? { decision: 'allow' } : deny(result.message);
  }

  function checkGrep(input: Record<string, unknown>, manifest: Manifest): GateDecision {
    if (input.glob !== undefined) {
      const globError = checkPattern('glob', input.glob);
      if (globError) return deny(`Grep is refused: ${globError}`);
    }
    const raw = input.path ?? '.';
    if (typeof raw !== 'string' || raw === '') return deny('Grep is refused: the path is not a text.');
    const result = checkFilePath(paths, manifest.id, raw, 'read');
    if (!result.ok) return deny(result.message);
    // A search of the mission's folder itself would also search manifest.yaml.
    let missionDir: string;
    try {
      missionDir = missionAreas(paths, manifest.id).mission;
    } catch (err) {
      return deny(`Grep is refused: the path could not be checked (${errorText(err)}).`);
    }
    if (result.realPath === missionDir && !globExcludesManifest(input.glob)) {
      return deny(
        'Grep is refused: a search of the whole mission folder would also search manifest.yaml, ' +
          'which a mission cannot read. Search a subfolder such as memory, data or skills, ' +
          'or give a glob that does not match manifest.yaml, such as "*.md".',
      );
    }
    return { decision: 'allow' };
  }

  function checkWrite(input: Record<string, unknown>, manifest: Manifest): GateDecision {
    const raw = input.file_path;
    if (typeof raw !== 'string' || raw === '') return deny('Write is refused: the call gives no path.');
    const result = checkFilePath(paths, manifest.id, raw, 'write');
    if (!result.ok) return deny(result.message);
    if (!result.inMemory) return { decision: 'allow' };
    if (typeof input.content !== 'string') return deny('Write is refused: the call gives no content.');
    return memoryDecision(input.content, result.realPath, raw, manifest);
  }

  function checkEdit(input: Record<string, unknown>, manifest: Manifest): GateDecision {
    const raw = input.file_path;
    if (typeof raw !== 'string' || raw === '') return deny('Edit is refused: the call gives no path.');
    const result = checkFilePath(paths, manifest.id, raw, 'write');
    if (!result.ok) return deny(result.message);
    if (!result.inMemory) return { decision: 'allow' };
    const { old_string: oldString, new_string: newString, replace_all: replaceAll } = input;
    if (typeof oldString !== 'string' || typeof newString !== 'string') {
      return deny('Edit is refused: the call must give old_string and new_string as text.');
    }
    const after = contentAfterEdit(result.realPath, oldString, newString, replaceAll === true);
    // The file could not be read, or the text is not in it: the tool itself fails or decides.
    if (after === undefined) return { decision: 'allow' };
    return memoryDecision(after, result.realPath, raw, manifest);
  }

  function checkNotebookEdit(input: Record<string, unknown>, manifest: Manifest): GateDecision {
    const raw = input.notebook_path;
    if (typeof raw !== 'string' || raw === '') return deny('NotebookEdit is refused: the call gives no path.');
    const result = checkFilePath(paths, manifest.id, raw, 'write');
    if (!result.ok) return deny(result.message);
    // The size of a notebook after the edit cannot be computed here, so the note limit could not hold.
    if (result.inMemory) {
      return deny(`NotebookEdit is refused for "${raw}": notebooks belong in the data folder, not in memory.`);
    }
    return { decision: 'allow' };
  }

  function memoryDecision(content: string, realPath: string, displayPath: string, manifest: Manifest): GateDecision {
    const memoryDir = missionAreas(paths, manifest.id).memory as string;
    const cfg = config();
    const message = checkMemoryContent(
      content,
      memoryFileKind(realPath, memoryDir),
      { maxNoteBytes: cfg.maxNoteBytes, maxIndexLineChars: cfg.maxIndexLineChars },
      displayPath,
    );
    return message === null ? { decision: 'allow' } : deny(message);
  }

  function checkSkill(input: Record<string, unknown>, manifest: Manifest): GateDecision {
    const raw = input.skill;
    if (typeof raw !== 'string' || raw === '') return deny('The skill call is refused: it names no skill.');
    const name = raw.startsWith('/') ? raw.slice(1) : raw;
    if (name.startsWith(`${manifest.id}:`) || name.startsWith('core:')) return { decision: 'allow' };
    return deny(
      `The skill "${raw}" is refused: only this mission's own skills and the core skills are available.`,
    );
  }

  function checkShell(input: Record<string, unknown>, manifest: Manifest): GateDecision {
    if (!manifest.tools.includes(SHELL_TOOL_ID)) {
      return deny('The shell command is refused: this mission does not have the shell tool.');
    }
    const command = input.command;
    if (typeof command !== 'string' || command.trim() === '') {
      return deny('The shell command is refused: the call gives no command.');
    }
    const declared = catalog.findOperation(SHELL_TOOL_NAME);
    return { decision: 'ask', action: declared?.operation.action ?? SHELL_ACTION, note: command };
  }

  function checkDeclared(toolName: string, manifest: Manifest): GateDecision {
    const found = catalog.findOperation(toolName);
    if (!found) {
      return deny(`The tool ${toolName} is refused: no declaration lists this operation.`);
    }
    const { tool, operation } = found;
    const alwaysOn = isAlwaysOn(tool);
    if (!alwaysOn) {
      const toolId = tool.id as string;
      if (!manifest.tools.includes(toolId)) {
        return deny(`The tool ${toolName} is refused: it belongs to ${toolId}, which this mission does not list.`);
      }
      const reserved = tool.reservedFor ?? catalog.toolReservedFor(toolId);
      if (reserved !== undefined && !reserved.includes(manifest.id)) {
        return deny(`The tool ${toolName} is refused: ${toolId} is reserved for other missions.`);
      }
    }

    const action = operation.action;
    const gate = strictestGate(manifest, action);

    if (gate?.kind === 'gate:deny') {
      return deny(`The action ${action} is refused: this mission's gates forbid it.`);
    }
    if (REGISTRY.has(action)) return ask(action, gate?.note);
    if (gate?.kind === 'gate:require_approval') return ask(action, gate.note);
    if (gate?.kind === 'gate:allow') return { decision: 'allow' };
    // The message tool and the delete tool need no approval (§A.5). The delete tool checks its own path.
    if (alwaysOn) return { decision: 'allow' };
    return operation.effect === 'read' ? { decision: 'allow' } : ask(action, undefined);
  }

  function isAlwaysOn(tool: ToolDefinition): boolean {
    return tool.id === undefined || catalog.alwaysOn().includes(tool);
  }

  return { check };
}

/** The most restrictive gate of the manifest for one action, with the first note of that kind. */
function strictestGate(manifest: Manifest, action: string): { kind: GateKind; note?: string } | undefined {
  let best: { kind: GateKind; note?: string } | undefined;
  for (const rule of manifest.gates) {
    if (rule.for !== action || !(rule.use in STRICTNESS)) continue;
    if (best === undefined || STRICTNESS[rule.use] > STRICTNESS[best.kind]) {
      best = { kind: rule.use, note: rule.note };
    } else if (rule.use === best.kind && best.note === undefined) {
      best.note = rule.note;
    }
  }
  return best;
}

/** Refuses a glob that is absolute, starts at the home folder, or climbs out with `..`. */
function checkPattern(field: string, raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return `the ${field} is not a text.`;
  if (/(^|[{,\s])[/\\~]/.test(raw) || /^[A-Za-z]:/.test(raw)) {
    return `the ${field} "${raw}" is an absolute path. Give a relative ${field} and set the path field instead.`;
  }
  if (/(^|[/\\{,\s])\.\.($|[/\\},\s])/.test(raw)) {
    return `the ${field} "${raw}" climbs out of the folder with "..".`;
  }
  return null;
}

/**
 * True when the glob filter surely leaves out `manifest.yaml`. The Grep tool may split the glob
 * on spaces and on commas outside braces. A part that starts with `!` only removes files, so at
 * least one other part must exist and none may match.
 */
function globExcludesManifest(glob: unknown): boolean {
  if (typeof glob !== 'string' || glob.trim() === '') return false;
  const parts = splitGlob(glob);
  const positive = parts.filter((p) => !p.startsWith('!'));
  if (positive.length === 0) return false;
  const candidates = [...positive, glob];
  return candidates.every((p) => !matchesGlob('manifest.yaml', p) && !matchesGlob('manifest.yaml', `**/${p}`));
}

function splitGlob(glob: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of glob) {
    if (ch === '{') depth += 1;
    if (ch === '}') depth = Math.max(0, depth - 1);
    if ((/\s/.test(ch) || (ch === ',' && depth === 0)) && current !== '') {
      parts.push(current);
      current = '';
    } else if (!/\s/.test(ch) && !(ch === ',' && depth === 0)) {
      current += ch;
    }
  }
  if (current !== '') parts.push(current);
  return parts;
}

function isSafeMissionId(id: string): boolean {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(id);
}

function deny(message: string): GateDecision {
  return { decision: 'deny', message };
}

function ask(action: string, note: string | undefined): GateDecision {
  return note === undefined ? { decision: 'ask', action } : { decision: 'ask', action, note };
}
