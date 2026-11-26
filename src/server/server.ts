import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Paths } from '../paths.js';
import { removeServerFile, writeServerFile } from './server-file.js';

/**
 * The local HTTP server of the harness (§J.3). It listens on 127.0.0.1 only, and every request
 * must carry the token that it creates at each start. The terminal chat and the two local pages
 * use it.
 */

export const MAX_BODY_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 15_000;
const TOKEN_BYTES = 32;

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface LocalServerOptions {
  paths: Pick<Paths, 'stateDir' | 'serverFile'>;
  /** 0, the default, lets the operating system choose a free port. */
  port?: number;
  /** Called with the error of a handler, which the client never sees. */
  onError?: (err: unknown, where: string) => void;
  /** Default 1 MB. */
  maxBodyBytes?: number;
  /** Time between two keep-alive lines on an event stream. Default 15 seconds. */
  heartbeatMs?: number;
}

export interface RouteRequest {
  method: string;
  /** The path of the request, without the query. */
  path: string;
  /** The values of the `:name` parts of the route, decoded. */
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  /** The parsed JSON body. Undefined for GET and HEAD, and for an empty body. */
  body: unknown;
  raw: IncomingMessage;
}

export interface RouteResponse {
  json(value: unknown, status?: number): void;
  text(text: string, status?: number): void;
  html(html: string, status?: number): void;
  /** Starts a server-sent event stream. The response stays open until one side closes it. */
  stream(): EventStream;
  raw: ServerResponse;
}

export interface EventStream {
  /** Sends one event with JSON data. Returns false when the stream is closed. */
  send(event: string, data: unknown): boolean;
  close(): void;
  /** Called once, when the client goes away or the stream is closed. */
  onClose(listener: () => void): void;
  readonly closed: boolean;
}

export type RouteHandler = (req: RouteRequest, res: RouteResponse) => void | Promise<void>;

export interface LocalServer {
  /** Adds a route. A path part `:name` matches one part of the request path. Can be called at any time. */
  route(method: HttpMethod, path: string, handler: RouteHandler): void;
  /** Listens, creates the token and writes `state/server`. */
  start(): Promise<{ port: number; token: string }>;
  /** Closes the event streams and the connections, and removes `state/server`. */
  stop(): Promise<void>;
  /** Undefined before start and after stop. */
  readonly port: number | undefined;
}

