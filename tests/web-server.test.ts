import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createWebServer, redactSecrets, type WebDeps } from '../src/web/server.js';
import { renderPage } from '../src/web/page.js';
import type { Snapshot } from '../src/status/snapshot.js';

const TOKEN = 'unit-test-token-0123456789abcdef';

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    generatedAt: '2026-10-14T00:00:00.000Z',
    ceilings: {} as Snapshot['ceilings'],
    dailyCounters: [],
    halts: [],
    queue: [],
    funnel: { discovered: 1, matched: 1, contacted: 0, replied: 0, interview: 0, offer: 0 },
    lastSend: null,
    degraded: [],
    ...over,
  };
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let open: http.Server[] = [];
afterEach(async () => {
  await Promise.all(open.map((s) => new Promise((r) => s.close(() => r(null)))));
  open = [];
});

async function start(over: Partial<WebDeps> = {}) {
  let clock = 1_000_000;
  const send = vi.fn(async (_t: string) => {});
  const deps: WebDeps = {
    token: TOKEN,
    port: 0,
    getSnapshot: async () => snap(),
    capture: async () => 'hello pane',
    send,
    now: () => clock,
    ...over,
  };
  const server = createWebServer(deps);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  open.push(server);
  const port = (server.address() as AddressInfo).port;
  function call(
    method: string,
    path: string,
    opts: { headers?: Record<string, string>; body?: string | Buffer } = {},
  ): Promise<Res> {
    return new Promise((resolve, reject) => {
      const r = http.request(
        { host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...opts.headers } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      r.on('error', reject);
      if (opts.body !== undefined) r.write(opts.body);
      r.end();
    });
  }
  const form = (token: string) => ({
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `token=${encodeURIComponent(token)}`,
  });
  async function login(): Promise<string> {
    const r = await call('POST', '/login', form(TOKEN));
    expect(r.status).toBe(303);
    const sc = String(r.headers['set-cookie']?.[0] ?? '');
    return sc.split(';')[0];
  }
  const sendJson = (cookie: string, text: unknown, extra: Record<string, string> = {}) =>
    call('POST', '/api/send', {
      headers: {
        cookie,
        origin: `http://127.0.0.1:${port}`,
        'content-type': 'application/json',
        ...extra,
      },
      body: JSON.stringify({ text }),
    });
  return { call, form, login, sendJson, send, port, advance: (ms: number) => (clock += ms) };
}

describe('web server', () => {
  it('rejects a wrong Host with 421', async () => {
    const s = await start();
    const r = await s.call('GET', '/', { headers: { host: 'evil.example:80' } });
    expect(r.status).toBe(421);
  });

  it('requires a cookie for api routes', async () => {
    const s = await start();
    expect((await s.call('GET', '/api/status')).status).toBe(401);
    expect((await s.call('GET', '/api/pane')).status).toBe(401);
    expect((await s.call('GET', '/nope')).status).toBe(401);
  });

  it('wrong token 401 then lockout 429', async () => {
    const s = await start();
    for (let i = 0; i < 5; i++) expect((await s.call('POST', '/login', s.form('bad' + i))).status).toBe(401);
    expect((await s.call('POST', '/login', s.form('bad'))).status).toBe(429);
    expect((await s.call('POST', '/login', s.form(TOKEN))).status).toBe(429);
    s.advance(10 * 60 * 1000 + 1);
    expect((await s.call('POST', '/login', s.form(TOKEN))).status).toBe(303);
  });

  it('login sets a hardened cookie and status works', async () => {
    const s = await start();
    const r = await s.call('POST', '/login', s.form(TOKEN));
    const sc = String(r.headers['set-cookie']?.[0]);
    expect(sc).toMatch(/^jobber_session=[0-9a-f]{64};/);
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('SameSite=Strict');
    expect(sc).toContain('Path=/');
    const cookie = sc.split(';')[0];
    const st = await s.call('GET', '/api/status', { headers: { cookie } });
    expect(st.status).toBe(200);
    expect(JSON.parse(st.body).funnel.discovered).toBe(1);
  });

  it('login rejects wrong content type and oversize body', async () => {
    const s = await start();
    const ct = await s.call('POST', '/login', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(ct.status).toBe(415);
    const big = await s.call('POST', '/login', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=' + 'a'.repeat(5000),
    });
    expect(big.status).toBe(413);
  });

  it('keeps at most 10 sessions, dropping the oldest', async () => {
    const s = await start();
    const first = await s.login();
    for (let i = 0; i < 10; i++) await s.login();
    expect((await s.call('GET', '/api/status', { headers: { cookie: first } })).status).toBe(401);
  });

  it('status errors do not leak the message', async () => {
    const s = await start({
      getSnapshot: async () => {
        throw new Error('secret db path /x/y');
      },
    });
    const cookie = await s.login();
    const r = await s.call('GET', '/api/status', { headers: { cookie } });
    expect(r.status).toBe(500);
    expect(JSON.parse(r.body)).toEqual({ error: 'status unavailable' });
  });

  it('send: bad Origin 403, wrong content type 415', async () => {
    const s = await start();
    const cookie = await s.login();
    expect((await s.sendJson(cookie, '/limits', { origin: 'http://evil.example' })).status).toBe(403);
    const noOrigin = await s.call('POST', '/api/send', {
      headers: { cookie, 'content-type': 'application/json' },
      body: '{"text":"/limits"}',
    });
    expect(noOrigin.status).toBe(403);
    const ct = await s.call('POST', '/api/send', {
      headers: { cookie, origin: `http://127.0.0.1:${s.port}`, 'content-type': 'text/plain' },
      body: '{"text":"/limits"}',
    });
    expect(ct.status).toBe(415);
    expect(s.send).not.toHaveBeenCalled();
  });

  it('send: over 4096 bytes 413', async () => {
    const s = await start();
    const cookie = await s.login();
    const r = await s.sendJson(cookie, 'a'.repeat(5000));
    expect(r.status).toBe(413);
    expect(s.send).not.toHaveBeenCalled();
  });

  it('send: bang and unknown slash commands are 400', async () => {
    const s = await start();
    const cookie = await s.login();
    expect((await s.sendJson(cookie, '!ls')).status).toBe(400);
    s.advance(3000);
    expect((await s.sendJson(cookie, '/login-as-admin')).status).toBe(400);
    s.advance(3000);
    expect((await s.sendJson(cookie, '/limits-extra')).status).toBe(400);
    s.advance(3000);
    expect((await s.sendJson(cookie, '/')).status).toBe(400);
    s.advance(3000);
    expect((await s.sendJson(cookie, 42)).status).toBe(400);
    s.advance(3000);
    expect((await s.sendJson(cookie, '')).status).toBe(400);
    expect(s.send).not.toHaveBeenCalled();
  });

  it('send: /limits goes through once, second within 2s is 429', async () => {
    const s = await start();
    const cookie = await s.login();
    const r = await s.sendJson(cookie, '/limits');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.send).toHaveBeenCalledWith('/limits');
    expect((await s.sendJson(cookie, '/limits')).status).toBe(429);
    expect(s.send).toHaveBeenCalledTimes(1);
    s.advance(2001);
    expect((await s.sendJson(cookie, '/health now')).status).toBe(200);
    expect(s.send).toHaveBeenCalledTimes(2);
  });

  it('send failure returns 500 without leaking', async () => {
    const s = await start({
      send: async () => {
        throw new Error('tmux exploded at /secret');
      },
    });
    const cookie = await s.login();
    const r = await s.sendJson(cookie, 'hello');
    expect(r.status).toBe(500);
    expect(r.body).not.toContain('secret');
  });

  it('pane output is last 40 lines with secrets redacted', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line${i}`);
    lines[59] = 'key sk-abcdefghijklmnopqrstuvwxyz0123 end';
    lines[58] = 'WEB_TOKEN=whatever';
    lines[57] = `echo ${TOKEN}`;
    const s = await start({ capture: async () => lines.join('\n') });
    const cookie = await s.login();
    const r = await s.call('GET', '/api/pane', { headers: { cookie } });
    expect(r.status).toBe(200);
    const text = JSON.parse(r.body).text as string;
    expect(text).not.toContain('sk-abc');
    expect(text).not.toContain('WEB_TOKEN');
    expect(text).not.toContain(TOKEN);
    expect(text).toContain('[redacted]');
    expect(text).not.toContain('line0\n');
    expect(text).toContain('line20');
    expect(text.split('\n').length).toBe(40);
  });

  it('page html has no innerHTML and requires nonce in CSP', async () => {
    const s = await start();
    const cookie = await s.login();
    const r = await s.call('GET', '/', { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.body).not.toMatch(/innerhtml/i);
    const csp = String(r.headers['content-security-policy']);
    const nonce = /script-src 'nonce-([0-9a-f]+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(r.body).toContain(`<script nonce="${nonce}">`);
    expect(renderPage({ nonce: 'abc', authenticated: true })).not.toMatch(/innerhtml/i);
  });

  it('unauthenticated GET / is the login form without a script', async () => {
    const s = await start();
    const r = await s.call('GET', '/');
    expect(r.status).toBe(200);
    expect(r.body).toContain('name="token"');
    expect(r.body).not.toContain('<script');
  });

  it('security headers on every response including errors', async () => {
    const s = await start();
    const cookie = await s.login();
    const rs = [
      await s.call('GET', '/api/status'),
      await s.call('GET', '/', { headers: { host: 'evil:1' } }),
      await s.call('GET', '/nope', { headers: { cookie } }),
      await s.call('PUT', '/api/status', { headers: { cookie } }),
      await s.call('POST', '/login', s.form('x')),
    ];
    for (const r of rs) {
      expect(String(r.headers['content-security-policy'])).toContain("default-src 'none'");
      expect(String(r.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
    }
  });

  it('unknown route 404 and wrong method 405 when authenticated', async () => {
    const s = await start();
    const cookie = await s.login();
    expect((await s.call('GET', '/nope', { headers: { cookie } })).status).toBe(404);
    expect((await s.call('PUT', '/api/status', { headers: { cookie } })).status).toBe(405);
    expect((await s.call('GET', '/api/send', { headers: { cookie } })).status).toBe(405);
    expect((await s.call('GET', '/login')).status).toBe(405);
  });
});

describe('redactSecrets', () => {
  it('replaces secret shapes and WEB_TOKEN lines', () => {
    const out = redactSecrets('a ghp_abcdefghijklmnopqrstuvwx b\nWEB_TOKEN=1\nAKIAABCDEFGHIJKLMNOP');
    expect(out).toBe('a [redacted] b\n[redacted]\n[redacted]');
  });
  it('handles repeated matches (global regex state)', () => {
    const s = 'sk-abcdefghijklmnopqrstuv sk-abcdefghijklmnopqrstuv';
    expect(redactSecrets(s)).toBe('[redacted] [redacted]');
    expect(redactSecrets(s)).toBe('[redacted] [redacted]');
  });
});
