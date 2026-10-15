// src/dash/desktopClient.ts
// Pure helpers for the google_desktop login mode: parse a Google "Desktop app" OAuth keys file,
// build loopback redirect URIs and the authorization URL. No I/O, no network, no secret echo.

export interface DesktopClient {
  clientId: string;
  clientSecret: string;
  authUri: string;
  tokenUri: string;
}

export type DesktopParse =
  | { ok: true; client: DesktopClient }
  | { ok: false; reason: 'not_object' | 'not_desktop' | 'missing_field' | 'bad_endpoint' };

const AUTH_HOST = 'accounts.google.com';
const TOKEN_HOST = 'oauth2.googleapis.com';
const CLIENT_ID_SUFFIX = '.apps.googleusercontent.com';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function httpsOnHost(raw: string, host: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && u.hostname === host && u.username === '' && u.password === '' && u.port === '';
}

/** Pure. Accepts the parsed JSON. Never returns or echoes the secret in `reason`. */
export function parseDesktopKeys(raw: unknown): DesktopParse {
  if (!isObject(raw)) return { ok: false, reason: 'not_object' };
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== 'installed') return { ok: false, reason: 'not_desktop' };
  const inst = raw.installed;
  if (!isObject(inst)) return { ok: false, reason: 'not_desktop' };
  const { client_id, client_secret, auth_uri, token_uri } = inst;
  if (typeof client_id !== 'string' || !client_id.endsWith(CLIENT_ID_SUFFIX) || client_id.length === CLIENT_ID_SUFFIX.length) {
    return { ok: false, reason: 'missing_field' };
  }
  if (typeof client_secret !== 'string' || client_secret === '') return { ok: false, reason: 'missing_field' };
  if (typeof auth_uri !== 'string' || typeof token_uri !== 'string') return { ok: false, reason: 'missing_field' };
  if (!httpsOnHost(auth_uri, AUTH_HOST) || !httpsOnHost(token_uri, TOKEN_HOST)) return { ok: false, reason: 'bad_endpoint' };
  return { ok: true, client: { clientId: client_id, clientSecret: client_secret, authUri: auth_uri, tokenUri: token_uri } };
}

export type RedirectShape = 'callback' | 'root';

/** http://127.0.0.1:<port>/auth/callback or http://127.0.0.1:<port>/ ; loopback IP literal only. */
export function redirectFor(shape: RedirectShape, port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
  return `http://127.0.0.1:${port}${shape === 'callback' ? '/auth/callback' : '/'}`;
}

export type LoadKeysResult =
  | { ok: true; client: DesktopClient }
  | { ok: false; reason: 'unreadable' | 'bad_json' | 'not_object' | 'not_desktop' | 'missing_field' | 'bad_endpoint' };

/** Reads and parses the keys file through an injected readFile. Returns only a reason code on failure, never content. */
export function loadDesktopKeys(path: string, readFile: (p: string) => string): LoadKeysResult {
  let text: string;
  try {
    text = readFile(path);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'bad_json' };
  }
  return parseDesktopKeys(raw);
}

/** Fixed operator message for a failed load; includes the documented fallback order. */
export function keysFailureMessage(reason: string): string {
  return (
    `google_desktop sign-in cannot start (reason: ${reason}). Fallbacks in order: ` +
    '(1) WEB_GOOGLE_REDIRECT_SHAPE=root; (2) WEB_AUTH_MODE=oidc with a dedicated Web client; (3) WEB_AUTH_MODE=token.'
  );
}

/** The authorization URL the live check prints (response_type=code, scope=openid email, S256 PKCE). No secret in it. */
export function authUrlFor(client: DesktopClient, redirectUri: string, state: string, challenge: string): string {
  const u = new URL(client.authUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', client.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', 'openid email');
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}
