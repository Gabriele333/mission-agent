import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { describeApproval } from '../../safety/index.js';
import { TELEGRAM_BOT_TOKEN } from '../../secrets/index.js';
import type { ApprovalAnswer, ApprovalRequest, IncomingMessage, MissionId, OutgoingMessage, Surface, SurfaceHost } from '../../types.js';
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
import { appendWithin, CALLBACK_TEXT_LIMIT, CAPTION_LIMIT, MESSAGE_LIMIT, splitText, TOPIC_NAME_LIMIT, truncate } from './text.js';
import type { TgCallbackQuery, TgFile, TgForumTopic, TgMessage, TgUpdate, TgUser } from './tg-types.js';

export const TELEGRAM_SURFACE_ID = 'surface:telegram';

/** The state key that holds the polling offset: `{"offset": <number>, "savedAt": <ms since 1970>}`. */
export const OFFSET_STATE_KEY = 'telegram.update_offset';

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

  // ------------------------------------------------------------ threads

  function topicName(label: string, missionId: MissionId): string {
    const name = label.trim() !== '' ? label.trim() : (options.missionName(missionId) ?? missionId);
    return truncate(name, TOPIC_NAME_LIMIT);
  }

  async function createTopic(missionId: MissionId, label: string): Promise<number> {
    const chatId = requireUser();
    const topic = await call<TgForumTopic>('createForumTopic', { chat_id: chatId, name: topicName(label, missionId) });
    requireHost().store.setThread(missionId, topic.message_thread_id);
    return topic.message_thread_id;
  }

  /** The stored thread of a mission, created when there is none. Runs inside the chain. */
  async function ensureThread(missionId: MissionId, label: string): Promise<number> {
    const stored = requireHost().store.getThread(missionId);
    if (stored !== undefined) return stored;
    return createTopic(missionId, label);
  }

  /**
   * Runs `post` in the mission's thread. When Telegram says the thread does not exist, for example
   * because the user deleted it, the thread is created again and `post` runs once more.
   */
  async function inThread<T>(missionId: MissionId, label: string, post: (threadId: number) => Promise<T>): Promise<T> {
    const threadId = await ensureThread(missionId, label);
    try {
      return await post(threadId);
    } catch (err) {
      if (!isThreadMissing(err)) throw err;
      requireHost().store.deleteThread(missionId);
      return post(await createTopic(missionId, label));
    }
  }

  function labelFor(missionId: MissionId | null, given?: string): string {
    if (missionId === null) return requireHost().label(general);
    return given ?? requireHost().label(missionId);
  }

  // ------------------------------------------------------------ sending

  async function postText(threadId: number | undefined, text: string, extra: Record<string, unknown> = {}): Promise<TgMessage> {
    const params: Record<string, unknown> = { chat_id: requireUser(), text, ...extra };
    if (threadId !== undefined) params.message_thread_id = threadId;
    return call<TgMessage>('sendMessage', params);
  }

  async function postParts(threadId: number, text: string): Promise<void> {
    for (const part of splitText(text, MESSAGE_LIMIT)) {
      // Telegram refuses an empty text, and a part that is only white space counts as empty.
      if (part.trim() === '') continue;
      await postText(threadId, part);
    }
  }

  async function postDocument(threadId: number, realPath: string, caption: string): Promise<void> {
    const data = await readFile(realPath);
    const form = new FormData();
    form.append('chat_id', String(requireUser()));
    form.append('message_thread_id', String(threadId));
    if (caption !== '') form.append('caption', caption);
    form.append('document', new Blob([data]), basename(realPath));
    await call<TgMessage>('sendDocument', form);
  }

  async function send(msg: OutgoingMessage): Promise<void> {
    requireHost();
    requireUser();
    const missionId = msg.missionId ?? general;
    const label = labelFor(msg.missionId, msg.label);
    const hasText = msg.text.trim() !== '';
    if (!hasText && msg.filePath === undefined) return;
    // The file is checked before anything is sent, so a refused file sends nothing.
    const realPath = msg.filePath === undefined ? undefined : await checkOutgoingFile(msg.filePath, options.dataDir(missionId));
    await enqueue(() =>
      inThread(missionId, label, async (threadId) => {
        if (realPath === undefined) return postParts(threadId, msg.text);
        if (msg.text.length <= CAPTION_LIMIT) return postDocument(threadId, realPath, hasText ? msg.text : '');
        await postParts(threadId, msg.text);
        await postDocument(threadId, realPath, '');
      }),
    );
  }

  /** A short note in the thread where the user wrote. Errors are reported, not thrown. */
  async function note(threadId: number | undefined, text: string): Promise<void> {
    try {
      await enqueue(() => postText(threadId, text));
    } catch (err) {
      report(err);
    }
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

  async function showApproval(req: ApprovalRequest, label: string): Promise<void> {
    requireHost();
    requireUser();
    const { parts, last } = approvalParts(req);
    await enqueue(() =>
      inThread(req.missionId, label, async (threadId) => {
        for (const part of parts) await postText(threadId, part);
        const entry: ShownApproval = { id: req.id, missionId: req.missionId, messageId: 0, text: last, state: 'buttons', keys: [] };
        const markup = keyboard([
          [
            { text: 'Approve', data: callbackData('a', entry) },
            { text: 'Reject', data: callbackData('r', entry) },
          ],
        ]);
        const sent = await postText(threadId, last, { reply_markup: markup });
        entry.messageId = sent.message_id;
        approvals.set(entry.id, entry);
        approvalOfMessage.set(entry.messageId, entry.id);
      }),
    );
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
  async function takeReason(entry: ShownApproval, text: string, threadId: number | undefined): Promise<void> {
    if (entry.timer !== undefined) {
      timers.clearTimer(entry.timer);
      entry.timer = undefined;
    }
    const reason = text.trim();
    const answer: ApprovalAnswer = reason === '' ? { kind: 'rejected' } : { kind: 'rejected', reason };
    if (!answerApproval(entry.id, answer)) {
      forget(entry);
      await note(threadId, 'That request is no longer waiting for an answer, so the reason was not used.');
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
  async function saveFileOf(message: TgMessage, missionId: MissionId, threadId: number | undefined): Promise<string[] | undefined> {
    let saved: string | { refused: string };
    try {
      saved = await saveFile(message, missionId);
    } catch (err) {
      report(err);
      if (!(err instanceof StoppedError)) {
        await note(threadId, 'The file could not be saved, so the message was not passed on. Please send it again.');
      }
      return undefined;
    }
    if (typeof saved !== 'string') {
      await note(threadId, saved.refused);
      return undefined;
    }
    return [saved];
  }

  async function handleMessage(message: TgMessage): Promise<void> {
    if (!isUserMessage(message, options.userId())) return;
    const h = requireHost();
    const threadId = message.message_thread_id;
    const text = message.text ?? message.caption ?? '';

    const repliedTo = message.reply_to_message?.message_id;
    if (repliedTo !== undefined && (message.text !== undefined || message.caption !== undefined)) {
      const id = approvalOfMessage.get(repliedTo);
      const entry = id === undefined ? undefined : approvals.get(id);
      if (entry?.state === 'reason') {
        await takeReason(entry, text, threadId);
        return;
      }
    }

    const threadMission = threadId === undefined ? undefined : h.store.missionOfThread(threadId);
    // The general thread, a message outside any thread and a thread the harness does not know all
    // go to triage, so the mission is left unset (§B.1, §B.3).
    const missionId = threadMission !== undefined && threadMission !== general ? threadMission : undefined;

    const hasFile = message.document !== undefined || message.photo !== undefined;
    if (!hasFile && message.text === undefined) {
      if (UNSUPPORTED_KINDS.some((k) => k in message)) await note(threadId, UNSUPPORTED);
      // Anything else, such as a service message about a topic, is ignored.
      return;
    }
    if (message.document?.file_size !== undefined && message.document.file_size > MAX_DOWNLOAD_BYTES) {
      await note(threadId, TOO_LARGE);
      return;
    }

    const incoming: IncomingMessage = { surface: TELEGRAM_SURFACE_ID, text };
    if (missionId !== undefined) incoming.missionId = missionId;
    // The harness saves the file only after it has accepted the message, in the data folder of
    // the mission that takes it. A refused message saves nothing.
    if (hasFile) incoming.saveFiles = (target) => saveFileOf(message, target, threadId);
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

  async function checkTopics(stop: AbortSignal): Promise<void> {
    try {
      const me = await api.call<{ has_topics_enabled?: boolean }>('getMe', {}, { signal: stop, attempts: 3 });
      if (me.has_topics_enabled !== true) {
        report(new Error('Topic mode is off for the Telegram bot, so missions cannot have their own threads. Turn on topics for the bot in BotFather.'));
      }
    } catch (err) {
      report(err);
    }
  }

  async function poll(stop: AbortSignal): Promise<void> {
    await checkTopics(stop);
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
    hasThreads: true,
    credentials: [TELEGRAM_BOT_TOKEN],

    async start(h: SurfaceHost) {
      if (loop) return;
      host = h;
      controller = new AbortController();
      const stop = controller.signal;
      loop = poll(stop).catch(report);
    },

    async stop() {
      controller?.abort();
      for (const entry of [...approvals.values()]) {
        if (entry.timer !== undefined) timers.clearTimer(entry.timer);
        entry.timer = undefined;
      }
      const running = loop;
      loop = undefined;
      await running;
    },

    send,
    showApproval,
    closeApproval,

    async createThread(missionId, label) {
      requireHost();
      requireUser();
      await enqueue(async () => {
        const stored = requireHost().store.getThread(missionId);
        if (stored === undefined) {
          await createTopic(missionId, label);
          return;
        }
        await rename(missionId, stored, label);
      });
    },

    async renameThread(missionId, label) {
      requireHost();
      requireUser();
      await enqueue(async () => {
        const stored = requireHost().store.getThread(missionId);
        if (stored === undefined) await createTopic(missionId, label);
        else await rename(missionId, stored, label);
      });
    },

    async deleteThread(missionId) {
      requireHost();
      await enqueue(async () => {
        const h = requireHost();
        const stored = h.store.getThread(missionId);
        for (const entry of [...approvals.values()]) if (entry.missionId === missionId) forget(entry);
        if (stored === undefined) return;
        try {
          await call('deleteForumTopic', { chat_id: requireUser(), message_thread_id: stored });
        } catch (err) {
          // A 400 answer means the thread is gone or cannot be deleted. The stored id is useless either way.
          if (!(err instanceof TelegramError && err.code === 400)) throw err;
          report(err);
        }
        h.store.deleteThread(missionId);
      });
    },
  };

  async function rename(missionId: MissionId, threadId: number, label: string): Promise<void> {
    try {
      await call('editForumTopic', { chat_id: requireUser(), message_thread_id: threadId, name: topicName(label, missionId) });
    } catch (err) {
      if (isNotModified(err)) return;
      if (!isThreadMissing(err)) throw err;
      requireHost().store.deleteThread(missionId);
      await createTopic(missionId, label);
    }
  }
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

function isThreadMissing(err: unknown): boolean {
  return err instanceof TelegramError && err.code === 400 && /thread not found|topic_id_invalid|topic not found/i.test(err.message);
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
