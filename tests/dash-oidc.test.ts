// tests/dash-oidc.test.ts
import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createOidc, OidcError, type OidcConfig } from '../src/dash/oidc.js';
import { createFakeOidc } from './helpers/fakeOidc.js';

const ISS = 'https://accounts.fake.test';
const T0 = new Date('2026-10-14T12:00:00Z');
const SECRET = 'super-secret-client-value';

function setup(over: Partial<OidcConfig> = {}) {
  const clock = { t: T0.getTime() };
  const now = () => new Date(clock.t);
  return createFakeOidc({ issuer: ISS, clientId: 'client-123', now }).then((fake) => {
    const cfg: OidcConfig = {
      issuer: ISS,
      clientId: 'client-123',
      clientSecret: SECRET,
      redirectUri: 'https://dash.example.test/auth/callback',
      reauthPrompt: 'login',
      maxAgeSec: 0,
      ...over,
    };
    const oidc = createOidc(cfg, { fetch: fake.fetch, now, random: (n) => randomBytes(n) });
    return { fake, oidc, clock, cfg };
  });
}

const sec = (d: Date) => Math.floor(d.getTime() / 1000);
async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    expect(e).toBeInstanceOf(OidcError);
    return (e as OidcError).code;
  }
}

describe('verifyIdToken', () => {
  it('accepts a good token', async () => {
    const { fake, oidc } = await setup();
    const tok = await fake.mint({ auth_time: sec(T0) });
    const r = await oidc.verifyIdToken(tok, { nonce: 'nonce-1' });
    expect(r).toMatchObject({ sub: 'sub-1', email: 'owner@example.test', emailVerified: true, iat: sec(T0), authTime: sec(T0) });
  });

  it('rejects wrong iss, aud, expired, azp', async () => {
    const { fake, oidc } = await setup();
    expect(await code(oidc.verifyIdToken(await fake.mint({ iss: 'https://evil.test' }), { nonce: 'nonce-1' }))).toBe('claims');
    expect(await code(oidc.verifyIdToken(await fake.mint({ aud: 'other' }), { nonce: 'nonce-1' }))).toBe('claims');
    expect(await code(oidc.verifyIdToken(await fake.mint({ exp: sec(T0) - 3600 }), { nonce: 'nonce-1' }))).toBe('claims');
    expect(await code(oidc.verifyIdToken(await fake.mint({ aud: ['client-123', 'x'], azp: 'x' }), { nonce: 'nonce-1' }))).toBe('claims');
    const ok = await oidc.verifyIdToken(await fake.mint({ aud: ['client-123', 'x'], azp: 'client-123' }), { nonce: 'nonce-1' });
    expect(ok.sub).toBe('sub-1');
  });

  it('rejects wrong or missing nonce', async () => {
    const { fake, oidc } = await setup();
    expect(await code(oidc.verifyIdToken(await fake.mint({ nonce: 'other' }), { nonce: 'nonce-1' }))).toBe('nonce');
    expect(await code(oidc.verifyIdToken(await fake.mint({}, { omit: ['nonce'] }), { nonce: 'nonce-1' }))).toBe('nonce');
  });

  it('rejects email_verified false, missing, or a string', async () => {
    const { fake, oidc } = await setup();
    expect(await code(oidc.verifyIdToken(await fake.mint({ email_verified: false }), { nonce: 'nonce-1' }))).toBe('unverified_email');
    expect(await code(oidc.verifyIdToken(await fake.mint({}, { omit: ['email_verified'] }), { nonce: 'nonce-1' }))).toBe('unverified_email');
    expect(await code(oidc.verifyIdToken(await fake.mint({ email_verified: 'true' }), { nonce: 'nonce-1' }))).toBe('unverified_email');
  });

  it('rejects empty email or sub', async () => {
    const { fake, oidc } = await setup();
    expect(await code(oidc.verifyIdToken(await fake.mint({ email: '' }), { nonce: 'nonce-1' }))).toBe('claims');
    expect(await code(oidc.verifyIdToken(await fake.mint({}, { omit: ['sub'] }), { nonce: 'nonce-1' }))).toBe('claims');
  });

  it('rejects a signature from another key, alg none and HS256 with the public key', async () => {
    const { fake, oidc } = await setup();
    const foreign = await fake.foreignKey(true);
    expect(await code(oidc.verifyIdToken(await fake.mint({}, { key: foreign }), { nonce: 'nonce-1' }))).toBe('signature');
    expect(await code(oidc.verifyIdToken(fake.mintNone(), { nonce: 'nonce-1' }))).toBe('signature');
    expect(await code(oidc.verifyIdToken(await fake.mintHs256WithPublicKey(), { nonce: 'nonce-1' }))).toBe('signature');
    expect(await code(oidc.verifyIdToken('not-a-jwt', { nonce: 'nonce-1' }))).toBe('signature');
  });

  it('error messages never contain the token', async () => {
    const { fake, oidc } = await setup();
    const tok = await fake.mint({ nonce: 'other' });
    try {
      await oidc.verifyIdToken(tok, { nonce: 'nonce-1' });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(tok);
      expect(String((e as Error).message)).not.toContain(tok.split('.')[1]);
    }
  });

  it('clock skew edges: exp 59 s past passes, 61 s fails; iat 59 s future passes, 61 s fails', async () => {
    const { fake, oidc } = await setup();
    const n = sec(T0);
    expect((await oidc.verifyIdToken(await fake.mint({ exp: n - 59 }), { nonce: 'nonce-1' })).sub).toBe('sub-1');
    expect(await code(oidc.verifyIdToken(await fake.mint({ exp: n - 61 }), { nonce: 'nonce-1' }))).toBe('claims');
    expect((await oidc.verifyIdToken(await fake.mint({ iat: n + 59 }), { nonce: 'nonce-1' })).sub).toBe('sub-1');
    expect(await code(oidc.verifyIdToken(await fake.mint({ iat: n + 61 }), { nonce: 'nonce-1' }))).toBe('claims');
  });

  it('re-auth: iat and auth_time must not predate notBefore (minus 60 s tolerance)', async () => {
    const { fake, oidc } = await setup();
    const n = sec(T0);
    const notBefore = T0;
    expect((await oidc.verifyIdToken(await fake.mint({ iat: n - 59, auth_time: n - 59 }), { nonce: 'nonce-1', notBefore })).sub).toBe('sub-1');
    expect(await code(oidc.verifyIdToken(await fake.mint({ iat: n - 61 }), { nonce: 'nonce-1', notBefore }))).toBe('claims');
    expect(await code(oidc.verifyIdToken(await fake.mint({ iat: n, auth_time: n - 3600 }), { nonce: 'nonce-1', notBefore }))).toBe('claims');
  });
});

