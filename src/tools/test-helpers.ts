import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, initRootFolder } from '../config/index.js';
import { createMissionRegistry, MISSION_ADMIN_MANIFEST, type WatchingMissionRegistry } from '../manifest/index.js';
import { pathsFor, type Paths } from '../paths.js';
import type {
  AgentConfig,
  CodeCatalog,
  MissionId,
  ToolCatalog,
  ToolContext,
  ToolHost,
  TriggerDefinition,
  TriggerSubscription,
} from '../types.js';
import { builtinTools, type BuiltinToolDeps } from './builtin.js';
import { createCodeCatalog, createToolCatalog } from './catalog.js';

/** Two triggers like the ones of §B.2, enough for the registry to validate manifests. */
export function fakeTriggers(): TriggerDefinition[] {
  const noParams = (params: Record<string, unknown>) => {
    const keys = Object.keys(params);
    return keys.length > 0 ? `takes no parameters, but has ${keys.join(', ')}.` : null;
  };
  return [
    { id: 'trigger:chat', credentials: [], validateParams: noParams, create: () => null },
    {
      id: 'trigger:cron',
      credentials: [],
      validateParams: (params) => {
        if (typeof params.at !== 'string') return 'needs "at", a cron expression such as "0 7 * * *".';
        const extra = Object.keys(params).filter((k) => k !== 'at');
        return extra.length > 0 ? `has unknown parameters: ${extra.join(', ')}.` : null;
      },
      create: () => null,
    },
  ];
}

export interface FakeHost extends ToolHost {
  sent: { missionId: MissionId; text: string; filePath?: string }[];
  changed: MissionId[];
  cleanedUp: MissionId[];
}

export function fakeHost(registry: ToolHost['registry']): FakeHost {
  const host: FakeHost = {
    sent: [],
    changed: [],
    cleanedUp: [],
    registry,
    sendMessage: async (missionId, text, filePath) => {
      host.sent.push(filePath === undefined ? { missionId, text } : { missionId, text, filePath });
    },
    cleanUpDeletedMission: async (id) => {
      host.cleanedUp.push(id);
    },
    missionChanged: async (id) => {
      host.changed.push(id);
    },
  };
  return host;
}

export interface Harness {
  root: string;
  paths: Paths;
  config: AgentConfig;
  triggers: TriggerDefinition[];
  tools: ToolCatalog;
  codeCatalog: CodeCatalog;
  registry: WatchingMissionRegistry;
  host: FakeHost;
  deps: BuiltinToolDeps;
  ctx(missionId: MissionId): ToolContext;
  cleanUp(): void;
}

/** A temporary root folder with the built-in tools, a real registry and a fake host, wired as the harness does it. */
export function makeHarness(): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mission-agent-tools-')));
  const paths = pathsFor(root);
  initRootFolder(paths);
  const config = defaultConfig('Ada');
  const triggers = fakeTriggers();

  let tools: ToolCatalog | undefined;
  const deps: BuiltinToolDeps = {
    paths,
    config: () => config,
    catalog: () => {
      if (tools === undefined) throw new Error('The tool catalog is not built yet.');
      return tools;
    },
    triggers: () => triggers,
  };
  tools = createToolCatalog(builtinTools(deps));
  const codeCatalog = createCodeCatalog(tools, {
    ids: () => triggers.map((t) => t.id),
    validateParams: (sub: TriggerSubscription) => {
      const { use, ...params } = sub;
      const t = triggers.find((d) => d.id === use);
      return t === undefined ? `unknown trigger ${use}.` : t.validateParams(params);
    },
  });
  const memory = new Map<string, string>();
  const registry = createMissionRegistry({
    paths,
    catalog: codeCatalog,
    config: () => config,
    codeManifests: [MISSION_ADMIN_MANIFEST],
    memory: { get: (k) => memory.get(k), set: (k, v) => void memory.set(k, v) },
  });
  registry.reload();
  const host = fakeHost(registry);
  return {
    root,
    paths,
    config,
    triggers,
    tools,
    codeCatalog,
    registry,
    host,
    deps,
    ctx: (missionId) => ({ missionId, root, credentials: {}, host }),
    cleanUp: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The text of a tool result. */
export function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
}
