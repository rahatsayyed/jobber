import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cookiePair, insertJob, makeHarness, setCookies, type Harness } from './helpers/webHarness.js';
import { getAllowedAccount, listAudit } from '../src/dash/authStore.js';

let h: Harness | null = null;
afterEach(async () => {
  if (h) await h.close();
  h = null;
});

const DENIED = '/#/denied';
const auditKinds = (hh: Harness) => listAudit(hh.auth, 100).map((r) => `${r.kind}:${r.note ?? ''}`);
const attempts = (hh: Harness) =>
  (hh.auth.prepare('SELECT COUNT(*) AS n FROM login_attempts').get() as { n: number }).n;

async function authed(over: Parameters<typeof makeHarness>[0] = {}) {
  h = await makeHarness(over);
  const { cb, cookie } = await h.login();
  expect(cb.status).toBe(302);
  return { h, cookie };
}

describe('api requires a session', () => {
  it('every API route is 401 without a cookie', async () => {
    h = await makeHarness();
    const paths = [
      '/api/session', '/api/status', '/api/jobs', '/api/jobs/counts', '/api/jobs/abc', '/api/people',
      '/api/people/1/thread', '/api/emails', '/api/emails/1', '/api/followups', '/api/replies', '/api/outcomes',
      '/api/funnel', '/api/sessions', '/api/pane?window=JobApplier', '/api/runs', '/api/config', '/api/audit',
    ];
    for (const p of paths) {
      const r = await h.call('GET', p);
      expect(r.status, p).toBe(401);
      expect(JSON.parse(r.body)).toEqual({ error: 'unauthenticated' });
    }
    expect((await h.call('POST', '/api/logout')).status).toBe(401);
    expect((await h.call('GET', '/api/health')).status).toBe(200);
  });
});

