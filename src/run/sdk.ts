import { query, type AccountInfo, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/** The part of the SDK's `Query` object that the run engine uses. Tests pass a fake. */
export interface RunQuery extends AsyncIterable<SDKMessage> {
  /** Works only when the prompt is given as a stream of messages. */
  interrupt(): Promise<unknown>;
  close(): void;
  accountInfo(): Promise<AccountInfo>;
}

export type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => RunQuery;

export const sdkQuery: QueryFn = query;

export function userMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}
