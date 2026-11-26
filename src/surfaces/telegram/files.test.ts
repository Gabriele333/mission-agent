import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkOutgoingFile, safeFileName, writeUniqueFile } from './files.js';

describe('safeFileName', () => {
  it('keeps a plain name', () => {
    expect(safeFileName('report.pdf')).toBe('report.pdf');
    expect(safeFileName('Été 2026.txt')).toBe('Été 2026.txt');
  });

  it('removes path separators and leading dots', () => {
    expect(safeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeFileName('..\\..\\boot.ini')).toBe('_.._boot.ini');
    expect(safeFileName('/abs/path.txt')).toBe('_abs_path.txt');
    expect(safeFileName('.bashrc')).toBe('bashrc');
    expect(safeFileName('...')).toBe('file');
    expect(safeFileName('..')).toBe('file');
  });

  it('removes control and direction characters', () => {
    expect(safeFileName('a\u0000b\nc.txt')).toBe('a_b_c.txt');
    expect(safeFileName('invoice‮fdp.exe')).toBe('invoicefdp.exe');
    expect(safeFileName('a:b.txt')).toBe('a_b.txt');
  });

  it('falls back when nothing is left', () => {
    expect(safeFileName(undefined)).toBe('file');
    expect(safeFileName('   ')).toBe('file');
    expect(safeFileName('', 'photo.jpg')).toBe('photo.jpg');
  });

  it('limits the length in bytes and keeps the extension', () => {
    const name = safeFileName(`${'é'.repeat(300)}.pdf`);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(150);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});

describe('writeUniqueFile and checkOutgoingFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-files-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('adds a number when the name is taken', async () => {
    const data = new TextEncoder().encode('x');
    const a = await writeUniqueFile(join(dir, 'data'), 'r.pdf', data);
    const b = await writeUniqueFile(join(dir, 'data'), 'r.pdf', data);
    const c = await writeUniqueFile(join(dir, 'data'), 'r.pdf', data);
    expect([a, b, c].map((p) => p.slice(dir.length))).toEqual(['/data/r.pdf', '/data/r-1.pdf', '/data/r-2.pdf']);
  });

  it('never writes through an existing link', async () => {
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'keep');
    mkdirSync(join(dir, 'data'));
    symlinkSync(outside, join(dir, 'data', 'n.txt'));
    const p = await writeUniqueFile(join(dir, 'data'), 'n.txt', new TextEncoder().encode('new'));
    expect(p).toBe(join(dir, 'data', 'n-1.txt'));
    expect(readFileSync(outside, 'utf8')).toBe('keep');
    expect(readdirSync(join(dir, 'data')).sort()).toEqual(['n-1.txt', 'n.txt']);
  });

  it('accepts a file inside the folder and refuses one outside', async () => {
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'ok.txt'), 'x');
    writeFileSync(join(dir, 'secret.txt'), 'x');
    symlinkSync(join(dir, 'secret.txt'), join(dir, 'data', 'link.txt'));
    await expect(checkOutgoingFile(join(dir, 'data', 'ok.txt'), join(dir, 'data'))).resolves.toContain('ok.txt');
    await expect(checkOutgoingFile(join(dir, 'secret.txt'), join(dir, 'data'))).rejects.toThrow(/not inside/);
    await expect(checkOutgoingFile(join(dir, 'data', 'link.txt'), join(dir, 'data'))).rejects.toThrow(/not inside/);
    await expect(checkOutgoingFile(join(dir, 'data', 'none.txt'), join(dir, 'data'))).rejects.toThrow(/does not exist/);
  });
});