describe('login flow', () => {
  it('full login sets a hardened cookie, pins the sub and audits', async () => {
    h = await makeHarness();
    const { cb } = await h.login();
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/');
    const c = setCookies(cb).find((x) => x.startsWith('jobber_session='))!;
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).not.toContain('Secure');
    expect(setCookies(cb).some((x) => x.startsWith('jobber_oidc=;'))).toBe(true);
    expect(getAllowedAccount(h.auth)?.sub).toBe('sub-1');
    const kinds = auditKinds(h);
    expect(kinds).toContain('login_ok:');
    expect(kinds).toContain('sub_pinned:');
  });

  it('login redirects only to the issuer and ignores next', async () => {
    h = await makeHarness();
    const r = await h.call('GET', '/auth/login?next=https://evil.example&return_to=/x');
    expect(r.status).toBe(302);
    const loc = new URL(String(r.headers.location));
    expect(loc.origin).toBe(h.fake.issuer);
    expect(loc.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8787/auth/callback');
    expect(String(r.headers.location)).not.toContain('evil.example');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('a replayed callback (same state) is denied', async () => {
    h = await makeHarness();
    const s = await h.start();
    const nowSec = Math.floor(h.clock.t / 1000);
    h.fake.setIdToken(await h.fake.mint({ nonce: s.nonce, iat: nowSec }));
    const url = `/auth/callback?code=c&state=${encodeURIComponent(s.state)}`;
    const first = await h.call('GET', url, { headers: { cookie: s.oidcCookie } });
    expect(first.headers.location).toBe('/');
    const second = await h.call('GET', url, { headers: { cookie: s.oidcCookie } });
    expect(second.status).toBe(302);
    expect(second.headers.location).toBe(DENIED);
    expect(auditKinds(h)).toContain('login_denied:state_unknown');
  });

  it('a state the browser did not start (no or wrong cookie) is denied', async () => {
    h = await makeHarness();
    const s = await h.start();
    const nowSec = Math.floor(h.clock.t / 1000);
    h.fake.setIdToken(await h.fake.mint({ nonce: s.nonce, iat: nowSec }));
    const url = `/auth/callback?code=c&state=${encodeURIComponent(s.state)}`;
    const none = await h.call('GET', url);
    expect(none.headers.location).toBe(DENIED);
    const wrong = await h.call('GET', url, { headers: { cookie: 'jobber_oidc=not-the-state' } });
    expect(wrong.headers.location).toBe(DENIED);
    expect(auditKinds(h).filter((k) => k === 'login_denied:state_cookie')).toHaveLength(2);
    // the pending login was not consumed by those, the real browser can still finish
    const ok = await h.call('GET', url, { headers: { cookie: s.oidcCookie } });
    expect(ok.headers.location).toBe('/');
  });

  it('bad tokens and accounts all give the same redirect with distinct audit reasons', async () => {
    h = await makeHarness();
    const nowSec = Math.floor(h.clock.t / 1000);
    const cases: [string, Record<string, unknown>, string][] = [
      ['other account', { email: 'someone@else.test' }, 'login_denied:email_mismatch'],
      ['unverified', { email_verified: false }, 'login_denied:unverified_email'],
      ['wrong nonce', { nonce: 'not-the-nonce' }, 'login_denied:nonce'],
      ['expired', { iat: nowSec - 4000, exp: nowSec - 1000 }, 'login_denied:claims'],
    ];
    for (const [, claims, expected] of cases) {
      const { cb } = await h.login(claims);
      expect(cb.status).toBe(302);
      expect(cb.headers.location).toBe(DENIED);
      expect(cb.headers.location).not.toContain('error');
      expect(auditKinds(h)).toContain(expected);
    }
    expect(getAllowedAccount(h.auth)?.sub).toBeNull();
  });

  it('a second login with the same email but a different sub is denied', async () => {
    h = await makeHarness();
    expect((await h.login()).cb.headers.location).toBe('/');
    const second = await h.login({ sub: 'sub-2' });
    expect(second.cb.headers.location).toBe(DENIED);
    expect(auditKinds(h)).toContain('login_denied:sub_mismatch');
    expect(second.cookie).toBe('');
  });

  it('provider error and missing code are denied', async () => {
    h = await makeHarness();
    const s = await h.start();
    const a = await h.call('GET', '/auth/callback?error=access_denied&state=x', { headers: { cookie: s.oidcCookie } });
    expect(a.headers.location).toBe(DENIED);
    const b = await h.call('GET', '/auth/callback?state=x', { headers: { cookie: s.oidcCookie } });
    expect(b.headers.location).toBe(DENIED);
    expect(auditKinds(h)).toEqual(expect.arrayContaining(['login_denied:provider_error', 'login_denied:no_code']));
  });

  it('provider down at login start: generic redirect, login_error audit', async () => {
    h = await makeHarness();
    h.fake.setDiscovery({ issuer: 'https://wrong.example' });
    const r = await h.call('GET', '/auth/login');
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(DENIED);
    expect(auditKinds(h)).toContain('login_error:discovery');
  });

  it('429 after 10 denied callbacks; blocked requests are not recorded and lockout audit is rate limited', async () => {
    h = await makeHarness();
    for (let i = 0; i < 10; i++) {
      const r = await h.call('GET', '/auth/callback?code=c&state=bad');
      expect(r.headers.location).toBe(DENIED);
    }
    expect(attempts(h)).toBe(10);
    const blocked = await h.call('GET', '/auth/callback?code=c&state=bad');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) expect((await h.call('GET', '/auth/callback?code=c&state=bad')).status).toBe(429);
    expect((await h.call('GET', '/auth/login')).status).toBe(429);
    expect(attempts(h)).toBe(10);
    expect(auditKinds(h).filter((k) => k.startsWith('lockout'))).toHaveLength(1);
    h.clock.t += 61_000;
    await h.call('GET', '/auth/login');
    expect(auditKinds(h).filter((k) => k.startsWith('lockout'))).toHaveLength(2);
  });

  it('Secure and __Host- cookies only with trustProxy and the forwarded proto header', async () => {
    h = await makeHarness({ trustProxy: true });
    const s = await h.start({ 'x-forwarded-proto': 'https' });
    const oc = setCookies(s.loginRes)[0];
    expect(oc.startsWith('__Host-jobber_oidc=')).toBe(true);
    expect(oc).toContain('Secure');
    expect(s.loginRes.headers['strict-transport-security']).toBeDefined();
    const { cb } = await h.login({}, { secure: true });
    const sc = setCookies(cb).find((x) => x.startsWith('__Host-jobber_session='))!;
    expect(sc).toContain('Secure');
    // without the header the same server stays plain
    const plain = await h.call('GET', '/auth/login');
    expect(setCookies(plain)[0].startsWith('jobber_oidc=')).toBe(true);
    expect(setCookies(plain)[0]).not.toContain('Secure');
    // without trustProxy the header is ignored
    const h2 = await makeHarness({ trustProxy: false });
    const r2 = await h2.call('GET', '/auth/login', { headers: { 'x-forwarded-proto': 'https' } });
    expect(setCookies(r2)[0]).not.toContain('Secure');
    expect(r2.headers['strict-transport-security']).toBeUndefined();
    await h2.close();
  });

  it('login with a forwarded for address records that ip only under trustProxy', async () => {
    h = await makeHarness({ trustProxy: true });
    await h.call('GET', '/auth/callback?code=c&state=bad', { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } });
    const ip = (h.auth.prepare('SELECT ip FROM login_attempts').get() as { ip: string }).ip;
    expect(ip).toBe('203.0.113.9');
  });

  it('logout revokes the session; the old cookie is 401', async () => {
    const { h: hh, cookie } = await authed();
    const sess = await hh.call('GET', '/api/session', { headers: { cookie } });
    expect(sess.status).toBe(200);
    const csrf = JSON.parse(sess.body).csrf as string;
    const out = await hh.call('POST', '/api/logout', {
      headers: { cookie, 'x-csrf-token': csrf, origin: `http://127.0.0.1:${hh.port}` },
    });
    expect(out.status).toBe(200);
    expect(setCookies(out)[0]).toContain('Max-Age=0');
    expect((await hh.call('GET', '/api/session', { headers: { cookie } })).status).toBe(401);
    expect(auditKinds(hh)).toContain('logout:');
  });

  it('a new login rotates an existing session cookie', async () => {
    h = await makeHarness();
    const first = await h.login();
    const s = await h.start({ cookie: first.cookie });
    const nowSec = Math.floor(h.clock.t / 1000);
    h.fake.setIdToken(await h.fake.mint({ nonce: s.nonce, iat: nowSec }));
    const cb = await h.call('GET', `/auth/callback?code=c&state=${encodeURIComponent(s.state)}`, {
      headers: { cookie: `${first.cookie}; ${s.oidcCookie}` },
    });
    expect(cb.headers.location).toBe('/');
    expect((await h.call('GET', '/api/session', { headers: { cookie: first.cookie } })).status).toBe(401);
  });

  it('re-auth needs a session, keeps it, refreshes authAt and audits reauth_ok', async () => {
    h = await makeHarness();
    expect((await h.call('GET', '/auth/login?reauth=1')).status).toBe(401);
    const { cookie } = await h.login();
    h.clock.t += 20 * 60_000;
    const before = JSON.parse((await h.call('GET', '/api/session', { headers: { cookie } })).body);
    expect(before.reauthRequired).toBe(true);
    const nowSec = Math.floor(h.clock.t / 1000);
    const re = await h.call('GET', '/auth/login?reauth=1', { headers: { cookie } });
    const loc = new URL(String(re.headers.location));
    expect(loc.searchParams.get('max_age')).toBe('0');
    const st = loc.searchParams.get('state')!;
    h.fake.setIdToken(await h.fake.mint({ nonce: loc.searchParams.get('nonce')!, iat: nowSec }));
    const oc = setCookies(re).map((c) => c.split(';')[0]).find((c) => /jobber_oidc=/.test(c))!;
    const cb = await h.call('GET', `/auth/callback?code=c&state=${encodeURIComponent(st)}`, {
      headers: { cookie: `${cookie}; ${oc}` },
    });
    expect(cb.headers.location).toBe('/');
    expect(cookiePair(cb, 'jobber_session')).toBeNull();
    const after = JSON.parse((await h.call('GET', '/api/session', { headers: { cookie } })).body);
    expect(after.reauthRequired).toBe(false);
    expect(auditKinds(h)).toContain('reauth_ok:');
  });
});

