import { readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalServer, type EventStream } from './server.js';
import { isServerAlive, pageUrl, readServerFile } from './server-file.js';
import { collectEvents, rawRequest, tempPaths, waitFor } from './test-helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function started(extra: Partial<Parameters<typeof createLocalServer>[0]> = {}) {
  const paths = tempPaths();
  const errors: unknown[] = [];
  const server = createLocalServer({ paths, onError: (err) => errors.push(err), ...extra });
  cleanups.push(() => paths.remove());
  cleanups.push(() => server.stop());
  const { port, token } = await server.start();
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${token}` };
  return { paths, server, port, token, base, auth, errors };
}

describe('server file', () => {
  it('writes port, token, pid and start time with mode 0600, and removes the file on stop', async () => {
    const { paths, server, port, token } = await started();
    const info = JSON.parse(readFileSync(paths.serverFile, 'utf8'));
    expect(info).toMatchObject({ port, token, pid: process.pid });
    expect(typeof info.startedAt).toBe('string');
    expect(statSync(paths.serverFile).mode & 0o777).toBe(0o600);
    // 32 random bytes in base64url are 43 characters.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readServerFile(paths)).toMatchObject({ port, token, pid: process.pid });
    await server.stop();
    expect(existsSync(paths.serverFile)).toBe(false);
    expect(readServerFile(paths)).toBeUndefined();
  });

  it('replaces an existing file and enforces the mode', async () => {
    const paths = tempPaths();
    cleanups.push(() => paths.remove());
    mkdirSync(paths.stateDir, { recursive: true });
    writeFileSync(paths.serverFile, 'old content that is not JSON\n', { mode: 0o644 });
    const server = createLocalServer({ paths });
    cleanups.push(() => server.stop());
    const { token } = await server.start();
    expect(statSync(paths.serverFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(paths.serverFile, 'utf8')).token).toBe(token);
  });

  it('creates a new token at each start', async () => {
    const paths = tempPaths();
    cleanups.push(() => paths.remove());
    const server = createLocalServer({ paths });
    const a = await server.start();
    await server.stop();
    const b = await server.start();
    cleanups.push(() => server.stop());
    expect(b.token).not.toBe(a.token);
  });

  it('readServerFile returns undefined for a file with invalid content', () => {
    const paths = tempPaths();
    cleanups.push(() => paths.remove());
    mkdirSync(paths.stateDir, { recursive: true });
    writeFileSync(paths.serverFile, JSON.stringify({ port: 'x', token: 't', pid: 1 }));
    expect(readServerFile(paths)).toBeUndefined();
  });

  it('isServerAlive is true for a running server and false after stop or with a wrong token', async () => {
    const { server, port, token } = await started();
    expect(await isServerAlive({ port, token })).toBe(true);
    expect(await isServerAlive({ port, token: 'wrong' })).toBe(false);
    await server.stop();
    expect(await isServerAlive({ port, token })).toBe(false);
  });

  it('listens on 127.0.0.1 only', async () => {
    const { port, token } = await started();
    // The same port on another local address is not served by this server.
    const other = await fetch(`http://[::1]:${port}/api/ping`, { headers: { authorization: `Bearer ${token}` } }).then(
      (r) => r.status,
      () => 'refused',
    );
    expect(other).not.toBe(200);
  });
});

