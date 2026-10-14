// src/dash/oidc.ts
// OIDC authorization-code client with PKCE (S256), cached discovery, JWKS with rotation handling
// and strict ID token checks. Dependencies (fetch, clock, randomness) are injected so tests run
// fully in process. Never logs or embeds tokens, codes, state, nonce, verifier or the secret in
// errors.
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
} from 'jose';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  reauthPrompt: 'login' | 'select_account';
  maxAgeSec: number;
}
export interface OidcDeps {
  fetch: typeof fetch;
  now: () => Date;
  random: (n: number) => Buffer;
}
export interface AuthRequest {
  url: string;
  stateHash: string;
  nonce: string;
  verifier: string;
  state: string;
}

export type OidcErrorCode =
  | 'discovery'
  | 'exchange'
  | 'signature'
  | 'claims'
  | 'nonce'
  | 'unverified_email';

export class OidcError extends Error {
  constructor(public readonly code: OidcErrorCode, detail?: string) {
    super(detail ? `oidc ${code}: ${detail}` : `oidc ${code}`);
    this.name = 'OidcError';
  }
}

const DISCOVERY_TTL_MS = 24 * 3600_000;
const JWKS_REFETCH_MIN_MS = 60_000;
const TOLERANCE_SEC = 60;
const FETCH_TIMEOUT_MS = 5000;
const BODY_CAP = 256 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

