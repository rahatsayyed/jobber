// src/web/env.ts
// Pure validation of the dashboard runner environment. No I/O, never echoes a secret value.
import { assertName } from '../platform/tmux.js';
import { normaliseEmail } from '../dash/account.js';

export type RunnerEnv = Record<string, string | undefined>;

export interface WebConfig {
  port: number;
  bind: string;
  allowRemoteBind: boolean;
  allowedHosts: string[];
  trustProxy: boolean;
  authDb: string;
  chatEnabled: boolean;
  session: string;
  window: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  reauthPrompt: 'login' | 'select_account';
  reauthMaxAgeSec: number;
  allowedEmail: string | null;
}

export type ErrorScope = 'web' | 'oidc' | 'account';
export interface ConfigError { scope: ErrorScope; message: string }
export type RunnerConfigResult = { ok: true; config: WebConfig } | { ok: false; errors: ConfigError[] };

export const LOOPBACK_BINDS: readonly string[] = ['127.0.0.1', '::1', 'localhost'];
const GOOGLE_ISSUER = 'https://accounts.google.com';
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

const val = (env: RunnerEnv, k: string): string => (env[k] ?? '').trim();

export const DEFAULT_AUTH_DB = '.dashboard/auth.sqlite';

// The one place the auth store path (relative to the project root unless absolute) is resolved from a merged env.
export function authDbPathFromEnv(env: RunnerEnv): string {
  return val(env, 'WEB_AUTH_DB') || DEFAULT_AUTH_DB;
}

function validHostValue(raw: string): boolean {
  let host = raw;
  const m = /^(.*):(\d{1,5})$/.exec(raw);
  if (m && !raw.startsWith('[') && !m[1].includes(':')) {
    const p = Number(m[2]);
    if (p < 1 || p > 65535) return false;
    host = m[1];
  }
  if (host.startsWith('[') && host.endsWith(']')) return /^[0-9a-f:]+$/i.test(host.slice(1, -1));
  return host.length > 0 && host.length <= 253 && HOST_RE.test(host);
}

function bool(env: RunnerEnv, key: string, errs: ConfigError[]): boolean {
  const v = val(env, key).toLowerCase();
  if (v === '' || v === 'false') return false;
  if (v === 'true') return true;
  errs.push({ scope: 'web', message: `${key} must be true or false` });
  return false;
}

export function isLoopbackBind(bind: string): boolean {
  return LOOPBACK_BINDS.includes(bind.toLowerCase());
}

