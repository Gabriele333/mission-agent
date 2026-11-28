import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { describeApproval } from '../../safety/index.js';
import { TELEGRAM_BOT_TOKEN } from '../../secrets/index.js';
import type { MenuCommand } from '../../triage/index.js';
import type {
  ApprovalAnswer,
  ApprovalRequest,
  IncomingMessage,
  MissionId,
  OutgoingMessage,
  Surface,
  SurfaceHost,
  WorkingSign,
} from '../../types.js';
import {
  backoffMs,
  createTelegramApi,
  FileTooLargeError,
  sleep,
  StoppedError,
  TelegramError,
  type FetchFn,
  type TelegramApi,
  type Timers,
} from './api.js';
import { checkOutgoingFile, MAX_DOWNLOAD_BYTES, safeFileName, writeUniqueFile } from './files.js';
import { appendWithin, CALLBACK_TEXT_LIMIT, CAPTION_LIMIT, MESSAGE_LIMIT, splitText, truncate } from './text.js';
import type { TgCallbackQuery, TgFile, TgMessage, TgUpdate, TgUser } from './tg-types.js';

export const TELEGRAM_SURFACE_ID = 'surface:telegram';

/** The state key that holds the polling offset: `{"offset": <number>, "savedAt": <ms since 1970>}`. */
export const OFFSET_STATE_KEY = 'telegram.update_offset';

/**
 * The state key that holds the thread of the user's last message: its number, or `none` when that
 * message had no thread. The surface writes there (§F.1). Absent before the first message.
 */
export const REPLY_THREAD_STATE_KEY = 'telegram.reply_thread';
const NO_THREAD = 'none';

/** The state key that is set once the notice about the one chat was sent (§F.1). */
export const ONE_CHAT_NOTICE_STATE_KEY = 'telegram.one_chat_notice_sent';

/** The notice for an install that used one thread per mission before. It is sent once. */
export const ONE_CHAT_NOTICE =
  'Telegram is now one chat with the agent. The old threads keep their messages, but the agent no longer uses them. ' +
  'The agent answers in the thread you last wrote in. You can turn off Threaded Mode in BotFather: open its app, ' +
  'choose the bot, and open Bot Settings. To write to one mission, send its command, such as /general. ' +
  'The menu of the chat lists the commands.';

/** Telegram shows "typing" for 5 seconds, so the surface sends it again after this time. */
export const TYPING_REPEAT_MS = 4000;
/** The sign that the agent works never lasts longer than this. */
export const WORKING_SIGN_MAX_MS = 5 * 60_000;
/** How many sent messages the surface remembers, to route a reply to the mission that sent it. */
export const SENT_MESSAGES_KEPT = 300;

/** How long the surface waits for a reason after the reject button (§G). */
export const REASON_WAIT_MS = 5 * 60_000;

/** The update types the surface handles. `getUpdates` asks for these only. */
export const ALLOWED_UPDATES = ['message', 'callback_query'] as const;

/**
 * Telegram keeps an update for 24 hours at most. An offset saved longer ago than that cannot
 * protect against a repeat, and update ids can restart at a random number after a week without
 * updates, so an old offset is not sent.
 */
const OFFSET_MAX_AGE_MS = 24 * 3_600_000;

/** Approval texts are cut shorter than a message, so the outcome can be added to the last part. */
const APPROVAL_PART_LIMIT = 3500;
/** The size of `callback_data` is 1-64 bytes. */
const CALLBACK_DATA_MAX_BYTES = 64;

const NOT_WAITING = 'This request is no longer waiting for an answer.';
const TOO_LARGE = 'The file is larger than 20 MB, the most a bot can download. It was not saved and the message was not passed on.';
const REASON_PROMPT =
  '\n\nRejected. Reply to this message to give the reason, or press "No reason". ' +
  'Without either, the request is rejected with no reason in 5 minutes.';
const UNSUPPORTED =
  'This message was not passed on. The agent takes text, documents and photos.';