describe('token', () => {
  it('answers 401 with no other information without a token and with a wrong token', async () => {
    const { base, auth } = await started();
    const none = await fetch(`${base}/api/ping`);
    expect(none.status).toBe(401);
    expect(await none.text()).toBe('Unauthorized');
    const wrong = await fetch(`${base}/api/ping`, { headers: { authorization: 'Bearer not-the-token' } });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toBe('Unauthorized');
    const other = await fetch(`${base}/api/ping`, { headers: { authorization: 'Basic abc' } });
    expect(other.status).toBe(401);
    const ok = await fetch(`${base}/api/ping`, { headers: auth });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, pid: process.pid });
  });

  it('answers 401 for an unknown path without a token, so paths cannot be probed', async () => {
    const { base } = await started();
    expect((await fetch(`${base}/no/such/path`)).status).toBe(401);
  });

  it('sets a cookie for a page opened with the token, then accepts the cookie', async () => {
    const { server, base, port, token } = await started();
    server.route('GET', '/setup', (_req, res) => res.html('<p>setup</p>'));

    const first = await fetch(pageUrl({ port, token }, '/setup'), { redirect: 'manual' });
    expect(first.status).toBe(303);
    expect(first.headers.get('location')).toBe('/setup');
    const cookie = first.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`mission_agent_${port}=${token}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');

    const page = await fetch(`${base}/setup`, { headers: { cookie: `mission_agent_${port}=${token}` } });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toBe('<p>setup</p>');

    const badQuery = await fetch(`${base}/setup?token=wrong`, { redirect: 'manual' });
    expect(badQuery.status).toBe(401);
    const badCookie = await fetch(`${base}/setup`, { headers: { cookie: `mission_agent_${port}=wrong` } });
    expect(badCookie.status).toBe(401);
  });

  it('keeps the other query parameters in the redirect, and refuses the query token on a POST', async () => {
    const { server, base, token } = await started();
    server.route('POST', '/api/thing', (_req, res) => res.json({ ok: true }));
    const first = await fetch(`${base}/dashboard?tab=runs&token=${token}`, { redirect: 'manual' });
    expect(first.headers.get('location')).toBe('/dashboard?tab=runs');
    const post = await fetch(`${base}/api/thing?token=${token}`, { method: 'POST' });
    expect(post.status).toBe(401);
  });
});

describe('Host and Origin checks', () => {
  it('refuses a request whose Host header is not the server itself', async () => {
    const { port, token } = await started();
    const auth = { authorization: `Bearer ${token}` };
    const evil = await rawRequest(port, { path: '/api/ping', headers: { ...auth, host: `evil.example:${port}` } });
    expect(evil.status).toBe(403);
    const wrongPort = await rawRequest(port, { path: '/api/ping', headers: { ...auth, host: `127.0.0.1:1` } });
    expect(wrongPort.status).toBe(403);
    const local = await rawRequest(port, { path: '/api/ping', headers: { ...auth, host: `localhost:${port}` } });
    expect(local.status).toBe(200);
    const ip = await rawRequest(port, { path: '/api/ping', headers: { ...auth, host: `127.0.0.1:${port}` } });
    expect(ip.status).toBe(200);
  });

  it('refuses a state-changing request from another origin, and allows its own origin and no origin', async () => {
    const { server, port, token } = await started();
    server.route('POST', '/api/thing', (_req, res) => res.json({ ok: true }));
    const headers = { authorization: `Bearer ${token}`, host: `127.0.0.1:${port}`, 'content-type': 'application/json' };
    const post = (origin?: string) =>
      rawRequest(port, {
        method: 'POST',
        path: '/api/thing',
        headers: origin === undefined ? headers : { ...headers, origin },
        body: '{}',
      });
    expect((await post('http://evil.example')).status).toBe(403);
    expect((await post('null')).status).toBe(403);
    expect((await post(`http://127.0.0.1:${port + 1}`)).status).toBe(403);
    expect((await post(`http://127.0.0.1:${port}`)).status).toBe(200);
    expect((await post(`http://localhost:${port}`)).status).toBe(200);
    expect((await post()).status).toBe(200);

    // A GET is not refused for its origin.
    const get = await rawRequest(port, { path: '/api/ping', headers: { ...headers, origin: 'http://evil.example' } });
    expect(get.status).toBe(200);
  });

  it('sends no CORS headers', async () => {
    const { port, token } = await started();
    const res = await rawRequest(port, {
      method: 'OPTIONS',
      path: '/api/ping',
      headers: { authorization: `Bearer ${token}`, host: `127.0.0.1:${port}`, origin: 'http://evil.example' },
    });
    expect(Object.keys(res.headers).some((h) => h.startsWith('access-control-'))).toBe(false);
    const get = await rawRequest(port, {
      path: '/api/ping',
      headers: { authorization: `Bearer ${token}`, host: `127.0.0.1:${port}`, origin: 'http://evil.example' },
    });
    expect(Object.keys(get.headers).some((h) => h.startsWith('access-control-'))).toBe(false);
  });
});

