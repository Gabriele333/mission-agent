import { describe, expect, it } from 'vitest';
import { applyReplacement, checkMemoryContent, memoryFileKind } from './memory-limits.js';

const limits = { maxNoteBytes: 10, maxIndexLineChars: 5 };

describe('memoryFileKind', () => {
  it('knows the index, a note, and a wrong-case index name', () => {
    expect(memoryFileKind('/m/memory/MEMORY.md', '/m/memory')).toBe('index');
    expect(memoryFileKind('/m/memory/memory.md', '/m/memory')).toBe('index-or-note');
    expect(memoryFileKind('/m/memory/sub/MEMORY.md', '/m/memory')).toBe('note');
    expect(memoryFileKind('/m/memory/fact.md', '/m/memory')).toBe('note');
  });
});

describe('checkMemoryContent', () => {
  it('applies both limits to a wrong-case index name', () => {
    expect(checkMemoryContent('a'.repeat(11), 'index-or-note', limits, 'x')).toMatch(/bytes/);
    expect(checkMemoryContent('aaaaaa', 'index-or-note', limits, 'x')).toMatch(/characters/);
    expect(checkMemoryContent('aaa\nbb', 'index-or-note', limits, 'x')).toBeNull();
  });

  it('counts characters, not bytes, for an index line, and ignores a carriage return', () => {
    expect(checkMemoryContent('ééééé\r\nok', 'index', limits, 'x')).toBeNull();
    expect(checkMemoryContent('éééééé', 'index', limits, 'x')).toMatch(/line 1 would hold 6/);
  });
});

describe('applyReplacement', () => {
  it('replaces the first match, or all of them', () => {
    expect(applyReplacement('a-a-a', 'a', 'b', false)).toBe('b-a-a');
    expect(applyReplacement('a-a-a', 'a', 'b', true)).toBe('b-b-b');
  });

  it('does not read $ patterns in the new text', () => {
    expect(applyReplacement('x', 'x', '$&$&', false)).toBe('$&$&');
  });

  it('matches curly quotes as straight quotes, like the Edit tool', () => {
    expect(applyReplacement('say “hi”', 'say "hi"', 'bye', false)).toBe('bye');
  });

  it('returns undefined when the text is not found', () => {
    expect(applyReplacement('abc', 'z', 'y', false)).toBeUndefined();
  });
});
