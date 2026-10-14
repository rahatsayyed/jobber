// src/web/router.ts
// Small helpers shared by the dashboard server and its route handlers: the per-request context, JSON replies
// with the security headers, and a bounded JSON body reader. No routing tables and no SQL live here.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionInfo } from '../dash/sessions.js';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  ip: string;
  secure: boolean;
  session: SessionInfo | null;
}
export type Handler = (ctx: Ctx) => Promise<void> | void;

/** Thrown by helpers to end a request with a status; the server turns it into `{error}` JSON. */
export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
    this.name = 'HttpError';
  }
}

const MAX_JSON_RESPONSE = 1024 * 1024;

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
  "form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** Headers set on every response, including errors. HSTS only when the request arrived over https. */
export function securityHeaders(secure: boolean): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
  if (secure) h['Strict-Transport-Security'] = 'max-age=31536000';
  return h;
}

export function applySecurityHeaders(res: ServerResponse, secure: boolean): void {
  for (const [k, v] of Object.entries(securityHeaders(secure))) res.setHeader(k, v);
}

export function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string | string[]> = {},
): void {
  let text = JSON.stringify(body);
  let code = status;
  if (text === undefined || Buffer.byteLength(text) > MAX_JSON_RESPONSE) {
    code = 500;
    text = '{"error":"internal"}';
  }
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(text);
}

export function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
      reject(new HttpError(415, 'unsupported media type'));
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new HttpError(413, 'payload too large'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) {
        done = true;
        chunks.length = 0;
        reject(new HttpError(413, 'payload too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid json'));
      }
    });
    req.on('error', (e) => {
      if (!done) reject(e);
    });
  });
}
