import { describe, expect, it } from 'vitest';
import { createRedactor } from './redactor.js';

const redactorOf = (pairs: Record<string, string>) => createRedactor(() => new Map(Object.entries(pairs)));

describe('createRedactor', () => {
  it('replaces every occurrence of a value with its id in brackets', () => {
    const r = redactorOf({ 'sk-ant-12345678': 'credential:model.api_key' });
    expect(r.redact('key sk-ant-12345678 and again sk-ant-12345678.')).toBe(
      'key [credential:model.api_key] and again [credential:model.api_key].',
    );
  });

  it('returns the text unchanged when no value matches', () => {
    const r = redactorOf({ 'sk-ant-12345678': 'credential:model.api_key' });
    expect(r.redact('nothing here')).toBe('nothing here');
    expect(createRedactor(() => new Map()).redact('abc')).toBe('abc');
  });

  it('replaces a value that contains another value as one id', () => {
    const r = redactorOf({
      'inner-12345': 'credential:a.inner',
      'outer-inner-12345-tail': 'credential:a.outer',
    });
    expect(r.redact('x outer-inner-12345-tail y inner-12345 z')).toBe('x [credential:a.outer] y [credential:a.inner] z');
  });

  it('leaves no part of two values that overlap', () => {
    const r = redactorOf({ 'AAAABBBB': 'credential:a.one', 'BBBBCCCC': 'credential:a.two' });
    const out = r.redact('start AAAABBBBCCCC end');
    expect(out).toBe('start [credential:a.one][credential:a.two] end');
  });

  it('handles a value that overlaps itself', () => {
    const r = redactorOf({ abababab: 'credential:a.rep' });
    expect(r.redact('xababababababy')).toBe('x[credential:a.rep]y');
  });

  it('skips values shorter than 8 characters', () => {
    const r = redactorOf({ short1: 'credential:a.short', exactly8: 'credential:a.eight' });
    expect(r.redact('short1 exactly8')).toBe('short1 [credential:a.eight]');
  });

  it('finds the value in JSON-escaped form, once and twice', () => {
    const value = 'pa"ss\\word\nline2';
    const r = redactorOf({ [value]: 'credential:mail.password' });
    const once = JSON.stringify({ input: `use ${value}` });
    expect(r.redact(once)).toBe('{"input":"use [credential:mail.password]"}');
    const twice = JSON.stringify({ row: once });
    expect(r.redact(twice)).toBe(JSON.stringify({ row: '{"input":"use [credential:mail.password]"}' }));
  });

  it('does not change the placeholder when a value equals part of an id', () => {
    const r = redactorOf({ 'credential': 'credential:x.word', 'telegram.bot': 'credential:y.word' });
    const out = r.redact('a credential b');
    expect(out).toBe('a [credential:x.word] b');
  });

  it('reads the values again on each call', () => {
    const map = new Map<string, string>();
    const r = createRedactor(() => map);
    expect(r.redact('token-abcdefgh')).toBe('token-abcdefgh');
    map.set('token-abcdefgh', 'credential:t.token');
    expect(r.redact('token-abcdefgh')).toBe('[credential:t.token]');
  });

  it('never leaves a secret in the output of a large mixed text', () => {
    const secrets: Record<string, string> = {};
    for (let i = 0; i < 20; i++) secrets[`secret-value-${i}-${'x'.repeat(i)}"\\`] = `credential:s.n${i}`;
    const r = redactorOf(secrets);
    const parts: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const v = Object.keys(secrets)[i % 20]!;
      parts.push(`row ${i} plain ${v} json ${JSON.stringify(v)} filler ${'lorem ipsum '.repeat(10)}`);
    }
    const text = parts.join('\n');
    expect(text.length).toBeGreaterThan(300_000);
    const t0 = performance.now();
    const out = r.redact(text);
    const ms = performance.now() - t0;
    for (const v of Object.keys(secrets)) {
      expect(out.includes(v)).toBe(false);
      expect(out.includes(JSON.stringify(v).slice(1, -1))).toBe(false);
    }
    expect(out).not.toContain('secret-value');
    // Generous bound for a slow machine. On this machine it takes a few milliseconds.
    expect(ms).toBeLessThan(500);
  });
});
