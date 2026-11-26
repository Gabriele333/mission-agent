import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGate } from '../safety/index.js';
import { SYS_GENERAL, SYS_MISSION_ADMIN, type Manifest, type ToolDefinition } from '../types.js';
import { harnessSdkTools } from './harness-tools.js';
import {
  HARNESS_SERVER,
  mcpToolName,
  MISSION_REGISTRY_SERVER,
  MISSION_REGISTRY_TOOL_ID,
  SHELL_ACTION,
  SHELL_TOOL_ID,
  WEB_FETCH_TOOL_ID,
  WEB_SEARCH_TOOL_ID,
} from './ids.js';
import { missionRegistrySdkTools } from './mission-registry.js';
import { makeHarness, type Harness } from './test-helpers.js';

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.cleanUp());

interface SdkServer {
  type: string;
  name: string;
  instance: { _registeredTools?: Record<string, unknown> };
}

/** The tool names that an SDK MCP server really registers. The field is private in the MCP SDK. */
function registeredNames(server: SdkServer): string[] {
  return Object.keys(server.instance._registeredTools ?? {});
}

/** Every SDK tool name a provision makes available: built-in tools, and `mcp__<key>__<tool>` for each server. */
function realNames(tool: ToolDefinition, missionId: string): string[] {
  const provision = tool.provide(h.ctx(missionId));
  const names = [...(provision.sdkTools ?? [])];
  for (const [key, value] of Object.entries(provision.mcpServers ?? {})) {
    const server = value as SdkServer;
    expect(server.type).toBe('sdk');
    expect(server.name).toBe(key);
    for (const t of registeredNames(server)) names.push(mcpToolName(key, t));
  }
  return names.sort();
}

describe('builtinTools', () => {
  it('declares every operation under the name the SDK reports for it', () => {
    for (const tool of h.tools.alwaysOn().concat(h.tools.toolIds().map((id) => h.tools.get(id) as ToolDefinition))) {
      const declared = tool.operations.map((o) => o.sdkToolName).sort();
      expect(realNames(tool, SYS_MISSION_ADMIN), tool.id ?? 'always on').toEqual(declared);
    }
  });

  it('builds the server tool lists from the same names as the declarations', () => {
    const ctx = h.ctx(SYS_MISSION_ADMIN);
    const harnessNames = Object.values(harnessSdkTools(ctx, h.paths)).map((t) => mcpToolName(HARNESS_SERVER, t.name));
    expect(harnessNames.sort()).toEqual(h.tools.alwaysOn()[0]?.operations.map((o) => o.sdkToolName).sort());
    const registryNames = Object.values(missionRegistrySdkTools(ctx, h.deps)).map((t) =>
      mcpToolName(MISSION_REGISTRY_SERVER, t.name),
    );
    expect(registryNames.sort()).toEqual(h.tools.get(MISSION_REGISTRY_TOOL_ID)?.operations.map((o) => o.sdkToolName).sort());
  });

  it('enables the SDK tools WebSearch, WebFetch and Bash', () => {
    const ctx = h.ctx(SYS_GENERAL);
    expect(h.tools.get(WEB_SEARCH_TOOL_ID)?.provide(ctx)).toEqual({ sdkTools: ['WebSearch'] });
    expect(h.tools.get(WEB_FETCH_TOOL_ID)?.provide(ctx)).toEqual({ sdkTools: ['WebFetch'] });
    expect(h.tools.get(SHELL_TOOL_ID)?.provide(ctx)).toEqual({ sdkTools: ['Bash'] });
  });

  it('gives the registry server to the mission admin only', () => {
    const tool = h.tools.get(MISSION_REGISTRY_TOOL_ID) as ToolDefinition;
    expect(tool.provide(h.ctx(SYS_GENERAL))).toEqual({});
    expect(Object.keys(tool.provide(h.ctx(SYS_MISSION_ADMIN)).mcpServers ?? {})).toEqual([MISSION_REGISTRY_SERVER]);
  });

  it('gives the always-on server to every mission', () => {
    const tool = h.tools.alwaysOn()[0] as ToolDefinition;
    expect(Object.keys(tool.provide(h.ctx(SYS_GENERAL)).mcpServers ?? {})).toEqual([HARNESS_SERVER]);
  });
});

describe('the gate with this catalog', () => {
  const call = (toolName: string, input: Record<string, unknown> = {}) => ({ toolName, input, toolUseId: 't' });

  it('allows the message and delete tools and the registry reads, and asks for each registry change', () => {
    const gate = createGate({ paths: h.paths, config: () => h.config, catalog: h.tools });
    const admin = h.registry.get(SYS_MISSION_ADMIN) as Manifest;
    expect(gate.check(call('mcp__harness__send_message', { text: 'x' }), admin)).toEqual({ decision: 'allow' });
    expect(gate.check(call('mcp__harness__delete_file', { path: 'data/x' }), admin)).toEqual({ decision: 'allow' });
    expect(gate.check(call('mcp__mission_registry__list_catalog'), admin)).toEqual({ decision: 'allow' });
    for (const [op, action] of [
      ['create_mission', 'action:registry.create'],
      ['edit_mission', 'action:registry.edit'],
      ['freeze_mission', 'action:registry.freeze'],
      ['delete_mission', 'action:registry.delete'],
    ]) {
      expect(gate.check(call(`mcp__mission_registry__${op}`), admin)).toEqual({ decision: 'ask', action });
    }
  });

  it('denies the registry to another mission, allows web search, and asks for every shell command', () => {
    const gate = createGate({ paths: h.paths, config: () => h.config, catalog: h.tools });
    const general = h.registry.get(SYS_GENERAL) as Manifest;
    expect(gate.check(call('mcp__mission_registry__delete_mission'), general).decision).toBe('deny');
    expect(gate.check(call('WebSearch', { query: 'x' }), general)).toEqual({ decision: 'allow' });
    const withShell = { ...general, tools: [...general.tools, SHELL_TOOL_ID] };
    expect(gate.check(call('Bash', { command: 'ls' }), withShell)).toEqual({ decision: 'ask', action: SHELL_ACTION, note: 'ls' });
  });
});