interface Route {
  method: string;
  parts: string[];
  handler: RouteHandler;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createLocalServer(options: LocalServerOptions): LocalServer {
  const maxBody = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const routes: Route[] = [];
  const streams = new Set<EventStream>();
  let server: Server | undefined;
  let port: number | undefined;
  let token: string | undefined;

  function route(method: HttpMethod, path: string, handler: RouteHandler): void {
    if (!path.startsWith('/')) throw new Error(`A route path must start with "/": ${path}`);
    routes.push({ method, parts: splitPath(path), handler });
  }

  route('GET', '/api/ping', (_req, res) => res.json({ ok: true, pid: process.pid }));

  function reportError(err: unknown, where: string): void {
    try {
      options.onError?.(err, where);
    } catch {
      // A failing error listener must not break the server.
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setCommonHeaders(res);
    const currentPort = port;
    const currentToken = token;
    if (currentPort === undefined || currentToken === undefined) return sendText(res, 503, 'Service unavailable');

    // A page from another site can reach 127.0.0.1 through DNS rebinding. Its Host header then
    // names the other site, so only our own two host names are accepted.
    const hostHeader = req.headers.host;
    if (hostHeader !== `127.0.0.1:${currentPort}` && hostHeader !== `localhost:${currentPort}`) {
      return sendText(res, 403, 'Forbidden');
    }

    const method = (req.method ?? 'GET').toUpperCase();
    const changes = method !== 'GET' && method !== 'HEAD';
    const origin = req.headers.origin;
    if (
      changes &&
      origin !== undefined &&
      origin !== `http://127.0.0.1:${currentPort}` &&
      origin !== `http://localhost:${currentPort}`
    ) {
      return sendText(res, 403, 'Forbidden');
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${currentPort}`);
    const cookieName = `mission_agent_${currentPort}`;
    const presented = presentedToken(req, cookieName);
    if (presented !== undefined) {
      if (!sameToken(presented, currentToken)) return sendText(res, 401, 'Unauthorized');
    } else {
      const fromQuery = url.searchParams.get('token');
      if (fromQuery === null || changes || !sameToken(fromQuery, currentToken)) {
        return sendText(res, 401, 'Unauthorized');
      }
      // A page opened with the token in its address: set the cookie, then load the same path
      // without the token, so it does not stay in the address bar and the history.
      url.searchParams.delete('token');
      const location = `/${url.pathname.replace(/^\/+/, '')}${url.search}`;
      res.setHeader('Set-Cookie', `${cookieName}=${currentToken}; HttpOnly; SameSite=Strict; Path=/`);
      res.setHeader('Location', location);
      return sendText(res, 303, 'See other');
    }

    const found = findRoute(routes, method, url.pathname);
    if (found === 'no-path') return sendText(res, 404, 'Not found');
    if (found === 'bad-path') return sendText(res, 400, 'Bad request');
    if (typeof found === 'string') {
      res.setHeader('Allow', found);
      return sendText(res, 405, 'Method not allowed');
    }

    let body: unknown;
    if (changes) {
      try {
        body = await readJsonBody(req, maxBody);
      } catch (err) {
        if (err instanceof HttpError) {
          if (err.status === 413) {
            // Stop reading the body and close the connection after the answer.
            res.setHeader('Connection', 'close');
            req.resume();
          }
          return sendText(res, err.status, err.message);
        }
        throw err;
      }
    }

    const routeReq: RouteRequest = {
      method,
      path: url.pathname,
      params: found.params,
      query: url.searchParams,
      headers: req.headers,
      body,
      raw: req,
    };
    await found.route.handler(routeReq, makeResponse(req, res));
  }

  function makeResponse(req: IncomingMessage, res: ServerResponse): RouteResponse {
    return {
      raw: res,
      json: (value, status = 200) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(value)),
      text: (text, status = 200) => sendText(res, status, text),
      html: (html, status = 200) => send(res, status, 'text/html; charset=utf-8', html),
      stream: () => openStream(req, res),
    };
  }

  function openStream(req: IncomingMessage, res: ServerResponse): EventStream {
    let closed = false;
    const listeners: Array<() => void> = [];
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    req.socket.setNoDelay(true);
    res.write(': connected\n\n');
    const timer = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, heartbeatMs);
    timer.unref();

    const stream: EventStream = {
      get closed() {
        return closed;
      },
      send(event, data) {
        if (closed) return false;
        if (!/^[A-Za-z0-9_.-]+$/.test(event)) throw new Error(`Invalid event name: ${event}`);
        // JSON.stringify escapes newlines, so the data is one line.
        res.write(`event: ${event}\ndata: ${JSON.stringify(data) ?? 'null'}\n\n`);
        return true;
      },
      close() {
        if (!closed) res.end();
        finish();
      },
      onClose(listener) {
        if (closed) listener();
        else listeners.push(listener);
      },
    };

    function finish(): void {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      streams.delete(stream);
      for (const listener of listeners.splice(0)) {
        try {
          listener();
        } catch (err) {
          reportError(err, 'event stream close listener');
        }
      }
    }

    res.on('close', finish);
    streams.add(stream);
    return stream;
  }

  async function start(): Promise<{ port: number; token: string }> {
    if (server) throw new Error('The local server is already started.');
    const s = createServer((req, res) => {
      handle(req, res).catch((err: unknown) => {
        reportError(err, `${req.method ?? ''} ${req.url ?? ''}`);
        if (!res.headersSent) sendText(res, 500, 'Internal server error');
        else res.destroy();
      });
    });
    server = s;
    try {
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.listen(options.port ?? 0, '127.0.0.1', () => {
          s.off('error', reject);
          resolve();
        });
      });
      const listening = (s.address() as AddressInfo).port;
      const newToken = randomBytes(TOKEN_BYTES).toString('base64url');
      writeServerFile(options.paths, {
        port: listening,
        token: newToken,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      });
      port = listening;
      token = newToken;
      return { port: listening, token: newToken };
    } catch (err) {
      server = undefined;
      await closeServer(s);
      throw err;
    }
  }

  async function stop(): Promise<void> {
    const s = server;
    if (!s) return;
    const oldToken = token;
    server = undefined;
    port = undefined;
    token = undefined;
    for (const stream of [...streams]) stream.close();
    if (oldToken !== undefined) removeServerFile(options.paths, oldToken);
    await closeServer(s);
  }

  return {
    route,
    start,
    stop,
    get port() {
      return port;
    },
  };
}

function closeServer(s: Server): Promise<void> {
  return new Promise((resolve) => {
    s.close(() => resolve());
    s.closeAllConnections();
  });
}

function setCommonHeaders(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  send(res, status, 'text/plain; charset=utf-8', text);
}

/** The token from the Authorization header, or else from the cookie. */
function presentedToken(req: IncomingMessage, cookieName: string): string | undefined {
  const auth = req.headers.authorization;
  if (auth !== undefined) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(auth);
    return match?.[1] ?? '';
  }
  const cookie = req.headers.cookie;
  if (cookie === undefined) return undefined;
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === cookieName) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Compares the SHA-256 of both values, so the time depends on neither the content nor the length. */
function sameToken(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function splitPath(path: string): string[] {
  return path.split('/').filter((p) => p !== '');
}

/**
 * Returns the route and its parameters, `no-path` when no route has this path, `bad-path` when
 * a parameter cannot be decoded, or the allowed methods when the path exists with other methods.
 */
function findRoute(
  routes: Route[],
  method: string,
  pathname: string,
): { route: Route; params: Record<string, string> } | 'no-path' | 'bad-path' | string {
  const parts = splitPath(pathname);
  const allowed = new Set<string>();
  let fallback: { route: Route; params: Record<string, string> } | undefined;
  for (const r of routes) {
    const params = matchParts(r.parts, parts);
    if (params === undefined) continue;
    if (params === null) return 'bad-path';
    if (r.method === method) return { route: r, params };
    // HEAD is answered by a GET route. Node sends the headers without the body.
    if (method === 'HEAD' && r.method === 'GET' && fallback === undefined) fallback = { route: r, params };
    allowed.add(r.method);
  }
  if (fallback) return fallback;
  return allowed.size === 0 ? 'no-path' : [...allowed].join(', ');
}

/** Undefined when the path does not match, null when a parameter cannot be decoded. */
function matchParts(pattern: string[], parts: string[]): Record<string, string> | undefined | null {
  if (pattern.length !== parts.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i] as string;
    const value = parts[i] as string;
    if (p.startsWith(':')) {
      try {
        params[p.slice(1)] = decodeURIComponent(value);
      } catch {
        return null;
      }
    } else if (p !== value) {
      return undefined;
    }
  }
  return params;
}

/** Reads the body up to the limit and parses it as JSON. An empty body gives undefined. */
async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const tooLarge = () => new HttpError(413, `The body is larger than ${limit} bytes.`);
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();

  const raw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.off('data', onData);
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.once('end', () => resolve(Buffer.concat(chunks)));
    req.once('error', reject);
  });
  if (raw.length === 0) return undefined;

  // Requiring JSON also means that a plain HTML form from another site cannot post here.
  const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'The body must be JSON (Content-Type: application/json).');
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'The body is not valid JSON.');
  }
}
