import { REGISTRY_ACTIONS, SHELL_ACTION, SHELL_TOOL_ID, SHELL_TOOL_NAME } from '../safety/index.js';

/**
 * Ids and names of the tools that come with the harness (§A.5).
 * Every `sdkToolName` is built from the server name and the tool name here,
 * and the MCP servers are built from the same constants, so the two cannot differ.
 */

/** The name the SDK reports for a tool of an MCP server: `mcp__<server>__<tool>`. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

// ---------------------------------------------------------------- tool ids

export const WEB_SEARCH_TOOL_ID = 'tool:web_search';
export const WEB_FETCH_TOOL_ID = 'tool:web_fetch';
export { SHELL_TOOL_ID };
export const MISSION_REGISTRY_TOOL_ID = 'tool:mission_registry';

// ---------------------------------------------------------------- SDK built-in tools

export const WEB_SEARCH_SDK_TOOL = 'WebSearch';
export const WEB_FETCH_SDK_TOOL = 'WebFetch';
export { SHELL_TOOL_NAME };

// ---------------------------------------------------------------- MCP servers and their tools

/** The server of the two tools that every mission has. */
export const HARNESS_SERVER = 'harness';
export const SEND_MESSAGE_TOOL = 'send_message';
export const DELETE_FILE_TOOL = 'delete_file';

export const MISSION_REGISTRY_SERVER = 'mission_registry';
export const REGISTRY_TOOLS = {
  listMissions: 'list_missions',
  readMission: 'read_mission',
  listCatalog: 'list_catalog',
  createMission: 'create_mission',
  editMission: 'edit_mission',
  freezeMission: 'freeze_mission',
  deleteMission: 'delete_mission',
  listLibrary: 'list_library',
  readLibraryMission: 'read_library_mission',
  addLibraryMission: 'add_library_mission',
} as const;

// ---------------------------------------------------------------- action ids

export const MESSAGE_SEND_ACTION = 'action:message.send';
export const FILE_DELETE_ACTION = 'action:file.delete';
export const WEB_SEARCH_ACTION = 'action:web.search';
export const WEB_FETCH_ACTION = 'action:web.fetch';
export { SHELL_ACTION };

const [REGISTRY_CREATE, REGISTRY_EDIT, REGISTRY_FREEZE, REGISTRY_DELETE] = REGISTRY_ACTIONS;

export const REGISTRY_ACTION_IDS = {
  list: 'action:registry.list',
  read: 'action:registry.read',
  catalog: 'action:catalog.list',
  libraryList: 'action:library.list',
  libraryRead: 'action:library.read',
  create: REGISTRY_CREATE,
  edit: REGISTRY_EDIT,
  freeze: REGISTRY_FREEZE,
  delete: REGISTRY_DELETE,
} as const;
