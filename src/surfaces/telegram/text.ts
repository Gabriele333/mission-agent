/**
 * Text helpers for Telegram. Lengths are counted in UTF-16 code units (JavaScript string length).
 * Telegram counts message length in characters. A character is one or two code units, so a limit
 * kept in code units is never over Telegram's limit.
 */

/** Longest text of one message (`sendMessage`: 1-4096 characters). */
export const MESSAGE_LIMIT = 4096;
/** Longest caption of a document (`sendDocument`: 0-1024 characters). */
export const CAPTION_LIMIT = 1024;
/** Longest text of a callback answer (`answerCallbackQuery`: 0-200 characters). */
export const CALLBACK_TEXT_LIMIT = 200;

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * Splits a text into parts of at most `limit` code units. It cuts after a blank line, else after
 * a line end, else after a space, when one of them lies in the second half of the part. Otherwise
 * it cuts at the limit, but never between the two halves of a surrogate pair.
 * Joining the parts gives the text back unchanged.
 */
export function splitText(text: string, limit = MESSAGE_LIMIT): string[] {
  if (!Number.isInteger(limit) || limit < 2) throw new Error('The limit must be an integer of at least 2.');
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = findCut(rest, limit);
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0 || parts.length === 0) parts.push(rest);
  return parts;
}

function findCut(s: string, limit: number): number {
  const window = s.slice(0, limit);
  const min = Math.floor(limit / 2);
  for (const sep of ['\n\n', '\n', ' ']) {
    const i = window.lastIndexOf(sep);
    if (i >= min) return i + sep.length;
  }
  let cut = limit;
  if (isHigh(s.charCodeAt(cut - 1)) && isLow(s.charCodeAt(cut))) cut -= 1;
  return cut;
}

/** Cuts a text to at most `limit` code units, without breaking a surrogate pair. Adds `…` when it cuts. */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let cut = limit - 1;
  if (cut > 0 && isHigh(text.charCodeAt(cut - 1))) cut -= 1;
  return `${text.slice(0, cut)}…`;
}

/** `base` followed by `suffix`, with the suffix shortened so that the whole fits in `limit`. */
export function appendWithin(base: string, suffix: string, limit = MESSAGE_LIMIT): string {
  if (base.length + suffix.length <= limit) return base + suffix;
  const room = limit - base.length;
  if (room <= 1) return truncate(base, limit);
  return base + truncate(suffix, room);
}
