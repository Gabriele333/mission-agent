import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OperationDeclaration, ToolDefinition, TriggerSubscription } from '../types.js';
import { createCodeCatalog, createToolCatalog, ToolCatalogError } from './catalog.js';
import {
  DELETE_FILE_TOOL,
  FILE_DELETE_ACTION,
  HARNESS_SERVER,
  mcpToolName,
  MESSAGE_SEND_ACTION,
  MISSION_REGISTRY_TOOL_ID,
  SEND_MESSAGE_TOOL,
  SHELL_TOOL_ID,
  WEB_FETCH_TOOL_ID,
  WEB_SEARCH_TOOL_ID,
} from './ids.js';
import { makeHarness, type Harness } from './test-helpers.js';

function def(id: string | undefined, ops: [string, string, 'read' | 'change'][], reservedFor?: string[]): ToolDefinition {
  const operations: OperationDeclaration[] = ops.map(([sdkToolName, action, effect]) => ({ sdkToolName, action, effect }));
  return { id, operations, credentials: [], reservedFor, provide: () => ({}) };
}

function problemsOf(defs: ToolDefinition[]): string[] {
  try {
    createToolCatalog(defs);
  } catch (err) {
    if (err instanceof ToolCatalogError) return err.problems;
    throw err;
  }
  return [];
}

describe('createToolCatalog', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanUp());

  it('lists the ids of the built-in tools and leaves out the always-on tool', () => {
    expect(h.tools.toolIds()).toEqual([WEB_SEARCH_TOOL_ID, WEB_FETCH_TOOL_ID, SHELL_TOOL_ID, MISSION_REGISTRY_TOOL_ID]);
  });

  it('returns the always-on tool, the same object that findOperation returns', () => {
    const alwaysOn = h.tools.alwaysOn();
    expect(alwaysOn).toHaveLength(1);
    const found = h.tools.findOperation(mcpToolName(HARNESS_SERVER, SEND_MESSAGE_TOOL));
    expect(found?.tool).toBe(alwaysOn[0]);
    expect(found?.operation.action).toBe(MESSAGE_SEND_ACTION);
    expect(h.tools.findOperation(mcpToolName(HARNESS_SERVER, DELETE_FILE_TOOL))?.operation.action).toBe(FILE_DELETE_ACTION);
  });

  it('includes the actions of the always-on tool in actionIds, so gates can name them', () => {
    expect(h.tools.actionIds()).toEqual(expect.arrayContaining([MESSAGE_SEND_ACTION, FILE_DELETE_ACTION]));
  });

  it('finds operations by SDK name and returns undefined for an unknown name', () => {
    expect(h.tools.findOperation('WebSearch')?.tool.id).toBe(WEB_SEARCH_TOOL_ID);
    expect(h.tools.findOperation('Bash')?.tool.id).toBe(SHELL_TOOL_ID);
    expect(h.tools.findOperation('mcp__mission_registry__create_mission')?.operation).toEqual({
      sdkToolName: 'mcp__mission_registry__create_mission',
      action: 'action:registry.create',
      effect: 'change',
    });
    expect(h.tools.findOperation('Agent')).toBeUndefined();
    expect(h.tools.findOperation('mcp__gmail__send')).toBeUndefined();
  });

  it('gets a tool by id and returns its reservation', () => {
    expect(h.tools.get(MISSION_REGISTRY_TOOL_ID)?.id).toBe(MISSION_REGISTRY_TOOL_ID);
    expect(h.tools.get('tool:nothing')).toBeUndefined();
    expect(h.tools.toolReservedFor(MISSION_REGISTRY_TOOL_ID)).toEqual(['sys-mission-admin']);
    expect(h.tools.toolReservedFor(WEB_SEARCH_TOOL_ID)).toBeUndefined();
  });

  it('rejects two tools with the same id', () => {
    const problems = problemsOf([
      def('tool:gmail', [['mcp__gmail__send', 'action:email.send', 'change']]),
      def('tool:gmail', [['mcp__gmail2__send', 'action:email.send', 'change']]),
    ]);
    expect(problems).toEqual(['tool tool:gmail: the id is declared twice.']);
  });

  it('rejects two tools that declare the same SDK name', () => {
    const problems = problemsOf([
      def('tool:a', [['mcp__x__run', 'action:a.run', 'read']]),
      def('tool:b', [['mcp__x__run', 'action:b.run', 'read']]),
    ]);
    expect(problems).toEqual(['tool tool:b: sdkToolName "mcp__x__run" is already declared by tool tool:a.']);
  });

  it('rejects ids and action ids with a wrong format, and an effect that is not read or change', () => {
    const problems = problemsOf([
      def('gmail', [['mcp__gmail__send', 'action:email.send', 'change']]),
      def('tool:Gmail', [['mcp__g__send', 'action:email', 'change']]),
      def('tool:ok', [['mcp__ok__run', 'email.send', 'change']]),
      { ...def('tool:eff', []), operations: [{ sdkToolName: 'mcp__eff__x', action: 'action:eff.x', effect: 'write' as 'read' }] },
    ]);
    expect(problems).toEqual([
      'tool gmail: the id must look like "tool:gmail".',
      'tool tool:Gmail: the id must look like "tool:gmail".',
      'tool tool:Gmail: action "action:email" must look like "action:email.send".',
      'tool tool:ok: action "email.send" must look like "action:email.send".',
      'tool tool:eff: operation mcp__eff__x has effect "write", not read or change.',
    ]);
  });

  it('rejects a tool with an id and no operation', () => {
    expect(problemsOf([def('tool:empty', [])])).toEqual(['tool tool:empty: it declares no operation.']);
  });

  it('throws one error that lists every problem', () => {
    expect(() =>
      createToolCatalog([def('tool:empty', []), def('bad', [['X', 'action:x.y', 'read']])]),
    ).toThrow(/tool:empty: it declares no operation[\s\S]*tool bad: the id must look like/);
  });

  it('accepts two tools that declare the same action id', () => {
    const catalog = createToolCatalog([
      def('tool:gmail', [['mcp__gmail__send', 'action:email.send', 'change']]),
      def('tool:outlook', [['mcp__outlook__send', 'action:email.send', 'change']]),
    ]);
    expect(catalog.actionIds()).toEqual(['action:email.send']);
    expect(catalog.findOperation('mcp__outlook__send')?.tool.id).toBe('tool:outlook');
  });
});