describe('JWKS rotation', () => {
  it('verifies a new kid after exactly one refetch, and does not refetch again within 60 s', async () => {
    const { fake, oidc, clock } = await setup();
    await oidc.verifyIdToken(await fake.mint(), { nonce: 'nonce-1' });
    expect(fake.hits.jwks).toBe(1);
    await fake.rotate();
    await oidc.verifyIdToken(await fake.mint(), { nonce: 'nonce-1' });
    expect(fake.hits.jwks).toBe(2);
    const unk = await fake.unpublishedKey();
    clock.t += 10_000;
    expect(await code(oidc.verifyIdToken(await fake.mint({}, { key: unk }), { nonce: 'nonce-1' }))).toBe('signature');
    expect(fake.hits.jwks).toBe(2);
    clock.t += 61_000;
    expect(await code(oidc.verifyIdToken(await fake.mint({}, { key: unk }), { nonce: 'nonce-1' }))).toBe('signature');
    expect(fake.hits.jwks).toBe(3);
  });
});

describe('discovery and exchange', () => {
  it('rejects a discovery document whose issuer differs', async () => {
    const { fake, oidc } = await setup();
    fake.setDiscovery({ issuer: 'https://other.test' });
    expect(await code(oidc.discover())).toBe('discovery');
  });

  it('rejects http endpoints for a non loopback issuer and missing S256', async () => {
    const a = await setup();
    a.fake.setDiscovery({ token_endpoint: 'http://accounts.fake.test/token' });
    expect(await code(a.oidc.discover())).toBe('discovery');
    const b = await setup();
    b.fake.setDiscovery({ code_challenge_methods_supported: ['plain'] });
    expect(await code(b.oidc.discover())).toBe('discovery');
  });

  it('caches discovery for 24 h', async () => {
    const { fake, oidc, clock } = await setup();
    await oidc.discover();
    await oidc.discover();
    expect(fake.hits.discovery).toBe(1);
    clock.t += 25 * 3600_000;
    await oidc.discover();
    expect(fake.hits.discovery).toBe(2);
  });

  it('exchanges a code and sends the verifier and secret in the body only', async () => {
    const { fake, oidc, cfg } = await setup();
    fake.setIdToken('the.id.token');
    const r = await oidc.exchangeCode('code-abc', 'verifier-xyz');
    expect(r.idToken).toBe('the.id.token');
    const body = fake.lastTokenBody!;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('code-abc');
    expect(body.get('code_verifier')).toBe('verifier-xyz');
    expect(body.get('redirect_uri')).toBe(cfg.redirectUri);
    expect(body.get('client_id')).toBe('client-123');
  });

  it('fails the exchange without an id_token, or a non Bearer token_type, or a non-200', async () => {
    const { fake, oidc } = await setup();
    fake.setTokenResponse({ token_type: 'Bearer', access_token: 'a' });
    expect(await code(oidc.exchangeCode('c', 'v'))).toBe('exchange');
    fake.setTokenResponse({ token_type: 'mac', id_token: 'x.y.z' });
    expect(await code(oidc.exchangeCode('c', 'v'))).toBe('exchange');
    fake.setTokenResponse({ error: 'invalid_grant' }, 400);
    expect(await code(oidc.exchangeCode('c', 'v'))).toBe('exchange');
  });
});

