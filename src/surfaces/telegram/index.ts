/** The Telegram surface (§F.1). */
export {
  createTelegramSurface,
  isUserCallback,
  isUserMessage,
  ALLOWED_UPDATES,
  OFFSET_STATE_KEY,
  REASON_WAIT_MS,
  TELEGRAM_SURFACE_ID,
  type TelegramSurfaceOptions,
} from './surface.js';
export { checkBot, pairTelegramUser, type BotCheck, type PairOptions } from './setup.js';
export { TelegramError, StoppedError, FileTooLargeError, scrubToken, type FetchFn } from './api.js';
export { splitText, MESSAGE_LIMIT, CAPTION_LIMIT, TOPIC_NAME_LIMIT } from './text.js';
export { safeFileName, MAX_DOWNLOAD_BYTES, MAX_UPLOAD_BYTES } from './files.js';
