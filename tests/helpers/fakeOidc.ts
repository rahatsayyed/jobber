// tests/helpers/fakeOidc.ts
// In-process fake OIDC provider: discovery, JWKS and token endpoints served through a fetch stub
// (no sockets). Mints ID tokens with controllable claims, rotates keys, signs with unknown or
// foreign keys. Test-only; keys are generated per instance.
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

export interface FakeKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

export interface FakeOidcOptions {
  issuer?: string;
  clientId?: string;
  now?: () => Date;
}

export type Claims = Record<string, unknown>;

export interface MintOptions {
  /** claim names to remove from the payload */
  omit?: string[];
  /** sign with this key instead of the current one (e.g. a foreign or unpublished key) */
  key?: FakeKey;
  /** header alg override for `none` / HS256 attacks is done via mintNone / mintHs256 */
}

async function makeKey(kid: string): Promise<FakeKey> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  return { kid, privateKey, publicJwk };
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

export async function createFakeOidc(opts: FakeOidcOptions = {}) {
  const issuer = opts.issuer ?? 'https://accounts.fake.test';
  const clientId = opts.clientId ?? 'client-123';
  const now = opts.now ?? (() => new Date());
  let counter = 0;
  const newKid = () => `kid-${++counter}`;

  let current = await makeKey(newKid());
  const published: FakeKey[] = [current];

  const state = {
    discoveryOverride: undefined as Record<string, unknown> | undefined,
    tokenResponse: undefined as Record<string, unknown> | undefined,
    tokenStatus: 200,
    lastTokenBody: undefined as URLSearchParams | undefined,
    issuedIdToken: undefined as string | undefined,
  };
  const hits: Record<string, number> = { discovery: 0, jwks: 0, token: 0 };

  const endpoints = {
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
  };

  function discoveryDoc(): Record<string, unknown> {
    return {
      issuer,
      ...endpoints,
      code_challenge_methods_supported: ['S256'],
      id_token_signing_alg_values_supported: ['RS256'],
      ...(state.discoveryOverride ?? {}),
    };
  }

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchStub = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === `${issuer}/.well-known/openid-configuration`) {
      hits.discovery++;
      return json(discoveryDoc());
    }
    if (url === endpoints.jwks_uri) {
      hits.jwks++;
      return json({ keys: published.map((k) => k.publicJwk) });
    }
    if (url === endpoints.token_endpoint) {
      hits.token++;
      state.lastTokenBody = new URLSearchParams(String(init?.body ?? ''));
      if (state.tokenResponse) return json(state.tokenResponse, state.tokenStatus);
      return json(
        { token_type: 'Bearer', access_token: 'at', id_token: state.issuedIdToken ?? 'missing' },
        state.tokenStatus,
      );
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  async function mint(claims: Claims = {}, mo: MintOptions = {}): Promise<string> {
    const nowSec = Math.floor(now().getTime() / 1000);
    const payload: Claims = {
      iss: issuer,
      aud: clientId,
      sub: 'sub-1',
      email: 'owner@example.test',
      email_verified: true,
      nonce: 'nonce-1',
      iat: nowSec,
      exp: nowSec + 300,
      ...claims,
    };
    for (const k of mo.omit ?? []) delete payload[k];
    const key = mo.key ?? current;
    return new SignJWT(payload as never)
      .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'JWT' })
      .sign(key.privateKey);
  }

  /** unsecured token: alg none, empty signature */
  function mintNone(claims: Claims = {}): string {
    const nowSec = Math.floor(now().getTime() / 1000);
    const payload = {
      iss: issuer, aud: clientId, sub: 'sub-1', email: 'owner@example.test', email_verified: true,
      nonce: 'nonce-1', iat: nowSec, exp: nowSec + 300, ...claims,
    };
    return `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.`;
  }

  /** HS256 token signed with the public key material as the HMAC secret (alg confusion) */
  async function mintHs256WithPublicKey(claims: Claims = {}): Promise<string> {
    const nowSec = Math.floor(now().getTime() / 1000);
    const secret = Buffer.from(String(current.publicJwk.n), 'base64url');
    return new SignJWT({
      iss: issuer, aud: clientId, sub: 'sub-1', email: 'owner@example.test', email_verified: true,
      nonce: 'nonce-1', iat: nowSec, exp: nowSec + 300, ...claims,
    } as never)
      .setProtectedHeader({ alg: 'HS256', kid: current.kid })
      .sign(secret);
  }

  return {
    issuer,
    clientId,
    fetch: fetchStub,
    hits,
    mint,
    mintNone,
    mintHs256WithPublicKey,
    get kid() { return current.kid; },
    /** a key that is never published, for "signature from another key" */
    async foreignKey(sameKid = true): Promise<FakeKey> {
      const k = await makeKey(sameKid ? current.kid : newKid());
      return k;
    },
    /** publish a new key and sign subsequent tokens with it; the old key stays published unless dropOld */
    async rotate(dropOld = false): Promise<FakeKey> {
      current = await makeKey(newKid());
      if (dropOld) published.length = 0;
      published.push(current);
      return current;
    },
    /** sign with a key that is not (yet) published */
    async unpublishedKey(): Promise<FakeKey> {
      return makeKey(newKid());
    },
    setDiscovery(over: Record<string, unknown> | undefined) { state.discoveryOverride = over; },
    setTokenResponse(body: Record<string, unknown> | undefined, status = 200) {
      state.tokenResponse = body;
      state.tokenStatus = status;
    },
    setIdToken(t: string) { state.issuedIdToken = t; },
    get lastTokenBody() { return state.lastTokenBody; },
  };
}

export type FakeOidc = Awaited<ReturnType<typeof createFakeOidc>>;
