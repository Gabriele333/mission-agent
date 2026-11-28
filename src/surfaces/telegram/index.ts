/** The Telegram surface (§F.1). */
export {
  createTelegramSurface,
  isUserCallback,
  isUserMessage,
  ALLOWED_UPDATES,
  OFFSET_STATE_KEY,
  ONE_CHAT_NOTICE,
  ONE_CHAT_NOTICE_STATE_KEY,
  REASON_WAIT_MS,
  REPLY_THREAD_STATE_KEY,
  SENT_MESSAGES_KEPT,
  TELEGRAM_SURFACE_ID,
  TYPING_REPEAT_MS,
  WORKING_SIGN_MAX_MS,
  type TelegramSurfaceOptions,
} from './surface.js';
export { checkBot, pairTelegramUser, type BotCheck, type PairOptions } from './setup.js';
export { TelegramError, StoppedError, FileTooLargeError, scrubToken, TELEGRAM_API_VARIABLE, testTelegramApiUrl, type FetchFn } from './api.js';
export { splitText, MESSAGE_LIMIT, CAPTION_LIMIT } from './text.js';
export { safeFileName, MAX_DOWNLOAD_BYTES, MAX_UPLOAD_BYTES } from './files.js';
