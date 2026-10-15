// tests/web-google-desktop.test.ts
// google_desktop mode (task 7 of plan 8C): keys loading, root shim, pinned-account flow, google-url CLI.
// Offline: fake OIDC provider, invented fixtures only. Google acceptance of the redirect is NOT tested here.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadDesktopKeys, keysFailureMessage, oidcConfigForDesktop } from '../src/dash/desktopClient.js';
import { validateRunnerConfig } from '../src/web/env.js';
import { main } from '../scripts/dashboard.js';
import { makeHarness, setCookies, type Harness } from './helpers/webHarness.js';

const fx = (n: string): string => readFileSync(new URL(`./fixtures/dash/${n}`, import.meta.url), 'utf8');
const SECRET = 'FIXTURE-NOT-A-SECRET';

let h: Harness | null = null;
afterEach(async () => {
  if (h) await h.close();
  h = null;
});

describe('loadDesktopKeys', () => {
  it('loads the desktop fixture through an injected readFile', () => {
    const r = loadDesktopKeys('keys.json', () => fx('gcp-oauth.desktop.json'));
    expect(r.ok).toBe(true);
  });
  it('wrong-type file returns not_desktop without echoing content', () => {
    const r = loadDesktopKeys('keys.json', () => fx('gcp-oauth.web.json'));
    expect(r).toEqual({ ok: false, reason: 'not_desktop' });
    expect(JSON.stringify(r)).not.toContain('secret');
  });
  it('unreadable and bad json give reason codes only', () => {
    expect(loadDesktopKeys('x', () => { throw new Error(`boom ${SECRET}`); })).toEqual({ ok: false, reason: 'unreadable' });
    expect(loadDesktopKeys('x', () => `{"installed": ${SECRET}`)).toEqual({ ok: false, reason: 'bad_json' });
  });
  it('failure message lists the fallbacks and has no content', () => {
    const m = keysFailureMessage('not_desktop');
    expect(m).toContain('not_desktop');
    expect(m).toMatch(/WEB_GOOGLE_REDIRECT_SHAPE=root.*WEB_AUTH_MODE=oidc.*token/);
  });
});

describe('oidcConfigForDesktop', () => {
  const k = loadDesktopKeys('k', () => fx('gcp-oauth.desktop.json'));
  if (!k.ok) throw new Error('fixture');
  it('root shape and callback shape', () => {
    const root = oidcConfigForDesktop(k.client, { port: 9001, shape: 'root', reauthMaxAgeSec: 120 });
    expect(root).toEqual({
      issuer: 'https://accounts.google.com',
      clientId: '000000000000-fixture.apps.googleusercontent.com',
      clientSecret: SECRET,
      redirectUri: 'http://127.0.0.1:9001/',
      reauthPrompt: 'select_account',
      maxAgeSec: 120,
    });
    const cb = oidcConfigForDesktop(k.client, { port: 9001, shape: 'callback', reauthMaxAgeSec: 300 });
    expect(cb.redirectUri).toBe('http://127.0.0.1:9001/auth/callback');
  });
});

describe('config rejects unsafe google_desktop', () => {
  it('trust proxy on loopback is rejected with scope google', () => {
    const r = validateRunnerConfig(
      { WEB_AUTH_MODE: 'google_desktop', DASHBOARD_ALLOWED_EMAIL: 'owner@example.test', WEB_TRUST_PROXY: 'true' },
      { accountStored: true },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.scope)).toEqual(['google']);
  });
  const base = { WEB_AUTH_MODE: 'google_desktop', DASHBOARD_ALLOWED_EMAIL: 'owner@example.test' };
  it('non-loopback bind is rejected', () => {
    const r = validateRunnerConfig(
      { ...base, WEB_BIND: '0.0.0.0', WEB_ALLOW_REMOTE_BIND: 'true' }, { accountStored: true },
    );
    expect(r.ok).toBe(false);
  });
  it('loopback is accepted', () => {
    expect(validateRunnerConfig(base, { accountStored: true }).ok).toBe(true);
  });
});

