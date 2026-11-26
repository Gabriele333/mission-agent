import type { RouteResponse } from '../server/index.js';

/**
 * The Content-Security-Policy of every page response (§J.3): scripts, styles and requests from
 * this server only, no inline script or style, nothing from outside, no framing.
 */
export const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
  "base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** Sends one of the static files of the pages, with the strict policy. */
export function sendPageFile(res: RouteResponse, contentType: string, body: string): void {
  const raw = res.raw;
  raw.statusCode = 200;
  raw.setHeader('Content-Type', contentType);
  raw.setHeader('Content-Security-Policy', PAGE_CSP);
  raw.setHeader('Content-Length', Buffer.byteLength(body));
  raw.end(body);
}

/** A refused request. The text is for the user and holds no secret value. */
export function fail(res: RouteResponse, status: number, error: string, extra: Record<string, unknown> = {}): void {
  res.json({ ok: false, error, ...extra }, status);
}

export function bodyObject(body: unknown): Record<string, unknown> | undefined {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