describe('buildAuthRequest', () => {
  it('builds a PKCE S256 URL without the client secret', async () => {
    const { oidc, cfg } = await setup();
    const r = await oidc.buildAuthRequest({ reauth: false });
    const u = new URL(r.url);
    expect(u.origin + u.pathname).toBe(`${ISS}/authorize`);
    const q = u.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe('client-123');
    expect(q.get('scope')).toBe('openid email');
    expect(q.get('redirect_uri')).toBe(cfg.redirectUri);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('state')).toBe(r.state);
    expect(q.get('nonce')).toBe(r.nonce);
    expect(q.get('prompt')).toBeNull();
    expect(q.get('max_age')).toBeNull();
    expect(q.get('code_challenge')).toBe(createHash('sha256').update(r.verifier).digest('base64url'));
    expect(r.verifier.length).toBeGreaterThanOrEqual(43);
    expect(r.verifier.length).toBeLessThanOrEqual(128);
    expect(r.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.stateHash).toBe(createHash('sha256').update(r.state).digest('hex'));
    expect(r.url).not.toContain(SECRET);
    expect(q.get('client_secret')).toBeNull();
  });

  it('adds prompt and max_age=0 only for re-auth, honouring reauthPrompt', async () => {
    const { oidc } = await setup({ reauthPrompt: 'select_account' });
    const q = new URL((await oidc.buildAuthRequest({ reauth: true })).url).searchParams;
    expect(q.get('prompt')).toBe('select_account');
    expect(q.get('max_age')).toBe('0');
  });

  it('never reuses a state', async () => {
    const { oidc } = await setup();
    const a = await oidc.buildAuthRequest({ reauth: false });
    const b = await oidc.buildAuthRequest({ reauth: false });
    expect(a.state).not.toBe(b.state);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.nonce).not.toBe(b.nonce);
  });
});