async function viaRoot(x: Harness, claims: Record<string, unknown>) {
  const s = await x.start();
  const nowSec = Math.floor(x.clock.t / 1000);
  x.fake.setIdToken(await x.fake.mint({ nonce: s.nonce, iat: nowSec, exp: nowSec + 300, ...claims }));
  const cb = await x.call('GET', `/?code=c1&state=${encodeURIComponent(s.state)}`, { headers: { cookie: s.oidcCookie } });
  const sess = setCookies(cb).map((c) => c.split(';')[0]).find((c) => /jobber_session=/.test(c)) ?? '';
  return { cb, sess };
}

describe('google_desktop server flow', () => {
  it('root shape: code flow signs in the allowed email and pins sub', async () => {
    h = await makeHarness({ authMode: 'google_desktop', googleRedirectShape: 'root' });
    const { cb, sess } = await viaRoot(h, {});
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/');
    expect(sess).not.toBe('');
    const s = await h.call('GET', '/api/session', { headers: { cookie: sess } });
    expect(s.status).toBe(200);
    const pinned = h.auth.prepare('SELECT sub FROM allowed_account').get() as { sub?: string } | undefined;
    expect(pinned?.sub ?? null).toBe('sub-1');
  });
  it('second sub with the same email is denied', async () => {
    h = await makeHarness({ authMode: 'google_desktop', googleRedirectShape: 'root' });
    expect((await viaRoot(h, {})).sess).not.toBe('');
    const r = await viaRoot(h, { sub: 'sub-2' });
    expect(r.sess).toBe('');
    expect(r.cb.headers.location).toBe('/#/denied');
    const rows = h.auth.prepare("SELECT note FROM audit_log WHERE kind = 'login_denied'").all() as { note: string }[];
    expect(rows.map((x) => x.note)).toContain('sub_mismatch');
  });
  it('unverified email is audited as login_denied', async () => {
    h = await makeHarness({ authMode: 'google_desktop', googleRedirectShape: 'root' });
    await viaRoot(h, { email_verified: false });
    const rows = h.auth.prepare("SELECT note FROM audit_log WHERE kind = 'login_denied'").all() as { note: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].note).toBe('unverified_email');
  });
  it('unverified email is denied', async () => {
    h = await makeHarness({ authMode: 'google_desktop', googleRedirectShape: 'root' });
    const r = await viaRoot(h, { email_verified: false });
    expect(r.sess).toBe('');
    expect(r.cb.headers.location).toBe('/#/denied');
  });
  it('root shape: plain GET / serves the shell', async () => {
    h = await makeHarness({ authMode: 'google_desktop', googleRedirectShape: 'root' });
    const r = await h.call('GET', '/');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
  });
  it('callback shape does not route GET / with code and state', async () => {
    h = await makeHarness({ authMode: 'google_desktop', googleRedirectShape: 'callback' });
    const r = await h.call('GET', '/?code=x&state=y');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.headers.location).toBeUndefined();
  });
  it('the shim is absent in oidc mode', async () => {
    h = await makeHarness({ authMode: 'oidc', googleRedirectShape: 'root' });
    const r = await h.call('GET', '/?code=x&state=y');
    expect(r.status).toBe(200);
    expect(r.headers.location).toBeUndefined();
  });
});

describe('dashboard google-url', () => {
  const run = async (env: Record<string, string>, file: string) => {
    const out: string[] = [];
    const errs: string[] = [];
    const code = await main(['google-url'], {
      env, stdout: (l) => out.push(l), stderr: (l) => errs.push(l), readFile: () => file,
    });
    return { code, out, errs };
  };
  it('prints the authorization URL with the redirect and no secret', async () => {
    const r = await run({ WEB_PORT: '8787', WEB_GOOGLE_REDIRECT_SHAPE: 'root' }, fx('gcp-oauth.desktop.json'));
    expect(r.code).toBe(0);
    const u = new URL(r.out[0]);
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8787/');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(r.out.join('\n')).not.toContain(SECRET);
    expect(r.out[1]).toContain('redirect_uri_mismatch');
  });
  it('callback shape by default', async () => {
    const r = await run({}, fx('gcp-oauth.desktop.json'));
    expect(new URL(r.out[0]).searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8787/auth/callback');
  });
  it('wrong-type keys file fails with a reason and no content', async () => {
    const r = await run({}, fx('gcp-oauth.web.json'));
    expect(r.code).toBe(1);
    expect(r.errs.join('\n')).toContain('not_desktop');
    expect(r.errs.join('\n')).not.toContain('secret');
    expect(r.out).toEqual([]);
  });
});