/** Message content that the surface does not pass on. The user is told so. */
const UNSUPPORTED_KINDS = ['voice', 'audio', 'video', 'video_note', 'sticker', 'animation', 'location', 'venue', 'contact', 'poll', 'dice'];

export interface TelegramSurfaceOptions {
  /** The bot token, read from memory (§A.5). Called for every request. */
  token: () => string;
  /** The numeric id of the user's Telegram account, from the agent configuration. */
  userId: () => number | undefined;
  /** The `data/` folder of a mission, where a file from the user is saved. */
  dataDir: (missionId: MissionId) => string;
  /** The name of a mission, for the text of an approval request. */
  missionName: (missionId: MissionId) => string | undefined;
  /** The id of the general mission (`sys-general`). */
  generalMissionId: MissionId;
  /**
   * The list of commands for the menu of the user's chat (§F.1). The surface publishes it at the
   * start and on `missionsChanged`. Without it, the surface publishes nothing.
   */
  commands?: () => MenuCommand[];
  /** Errors that the surface cannot return to a caller. The message never contains the token. */
  onError: (error: Error) => void;
  fetchFn?: FetchFn;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Milliseconds since 1970. Default `Date.now`. */
  now?: () => number;
  /** Seconds that one `getUpdates` call waits for an update. Default 30. */
  pollTimeoutSeconds?: number;
  /** Default `https://api.telegram.org`. */
  apiBaseUrl?: string;
}

interface ShownApproval {
  id: string;
  missionId: MissionId;
  messageId: number;
  /** The text of the message that carries the buttons. */
  text: string;
  state: 'buttons' | 'reason';
  timer?: unknown;
  /** Short keys used in `callback_data` when the id is too long for it. */
  keys: string[];
}

type ButtonKind = 'a' | 'r' | 'n';