/** accountStored: whether the auth store already holds an allowed account. */
export function validateRunnerConfig(env: RunnerEnv, opts: { accountStored: boolean }): RunnerConfigResult {
  const errs: ConfigError[] = [];
  const web = (message: string): void => void errs.push({ scope: 'web', message });
  const oidc = (message: string): void => void errs.push({ scope: 'oidc', message });

  let port = 8787;
  const rawPort = val(env, 'WEB_PORT');
  if (rawPort !== '') {
    if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1024 || Number(rawPort) > 65535) {
      web('WEB_PORT must be an integer from 1024 to 65535');
    } else port = Number(rawPort);
  }

  const bind = val(env, 'WEB_BIND') || '127.0.0.1';
  const bindIsIpv6 = /^[0-9a-f:]+$/i.test(bind) && bind.includes(':');
  if (!isLoopbackBind(bind) && !bindIsIpv6 && (/:\d+$/.test(bind) || !validHostValue(bind))) {
    web('WEB_BIND is not a valid host (no port, no scheme)');
  }
  const allowRemoteBind = bool(env, 'WEB_ALLOW_REMOTE_BIND', errs);
  if (!isLoopbackBind(bind) && !allowRemoteBind) {
    web('WEB_BIND is not a loopback address: set WEB_ALLOW_REMOTE_BIND=true to bind it deliberately');
  }

  const allowedHosts: string[] = [];
  const rawHosts = val(env, 'WEB_ALLOWED_HOSTS');
  if (rawHosts !== '') {
    for (const h of rawHosts.split(',').map((s) => s.trim().toLowerCase())) {
      if (h === '' || !validHostValue(h)) web('WEB_ALLOWED_HOSTS has an invalid host value (use hostname or host:port)');
      else allowedHosts.push(h);
    }
  }
  const trustProxy = bool(env, 'WEB_TRUST_PROXY', errs);
  const chatEnabled = bool(env, 'WEB_CHAT_ENABLED', errs);
  const authDb = authDbPathFromEnv(env);

  const session = val(env, 'WEB_TMUX_SESSION') || 'ccgram';
  const window = val(env, 'WEB_TMUX_WINDOW') || 'JobApplier';
  try { assertName(session); } catch { web('WEB_TMUX_SESSION is not a valid tmux name'); }
  try { assertName(window); } catch { web('WEB_TMUX_WINDOW is not a valid tmux name'); }

  const issuer = val(env, 'WEB_OIDC_ISSUER') || GOOGLE_ISSUER;
  let issuerOk = false;
  try { issuerOk = new URL(issuer).protocol === 'https:'; } catch { /* invalid */ }
  if (!issuerOk) oidc('WEB_OIDC_ISSUER must be an https URL');
  const clientId = val(env, 'WEB_OIDC_CLIENT_ID');
  const clientSecret = val(env, 'WEB_OIDC_CLIENT_SECRET');
  const redirectUri = val(env, 'WEB_OIDC_REDIRECT_URI');
  if (clientId === '') oidc('WEB_OIDC_CLIENT_ID is required');
  if (clientSecret === '') oidc('WEB_OIDC_CLIENT_SECRET is required');
  if (redirectUri === '') oidc('WEB_OIDC_REDIRECT_URI is required');
  else {
    let u: URL | null = null;
    try { u = new URL(redirectUri); } catch { /* invalid */ }
    const loopbackHttp = !!u && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
    const schemeOk = !!u && (u.protocol === 'https:' || loopbackHttp);
    const shapeOk = !!u && u.pathname === '/auth/callback' && u.search === '' && u.hash === '' && u.username === '' && u.password === '';
    if (!u || !schemeOk || !shapeOk) {
      oidc('WEB_OIDC_REDIRECT_URI must be https, or http on 127.0.0.1 or localhost, with path /auth/callback');
    } else {
      const host = u.host.toLowerCase();
      const loopbackOk = loopbackHttp && (u.port || '80') === String(port);
      const listed = allowedHosts.includes(host) || (allowedHosts.includes(u.hostname.toLowerCase()) && u.port === '');
      if (!loopbackOk && !listed) oidc('WEB_OIDC_REDIRECT_URI host is not in WEB_ALLOWED_HOSTS or the loopback listen address');
      if (u.protocol === 'https:' && !trustProxy) {
        oidc('WEB_OIDC_REDIRECT_URI is https: set WEB_TRUST_PROXY=true when running behind a TLS proxy (cookies must be Secure and the Origin check expects https)');
      }
    }
  }

  let reauthPrompt: 'login' | 'select_account' = issuer === GOOGLE_ISSUER ? 'select_account' : 'login';
  const rawPrompt = val(env, 'WEB_OIDC_REAUTH_PROMPT');
  if (rawPrompt === 'login' || rawPrompt === 'select_account') reauthPrompt = rawPrompt;
  else if (rawPrompt !== '') oidc('WEB_OIDC_REAUTH_PROMPT must be login or select_account');

  let reauthMaxAgeSec = 300;
  const rawAge = val(env, 'WEB_REAUTH_MAX_AGE_SEC');
  if (rawAge !== '') {
    if (!/^\d+$/.test(rawAge) || Number(rawAge) < 60 || Number(rawAge) > 3600) {
      oidc('WEB_REAUTH_MAX_AGE_SEC must be an integer from 60 to 3600');
    } else reauthMaxAgeSec = Number(rawAge);
  }

  const rawEmail = val(env, 'DASHBOARD_ALLOWED_EMAIL');
  const allowedEmail = rawEmail === '' ? null : normaliseEmail(rawEmail);
  if (rawEmail !== '' && allowedEmail === null) {
    errs.push({ scope: 'account', message: 'DASHBOARD_ALLOWED_EMAIL is not a valid email address' });
  }
  if (!opts.accountStored && allowedEmail === null) {
    errs.push({ scope: 'account', message: 'no allowed account: run npm run dashboard -- allow <email>' });
  }

  if (errs.length > 0) return { ok: false, errors: errs };
  return {
    ok: true,
    config: {
      port, bind, allowRemoteBind, allowedHosts, trustProxy, authDb, chatEnabled, session, window,
      issuer, clientId, clientSecret, redirectUri, reauthPrompt, reauthMaxAgeSec, allowedEmail,
    },
  };
}
