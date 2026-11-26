import { describe, expect, it } from 'vitest';
import { appendWithin, MESSAGE_LIMIT, splitText, truncate } from './text.js';

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;

function checkParts(text: string, parts: string[], limit: number) {
  expect(parts.join('')).toBe(text);
  for (const p of parts) {
    expect(p.length).toBeLessThanOrEqual(limit);
    expect(p.length).toBeGreaterThan(0);
    expect(isHigh(p.charCodeAt(p.length - 1))).toBe(false);
  }
}

describe('splitText', () => {
  it('keeps a short text in one part', () => {
    expect(splitText('hello')).toEqual(['hello']);
    expect(splitText('x'.repeat(MESSAGE_LIMIT))).toHaveLength(1);
  });

  it('returns one empty part for an empty text', () => {
    expect(splitText('')).toEqual(['']);
  });

  it('cuts after a blank line first', () => {
    const a = 'a'.repeat(3000);
    const b = 'b'.repeat(3000);
    const text = `${a}\nline\n\n${b}`;
    const parts = splitText(text);
    expect(parts[0]).toBe(`${a}\nline\n\n`);
    checkParts(text, parts, MESSAGE_LIMIT);
  });

  it('cuts after a line end when no blank line is near the limit', () => {
    const text = `${'a'.repeat(2500)}\n${'b'.repeat(2500)}`;
    const parts = splitText(text);
    expect(parts[0]).toBe(`${'a'.repeat(2500)}\n`);
    checkParts(text, parts, MESSAGE_LIMIT);
  });

  it('cuts after a space when there is no line end', () => {
    const words = Array.from({ length: 1200 }, (_, i) => `w${i}`).join(' ');
    const parts = splitText(words);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]!.endsWith(' ')).toBe(true);
    checkParts(words, parts, MESSAGE_LIMIT);
  });

  it('cuts hard at the limit when there is nothing better', () => {
    const text = 'x'.repeat(10_000);
    const parts = splitText(text);
    expect(parts.map((p) => p.length)).toEqual([4096, 4096, 1808]);
    checkParts(text, parts, MESSAGE_LIMIT);
  });

  it('never cuts a surrogate pair', () => {
    // 4095 code units, then an emoji of two code units across the limit.
    const text = `${'x'.repeat(4095)}😀${'y'.repeat(10)}`;
    const parts = splitText(text);
    expect(parts[0]).toBe('x'.repeat(4095));
    expect(parts[1]).toBe(`😀${'y'.repeat(10)}`);
    checkParts(text, parts, MESSAGE_LIMIT);
  });

  it('keeps every character of a long text made of emoji only', () => {
    const text = '😀🎉'.repeat(5000);
    const parts = splitText(text);
    checkParts(text, parts, MESSAGE_LIMIT);
    for (const p of parts) expect(p.length % 2).toBe(0);
  });

  it('keeps every character of mixed text with small limits', () => {
    const text = 'ab😀\n\ncd 🎉ef\n' .repeat(50);
    for (const limit of [2, 3, 5, 7, 16, 33]) checkParts(text, splitText(text, limit), limit);
  });
});

describe('truncate and appendWithin', () => {
  it('truncates without breaking a pair', () => {
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('ab😀cd', 4)).toBe('ab…');
    expect(truncate('abcdef', 4)).toBe('abc…');
  });

  it('shortens the suffix to fit', () => {
    expect(appendWithin('abc', 'def', 10)).toBe('abcdef');
    const out = appendWithin('a'.repeat(8), 'bcdef', 10);
    expect(out).toBe('aaaaaaaab…');
    expect(out.length).toBe(10);
  });
});
