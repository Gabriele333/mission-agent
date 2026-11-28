/**
 * The parts of the Bot API objects that the surface reads. Field names follow
 * https://core.telegram.org/bots/api (Update, Message, CallbackQuery, File).
 */

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel' | string;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgDocument {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TgUser;
  /** Unix time in seconds. 0 for a message the bot can no longer reach (InaccessibleMessage). */
  date: number;
  chat: TgChat;
  is_topic_message?: boolean;
  reply_to_message?: TgMessage;
  text?: string;
  caption?: string;
  document?: TgDocument;
  photo?: TgPhotoSize[];
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  /** Absent when the bot's `callback_query_mode` puts `inline_message_id` in its place. */
  message?: TgMessage;
  inline_message_id?: string;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface TgFile {
  file_id: string;
  file_size?: number;
  file_path?: string;
}

/** The fields of `getMe` (BotFullInfo) that the setup page needs. */
export interface TgBotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}
