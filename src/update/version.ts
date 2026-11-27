/** Release versions (chapter 7.1). A release is a git tag such as `v0.2.0`, with the same number in `package.json`. */

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

const VERSION_RE = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/;
const TAG_RE = /^v\d+\.\d+\.\d+$/;

/** Reads `0.2.0` or `v0.2.0`. Undefined for anything else, such as a version with a suffix. */
export function parseVersion(text: string): Version | undefined {
  const m = VERSION_RE.exec(text.trim());
  if (m === null) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/** Negative when `a` is older than `b`, zero when they are the same, positive when `a` is newer. */
export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** True for the name of a release tag: `v`, then three numbers. */
export function isReleaseTag(tag: string): boolean {
  return TAG_RE.test(tag);
}

/** The newest release tag of a list of tag names. Names that are not release tags are ignored. */
export function newestReleaseTag(tags: Iterable<string>): string | undefined {
  let best: { tag: string; version: Version } | undefined;
  for (const tag of tags) {
    if (!isReleaseTag(tag)) continue;
    const version = parseVersion(tag);
    if (version === undefined) continue;
    if (best === undefined || compareVersions(version, best.version) > 0) best = { tag, version };
  }
  return best?.tag;
}

/** The tag names in the output of `git ls-remote --tags --refs`. */
export function tagsOfLsRemote(output: string): string[] {
  const tags: string[] = [];
  for (const line of output.split('\n')) {
    const m = /\trefs\/tags\/(\S+)$/.exec(line.trimEnd());
    if (m?.[1] !== undefined) tags.push(m[1]);
  }
  return tags;
}
