import type { Paths } from '../paths.js';
import type { ToolDefinition } from '../types.js';
import { harnessTool } from './harness-tools.js';
import { missionRegistryTool, type MissionRegistryToolDeps } from './mission-registry.js';
import { shellTool, webFetchTool, webSearchTool } from './sdk-tools.js';

/**
 * What the tools that come with the harness need.
 * `catalog` and `triggers` are getters, because the tool catalog is built from the list that
 * `builtinTools` returns. They are read only when `list_catalog` runs, so during a run.
 */
export interface BuiltinToolDeps extends MissionRegistryToolDeps {
  paths: Paths;
}

/**
 * The tools that come with the harness (§A.5), except `tool:promotion_stage`, which belongs to §I.
 * The first one has no id: it is the always-on tool with the message and delete operations.
 */
export function builtinTools(deps: BuiltinToolDeps): ToolDefinition[] {
  return [
    harnessTool(deps.paths),
    webSearchTool(),
    webFetchTool(),
    shellTool(),
    missionRegistryTool({ config: deps.config, catalog: deps.catalog, triggers: deps.triggers }),
  ];
}
