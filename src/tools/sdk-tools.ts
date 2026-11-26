import type { ToolDefinition } from '../types.js';
import {
  SHELL_ACTION,
  SHELL_TOOL_ID,
  SHELL_TOOL_NAME,
  WEB_FETCH_ACTION,
  WEB_FETCH_SDK_TOOL,
  WEB_FETCH_TOOL_ID,
  WEB_SEARCH_ACTION,
  WEB_SEARCH_SDK_TOOL,
  WEB_SEARCH_TOOL_ID,
} from './ids.js';

/** A tool that only turns on one of the SDK's own tools. */
function sdkBuiltin(id: string, sdkToolName: string, action: string, effect: 'read' | 'change'): ToolDefinition {
  return {
    id,
    operations: [{ sdkToolName, action, effect }],
    credentials: [],
    provide: () => ({ sdkTools: [sdkToolName] }),
  };
}

export function webSearchTool(): ToolDefinition {
  return sdkBuiltin(WEB_SEARCH_TOOL_ID, WEB_SEARCH_SDK_TOOL, WEB_SEARCH_ACTION, 'read');
}

export function webFetchTool(): ToolDefinition {
  return sdkBuiltin(WEB_FETCH_TOOL_ID, WEB_FETCH_SDK_TOOL, WEB_FETCH_ACTION, 'read');
}

/** The gate makes every shell command wait for the user's approval, whatever the effect or the gates say (§C.5). */
export function shellTool(): ToolDefinition {
  return sdkBuiltin(SHELL_TOOL_ID, SHELL_TOOL_NAME, SHELL_ACTION, 'change');
}
