// tests/dash-desktop-client.test.ts
// Verdict (task 1 of plan 8C). Checked offline: shape, endpoints, client reuse.
// NOT checked: Google accepting the redirect path (owner check L2).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { authUrlFor, parseDesktopKeys, redirectFor } from '../src/dash/desktopClient.js';
import { createOidc, type OidcConfig } from '../src/dash/oidc.js';
import { createFakeOidc } from './helpers/fakeOidc.js';

const load = (n: string): any => JSON.parse(readFileSync(new URL(`./fixtures/dash/${n}`, import.meta.url), 'utf8'));
const SECRET = 'FIXTURE-NOT-A-SECRET';
const desktop = () => load('gcp-oauth.desktop.json');

function withInstalled(over: Record<string, unknown>) {
  const d = desktop();
  return { installed: { ...d.installed, ...over } };
}

describe('parseDesktopKeys', () => {
  it('parses the desktop fixture', () => {
    const r = parseDesktopKeys(desktop());
    expect(r).toEqual({
      ok: true,
      client: {
        clientId: '000000000000-fixture.apps.googleusercontent.com',
        clientSecret: SECRET,
        authUri: 'https://accounts.google.com/o/oauth2/auth',
        tokenUri: 'https://oauth2.googleapis.com/token',
      },
    });
  });
  it('rejects a web client as not_desktop', () => {
    expect(parseDesktopKeys(load('gcp-oauth.web.json'))).toEqual({ ok: false, reason: 'not_desktop' });
  });
  it('rejects non-objects', () => {
    for (const v of [null, 'x', 3, [], undefined]) expect(parseDesktopKeys(v)).toEqual({ ok: false, reason: 'not_object' });
  });
  it('rejects extra top-level keys', () => {
    expect(parseDesktopKeys({ ...desktop(), web: {} })).toEqual({ ok: false, reason: 'not_desktop' });
  });
  it('flags missing fields', () => {
    const d = desktop();
    delete d.installed.client_secret;
    expect(parseDesktopKeys(d)).toEqual({ ok: false, reason: 'missing_field' });
    expect(parseDesktopKeys(withInstalled({ client_secret: '' }))).toEqual({ ok: false, reason: 'missing_field' });
    expect(parseDesktopKeys(withInstalled({ client_id: 'abc' }))).toEqual({ ok: false, reason: 'missing_field' });
    expect(parseDesktopKeys(withInstalled({ client_id: 5 }))).toEqual({ ok: false, reason: 'missing_field' });
  });
  it('rejects endpoints on other hosts or http', () => {
    const bad = [
      { token_uri: 'https://evil.example/token' },
      { token_uri: 'http://oauth2.googleapis.com/token' },
      { auth_uri: 'http://accounts.google.com/o/oauth2/auth' },
      { auth_uri: 'https://accounts.google.com.evil.test/x' },
      { token_uri: 'https://oauth2.googleapis.com@evil.test/token' },
      { auth_uri: 'not a url' },
    ];
    for (const o of bad) expect(parseDesktopKeys(withInstalled(o))).toEqual({ ok: false, reason: 'bad_endpoint' });
  });
  it('never leaks the secret in a reason', () => {
    const cases = [load('gcp-oauth.web.json'), withInstalled({ token_uri: 'https://evil.example/t' }), withInstalled({ client_id: 'x' }), null];
    for (const c of cases) expect(JSON.stringify(parseDesktopKeys(c))).not.toContain(SECRET);
  });
});

describe('redirectFor', () => {
  it('builds loopback IP-literal URLs', () => {
    expect(redirectFor('callback', 8787)).toBe('http://127.0.0.1:8787/auth/callback');
    expect(redirectFor('root', 8787)).toBe('http://127.0.0.1:8787/');
  });
});

describe('authUrlFor', () => {
  const r = parseDesktopKeys(desktop());
  if (!r.ok) throw new Error('fixture');
  it('carries PKCE S256, scope and redirect, never the secret', () => {
    const redirect = redirectFor('callback', 8787);
    const url = authUrlFor(r.client, redirect, 'st-1', 'chal-1');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/auth');
    const q = u.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe(r.client.clientId);
    expect(q.get('scope')).toBe('openid email');
    expect(q.get('redirect_uri')).toBe(redirect);
    expect(q.get('code_challenge')).toBe('chal-1');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('state')).toBe('st-1');
    expect(url).not.toContain('client_secret');
    expect(url).not.toContain(SECRET);
  });
});

describe('OIDC client reuse', () => {
  it('createOidc accepts the fixture client and redirect unchanged', async () => {
    const r = parseDesktopKeys(desktop());
    if (!r.ok) throw new Error('fixture');
    const ISS = 'https://accounts.google.com';
    const now = () => new Date('2026-10-15T12:00:00Z');
    const fake = await createFakeOidc({ issuer: ISS, clientId: r.client.clientId, now });
    const cfg: OidcConfig = {
      issuer: ISS,
      clientId: r.client.clientId,
      clientSecret: r.client.clientSecret,
      redirectUri: redirectFor('callback', 8787),
      reauthPrompt: 'login',
      maxAgeSec: 0,
    };
    const oidc = createOidc(cfg, { fetch: fake.fetch, now, random: (n) => randomBytes(n) });
    const a = await oidc.buildAuthRequest({ reauth: false });
    const q = new URL(a.url).searchParams;
    expect(q.get('redirect_uri')).toBe('http://127.0.0.1:8787/auth/callback');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toBeTruthy();
    expect(a.url).not.toContain(SECRET);
  });
});