export function createTelegramSurface(options: TelegramSurfaceOptions): Surface {
  const timers: Timers = {
    setTimer: options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimer: options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
  };
  const now = options.now ?? Date.now;
  const pollSeconds = options.pollTimeoutSeconds ?? 30;
  const general = options.generalMissionId;
  const apiOptions: Parameters<typeof createTelegramApi>[0] = { token: options.token, timers };
  if (options.fetchFn) apiOptions.fetchFn = options.fetchFn;
  if (options.apiBaseUrl) apiOptions.baseUrl = options.apiBaseUrl;
  const api: TelegramApi = createTelegramApi(apiOptions);

  let host: SurfaceHost | undefined;
  let controller: AbortController | undefined;
  let loop: Promise<void> | undefined;
  /** Every write to Telegram runs in this chain, so the parts of a message stay in order. */
  let chain: Promise<unknown> = Promise.resolve();
  const approvals = new Map<string, ShownApproval>();
  const approvalOfMessage = new Map<number, string>();
  const approvalOfKey = new Map<string, string>();
  /** The mission of each message the surface sent, newest last, for a reply (§B.1). */
  const missionOfSent = new Map<number, MissionId>();
  /** The signs that the agent works. While one is open, "typing" is sent every 4 seconds. */
  const signs = new Set<{ cap: unknown }>();
  let typingTimer: unknown;

  const report = (err: unknown) => {
    if (err instanceof StoppedError) return;
    options.onError(err instanceof Error ? err : new Error(String(err)));
  };

  function requireHost(): SurfaceHost {
    if (!host) throw new Error('The Telegram surface is not started.');
    return host;
  }

  function requireUser(): number {
    const id = options.userId();
    if (id === undefined) throw new Error("The user's Telegram account is not set. Pair it on the setup page.");
    return id;
  }

  function signal(): AbortSignal {
    if (!controller || controller.signal.aborted) throw new StoppedError();
    return controller.signal;
  }

  function call<T>(method: string, params: Record<string, unknown> | FormData, attempts = 5): Promise<T> {
    return api.call<T>(method, params, { signal: signal(), attempts });
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  }

  // ------------------------------------------------------------ where the agent writes (§F.1)

  /**
   * The thread of the user's last message, or undefined for none. Before the first message, it is
   * the general mission's thread of the old layout when one is stored, else none.
   */
  function replyThread(): number | undefined {
    const h = requireHost();
    const raw = h.store.getState(REPLY_THREAD_STATE_KEY);
    if (raw === undefined) return h.store.getThread(general);
    if (raw === NO_THREAD) return undefined;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  }

  function rememberThread(threadId: number | undefined): void {
    requireHost().store.setState(REPLY_THREAD_STATE_KEY, threadId === undefined ? NO_THREAD : String(threadId));
  }

  /**
   * Runs `post` in the thread where the user last wrote. When Telegram refuses the call (answer
   * 400), the surface runs `post` once more with no thread. Telegram's documentation does not list
   * the answers for a thread that is gone or for topic mode that was turned off, so every refusal
   * is tried again. The thread is forgotten only when the second call works. When it fails too,
   * the thread was not the cause, and the first error is thrown.
   */
  async function inReplyThread<T>(post: (threadId: number | undefined) => Promise<T>): Promise<T> {
    const threadId = replyThread();
    try {
      return await post(threadId);
    } catch (err) {
      if (threadId === undefined || !isRefused(err)) throw err;
      let result: T;
      try {
        result = await post(undefined);
      } catch {
        throw err;
      }
      rememberThread(undefined);
      return result;
    }
  }

  /** The first line of a message: the mission's name, for every mission except the general mission. */
  function labelLine(msg: OutgoingMessage): string | undefined {
    if (msg.missionId === null || msg.missionId === general) return undefined;
    return options.missionName(msg.missionId) ?? nameFromLabel(msg.label) ?? msg.missionId;
  }

  function rememberSent(messageId: number, missionId: MissionId): void {
    missionOfSent.delete(messageId);
    missionOfSent.set(messageId, missionId);
    while (missionOfSent.size > SENT_MESSAGES_KEPT) {
      const oldest = missionOfSent.keys().next().value;
      if (oldest === undefined) break;
      missionOfSent.delete(oldest);
    }
  }

  // ------------------------------------------------------------ sending

  async function postText(text: string, extra: Record<string, unknown> = {}): Promise<TgMessage> {
    return inReplyThread((threadId) => {
      const params: Record<string, unknown> = { chat_id: requireUser(), text, ...extra };
      if (threadId !== undefined) params.message_thread_id = threadId;
      return call<TgMessage>('sendMessage', params);
    });
  }

  async function postParts(text: string, sent: number[]): Promise<void> {
    for (const part of splitText(text, MESSAGE_LIMIT)) {
      // Telegram refuses an empty text, and a part that is only white space counts as empty.
      if (part.trim() === '') continue;
      sent.push((await postText(part)).message_id);
    }
  }

  async function postDocument(realPath: string, caption: string): Promise<number> {
    const data = await readFile(realPath);
    const message = await inReplyThread((threadId) => {
      const form = new FormData();
      form.append('chat_id', String(requireUser()));
      if (threadId !== undefined) form.append('message_thread_id', String(threadId));
      if (caption !== '') form.append('caption', caption);
      form.append('document', new Blob([data]), basename(realPath));
      return call<TgMessage>('sendDocument', form);
    });
    return message.message_id;
  }

  async function send(msg: OutgoingMessage): Promise<void> {
    requireHost();
    requireUser();
    const missionId = msg.missionId ?? general;
    const hasText = msg.text.trim() !== '';
    if (!hasText && msg.filePath === undefined) return;
    // The file is checked before anything is sent, so a refused file sends nothing.
    const realPath = msg.filePath === undefined ? undefined : await checkOutgoingFile(msg.filePath, options.dataDir(missionId));
    const name = labelLine(msg);
    const body = hasText ? msg.text : '';
    const text = name === undefined ? body : body === '' ? name : `${name}\n${body}`;
    await enqueue(async () => {
      const sent: number[] = [];
      if (realPath === undefined) {
        await postParts(text, sent);
      } else if (text.length <= CAPTION_LIMIT) {
        sent.push(await postDocument(realPath, text));
      } else {
        await postParts(text, sent);
        sent.push(await postDocument(realPath, ''));
      }
      if (msg.missionId !== null) for (const id of sent) rememberSent(id, msg.missionId);
    });
  }

  /** A short note from the surface. Errors are reported, not thrown. */
  async function note(text: string): Promise<void> {
    try {
      await enqueue(() => postText(text));
    } catch (err) {
      report(err);
    }
  }

  /** Publishes the list of commands for the user's chat only. A failure is reported and changes nothing else. */
  async function publishCommands(): Promise<void> {
    if (options.commands === undefined || controller === undefined || controller.signal.aborted) return;
    try {
      const chatId = requireUser();
      await call('setMyCommands', { commands: options.commands(), scope: { type: 'chat', chat_id: chatId } }, 3);
    } catch (err) {
      report(err);
    }
  }

  /** Sends the notice about the one chat once, to an install that has threads of the old layout. */
  async function sendOneChatNotice(): Promise<void> {
    try {
      const h = requireHost();
      if (h.store.getState(ONE_CHAT_NOTICE_STATE_KEY) !== undefined || h.store.countThreads() === 0) return;
      await enqueue(() => postText(ONE_CHAT_NOTICE));
      h.store.setState(ONE_CHAT_NOTICE_STATE_KEY, new Date(now()).toISOString());
    } catch (err) {
      report(err);
    }
  }

  // ------------------------------------------------------------ the sign that the agent works

  function sendTyping(): void {
    if (controller === undefined || controller.signal.aborted || options.userId() === undefined) return;
    // Errors of this call are ignored: the sign is not worth a message to the user. A refusal
    // here is not tried again and never changes the thread that the messages use.
    const params: Record<string, unknown> = { chat_id: requireUser(), action: 'typing' };
    const threadId = replyThread();
    if (threadId !== undefined) params.message_thread_id = threadId;
    call('sendChatAction', params, 1).catch(() => undefined);
  }

  function stopTyping(): void {
    if (typingTimer !== undefined) timers.clearTimer(typingTimer);
    typingTimer = undefined;
  }

  function scheduleTyping(): void {
    stopTyping();
    typingTimer = timers.setTimer(() => {
      typingTimer = undefined;
      if (signs.size === 0) return;
      sendTyping();
      scheduleTyping();
    }, TYPING_REPEAT_MS);
  }

  function showWorking(): WorkingSign {
    if (controller === undefined || controller.signal.aborted) return { stop() {} };
    const sign: { cap: unknown } = { cap: undefined };
    const stop = () => {
      if (!signs.delete(sign)) return;
      timers.clearTimer(sign.cap);
      if (signs.size === 0) stopTyping();
    };
    sign.cap = timers.setTimer(stop, WORKING_SIGN_MAX_MS);
    signs.add(sign);
    sendTyping();
    scheduleTyping();
    return { stop };
  }

  // ------------------------------------------------------------ approvals

  function callbackData(kind: ButtonKind, entry: ShownApproval): string {
    const direct = `${kind}:${entry.id}`;
    if (Buffer.byteLength(direct) <= CALLBACK_DATA_MAX_BYTES) return direct;
    const key = `~${randomBytes(9).toString('base64url')}`;
    approvalOfKey.set(key, entry.id);
    entry.keys.push(key);
    return `${kind}:${key}`;
  }

  function parseCallbackData(data: string | undefined): { kind: ButtonKind; id: string } | undefined {
    if (data === undefined) return undefined;
    const at = data.indexOf(':');
    const kind = data.slice(0, at);
    if (at < 1 || (kind !== 'a' && kind !== 'r' && kind !== 'n')) return undefined;
    const rest = data.slice(at + 1);
    const id = rest.startsWith('~') ? approvalOfKey.get(rest) : rest;
    if (id === undefined || id === '') return undefined;
    return { kind, id };
  }

  function keyboard(rows: { text: string; data: string }[][]): Record<string, unknown> {
    return { inline_keyboard: rows.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) };
  }

  const NO_BUTTONS = { inline_keyboard: [] };

  function forget(entry: ShownApproval): void {
    if (entry.timer !== undefined) timers.clearTimer(entry.timer);
    approvals.delete(entry.id);
    approvalOfMessage.delete(entry.messageId);
    for (const key of entry.keys) approvalOfKey.delete(key);
  }

  /** The parts of a request's text. The last one goes on the message with the buttons. */
  function approvalParts(req: ApprovalRequest): { parts: string[]; last: string } {
    const body = describeApproval(req, options.missionName(req.missionId) ?? req.missionId);
    const parts = splitText(body, APPROVAL_PART_LIMIT).filter((p) => p.trim() !== '');
    const last = parts.pop() ?? req.action;
    return { parts, last };
  }

  async function showApproval(req: ApprovalRequest, _label: string): Promise<void> {
    requireHost();
    requireUser();
    const { parts, last } = approvalParts(req);
    await enqueue(async () => {
      // A request is a message of its mission, so a reply to it goes to the mission, unless it is the reason (§G).
      for (const part of parts) rememberSent((await postText(part)).message_id, req.missionId);
      const entry: ShownApproval = { id: req.id, missionId: req.missionId, messageId: 0, text: last, state: 'buttons', keys: [] };
      const markup = keyboard([
        [
          { text: 'Approve', data: callbackData('a', entry) },
          { text: 'Reject', data: callbackData('r', entry) },
        ],
      ]);
      const sent = await postText(last, { reply_markup: markup });
      rememberSent(sent.message_id, req.missionId);
      entry.messageId = sent.message_id;
      approvals.set(entry.id, entry);
      approvalOfMessage.set(entry.messageId, entry.id);
    });
  }

  async function editApproval(entry: ShownApproval, text: string, markup: Record<string, unknown>): Promise<void> {
    try {
      await call('editMessageText', { chat_id: requireUser(), message_id: entry.messageId, text, reply_markup: markup });
    } catch (err) {
      if (!isNotModified(err)) report(err);
    }
  }

  async function closeApproval(id: string, outcome: string): Promise<void> {
    const entry = approvals.get(id);
    if (!entry) return;
    forget(entry);
    await editApproval(entry, appendWithin(entry.text, `\n\nOutcome: ${outcome}`), NO_BUTTONS);
  }

  /** Removes the buttons of a message whose request is not known or no longer waits. */
  async function dropButtons(query: TgCallbackQuery): Promise<void> {
    const message = query.message;
    if (!message || message.date === 0) return;
    try {
      await call('editMessageReplyMarkup', { chat_id: message.chat.id, message_id: message.message_id, reply_markup: NO_BUTTONS });
    } catch (err) {
      if (!isNotModified(err)) report(err);
    }
  }

  function answerApproval(id: string, answer: ApprovalAnswer): boolean {
    return requireHost().answerApproval(id, answer);
  }

  function rejectAfterWait(entry: ShownApproval): void {
    entry.timer = timers.setTimer(() => {
      entry.timer = undefined;
      if (approvals.get(entry.id) !== entry) return;
      if (!answerApproval(entry.id, { kind: 'rejected' })) {
        forget(entry);
        void editApproval(entry, entry.text, NO_BUTTONS);
      }
    }, REASON_WAIT_MS);
  }

  async function answerQuery(query: TgCallbackQuery, text: string): Promise<void> {
    const params: Record<string, unknown> = { callback_query_id: query.id };
    if (text !== '') params.text = truncate(text, CALLBACK_TEXT_LIMIT);
    try {
      await call('answerCallbackQuery', params, 3);
    } catch (err) {
      report(err);
    }
  }

  /**
   * The entry for a press on a request that this surface object did not show, because the surface
   * was stopped and started again (a new bot token, or pairing on the setup page) while the
   * request waited. The request must still wait in the store, and the press must come from a
   * message that Telegram still lets the bot edit. Undefined otherwise.
   */
  function adopt(query: TgCallbackQuery, id: string): ShownApproval | undefined {
    const message = query.message;
    if (!message || message.date === 0) return undefined;
    let req: ApprovalRequest | undefined;
    try {
      req = requireHost().store.listApprovals().find((r) => r.id === id);
    } catch (err) {
      report(err);
      return undefined;
    }
    if (req === undefined) return undefined;
    const text = typeof message.text === 'string' && message.text !== '' ? message.text : approvalParts(req).last;
    const entry: ShownApproval = { id, missionId: req.missionId, messageId: message.message_id, text, state: 'buttons', keys: [] };
    approvals.set(id, entry);
    approvalOfMessage.set(entry.messageId, id);
    return entry;
  }

  async function handleCallback(query: TgCallbackQuery): Promise<void> {
    if (!isUserCallback(query, options.userId())) return;
    const parsed = parseCallbackData(query.data);
    const entry = parsed ? (approvals.get(parsed.id) ?? adopt(query, parsed.id)) : undefined;
    // A press without a message (callback_query_mode "inline") is accepted only for a request shown here.
    if (!query.message && !entry) {
      await answerQuery(query, NOT_WAITING);
      return;
    }
    if (!parsed) {
      await answerQuery(query, '');
      return;
    }
    switch (parsed.kind) {
      case 'a': {
        const ok = answerApproval(parsed.id, { kind: 'approved' });
        await answerQuery(query, ok ? 'Approved.' : NOT_WAITING);
        if (!ok) {
          if (entry) forget(entry);
          await dropButtons(query);
        }
        return;
      }
      case 'r': {
        if (!entry) {
          await answerQuery(query, NOT_WAITING);
          await dropButtons(query);
          return;
        }
        if (entry.state === 'buttons') {
          entry.state = 'reason';
          rejectAfterWait(entry);
        }
        await answerQuery(query, 'Reply to the request with a reason, or press "No reason".');
        // A second press means the earlier edit did not show, so it is tried again.
        const markup = keyboard([[{ text: 'No reason', data: callbackData('n', entry) }]]);
        await editApproval(entry, appendWithin(entry.text, REASON_PROMPT), markup);
        return;
      }
      case 'n': {
        if (entry?.timer !== undefined) {
          timers.clearTimer(entry.timer);
          entry.timer = undefined;
        }
        const ok = answerApproval(parsed.id, { kind: 'rejected' });
        await answerQuery(query, ok ? 'Rejected.' : NOT_WAITING);
        if (!ok) {
          if (entry) forget(entry);
          await dropButtons(query);
        }
        return;
      }
    }
  }

  /** A reply to a request that waits for a reason. It is the reason, never a chat message (§G). */
  async function takeReason(entry: ShownApproval, text: string): Promise<void> {
    if (entry.timer !== undefined) {
      timers.clearTimer(entry.timer);
      entry.timer = undefined;
    }
    const reason = text.trim();
    const answer: ApprovalAnswer = reason === '' ? { kind: 'rejected' } : { kind: 'rejected', reason };
    if (!answerApproval(entry.id, answer)) {
      forget(entry);
      await note('That request is no longer waiting for an answer, so the reason was not used.');
    }
  }

  // ------------------------------------------------------------ incoming messages

  async function saveFile(message: TgMessage, missionId: MissionId): Promise<string | { refused: string }> {
    let fileId: string;
    let size: number | undefined;
    let name: string | undefined;
    if (message.document) {
      fileId = message.document.file_id;
      size = message.document.file_size;
      name = message.document.file_name;
    } else {
      const photo = largestPhoto(message.photo ?? []);
      if (!photo) return { refused: 'The photo had no size that can be downloaded.' };
      fileId = photo.file_id;
      size = photo.file_size;
    }
    const tooLarge = { refused: TOO_LARGE };
    if (size !== undefined && size > MAX_DOWNLOAD_BYTES) return tooLarge;
    const file = await call<TgFile>('getFile', { file_id: fileId });
    if (file.file_size !== undefined && file.file_size > MAX_DOWNLOAD_BYTES) return tooLarge;
    if (!file.file_path) return { refused: 'Telegram gave no way to download the file. It was not saved.' };
    let data: Uint8Array;
    try {
      data = await api.download(file.file_path, MAX_DOWNLOAD_BYTES, { signal: signal() });
    } catch (err) {
      if (err instanceof FileTooLargeError) return tooLarge;
      throw err;
    }
    const ext = extname(file.file_path).slice(0, 16);
    const fileName = message.document
      ? safeFileName(name ?? `file${ext}`)
      : safeFileName(`photo-${stamp(message.date)}${ext || '.jpg'}`);
    return writeUniqueFile(options.dataDir(missionId), fileName, data);
  }

  /** Saves the file of a message for `saveFiles`. On a failure it tells the user and returns undefined. */
  async function saveFileOf(message: TgMessage, missionId: MissionId): Promise<string[] | undefined> {
    let saved: string | { refused: string };
    try {
      saved = await saveFile(message, missionId);
    } catch (err) {
      report(err);
      if (!(err instanceof StoppedError)) {
        await note('The file could not be saved, so the message was not passed on. Please send it again.');
      }
      return undefined;
    }
    if (typeof saved !== 'string') {
      await note(saved.refused);
      return undefined;
    }
    return [saved];
  }

  async function handleMessage(message: TgMessage): Promise<void> {
    if (!isUserMessage(message, options.userId())) return;
    const h = requireHost();
    // The agent writes where the user last wrote: in a thread of the old layout, or outside any (§F.1).
    rememberThread(message.message_thread_id);
    const text = message.text ?? message.caption ?? '';

    const repliedTo = message.reply_to_message?.message_id;
    if (repliedTo !== undefined && (message.text !== undefined || message.caption !== undefined)) {
      const id = approvalOfMessage.get(repliedTo);
      const entry = id === undefined ? undefined : approvals.get(id);
      if (entry?.state === 'reason') {
        await takeReason(entry, text);
        return;
      }
    }

    // A reply to a message that a mission sent goes to that mission (§B.1). The thread of a
    // message no longer says anything about its mission.
    const missionId = repliedTo === undefined ? undefined : missionOfSent.get(repliedTo);

    const hasFile = message.document !== undefined || message.photo !== undefined;
    if (!hasFile && message.text === undefined) {
      if (UNSUPPORTED_KINDS.some((k) => k in message)) await note(UNSUPPORTED);
      // Anything else, such as a service message about a topic, is ignored.
      return;
    }
    if (message.document?.file_size !== undefined && message.document.file_size > MAX_DOWNLOAD_BYTES) {
      await note(TOO_LARGE);
      return;
    }

    const incoming: IncomingMessage = { surface: TELEGRAM_SURFACE_ID, text };
    if (missionId !== undefined) incoming.missionId = missionId;
    // The harness saves the file only after it has accepted the message, in the data folder of
    // the mission that takes it. A refused message saves nothing.
    if (hasFile) incoming.saveFiles = (target) => saveFileOf(message, target);
    if (hasFile) {
      // Awaited, so the update counts as handled only after the harness has routed the message
      // and the file is saved or refused. Routing does not include the run. If the surface stops
      // meanwhile, the update is not marked as handled and comes again at the next start.
      await h.incoming(incoming);
      if (controller === undefined || controller.signal.aborted) throw new StoppedError();
      return;
    }
    // Not awaited: a run can take minutes, and button presses must still be read meanwhile.
    h.incoming(incoming).catch(report);
  }

  // ------------------------------------------------------------ polling

  function readOffset(): number | undefined {
    const raw = requireHost().store.getState(OFFSET_STATE_KEY);
    if (raw === undefined) return undefined;
    try {
      const parsed = JSON.parse(raw) as { offset?: unknown; savedAt?: unknown };
      if (typeof parsed.offset !== 'number' || typeof parsed.savedAt !== 'number') return undefined;
      if (now() - parsed.savedAt > OFFSET_MAX_AGE_MS) return undefined;
      return parsed.offset;
    } catch {
      return undefined;
    }
  }

  function saveOffset(offset: number): void {
    requireHost().store.setState(OFFSET_STATE_KEY, JSON.stringify({ offset, savedAt: now() }));
  }

  async function poll(stop: AbortSignal): Promise<void> {
    let failures = 0;
    while (!stop.aborted) {
      const offset = readOffset();
      const params: Record<string, unknown> = { timeout: pollSeconds, allowed_updates: ALLOWED_UPDATES };
      if (offset !== undefined) params.offset = offset;
      let updates: TgUpdate[];
      try {
        updates = await api.call<TgUpdate[]>('getUpdates', params, { signal: stop, attempts: 1, timeoutMs: (pollSeconds + 15) * 1000 });
        failures = 0;
      } catch (err) {
        if (stop.aborted) return;
        failures++;
        report(err);
        const wait = err instanceof TelegramError && err.retryAfter !== undefined ? err.retryAfter * 1000 : backoffMs(failures);
        try {
          await sleep(wait, timers, stop);
        } catch {
          return;
        }
        continue;
      }
      for (const update of updates) {
        if (stop.aborted) return;
        if (offset !== undefined && update.update_id < offset) continue;
        try {
          if (update.callback_query) await handleCallback(update.callback_query);
          else if (update.message) await handleMessage(update.message);
        } catch (err) {
          // Stopped in the middle: the update is not marked as handled, so it comes again.
          if (err instanceof StoppedError || stop.aborted) return;
          report(err);
        }
        saveOffset(update.update_id + 1);
      }
    }
  }

  // ------------------------------------------------------------ surface

  return {
    id: TELEGRAM_SURFACE_ID,
    credentials: [TELEGRAM_BOT_TOKEN],

    async start(h: SurfaceHost) {
      if (loop) return;
      host = h;
      controller = new AbortController();
      const stop = controller.signal;
      loop = poll(stop).catch(report);
      // Neither of these holds up the polling. Each reports its own errors.
      void publishCommands();
      void sendOneChatNotice();
    },

    async stop() {
      controller?.abort();
      for (const entry of [...approvals.values()]) {
        if (entry.timer !== undefined) timers.clearTimer(entry.timer);
        entry.timer = undefined;
      }
      for (const sign of [...signs]) timers.clearTimer(sign.cap);
      signs.clear();
      stopTyping();
      const running = loop;
      loop = undefined;
      await running;
    },

    send,
    showApproval,
    closeApproval,
    missionsChanged: publishCommands,
    showWorking,
  };
}

