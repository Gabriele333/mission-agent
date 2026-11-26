import type { Redactor } from '../types.js';

/** Values shorter than this are not redacted: they would match too much ordinary text. */
export const MIN_REDACTED_LENGTH = 8;

interface Match {
  start: number;
  end: number;
  id: string;
}

/**
 * Replaces each known secret value in a text with `[<credential id>]` (§A.5 "Protection of values").
 *
 * `values` returns a map from secret value to credential id. It is called on every
 * `redact`, so a value set with `secret set` is covered at once.
 *
 * Each value is searched in three forms: as it is, escaped once as inside a JSON string,
 * and escaped twice (a JSON text stored inside another JSON string).
 * When matches overlap, the whole span they cover is replaced, so no part of a value
 * is left. A match inside a longer match is dropped, so a value that contains another
 * value becomes one id.
 */
export function createRedactor(values: () => Map<string, string>): Redactor {
  return {
    redact(text) {
      const patterns = buildPatterns(values());
      if (patterns.length === 0 || text.length === 0) return text;

      const matches: Match[] = [];
      for (const p of patterns) {
        let i = text.indexOf(p.text);
        while (i !== -1) {
          matches.push({ start: i, end: i + p.text.length, id: p.id });
          i = text.indexOf(p.text, i + 1);
        }
      }
      if (matches.length === 0) return text;

      // Longest first at the same start, so the outer match leads its group.
      matches.sort((a, b) => a.start - b.start || b.end - a.end);

      let out = '';
      let pos = 0;
      let k = 0;
      while (k < matches.length) {
        const first = matches[k]!;
        let end = first.end;
        const labels: string[] = [first.id];
        let lastLabelEnd = first.end;
        k++;
        while (k < matches.length && matches[k]!.start < end) {
          const m = matches[k]!;
          // A match that ends inside the span so far is contained in it and adds no label.
          if (m.end > lastLabelEnd) {
            if (labels[labels.length - 1] !== m.id) labels.push(m.id);
            lastLabelEnd = m.end;
          }
          end = Math.max(end, m.end);
          k++;
        }
        out += text.slice(pos, first.start) + labels.map((id) => `[${id}]`).join('');
        pos = end;
      }
      return out + text.slice(pos);
    },
  };
}

interface Pattern {
  text: string;
  id: string;
}

function buildPatterns(valueToId: Map<string, string>): Pattern[] {
  const byText = new Map<string, string>();
  // Raw values go first, so the id of a raw value wins over an escaped form that happens to be equal.
  const raw = [...valueToId].filter(([v]) => v.length >= MIN_REDACTED_LENGTH);
  for (const [v, id] of raw) if (!byText.has(v)) byText.set(v, id);
  for (const [v, id] of raw) {
    const once = jsonEscape(v);
    const twice = jsonEscape(once);
    if (!byText.has(once)) byText.set(once, id);
    if (!byText.has(twice)) byText.set(twice, id);
  }
  return [...byText].map(([text, id]) => ({ text, id }));
}

/** The text between the quotes of `JSON.stringify(value)`. */
function jsonEscape(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
