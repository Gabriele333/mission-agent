import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SYS_GENERAL, SYS_MISSION_ADMIN, type ToolContext } from '../types.js';
import { deleteFile, sendMessage } from './harness-tools.js';
import { makeHarness, textOf, type Harness } from './test-helpers.js';

let h: Harness;
let ctx: ToolContext;
const ID = SYS_GENERAL;
const OTHER = SYS_MISSION_ADMIN;

beforeEach(() => {
  h = makeHarness();
  ctx = h.ctx(ID);
});
afterEach(() => h.cleanUp());

function put(path: string, content = 'x'): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe('send_message', () => {
  it('sends a text to the user for the run\'s own mission', async () => {
    const result = await sendMessage(ctx, h.paths, { text: 'Hello' });
    expect(result.isError).toBeUndefined();
    expect(h.host.sent).toEqual([{ missionId: ID, text: 'Hello' }]);
  });

  it('sends a file from the data folder, given relative or absolute', async () => {
    const file = put(join(h.paths.dataDir(ID), 'report.txt'));
    const relative = await sendMessage(ctx, h.paths, { text: 'Report', file: 'data/report.txt' });
    expect(textOf(relative)).toBe('The message and the file were sent to the user.');
    await sendMessage(ctx, h.paths, { text: 'Again', file });
    expect(h.host.sent).toEqual([
      { missionId: ID, text: 'Report', filePath: file },
      { missionId: ID, text: 'Again', filePath: file },
    ]);
  });

  it('refuses a file of the mission that is outside the data folder', async () => {
    put(join(h.paths.memoryDir(ID), 'note.md'));
    const result = await sendMessage(ctx, h.paths, { text: 'Note', file: 'memory/note.md' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not inside this mission's data\/ folder/);
    expect(h.host.sent).toEqual([]);
  });

  it('refuses the manifest and a file in core/', async () => {
    put(join(h.paths.coreDir, 'facts.txt'));
    const manifest = await sendMessage(ctx, h.paths, { text: 'M', file: 'manifest.yaml' });
    expect(textOf(manifest)).toMatch(/cannot read its manifest.yaml/);
    const core = await sendMessage(ctx, h.paths, { text: 'C', file: join(h.paths.coreDir, 'facts.txt') });
    expect(core.isError).toBe(true);
    expect(h.host.sent).toEqual([]);
  });

  it('refuses a file in another mission\'s data folder', async () => {
    const file = put(join(h.paths.dataDir(OTHER), 'secret.txt'));
    const absolute = await sendMessage(ctx, h.paths, { text: 'S', file });
    expect(absolute.isError).toBe(true);
    const climbing = await sendMessage(ctx, h.paths, { text: 'S', file: `data/../../${OTHER}/data/secret.txt` });
    expect(climbing.isError).toBe(true);
    expect(h.host.sent).toEqual([]);
  });

  it('refuses a missing file and a folder', async () => {
    mkdirSync(join(h.paths.dataDir(ID), 'sub'));
    expect(textOf(await sendMessage(ctx, h.paths, { text: 'x', file: 'data/none.txt' }))).toMatch(/does not exist/);
    expect(textOf(await sendMessage(ctx, h.paths, { text: 'x', file: 'data/sub' }))).toMatch(/is not a file/);
    expect(textOf(await sendMessage(ctx, h.paths, { text: 'x', file: 'data' }))).toMatch(/not inside/);
    expect(h.host.sent).toEqual([]);
  });

  it('returns an error result when the host fails', async () => {
    ctx.host.sendMessage = async () => {
      throw new Error('no surface');
    };
    const result = await sendMessage(ctx, h.paths, { text: 'x' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('The message was not sent: no surface');
  });
});

describe('delete_file', () => {
  it('deletes a note in memory/ and reminds the model to edit the index, which it leaves as it is', async () => {
    const note = put(join(h.paths.memoryDir(ID), 'old.md'));
    writeFileSync(h.paths.memoryIndexFile(ID), '- old.md: an old note\n');
    const result = await deleteFile(ctx, h.paths, { path: 'memory/old.md' });
    expect(result.isError).toBeUndefined();
    expect(existsSync(note)).toBe(false);
    expect(textOf(result)).toBe('Deleted memory/old.md. MEMORY.md was not changed: remove the line for old.md from the index yourself.');
    expect(existsSync(h.paths.memoryIndexFile(ID))).toBe(true);
  });

  it('deletes a file in data/, also in a subfolder and by absolute path', async () => {
    const a = put(join(h.paths.dataDir(ID), 'a.txt'));
    const b = put(join(h.paths.dataDir(ID), 'sub', 'b.txt'));
    expect(textOf(await deleteFile(ctx, h.paths, { path: 'data/a.txt' }))).toBe('Deleted data/a.txt.');
    expect((await deleteFile(ctx, h.paths, { path: b })).isError).toBeUndefined();
    expect(existsSync(a) || existsSync(b)).toBe(false);
    expect(existsSync(join(h.paths.dataDir(ID), 'sub'))).toBe(true);
  });

  it('refuses a folder', async () => {
    mkdirSync(join(h.paths.dataDir(ID), 'sub'));
    const result = await deleteFile(ctx, h.paths, { path: 'data/sub' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/is a folder/);
    expect(existsSync(join(h.paths.dataDir(ID), 'sub'))).toBe(true);
    expect((await deleteFile(ctx, h.paths, { path: 'data' })).isError).toBe(true);
    expect((await deleteFile(ctx, h.paths, { path: 'memory' })).isError).toBe(true);
  });

  it('refuses manifest.yaml, also through ..', async () => {
    for (const path of ['manifest.yaml', 'data/../manifest.yaml', h.paths.manifestFile(ID)]) {
      const result = await deleteFile(ctx, h.paths, { path });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/can delete only files inside its own memory\/ and data\/ folders/);
    }
    expect(existsSync(h.paths.manifestFile(ID))).toBe(true);
  });

  it('refuses a skill file and a file in core/', async () => {
    const skill = put(join(h.paths.skillsDir(ID), 'x', 'SKILL.md'));
    expect((await deleteFile(ctx, h.paths, { path: 'skills/x/SKILL.md' })).isError).toBe(true);
    expect((await deleteFile(ctx, h.paths, { path: h.paths.coreMemoryFile })).isError).toBe(true);
    expect(existsSync(skill) && existsSync(h.paths.coreMemoryFile)).toBe(true);
  });

  it('refuses MEMORY.md', async () => {
    const result = await deleteFile(ctx, h.paths, { path: 'memory/MEMORY.md' });
    expect(textOf(result)).toMatch(/MEMORY.md is the index/);
    expect(existsSync(h.paths.memoryIndexFile(ID))).toBe(true);
  });

  it('refuses a symbolic link in data/ that points outside, and leaves the target', async () => {
    const target = put(join(h.paths.dataDir(OTHER), 'theirs.txt'));
    symlinkSync(target, join(h.paths.dataDir(ID), 'link.txt'));
    const result = await deleteFile(ctx, h.paths, { path: 'data/link.txt' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/The path leads to/);
    expect(existsSync(target)).toBe(true);
  });

  it('refuses a file of another mission, by absolute path and through ..', async () => {
    const theirs = put(join(h.paths.dataDir(OTHER), 'theirs.txt'));
    expect((await deleteFile(ctx, h.paths, { path: theirs })).isError).toBe(true);
    expect((await deleteFile(ctx, h.paths, { path: `data/../../${OTHER}/data/theirs.txt` })).isError).toBe(true);
    expect(existsSync(theirs)).toBe(true);
  });

  it('returns an error for a file that does not exist', async () => {
    const result = await deleteFile(ctx, h.paths, { path: 'data/none.txt' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/does not exist/);
  });
});