describe('pending login growth', () => {
  it('a flood of unauthenticated login starts keeps pending_login bounded', async () => {
    h = await makeHarness();
    for (let i = 0; i < 130; i++) {
      const r = await h.call('GET', '/auth/login');
      expect(r.status).toBe(302);
    }
    const n = (h.auth.prepare('SELECT COUNT(*) AS n FROM pending_login').get() as { n: number }).n;
    expect(n).toBeLessThanOrEqual(100);
  });
});

describe('csrf and origin', () => {
  it('session endpoint returns the csrf token; POST without it is 403, foreign origin 403, correct passes', async () => {
    const { h: hh, cookie } = await authed();
    const s = JSON.parse((await hh.call('GET', '/api/session', { headers: { cookie } })).body);
    expect(Object.keys(s).sort()).toEqual(['authAt', 'chatEnabled', 'csrf', 'expiresAt', 'reauthRequired']);
    const origin = `http://127.0.0.1:${hh.port}`;
    expect((await hh.call('POST', '/api/logout', { headers: { cookie, origin } })).status).toBe(403);
    expect((await hh.call('POST', '/api/logout', { headers: { cookie, origin, 'x-csrf-token': 'nope' } })).status).toBe(403);
    expect((await hh.call('POST', '/api/logout', { headers: { cookie, 'x-csrf-token': s.csrf } })).status).toBe(403);
    expect(
      (await hh.call('POST', '/api/logout', { headers: { cookie, 'x-csrf-token': s.csrf, origin: 'http://evil.example' } })).status,
    ).toBe(403);
    expect((await hh.call('GET', '/api/session', { headers: { cookie } })).status).toBe(200);
  });

  it('121st request within a minute is 429', async () => {
    const { h: hh, cookie } = await authed();
    let last = 0;
    for (let i = 0; i < 125; i++) {
      last = (await hh.call('GET', '/api/funnel', { headers: { cookie } })).status;
      if (last === 429) {
        expect(i).toBeGreaterThanOrEqual(115);
        return;
      }
    }
    throw new Error(`never limited, last ${last}`);
  });
});