describe('routes', () => {
  it('passes decoded path parameters and the query to the handler', async () => {
    const { server, base, auth } = await started();
    server.route('GET', '/api/approvals/:id/parts/:part', (req, res) =>
      res.json({ params: req.params, q: req.query.get('q') }),
    );
    const res = await fetch(`${base}/api/approvals/apr_12%20ab/parts/x%2Fy?q=1`, { headers: auth });
    expect(await res.json()).toEqual({ params: { id: 'apr_12 ab', part: 'x/y' }, q: '1' });
    expect((await fetch(`${base}/api/approvals/a/parts`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/api/approvals/%E0%A4%A/parts/x`, { headers: auth })).status).toBe(400);
  });

  it('answers 404 for an unknown path and 405 for another method', async () => {
    const { base, auth } = await started();
    expect((await fetch(`${base}/api/nothing`, { headers: auth })).status).toBe(404);
    const res = await fetch(`${base}/api/ping`, { method: 'POST', headers: auth });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  it('answers HEAD with a GET route', async () => {
    const { base, auth } = await started();
    const res = await fetch(`${base}/api/ping`, { method: 'HEAD', headers: auth });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('parses a JSON body, and refuses invalid JSON and another content type', async () => {
    const { server, base, auth } = await started();
    server.route('POST', '/api/echo', (req, res) => res.json({ body: req.body ?? null }));
    const json = { ...auth, 'content-type': 'application/json' };
    const ok = await fetch(`${base}/api/echo`, { method: 'POST', headers: json, body: JSON.stringify({ a: 1 }) });
    expect(await ok.json()).toEqual({ body: { a: 1 } });
    const empty = await fetch(`${base}/api/echo`, { method: 'POST', headers: auth });
    expect(await empty.json()).toEqual({ body: null });
    const bad = await fetch(`${base}/api/echo`, { method: 'POST', headers: json, body: '{nope' });
    expect(bad.status).toBe(400);
    const form = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=1',
    });
    expect(form.status).toBe(415);
  });

  it('refuses a body larger than 1 MB and accepts one just under it', async () => {
    const { server, base, auth, port, token } = await started();
    server.route('POST', '/api/echo', (req, res) => res.json({ size: JSON.stringify(req.body).length }));
    const json = { ...auth, 'content-type': 'application/json' };
    const justUnder = JSON.stringify('x'.repeat(1024 * 1024 - 2));
    const ok = await fetch(`${base}/api/echo`, { method: 'POST', headers: json, body: justUnder });
    expect(ok.status).toBe(200);
    const tooBig = JSON.stringify('x'.repeat(1024 * 1024));
    const res = await fetch(`${base}/api/echo`, { method: 'POST', headers: json, body: tooBig });
    expect(res.status).toBe(413);

    // Without a Content-Length header the limit applies while the body is read.
    const chunked = await new Promise<number>((resolve, reject) => {
      import('node:http').then(({ request }) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/api/echo',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          },
          (r) => {
            r.resume();
            resolve(r.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.write('"');
        req.write('x'.repeat(600 * 1024));
        req.write('x'.repeat(600 * 1024));
        req.end('"');
      }, reject);
    });
    expect(chunked).toBe(413);
  });

  it('answers 500 with a plain message when a handler throws, and never the stack', async () => {
    const { server, base, auth, errors } = await started();
    server.route('GET', '/api/fail', () => {
      throw new Error('secret detail at /Users/someone/file.ts:12');
    });
    server.route('GET', '/api/fail-async', async () => {
      await Promise.resolve();
      throw new Error('async detail');
    });
    for (const path of ['/api/fail', '/api/fail-async']) {
      const res = await fetch(`${base}${path}`, { headers: auth });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toBe('Internal server error');
    }
    expect(errors).toHaveLength(2);
  });

  it('sends text with the right content type', async () => {
    const { server, base, auth } = await started();
    server.route('GET', '/api/text', (_req, res) => res.text('hello', 202));
    const res = await fetch(`${base}/api/text`, { headers: auth });
    expect(res.status).toBe(202);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('hello');
  });
});

describe('event stream', () => {
  it('sends events to the client, and stop() closes the stream', async () => {
    const { server, base, token } = await started();
    let opened: EventStream | undefined;
    let closedOnServer = false;
    server.route('GET', '/api/events', (_req, res) => {
      opened = res.stream();
      opened.onClose(() => {
        closedOnServer = true;
      });
      opened.send('hello', { n: 1 });
    });
    const client = await collectEvents(`${base}/api/events`, token);
    await waitFor(() => client.events.length === 1, 'the first event');
    opened?.send('line', { text: 'two\nlines' });
    await waitFor(() => client.events.length === 2, 'the second event');
    expect(client.events).toEqual([
      { event: 'hello', data: { n: 1 } },
      { event: 'line', data: { text: 'two\nlines' } },
    ]);
    await server.stop();
    await client.ended;
    expect(closedOnServer).toBe(true);
    expect(opened?.closed).toBe(true);
    expect(opened?.send('late', {})).toBe(false);
  });

  it('sends keep-alive lines and notices a client that goes away', async () => {
    const { server, base, token } = await started({ heartbeatMs: 20 });
    let closedOnServer = false;
    server.route('GET', '/api/events', (_req, res) => {
      res.stream().onClose(() => {
        closedOnServer = true;
      });
    });
    const res = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes(': ping')) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    await waitFor(() => closedOnServer, 'the server to see the closed stream');
  });
});
