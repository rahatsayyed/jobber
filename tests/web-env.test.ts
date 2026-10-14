import { describe, it, expect } from 'vitest';
import { validateRunnerConfig, type RunnerEnv } from '../src/web/env.js';

const GOOD: RunnerEnv = {
  WEB_OIDC_CLIENT_ID: 'cid',
  WEB_OIDC_CLIENT_SECRET: 'csecret-value',
  WEB_OIDC_REDIRECT_URI: 'http://127.0.0.1:8787/auth/callback',
  DASHBOARD_ALLOWED_EMAIL: 'me@example.com',
};
const msgs = (env: RunnerEnv, accountStored = false): string[] => {
  const r = validateRunnerConfig(env, { accountStored });
  return r.ok ? [] : r.errors.map((e) => e.message);
};

describe('validateRunnerConfig defaults', () => {
  it('applies defaults', () => {
    const r = validateRunnerConfig(GOOD, { accountStored: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config).toMatchObject({
      port: 8787, bind: '127.0.0.1', allowRemoteBind: false, allowedHosts: [], trustProxy: false,
      authDb: '.dashboard/auth.sqlite', chatEnabled: false, session: 'ccgram', window: 'JobApplier',
      issuer: 'https://accounts.google.com', reauthPrompt: 'select_account', reauthMaxAgeSec: 300,
    });
  });
  it('non-google issuer defaults to login prompt', () => {
    const r = validateRunnerConfig({ ...GOOD, WEB_OIDC_ISSUER: 'https://idp.example.org' }, { accountStored: true });
    expect(r.ok && r.config.reauthPrompt).toBe('login');
  });
});

describe('validateRunnerConfig refusals', () => {
  it('bad ports', () => {
    for (const p of ['80', '1023', '65536', 'abc', '8787.5', '-1']) {
      expect(validateRunnerConfig({ ...GOOD, WEB_PORT: p }, { accountStored: true }).ok).toBe(false);
    }
    expect(validateRunnerConfig({ ...GOOD, WEB_PORT: '1024', WEB_OIDC_REDIRECT_URI: 'http://127.0.0.1:1024/auth/callback' }, { accountStored: true }).ok).toBe(true);
    expect(validateRunnerConfig({ ...GOOD, WEB_PORT: '65535', WEB_OIDC_REDIRECT_URI: 'http://127.0.0.1:65535/auth/callback' }, { accountStored: true }).ok).toBe(true);
  });
  it('no account and no valid email', () => {
    const e = { ...GOOD, DASHBOARD_ALLOWED_EMAIL: undefined };
    expect(msgs(e)[0]).toContain('npm run dashboard -- allow <email>');
    expect(msgs({ ...GOOD, DASHBOARD_ALLOWED_EMAIL: 'not-an-email' })).not.toEqual([]);
    expect(msgs(e, true)).toEqual([]);
  });
  it('missing OIDC keys', () => {
    for (const k of ['WEB_OIDC_CLIENT_ID', 'WEB_OIDC_CLIENT_SECRET', 'WEB_OIDC_REDIRECT_URI']) {
      const env = { ...GOOD, [k]: '' };
      expect(msgs(env).join(' ')).toContain(k);
    }
  });
  it('issuer must be https', () => {
    expect(msgs({ ...GOOD, WEB_OIDC_ISSUER: 'http://idp.example.org' }).join(' ')).toContain('WEB_OIDC_ISSUER');
    expect(msgs({ ...GOOD, WEB_OIDC_ISSUER: 'nonsense' }).join(' ')).toContain('WEB_OIDC_ISSUER');
  });
  it('redirect URI scheme and path rules', () => {
    const bad = [
      'http://example.com/auth/callback',
      'http://127.0.0.1:8787/other',
      'https://dash.example.com/other',
      'ftp://127.0.0.1/auth/callback',
      'http://127.0.0.1:8787/auth/callback?x=1',
      'nonsense',
    ];
    for (const u of bad) {
      expect(msgs({ ...GOOD, WEB_OIDC_REDIRECT_URI: u, WEB_ALLOWED_HOSTS: 'example.com,dash.example.com' }).join(' ')).toContain('WEB_OIDC_REDIRECT_URI');
    }
    expect(msgs({ ...GOOD, WEB_OIDC_REDIRECT_URI: 'http://localhost:8787/auth/callback' })).toEqual([]);
  });
  it('redirect host must be in the allowlist', () => {
    const env = { ...GOOD, WEB_OIDC_REDIRECT_URI: 'https://dash.example.com/auth/callback' };
    expect(msgs(env).join(' ')).toContain('WEB_ALLOWED_HOSTS');
    expect(msgs({ ...env, WEB_ALLOWED_HOSTS: 'dash.example.com' })).toEqual([]);
    // loopback redirect on a port that is not the listen port is not reachable
    expect(msgs({ ...GOOD, WEB_OIDC_REDIRECT_URI: 'http://127.0.0.1:9999/auth/callback' }).join(' ')).toContain('WEB_ALLOWED_HOSTS');
  });
  it('host values are validated', () => {
    for (const h of ['bad host', 'a..b', 'x:99999', '-x.com', 'http://x.com', 'x.com/path']) {
      expect(msgs({ ...GOOD, WEB_ALLOWED_HOSTS: h }).join(' ')).toContain('WEB_ALLOWED_HOSTS');
    }
    const r = validateRunnerConfig({ ...GOOD, WEB_ALLOWED_HOSTS: 'a.example.com, b.example.com:8443' }, { accountStored: true });
    expect(r.ok && r.config.allowedHosts).toEqual(['a.example.com', 'b.example.com:8443']);
  });
  it('non-loopback bind needs the explicit flag', () => {
    const env = { ...GOOD, WEB_BIND: '192.168.1.5' };
    expect(msgs(env).join(' ')).toContain('WEB_ALLOW_REMOTE_BIND');
    const ok = validateRunnerConfig({ ...env, WEB_ALLOW_REMOTE_BIND: 'true' }, { accountStored: true });
    expect(ok.ok).toBe(true);
    for (const b of ['127.0.0.1', '::1', 'localhost']) expect(msgs({ ...GOOD, WEB_BIND: b })).toEqual([]);
  });
  it('booleans, prompt, reauth age and tmux names', () => {
    expect(msgs({ ...GOOD, WEB_TRUST_PROXY: 'yes' }).join(' ')).toContain('WEB_TRUST_PROXY');
    expect(msgs({ ...GOOD, WEB_CHAT_ENABLED: '1' }).join(' ')).toContain('WEB_CHAT_ENABLED');
    expect(msgs({ ...GOOD, WEB_OIDC_REAUTH_PROMPT: 'consent' }).join(' ')).toContain('WEB_OIDC_REAUTH_PROMPT');
    for (const v of ['59', '3601', 'x']) expect(msgs({ ...GOOD, WEB_REAUTH_MAX_AGE_SEC: v }).join(' ')).toContain('WEB_REAUTH_MAX_AGE_SEC');
    expect(msgs({ ...GOOD, WEB_REAUTH_MAX_AGE_SEC: '60' })).toEqual([]);
    expect(msgs({ ...GOOD, WEB_TMUX_SESSION: 'a b' })).not.toEqual([]);
    expect(msgs({ ...GOOD, WEB_TMUX_WINDOW: 'w;rm' })).not.toEqual([]);
  });
  it('never echoes a secret value', () => {
    const r = validateRunnerConfig({ ...GOOD, WEB_PORT: 'zzz', WEB_OIDC_ISSUER: 'http://x' }, { accountStored: false });
    expect(JSON.stringify(r)).not.toContain('csecret-value');
  });
});