describe('data routes', () => {
  it('limit is clamped to 100 and a hostile title stays an inert JSON string', async () => {
    const { h: hh, cookie } = await authed();
    for (let i = 0; i < 120; i++) insertJob(hh.data, `j${i}`, `Role ${i}`);
    insertJob(hh.data, 'xss', '<img src=x onerror=1>', 'Evil<script>');
    const r = await hh.call('GET', '/api/jobs?limit=100000', { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/json');
    const body = JSON.parse(r.body);
    expect(body.items.length).toBeLessThanOrEqual(100);
    const d = await hh.call('GET', '/api/jobs/xss', { headers: { cookie } });
    expect(JSON.parse(d.body).title).toBe('<img src=x onerror=1>');
    expect(d.headers['content-type']).toContain('application/json');
    expect((await hh.call('GET', '/api/jobs/counts', { headers: { cookie } })).status).toBe(200);
  });

  it('validates ids and buckets; unknown ids are 404', async () => {
    const { h: hh, cookie } = await authed();
    const hdr = { headers: { cookie } };
    expect((await hh.call('GET', '/api/jobs/bad%20id', hdr)).status).toBe(400);
    expect((await hh.call('GET', '/api/jobs?bucket=nope', hdr)).status).toBe(400);
    expect((await hh.call('GET', '/api/jobs/nothere', hdr)).status).toBe(404);
    expect((await hh.call('GET', '/api/people/abc/thread', hdr)).status).toBe(400);
    expect((await hh.call('GET', '/api/people/99999/thread', hdr)).status).toBe(404);
    expect((await hh.call('GET', '/api/emails/12abc', hdr)).status).toBe(400);
    expect((await hh.call('GET', '/api/emails/5', hdr)).status).toBe(404);
    expect((await hh.call('GET', '/api/jobs?bogus=1&limit=2', hdr)).status).toBe(200);
  });

  it('read routes return JSON shapes', async () => {
    const { h: hh, cookie } = await authed();
    const hdr = { headers: { cookie } };
    for (const p of ['/api/people', '/api/emails', '/api/followups', '/api/replies', '/api/outcomes', '/api/funnel', '/api/runs', '/api/status']) {
      const r = await hh.call('GET', p, hdr);
      expect(r.status, p).toBe(200);
      expect(() => JSON.parse(r.body)).not.toThrow();
    }
    const a = JSON.parse((await hh.call('GET', '/api/audit?limit=5', hdr)).body);
    expect(a.items.some((x: { kind: string }) => x.kind === 'login_ok')).toBe(true);
    expect(JSON.stringify(a)).not.toMatch(/state|nonce|verifier|cookie/i);
  });

  it('sessions lists configured windows; pane is redacted and window must belong to a session', async () => {
    const { h: hh, cookie } = await authed();
    const hdr = { headers: { cookie } };
    const s = JSON.parse((await hh.call('GET', '/api/sessions', hdr)).body);
    expect(s.sessions[0].session).toBe('ccgram');
    expect(s.sessions[0].windows[0].window).toBe('JobApplier');
    hh.paneText.value = 'ok line\nWEB_OIDC_CLIENT_SECRET=abcd efgh\nkey sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\nplanted-literal-9f3k end';
    const r = await hh.call('GET', '/api/pane?window=JobApplier', hdr);
    expect(r.status).toBe(200);
    expect(r.body).not.toContain('sk-ant-api03');
    expect(r.body).not.toContain('abcd efgh');
    expect((await hh.call('GET', '/api/pane?window=Other', hdr)).status).toBe(404);
    expect((await hh.call('GET', '/api/pane?window=a%3Bb', hdr)).status).toBe(400);
    expect((await hh.call('GET', '/api/pane', hdr)).status).toBe(400);
  });

  it('sessions panel masks a literal secret echoed in a pane line', async () => {
    const { h: hh, cookie } = await authed({ secrets: ['GOCSPX-literalsecret1234'] });
    hh.paneText.value = 'echo GOCSPX-literalsecret1234 done';
    const r = await hh.call('GET', '/api/sessions', { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.body).not.toContain('GOCSPX-literalsecret1234');
  });

  it('extra secret literals are masked in the pane and status', async () => {
    const { h: hh, cookie } = await authed({ secrets: ['planted-literal-9f3k'] });
    hh.paneText.value = 'before planted-literal-9f3k after';
    const r = await hh.call('GET', '/api/pane?window=JobApplier', { headers: { cookie } });
    expect(r.body).not.toContain('planted-literal-9f3k');
  });

  it('config view has no value for a planted client secret or app password', async () => {
    const root = mkdtempSync(join(tmpdir(), 'web-root-'));
    writeFileSync(join(root, '.env.example'), 'WEB_OIDC_CLIENT_SECRET=\nGMAIL_APP_PASSWORD=\nMATCH_THRESHOLD=60\n');
    const { h: hh, cookie } = await authed({
      root,
      env: { WEB_OIDC_CLIENT_SECRET: 'planted-oidc-secret-77', GMAIL_APP_PASSWORD: 'planted-gmail-pw-88', MATCH_THRESHOLD: '61' } as NodeJS.ProcessEnv,
      secrets: ['planted-oidc-secret-77', 'planted-gmail-pw-88'],
    });
    const r = await hh.call('GET', '/api/config', { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.body).not.toContain('planted-oidc-secret-77');
    expect(r.body).not.toContain('planted-gmail-pw-88');
    const v = JSON.parse(r.body);
    expect(v.env.find((e: { name: string }) => e.name === 'MATCH_THRESHOLD').value).toBe('61');
  });

  it('a handler failure is 500 internal with no detail', async () => {
    const { h: hh, cookie } = await authed();
    hh.data.close();
    const r = await hh.call('GET', '/api/status', { headers: { cookie } });
    expect(r.status).toBe(500);
    expect(JSON.parse(r.body)).toEqual({ error: 'internal' });
  });
});

describe('static frontend', () => {
  it('GET root serves the shell with the CSP header and every static file is reachable', async () => {
    h = await makeHarness();
    const root = await h.call('GET', '/');
    expect(root.status).toBe(200);
    expect(String(root.headers['content-type'])).toContain('text/html');
    expect(String(root.headers['content-security-policy'])).toContain("script-src 'self'");
    expect(root.body).toContain('<div id="app">');
    const { readdirSync, statSync } = await import('node:fs');
    const base = join(process.cwd(), 'src', 'web', 'static');
    const walk = (d: string, rel = ''): string[] =>
      readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n), `${rel}/${n}`) : [`${rel}/${n}`]));
    const want: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
    for (const p of walk(base)) {
      const url = p === '/index.html' ? '/' : p;
      const r = await h.call('GET', url);
      expect(r.status, url).toBe(200);
      expect(String(r.headers['content-type']), url).toContain(want[p.slice(p.lastIndexOf('.'))]);
    }
  });
});
