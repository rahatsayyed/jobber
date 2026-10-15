import { describe, it, expect } from 'vitest';
import { authDbPathFromEnv, resolveAuthMode, validateRunnerConfig, type RunnerEnv } from '../src/web/env.js';

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
      const env = { ...GOOD, WEB_AUTH_MODE: 'oidc', [k]: '' };
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
    const env = { ...GOOD, WEB_OIDC_REDIRECT_URI: 'https://dash.example.com/auth/callback', WEB_TRUST_PROXY: 'true' };
    expect(msgs(env).join(' ')).toContain('WEB_ALLOWED_HOSTS');
    expect(msgs({ ...env, WEB_ALLOWED_HOSTS: 'dash.example.com' })).toEqual([]);
    // loopback redirect on a port that is not the listen port is not reachable
    expect(msgs({ ...GOOD, WEB_OIDC_REDIRECT_URI: 'http://127.0.0.1:9999/auth/callback' }).join(' ')).toContain('WEB_ALLOWED_HOSTS');
  });
  it('https redirect requires WEB_TRUST_PROXY=true', () => {
    const env = { ...GOOD, WEB_OIDC_REDIRECT_URI: 'https://dash.example.com/auth/callback', WEB_ALLOWED_HOSTS: 'dash.example.com' };
    const r = validateRunnerConfig(env, { accountStored: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const e = r.errors.find((x) => x.message.includes('WEB_TRUST_PROXY'));
      expect(e?.scope).toBe('oidc');
    }
    expect(msgs({ ...env, WEB_TRUST_PROXY: 'true' })).toEqual([]);
    expect(msgs({ ...GOOD, WEB_OIDC_REDIRECT_URI: 'http://localhost:8787/auth/callback' })).toEqual([]);
  });
  it('authDbPathFromEnv resolves the shared default', () => {
    expect(authDbPathFromEnv({})).toBe('.dashboard/auth.sqlite');
    expect(authDbPathFromEnv({ WEB_AUTH_DB: '' })).toBe('.dashboard/auth.sqlite');
    expect(authDbPathFromEnv({ WEB_AUTH_DB: '  ' })).toBe('.dashboard/auth.sqlite');
    expect(authDbPathFromEnv({ WEB_AUTH_DB: '/x/a.sqlite' })).toBe('/x/a.sqlite');
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

describe('resolveAuthMode', () => {
  it('unset with no OIDC keys is token', () => {
    expect(resolveAuthMode({})).toEqual({ mode: 'token', implicit: false });
  });
  it('unset with id and secret is oidc, implicit', () => {
    expect(resolveAuthMode({ WEB_OIDC_CLIENT_ID: 'a', WEB_OIDC_CLIENT_SECRET: 'b' })).toEqual({ mode: 'oidc', implicit: true });
  });
  it('explicit value wins', () => {
    const keys = { WEB_OIDC_CLIENT_ID: 'a', WEB_OIDC_CLIENT_SECRET: 'b' };
    expect(resolveAuthMode({ ...keys, WEB_AUTH_MODE: 'token' })).toEqual({ mode: 'token', implicit: false });
    expect(resolveAuthMode({ WEB_AUTH_MODE: 'google_desktop' })).toEqual({ mode: 'google_desktop', implicit: false });
    expect(resolveAuthMode({ WEB_AUTH_MODE: 'oidc' })).toEqual({ mode: 'oidc', implicit: false });
  });
  it('garbage is an error', () => {
    const r = resolveAuthMode({ WEB_AUTH_MODE: 'password' });
    expect('error' in r && r.error).toBe('WEB_AUTH_MODE must be token, google_desktop or oidc');
  });
});

describe('auth mode validation', () => {
  const TOKEN: RunnerEnv = { WEB_AUTH_MODE: 'token' };
  const GD: RunnerEnv = { WEB_AUTH_MODE: 'google_desktop', DASHBOARD_ALLOWED_EMAIL: 'me@example.com' };
  const errs = (env: RunnerEnv, accountStored = false) => {
    const r = validateRunnerConfig(env, { accountStored });
    return r.ok ? [] : r.errors;
  };
  it('garbage mode reports scope web', () => {
    const e = errs({ WEB_AUTH_MODE: 'x' });
    expect(e[0]).toEqual({ scope: 'web', message: 'WEB_AUTH_MODE must be token, google_desktop or oidc' });
  });
  it('token env with empty OIDC and no account is ok', () => {
    expect(errs({ ...TOKEN, WEB_OIDC_CLIENT_ID: '', WEB_OIDC_CLIENT_SECRET: '', WEB_OIDC_REDIRECT_URI: '', WEB_OIDC_ISSUER: 'nonsense' })).toEqual([]);
    const r = validateRunnerConfig(TOKEN, { accountStored: false });
    expect(r.ok && r.config).toMatchObject({ authMode: 'token', authModeImplicit: false, googleRedirectShape: 'callback', googleKeysPath: './secrets/gcp-oauth.keys.json' });
  });
  it('oidc mode keeps today errors', () => {
    const e = errs({ WEB_AUTH_MODE: 'oidc', DASHBOARD_ALLOWED_EMAIL: 'me@example.com' });
    expect(e.map((x) => x.message).join(' ')).toContain('WEB_OIDC_CLIENT_ID is required');
    expect(e.every((x) => x.scope === 'oidc')).toBe(true);
  });
  it('implicit oidc is flagged', () => {
    const r = validateRunnerConfig(GOOD, { accountStored: false });
    expect(r.ok && r.config.authMode).toBe('oidc');
    expect(r.ok && r.config.authModeImplicit).toBe(true);
  });
  it('reauth max age validated in every mode under scope web', () => {
    const e = errs({ ...TOKEN, WEB_REAUTH_MAX_AGE_SEC: '5' });
    expect(e).toEqual([{ scope: 'web', message: 'WEB_REAUTH_MAX_AGE_SEC must be an integer from 60 to 3600' }]);
  });
  it('account rule applies in google_desktop and oidc only', () => {
    expect(errs({ WEB_AUTH_MODE: 'google_desktop' }).map((e) => e.scope)).toContain('account');
    expect(errs({ ...GOOD, DASHBOARD_ALLOWED_EMAIL: undefined }).map((e) => e.scope)).toContain('account');
    expect(errs(TOKEN)).toEqual([]);
    expect(errs({ ...TOKEN, DASHBOARD_ALLOWED_EMAIL: 'bad' })).toEqual([]);
  });
  it('google_desktop ok on loopback, derives redirect, shape default and root', () => {
    const r = validateRunnerConfig({ ...GD, WEB_PORT: '9000', WEB_GOOGLE_KEYS_PATH: 'keys/k.json' }, { accountStored: false });
    expect(r.ok && r.config).toMatchObject({ authMode: 'google_desktop', googleRedirectShape: 'callback', googleKeysPath: 'keys/k.json', redirectUri: 'http://127.0.0.1:9000/auth/callback' });
    const root = validateRunnerConfig({ ...GD, WEB_GOOGLE_REDIRECT_SHAPE: 'root' }, { accountStored: false });
    expect(root.ok && root.config.redirectUri).toBe('http://127.0.0.1:8787/');
    const g = validateRunnerConfig({ ...GD, GMAIL_OAUTH_PATH: 'keys/g.json' }, { accountStored: false });
    expect(g.ok && g.config.googleKeysPath).toBe('keys/g.json');
  });
  it('google_desktop bad shape is scope google', () => {
    expect(errs({ ...GD, WEB_GOOGLE_REDIRECT_SHAPE: 'other' }).map((e) => e.scope)).toEqual(['google']);
  });
  describe('remote bind table', () => {
    const remote = { WEB_BIND: '10.0.0.5' };
    it('token loopback ok', () => expect(errs({ ...TOKEN, WEB_BIND: '127.0.0.1' })).toEqual([]));
    it('token non-loopback without remote flag: web error', () => {
      const e = errs({ ...TOKEN, ...remote });
      expect(e).toHaveLength(1);
      expect(e[0].scope).toBe('web');
      expect(e[0].message).toContain('WEB_ALLOW_REMOTE_BIND');
    });
    it('token remote, no trust proxy: token error', () => {
      const e = errs({ ...TOKEN, ...remote, WEB_ALLOW_REMOTE_BIND: 'true', WEB_ALLOWED_HOSTS: 'd.example.com' });
      expect(e.map((x) => x.scope)).toEqual(['token']);
      expect(e[0].message).toBe('token sign-in on a non-loopback bind needs WEB_TRUST_PROXY=true behind a TLS proxy and WEB_ALLOWED_HOSTS');
    });
    it('token remote, proxy but no hosts: token error', () => {
      expect(errs({ ...TOKEN, ...remote, WEB_ALLOW_REMOTE_BIND: 'true', WEB_TRUST_PROXY: 'true' }).map((x) => x.scope)).toEqual(['token']);
    });
    it('token remote, proxy and hosts: ok', () => {
      expect(errs({ ...TOKEN, ...remote, WEB_ALLOW_REMOTE_BIND: 'true', WEB_TRUST_PROXY: 'true', WEB_ALLOWED_HOSTS: 'd.example.com' })).toEqual([]);
    });
    it('google_desktop non-loopback: google error', () => {
      const e = errs({ ...GD, ...remote, WEB_ALLOW_REMOTE_BIND: 'true', WEB_TRUST_PROXY: 'true', WEB_ALLOWED_HOSTS: 'd.example.com' });
      expect(e.map((x) => x.scope)).toEqual(['google']);
    });
    it('google_desktop on loopback with WEB_TRUST_PROXY=true: google error', () => {
      const e = errs({ ...GD, WEB_TRUST_PROXY: 'true' });
      expect(e.map((x) => x.scope)).toEqual(['google']);
      expect(e[0].message).toMatch(/WEB_TRUST_PROXY/);
    });
    it('oidc non-loopback ok (unchanged)', () => {
      const env = { ...GOOD, ...remote, WEB_ALLOW_REMOTE_BIND: 'true', WEB_TRUST_PROXY: 'true', WEB_ALLOWED_HOSTS: 'd.example.com', WEB_OIDC_REDIRECT_URI: 'https://d.example.com/auth/callback' };
      expect(errs(env)).toEqual([]);
    });
  });
});