describe('createCodeCatalog', () => {
  it('takes tools from the tool catalog and triggers from the triggers', () => {
    const tools = createToolCatalog([
      def('tool:gmail', [['mcp__gmail__send', 'action:email.send', 'change']]),
      def('tool:secret', [['mcp__secret__read', 'action:secret.read', 'read']], ['m_aaaaaaaaaaaa']),
      def(undefined, [['mcp__harness__send_message', 'action:message.send', 'read']]),
    ]);
    const seen: TriggerSubscription[] = [];
    const code = createCodeCatalog(tools, {
      ids: () => ['trigger:chat', 'trigger:cron'],
      validateParams: (sub) => {
        seen.push(sub);
        return sub.use === 'trigger:cron' && sub.at === undefined ? 'needs "at".' : null;
      },
    });
    expect(code.toolIds()).toEqual(['tool:gmail', 'tool:secret']);
    expect(code.actionIds()).toEqual(['action:email.send', 'action:secret.read', 'action:message.send']);
    expect(code.triggerIds()).toEqual(['trigger:chat', 'trigger:cron']);
    expect(code.toolReservedFor('tool:secret')).toEqual(['m_aaaaaaaaaaaa']);
    expect(code.toolReservedFor('tool:gmail')).toBeUndefined();
    expect(code.validateTriggerParams({ use: 'trigger:cron' })).toBe('needs "at".');
    expect(code.validateTriggerParams({ use: 'trigger:cron', at: '0 7 * * *' })).toBeNull();
    expect(seen).toHaveLength(2);
  });
});
