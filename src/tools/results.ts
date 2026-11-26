import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

/** What the handler of an SDK MCP tool returns. */
export type ToolResult = Awaited<ReturnType<SdkMcpToolDefinition['handler']>>;

export function okResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/** A failure that the model sees, so it can correct the call. */
export function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
