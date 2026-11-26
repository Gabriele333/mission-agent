export {
  BACKLOG_SIZE,
  createTerminalSurface,
  TERMINAL_SURFACE_ID,
  type TerminalSurface,
  type TerminalSurfaceOptions,
} from './surface.js';
export {
  ChatClientError,
  NOT_RUNNING_TEXT,
  parseLine,
  runChatClient,
  type ChatClientOptions,
  type ParsedLine,
} from './client.js';
export * from './events.js';
