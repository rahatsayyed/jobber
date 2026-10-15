// tests/web-token-login.test.ts
// Token login route: transport rule, Origin/Content-Type, throttle, cookie, reauth, and no-leak checks.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashToken, setToken } from '../src/dash/accessToken.js';
import { makeHarness, setCookies, type Harness, type Res } from './helpers/webHarness.js';

const TOKEN = 'T0kenValue_abcdefghijklmnopqrstuvwxyz0123456789ABC';
let h: Harness | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  if (h) await h.close();
  h = null;
});

async function mk(over: Record<string, unknown> = {}, store = true): Promise<Harness> {
  const x = await makeHarness(
    { authMode: 'token', oidc: undefined, oidcCfg: undefined, ...over } as never,
    { allow: false },
  );
  if (store) setToken(x.auth, TOKEN, x.now());
  return x;
}

function post(x: Harness, body: unknown, headers: Record<string, string> = {}, raw?: string): Promise<Res> {
  return x.call('POST', '/auth/token', {
    headers: {
      origin: `http://127.0.0.1:${x.port}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: raw ?? JSON.stringify(body),
  });
}

const sessionCookie = (r: Res): string =>
  setCookies(r).map((c) => c.split(';')[0]).find((c) => /jobber_session=/.test(c)) ?? '';

describe('token login', () => {
  it('correct token gives an HttpOnly session cookie that authorizes /api/session', async () => {
    h = await mk();
    const r = await post(h, { token: TOKEN });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });
    const raw = setCookies(r).find((c) => c.startsWith('jobber_session='))!;
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Lax/);
    expect(raw).toMatch(/Path=\//);
    expect(raw).not.toMatch(/Secure/);
    const s = await h.call('GET', '/api/session', { headers: { cookie: sessionCookie(r) } });
    expect(s.status).toBe(200);
  });

  it('wrong token is a generic 401, identical when no token is stored', async () => {
    h = await mk();
    const a = await post(h, { token: 'wrong' });
    expect(a.status).toBe(401);
    expect(a.body).toBe('{"error":"denied"}');
    const g = await mk({}, false);
    const b = await post(g, { token: TOKEN });
    expect(b.status).toBe(401);
    expect(b.body).toBe(a.body);
    await g.close();
  });

  it('10 wrong tokens lock the ip, correct token also 429, other ip unaffected', async () => {
    h = await mk({ trustProxy: true });
    const hdr = (ip: string): Record<string, string> => ({
      'x-forwarded-proto': 'https', 'x-forwarded-for': ip, origin: `https://127.0.0.1:${h!.port}`,
    });
    for (let i = 0; i < 10; i++) expect((await post(h, { token: 'bad' }, hdr('9.9.9.9'))).status).toBe(401);
    const locked = await post(h, { token: TOKEN }, hdr('9.9.9.9'));
    expect(locked.status).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await post(h, { token: TOKEN }, hdr('8.8.8.8'))).status).toBe(200);
  });

  it('global lock at 20 failures across ips', async () => {
    h = await mk({ trustProxy: true });
    const hdr = (ip: string): Record<string, string> => ({
      'x-forwarded-proto': 'https', 'x-forwarded-for': ip, origin: `https://127.0.0.1:${h!.port}`,
    });
    for (let i = 0; i < 20; i++) await post(h, { token: 'bad' }, hdr(`10.0.0.${i}`));
    expect((await post(h, { token: TOKEN }, hdr('7.7.7.7'))).status).toBe(429);
  });

  it('wrong Origin and non-JSON content type are 403', async () => {
    h = await mk();
    expect((await post(h, { token: TOKEN }, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await post(h, { token: TOKEN }, { 'content-type': 'text/plain' })).status).toBe(403);
    const noOrigin = await h.call('POST', '/auth/token', {
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }),
    });
    expect(noOrigin.status).toBe(403);
  });

  it('body over 1 KiB is refused without echo', async () => {
    h = await mk();
    const big = JSON.stringify({ token: 'ZZZZ'.repeat(400) });
    const r = await post(h, null, {}, big);
    expect([400, 413]).toContain(r.status);
    expect(r.body).not.toContain('ZZZZ');
  });

  it('a token in the query string does not log in', async () => {
    h = await mk();
    for (const p of [`/?token=${TOKEN}`, `/api/session?token=${TOKEN}`]) {
      const r = await h.call('GET', p);
      expect(sessionCookie(r)).toBe('');
    }
    expect((await h.call('GET', `/api/session?token=${TOKEN}`)).status).toBe(401);
  });

  it('forwarding header on a loopback socket without trustProxy is insecure_transport', async () => {
    h = await mk();
    const r = await post(h, { token: TOKEN }, { 'x-forwarded-for': '1.2.3.4' });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toEqual({ error: 'insecure_transport' });
    const rows = h.auth.prepare("SELECT note FROM audit_log WHERE kind = 'token_login_denied'").all() as { note: string }[];
    expect(rows.map((x) => x.note)).toContain('insecure_transport');
    expect((await post(h, { token: TOKEN }, { forwarded: 'for=1.2.3.4' })).status).toBe(403);
  });

  it('trustProxy with x-forwarded-proto https gives a Secure __Host- cookie', async () => {
    h = await mk({ trustProxy: true });
    const r = await post(h, { token: TOKEN }, {
      'x-forwarded-proto': 'https', origin: `https://127.0.0.1:${h.port}`,
    });
    expect(r.status).toBe(200);
    const raw = setCookies(r).find((c) => c.startsWith('__Host-'))!;
    expect(raw).toMatch(/Secure/);
    expect(raw).toMatch(/HttpOnly/);
  });

  it('reauth refreshes auth_at without a new cookie, and needs a session', async () => {
    h = await mk();
    const first = await post(h, { token: TOKEN });
    const cookie = sessionCookie(first);
    h.clock.t += 5 * 60_000;
    const r = await post(h, { token: TOKEN, reauth: true }, { cookie });
    expect(r.status).toBe(200);
    expect(setCookies(r)).toEqual([]);
    const s = JSON.parse((await h.call('GET', '/api/session', { headers: { cookie } })).body);
    expect(Date.parse(s.authAt)).toBe(h.clock.t);
    const none = await post(h, { token: TOKEN, reauth: true });
    expect(none.status).toBe(401);
  });

  it('a second login revokes the presented session cookie', async () => {
    h = await mk();
    const c1 = sessionCookie(await post(h, { token: TOKEN }));
    const c2 = sessionCookie(await post(h, { token: TOKEN }, { cookie: c1 }));
    expect(c2).not.toBe(c1);
    expect((await h.call('GET', '/api/session', { headers: { cookie: c1 } })).status).toBe(401);
    expect((await h.call('GET', '/api/session', { headers: { cookie: c2 } })).status).toBe(200);
  });

  it('token mode: auth mode route, login and callback 404, reauth url', async () => {
    h = await mk();
    expect(JSON.parse((await h.call('GET', '/api/auth/mode')).body)).toEqual({ mode: 'token' });
    expect((await h.call('GET', '/auth/login')).status).toBe(404);
    expect((await h.call('GET', '/auth/callback?code=a&state=b')).status).toBe(404);
  });

  it('oidc mode: POST /auth/token is 404 and mode says oidc', async () => {
    h = await makeHarness({ authMode: 'oidc' });
    expect((await post(h, { token: TOKEN })).status).toBe(404);
    expect(JSON.parse((await h.call('GET', '/api/auth/mode')).body)).toEqual({ mode: 'oidc' });
  });

  it('oidc or google_desktop mode without oidc throws at construction', async () => {
    await expect(mk({ authMode: 'oidc' })).rejects.toThrow();
    await expect(mk({ authMode: 'google_desktop' })).rejects.toThrow();
  });
});