function sha256b64url(s: string): string {
  return createHash('sha256').update(s).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readCapped(res: Response): Promise<string> {
  const len = Number(res.headers.get('content-length') ?? '0');
  if (len > BODY_CAP) throw new Error('body too large');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BODY_CAP) {
      await reader.cancel().catch(() => undefined);
      throw new Error('body too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createOidc(cfg: OidcConfig, deps: OidcDeps) {
  let disc: Discovery | undefined;
  let discAt = 0;
  let jwks: JSONWebKeySet | undefined;
  let lastRefetchAt = Number.NEGATIVE_INFINITY;

  const issuerHost = (() => {
    try {
      return new URL(cfg.issuer).hostname;
    } catch {
      return '';
    }
  })();
  const loopbackIssuer = LOOPBACK_HOSTS.has(issuerHost);

  function endpointOk(raw: unknown): raw is string {
    if (typeof raw !== 'string') return false;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return false;
    }
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && loopbackIssuer && LOOPBACK_HOSTS.has(u.hostname);
  }

  async function getJson(url: string, init: RequestInit, code: OidcErrorCode): Promise<{ status: number; body: unknown }> {
    let res: Response;
    let text: string;
    try {
      res = await deps.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      text = await readCapped(res);
    } catch {
      throw new OidcError(code, 'request failed');
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OidcError(code, 'invalid json');
    }
    return { status: res.status, body };
  }

  async function discover(): Promise<void> {
    const t = deps.now().getTime();
    if (disc && t - discAt < DISCOVERY_TTL_MS) return;
    const url = `${cfg.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const { status, body } = await getJson(url, { method: 'GET' }, 'discovery');
    if (status !== 200 || !body || typeof body !== 'object') throw new OidcError('discovery', 'bad response');
    const d = body as Record<string, unknown>;
    if (d.issuer !== cfg.issuer) throw new OidcError('discovery', 'issuer mismatch');
    if (!endpointOk(d.authorization_endpoint) || !endpointOk(d.token_endpoint) || !endpointOk(d.jwks_uri)) {
      throw new OidcError('discovery', 'insecure or missing endpoint');
    }
    const methods = d.code_challenge_methods_supported;
    if (methods !== undefined && !(Array.isArray(methods) && methods.includes('S256'))) {
      throw new OidcError('discovery', 'S256 not supported');
    }
    const jwksChanged = disc?.jwks_uri !== d.jwks_uri;
    disc = {
      authorization_endpoint: d.authorization_endpoint,
      token_endpoint: d.token_endpoint,
      jwks_uri: d.jwks_uri,
    };
    discAt = t;
    if (jwksChanged) jwks = undefined;
  }

  async function loadJwks(): Promise<JSONWebKeySet> {
    await discover();
    const { status, body } = await getJson(disc!.jwks_uri, { method: 'GET' }, 'signature');
    const keys = (body as { keys?: unknown } | null)?.keys;
    if (status !== 200 || !Array.isArray(keys)) throw new OidcError('signature', 'bad jwks');
    jwks = { keys: keys as JSONWebKeySet['keys'] };
    return jwks;
  }

  const hasKid = (set: JSONWebKeySet, kid: string) => set.keys.some((k) => k.kid === kid);

  async function keySetFor(kid: string | undefined): Promise<JSONWebKeySet> {
    if (!jwks) await loadJwks();
    if (kid === undefined || hasKid(jwks!, kid)) return jwks!;
    const t = deps.now().getTime();
    if (t - lastRefetchAt < JWKS_REFETCH_MIN_MS) return jwks!;
    lastRefetchAt = t;
    return loadJwks();
  }

  async function buildAuthRequest(opts: { reauth: boolean }): Promise<AuthRequest> {
    await discover();
    const state = deps.random(32).toString('base64url');
    const nonce = deps.random(32).toString('base64url');
    const verifier = deps.random(32).toString('base64url');
    const u = new URL(disc!.authorization_endpoint);
    const q = u.searchParams;
    q.set('response_type', 'code');
    q.set('client_id', cfg.clientId);
    q.set('redirect_uri', cfg.redirectUri);
    q.set('scope', 'openid email');
    q.set('state', state);
    q.set('nonce', nonce);
    q.set('code_challenge', sha256b64url(verifier));
    q.set('code_challenge_method', 'S256');
    if (opts.reauth) {
      q.set('prompt', cfg.reauthPrompt);
      q.set('max_age', '0');
    }
    return {
      url: u.toString(),
      state,
      nonce,
      verifier,
      stateHash: createHash('sha256').update(state).digest('hex'),
    };
  }

  async function exchangeCode(code: string, verifier: string): Promise<{ idToken: string }> {
    await discover();
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: cfg.redirectUri,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code_verifier: verifier,
    });
    const { status, body } = await getJson(
      disc!.token_endpoint,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(),
      },
      'exchange',
    );
    if (status !== 200 || !body || typeof body !== 'object') throw new OidcError('exchange', `status ${status}`);
    const b = body as Record<string, unknown>;
    if (typeof b.token_type !== 'string' || b.token_type.toLowerCase() !== 'bearer') {
      throw new OidcError('exchange', 'token_type not Bearer');
    }
    if (typeof b.id_token !== 'string' || b.id_token.length === 0) {
      throw new OidcError('exchange', 'no id_token');
    }
    return { idToken: b.id_token };
  }

  async function verifyIdToken(
    idToken: string,
    expect: { nonce: string; notBefore?: Date },
  ): Promise<{ sub: string; email: string; emailVerified: boolean; iat: number; authTime?: number }> {
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(idToken).kid;
    } catch {
      throw new OidcError('signature', 'malformed token');
    }
    const set = await keySetFor(kid);
    const now = deps.now();
    let payload: Record<string, unknown>;
    try {
      const r = await jwtVerify(idToken, createLocalJWKSet(set), {
        issuer: cfg.issuer,
        audience: cfg.clientId,
        algorithms: ['RS256', 'ES256'],
        clockTolerance: TOLERANCE_SEC,
        currentDate: now,
      });
      payload = r.payload as Record<string, unknown>;
    } catch (e) {
      if (e instanceof joseErrors.JWTClaimValidationFailed || e instanceof joseErrors.JWTExpired) {
        throw new OidcError('claims', (e as { claim?: string }).claim ?? 'claim');
      }
      throw new OidcError('signature');
    }

    if (typeof payload.nonce !== 'string' || !safeEqual(payload.nonce, expect.nonce)) {
      throw new OidcError('nonce');
    }
    if (payload.email_verified !== true) throw new OidcError('unverified_email');
    const { sub, email } = payload;
    if (typeof email !== 'string' || email.length === 0) throw new OidcError('claims', 'email');
    if (typeof sub !== 'string' || sub.length === 0) throw new OidcError('claims', 'sub');
    if (Array.isArray(payload.aud) && payload.azp !== cfg.clientId) throw new OidcError('claims', 'azp');

    const nowSec = Math.floor(now.getTime() / 1000);
    const iat = payload.iat;
    if (typeof iat !== 'number' || !Number.isFinite(iat)) throw new OidcError('claims', 'iat');
    if (iat > nowSec + TOLERANCE_SEC) throw new OidcError('claims', 'iat in the future');
    const authTime = payload.auth_time;
    if (authTime !== undefined && (typeof authTime !== 'number' || !Number.isFinite(authTime))) {
      throw new OidcError('claims', 'auth_time');
    }
    if (expect.notBefore) {
      const floor = Math.floor(expect.notBefore.getTime() / 1000) - TOLERANCE_SEC;
      if (iat < floor) throw new OidcError('claims', 'iat before re-auth');
      if (authTime !== undefined && authTime < floor) throw new OidcError('claims', 'auth_time before re-auth');
    }
    return { sub, email, emailVerified: true, iat, ...(authTime !== undefined ? { authTime } : {}) };
  }

  return { discover, buildAuthRequest, exchangeCode, verifyIdToken };
}