// ------------------------------------------------------------ checks

/** True for a message from the user's own account in the private chat with the bot (§F.1). */
export function isUserMessage(message: TgMessage, userId: number | undefined): boolean {
  if (userId === undefined) return false;
  return isUser(message.from, userId) && message.chat.type === 'private' && message.chat.id === userId;
}

/** The same check for a button press. A press with no message is checked on its sender only. */
export function isUserCallback(query: TgCallbackQuery, userId: number | undefined): boolean {
  if (userId === undefined) return false;
  if (!isUser(query.from, userId)) return false;
  if (!query.message) return true;
  return query.message.chat.type === 'private' && query.message.chat.id === userId;
}

function isUser(user: TgUser | undefined, userId: number): boolean {
  return user !== undefined && user.is_bot !== true && user.id === userId;
}

/** The mission name in a label `<agent name> · <mission name>`. */
function nameFromLabel(label: string): string | undefined {
  const at = label.indexOf(' · ');
  if (at === -1) return undefined;
  const name = label.slice(at + 3).trim();
  return name === '' ? undefined : name;
}

/** True when Telegram refused the call itself (answer 400), as it does for a thread that it does not accept. */
function isRefused(err: unknown): boolean {
  return err instanceof TelegramError && err.code === 400;
}

function isNotModified(err: unknown): boolean {
  return err instanceof TelegramError && err.code === 400 && /not[ _]modified/i.test(err.message);
}

function largestPhoto(sizes: NonNullable<TgMessage['photo']>) {
  let best = sizes[sizes.length - 1];
  for (const s of sizes) {
    if (best && s.width * s.height > best.width * best.height) best = s;
  }
  return best;
}

/** `YYYYMMDD-HHMMSS` in UTC, from a Unix time in seconds. */
function stamp(unixSeconds: number): string {
  const iso = new Date(unixSeconds * 1000).toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
}
