// src/web/server.ts
// Local, authenticated status page. Binds loopback only; every request is checked for Host (DNS rebinding),
// then for a session cookie. Nothing here logs tokens, cookies or bodies.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Snapshot } from '../status/snapshot.js';
import { redactSecrets } from '../safety/redact.js';
import { validateSendText } from '../platform/tmux.js';
import { renderPage } from './page.js';

export interface WebDeps {
  token: string; // validated by caller, length >= 24
  port: number;
  getSnapshot: () => Promise<Snapshot>;
  capture: () => Promise<string>; // pane text
  send: (text: string) => Promise<void>; // calls sendText
  now?: () => number;
  secrets?: string[]; // extra literal secret values to mask in the pane (token is always included)
}

export const STATUS_COMMANDS = ['limits', 'working', 'health'] as const;

const COOKIE = 'jobber_session';
const MAX_BODY = 4096;
const MAX_SESSIONS = 10;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const csp = (nonce: string): string =>
  `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
const LOGIN_FAIL_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Jobber</title></head><body style="font-family:system-ui,sans-serif;margin:16px"><p>Invalid token.</p><p><a href="/">Back to sign in</a></p></body></html>';
const LOCK_FAILS = 5;
const LOCK_WINDOW_MS = 10 * 60 * 1000;
const SEND_GAP_MS = 2000;
const PANE_LINES = 40;

export { redactSecrets };

const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

class BodyTooLarge extends Error {}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      reject(new BodyTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) {
        done = true;
        chunks.length = 0;
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (e) => {
      if (!done) reject(e);
    });
  });
}

export function createWebServer(deps: WebDeps): http.Server {
  const now = deps.now ?? Date.now;
  const tokenDigest = sha(deps.token);
  const sessions: { d: Buffer; at: number }[] = []; // sha256 of session ids, oldest first
  let failures: number[] = [];
  let lastSend = -Infinity;
  let server: http.Server;

  const maskList = (): string[] => [deps.token, ...(deps.secrets ?? [])];
  const port = (): number => deps.port || (server.address() as AddressInfo | null)?.port || 0;

  function hasSession(req: http.IncomingMessage): boolean {
    const raw = req.headers.cookie;
    if (!raw || raw.length > 2048) return false;
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i < 0 || part.slice(0, i).trim() !== COOKIE) continue;
      const value = part.slice(i + 1).trim();
      if (!/^[0-9a-f]{64}$/.test(value)) continue;
      const d = sha(value);
      const tn = now();
      for (let k = sessions.length - 1; k >= 0; k--) if (tn - sessions[k].at >= SESSION_TTL_MS) sessions.splice(k, 1);
      let hit = false;
      for (const s of sessions) if (timingSafeEqual(s.d, d)) hit = true; // scan all, no early exit
      if (hit) return true;
    }
    return false;
  }

  function respond(
    res: http.ServerResponse,
    nonce: string,
    status: number,
    body: string,
    type: string,
    extra: Record<string, string | string[]> = {},
  ): void {
    res.writeHead(status, {
      'Content-Type': type,
      'Content-Security-Policy': csp(nonce),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      ...extra,
    });
    res.end(body);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const nonce = randomBytes(16).toString('hex');
    const json = (status: number, obj: unknown, extra: Record<string, string | string[]> = {}) =>
      respond(res, nonce, status, JSON.stringify(obj), 'application/json; charset=utf-8', extra);
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0].split('#')[0];

    const host = req.headers.host ?? '';
    const p = port();
    if (host !== `127.0.0.1:${p}` && host !== `localhost:${p}`) {
      json(421, { error: 'misdirected request' });
      return;
    }

    const isLogin = path === '/login';
    const isRoot = path === '/';
    const authed = hasSession(req);

    if (!isLogin && !(isRoot && method === 'GET') && !authed) {
      json(401, { error: 'unauthorized' });
      return;
    }

    if (isRoot) {
      if (method !== 'GET') return json(405, { error: 'method not allowed' }, { Allow: 'GET' });
      respond(res, nonce, 200, renderPage({ nonce, authenticated: authed }), 'text/html; charset=utf-8');
      return;
    }

    if (isLogin) {
      if (method !== 'POST') return json(405, { error: 'method not allowed' }, { Allow: 'POST' });
      const t = now();
      failures = failures.filter((x) => t - x < LOCK_WINDOW_MS);
      if (failures.length >= LOCK_FAILS) return json(429, { error: 'too many attempts' });
      failures.push(t); // count the attempt before awaiting the body; cleared on success
      if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
        return json(415, { error: 'unsupported media type' });
      }
      let body: string;
      try {
        body = await readBody(req);
      } catch (e) {
        return json(e instanceof BodyTooLarge ? 413 : 400, { error: 'bad request' }, { Connection: 'close' });
      }
      const given = new URLSearchParams(body).get('token') ?? '';
      if (!timingSafeEqual(sha(given), tokenDigest)) {
        return respond(res, nonce, 401, LOGIN_FAIL_HTML, 'text/html; charset=utf-8');
      }
      failures = [];
      const sid = randomBytes(32).toString('hex');
      sessions.push({ d: sha(sid), at: t });
      while (sessions.length > MAX_SESSIONS) sessions.shift();
      respond(res, nonce, 303, '', 'text/plain; charset=utf-8', {
        Location: '/',
        'Set-Cookie': `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/`,
      });
      return;
    }

    if (path === '/api/status') {
      if (method !== 'GET') return json(405, { error: 'method not allowed' }, { Allow: 'GET' });
      try {
        const snapText = JSON.stringify(await deps.getSnapshot());
        // redact the serialized string: the replacement token is valid inside a JSON string
        respond(res, nonce, 200, redactSecrets(snapText, maskList(), { tokenLines: false }), 'application/json; charset=utf-8');
      } catch {
        json(500, { error: 'status unavailable' });
      }
      return;
    }

    if (path === '/api/pane') {
      if (method !== 'GET') return json(405, { error: 'method not allowed' }, { Allow: 'GET' });
      try {
        const raw = await deps.capture();
        const whole = redactSecrets(raw, maskList());
        json(200, { text: whole.split('\n').slice(-PANE_LINES).join('\n') });
      } catch {
        json(500, { error: 'pane unavailable' });
      }
      return;
    }

    if (path === '/api/send') {
      if (method !== 'POST') return json(405, { error: 'method not allowed' }, { Allow: 'POST' });
      if (req.headers.origin !== `http://${host}`) return json(403, { error: 'forbidden origin' });
      if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
        return json(415, { error: 'unsupported media type' });
      }
      let body: string;
      try {
        body = await readBody(req);
      } catch (e) {
        return json(e instanceof BodyTooLarge ? 413 : 400, { error: 'bad request' }, { Connection: 'close' });
      }
      let text: unknown;
      try {
        text = (JSON.parse(body) as { text?: unknown }).text;
      } catch {
        return json(400, { error: 'invalid json' });
      }
      if (typeof text !== 'string') return json(400, { error: 'invalid text' });
      const t = now();
      if (t - lastSend < SEND_GAP_MS) return json(429, { error: 'too fast' });
      try {
        validateSendText(text);
      } catch {
        return json(400, { error: 'invalid text' });
      }
      const trimmed = text.trimStart();
      if (trimmed.startsWith('/')) {
        // exact bare command only, no arguments
        const word = text.trim().slice(1);
        if (!(STATUS_COMMANDS as readonly string[]).includes(word)) return json(400, { error: 'command not allowed' });
      }
      lastSend = t; // claim the slot before awaiting so concurrent sends cannot both pass
      try {
        await deps.send(text);
      } catch {
        return json(500, { error: 'send failed' });
      }
      return json(200, { ok: true });
    }

    json(404, { error: 'not found' });
  }

  server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        respond(res, randomBytes(16).toString('hex'), 500, '{"error":"internal"}', 'application/json; charset=utf-8');
      } else {
        res.end();
      }
    });
  });
  server.on('clientError', (_err, socket) => {
    if (!socket.writable) return;
    const body = '{"error":"bad request"}';
    socket.end(
      'HTTP/1.1 400 Bad Request\r\nContent-Type: application/json; charset=utf-8\r\n' +
        `Content-Security-Policy: ${csp(randomBytes(16).toString('hex'))}\r\n` +
        'X-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\n' +
        `Connection: close\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
    );
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  return server;
}

/** Create the server and listen on loopback only. */
export function startWebServer(deps: WebDeps): Promise<http.Server> {
  const server = createWebServer(deps);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
