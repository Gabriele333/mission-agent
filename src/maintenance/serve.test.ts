import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMON_JS } from '../pages/assets/common.js';
import { PROGRESS_JS } from '../pages/assets/progress.js';
import { PAGE_CSP } from '../pages/http.js';
import { readServerFile } from '../server/server-file.js';
import { runPageScript } from '../pages/test-helpers.js';
import { layoutFor, type Layout } from './layout.js';
import { startProgressServer, type ProgressServer } from './serve.js';
import { UPDATE_PARTS } from './update.js';

/** The progress page of the maintenance program (chapter 7.5). */

let tmp: string;
let layout: Layout;
let server: ProgressServer | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mission-agent-serve-'));
  layout = layoutFor(join(tmp, '.mission-agent'));
});
afterEach(async () => {
  await server?.stop();
  server = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

function parts(url: string): { base: string; token: string; port: number } {
  const u = new URL(url);
  return { base: `${u.protocol}//${u.host}`, token: u.searchParams.get('token') as string, port: Number(u.port) };
}

/** A GET with a Host header of our choice, which fetch does not allow. */
function getWithHost(port: number, path: string, host: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host, authorization: `Bearer ${token}` } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('the progress server', () => {
  it('answers on 127.0.0.1 with its own token, and writes where it answers', async () => {
    server = await startProgressServer(layout);
    const { base, token, port } = parts(server.url);
    expect(base).toBe(`http://127.0.0.1:${port}`);
    expect(token.length).toBeGreaterThanOrEqual(32);
    const info = readServerFile({ serverFile: layout.server });
    expect(info?.pid).toBe(process.pid);
    expect(info?.token).toBe(token);

    expect((await fetch(`${base}/api/progress`)).status).toBe(401);
    expect((await fetch(`${base}/api/progress`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    const ok = await fetch(`${base}/api/progress`, { headers: { authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
    expect(await getWithHost(port, '/api/progress', 'evil.example', token)).toBe(403);
    expect(await getWithHost(port, '/api/progress', `127.0.0.1:${port}`, token)).toBe(200);

    const page = await fetch(server.url, { redirect: 'manual' });
    expect(page.status).toBe(303);
    for (const path of ['/', '/pages/common.js', '/pages/progress.js', '/pages/style.css']) {
      const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-security-policy')).toBe(PAGE_CSP);
    }
    const cross = await fetch(`${base}/api/repair`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: 'http://evil.example' },
      body: '{}',
    });
    expect(cross.status).toBe(403);
  });

  it('shows the steps and lines, refuses a repair until one is offered, and stops after the end', async () => {
    server = await startProgressServer(layout, { stopAfterMs: 200 });
    const { base, token } = parts(server.url);
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    server.begin('update', 'Update to version 0.2.0', UPDATE_PARTS);
    server.reporter.step('build', 'Build', 'running');
    server.line('Getting release v0.2.0.');
    const d = (await (await fetch(`${base}/api/progress`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
      steps: { id: string; state: string }[];
      lines: string[];
    };
    expect(d.steps.find((s) => s.id === 'build')?.state).toBe('running');
    expect(d.lines).toContain('Getting release v0.2.0.');
    expect((await post('/api/repair', {})).status).toBe(409);
    expect((await post('/api/answer', { id: 'x', answer: 'yes' })).status).toBe(409);

    let repairs = 0;
    server.onRepair(() => repairs++);
    server.end({ state: 'needs-repair', result: 'Going back failed.', oldRuns: false, canRepair: true, dashboard: null });
    expect((await post('/api/repair', {})).status).toBe(200);
    expect((await post('/api/repair', {})).status).toBe(409);
    expect(repairs).toBe(1);
    await server.stopped;
    await expect(fetch(`${base}/api/progress`)).rejects.toThrow();
  });

  it('asks the question about the data on the page, and takes only yes or no', async () => {
    server = await startProgressServer(layout);
    const { base, token } = parts(server.url);
    const answer = server.asker.line('Put this copy back? [y/N] ');
    const d = (await (await fetch(`${base}/api/progress`, { headers: { authorization: `Bearer ${token}` } })).json()) as { question: { id: string; text: string } };
    expect(d.question.text).toBe('Put this copy back?');
    const post = (body: unknown) =>
      fetch(`${base}/api/answer`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ id: d.question.id, answer: 'maybe' })).status).toBe(400);
    expect((await post({ id: 'other', answer: 'yes' })).status).toBe(409);
    expect((await post({ id: d.question.id, answer: 'yes' })).status).toBe(200);
    expect(await answer).toBe('yes');
  });

  it('renders the result, the dashboard link and the Repair button with MA.el', async () => {
    server = await startProgressServer(layout);
    const { base, token } = parts(server.url);
    server.begin('update', 'Update to version 0.2.0', UPDATE_PARTS);
    server.end({ state: 'done', result: 'Version 0.2.0 is installed.', oldRuns: null, canRepair: false, dashboard: 'http://127.0.0.1:4999/dashboard?token=abc' });
    const page = await runPageScript({ base, token }, [COMMON_JS, PROGRESS_JS]);
    await page.waitForText('The update is finished. Version 0.2.0 is installed.');
    const link = page.find((n) => n.tagName === 'A');
    expect(link?.getAttribute('href')).toBe('http://127.0.0.1:4999/dashboard?token=abc');
    expect(page.tags.has('script')).toBe(false);

    server.begin('update', 'Update to version 0.2.0', UPDATE_PARTS);
    let repairs = 0;
    server.onRepair(() => repairs++);
    server.end({ state: 'needs-repair', result: 'Going back failed.', oldRuns: false, canRepair: true, dashboard: null });
    const again = await runPageScript({ base, token }, [COMMON_JS, PROGRESS_JS]);
    await again.waitForText('The agent does not run now.');
    await again.button('Repair').fire('click');
    for (let i = 0; i < 100 && repairs === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(repairs).toBe(1);
  });
});
