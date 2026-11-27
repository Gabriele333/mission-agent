import { describe, expect, it } from 'vitest';
import { compareVersions, formatVersion, isReleaseTag, newestReleaseTag, parseVersion, tagsOfLsRemote } from './version.js';

describe('release versions', () => {
  it('reads a version with or without the v, and nothing else', () => {
    expect(parseVersion('0.2.0')).toEqual({ major: 0, minor: 2, patch: 0 });
    expect(parseVersion('v1.20.3\n')).toEqual({ major: 1, minor: 20, patch: 3 });
    for (const bad of ['', 'v1.2', '1.2.3-beta', 'v1.2.3.4', 'latest', 'v1.x.0']) expect(parseVersion(bad)).toBeUndefined();
    expect(formatVersion({ major: 1, minor: 20, patch: 3 })).toBe('1.20.3');
  });

  it('compares by number, not by text', () => {
    const v = (t: string) => parseVersion(t) as NonNullable<ReturnType<typeof parseVersion>>;
    expect(compareVersions(v('0.10.0'), v('0.9.9'))).toBeGreaterThan(0);
    expect(compareVersions(v('1.0.0'), v('0.99.99'))).toBeGreaterThan(0);
    expect(compareVersions(v('0.2.1'), v('0.2.10'))).toBeLessThan(0);
    expect(compareVersions(v('2.3.4'), v('v2.3.4'))).toBe(0);
  });

  it('takes the newest release tag and ignores every other tag', () => {
    expect(isReleaseTag('v0.2.0')).toBe(true);
    expect(isReleaseTag('0.2.0')).toBe(false);
    expect(isReleaseTag('v0.2.0-rc1')).toBe(false);
    expect(newestReleaseTag(['v0.9.0', 'v0.10.0', 'v0.10.0-rc1', 'nightly', 'v0.2.0', ''])).toBe('v0.10.0');
    expect(newestReleaseTag(['nightly'])).toBeUndefined();
  });

  it('reads the tag names that git ls-remote prints', () => {
    const output = ['a'.repeat(40) + '\trefs/tags/v0.1.0', 'b'.repeat(40) + '\trefs/tags/v0.2.0', 'c'.repeat(40) + '\trefs/heads/main', ''].join('\n');
    expect(tagsOfLsRemote(output)).toEqual(['v0.1.0', 'v0.2.0']);
    expect(tagsOfLsRemote('')).toEqual([]);
  });
});