describe('no leak', () => {
  it('token and its hash appear in no log, audit row or API response', async () => {
    h = await mk({ chat: { enabled: false, session: 'ccgram', window: 'JobApplier', send: async () => {} } });
    const spies = [
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
    ];
    await post(h, { token: 'not-the-token-but-long-enough' });
    const ok = await post(h, { token: TOKEN });
    const cookie = sessionCookie(ok);
    const th = hashToken(TOKEN);
    const texts: string[] = [ok.body];
    for (const p of ['/api/status', '/api/config', '/api/audit', '/api/session']) {
      const r = await h.call('GET', p, { headers: { cookie } });
      expect(r.status).toBe(200);
      texts.push(r.body);
    }
    for (const t of texts) {
      expect(t).not.toContain(TOKEN);
      expect(t).not.toContain(th);
    }
    const rows = JSON.stringify(h.auth.prepare('SELECT * FROM audit_log').all());
    expect(rows).not.toContain(TOKEN);
    expect(rows).not.toContain(th);
    expect(rows).not.toContain('not-the-token');
    for (const s of spies) for (const call of s.mock.calls) {
      const line = JSON.stringify(call);
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(th);
    }
  });

  it('stale token session: chat reauth_required url is the hash route', async () => {
    h = await mk({ chat: { enabled: true, session: 's', window: 'w', send: async () => {} } });
    const cookie = sessionCookie(await post(h, { token: TOKEN }));
    const sess = JSON.parse((await h.call('GET', '/api/session', { headers: { cookie } })).body);
    h.auth.prepare('UPDATE sessions SET auth_at = ?').run(new Date(h.now().getTime() - 86_400_000).toISOString());
    const p = await h.call('POST', '/api/send/prepare', {
      headers: {
        cookie, 'x-csrf-token': sess.csrf, origin: `http://127.0.0.1:${h.port}`, 'content-type': 'application/json',
      },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(p.status).toBe(401);
    expect(JSON.parse(p.body)).toEqual({ error: 'reauth_required', url: '/#/login?reauth=1' });
  });
});
