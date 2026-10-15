// tests/web-auth-migration.test.ts
// Plan 8C task 8: an existing OIDC install keeps working after the auth mode change. In process, temp dirs, no network.
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { validateRunnerConfig, resolveAuthMode } from '../src/web/env.js';
import { openAuthStore, getAllowedAccount, listAudit } from '../src/dash/authStore.js';
import { setToken } from '../src/dash/accessToken.js';
import { validateSession } from '../src/dash/sessions.js';
import { makeHarness, type Harness } from './helpers/webHarness.js';

let h: Harness | null = null;
afterEach(async () => {
  if (h) await h.close();
  h = null;
});

const OIDC_ENV = {
  WEB_OIDC_CLIENT_ID: 'cid',
  WEB_OIDC_CLIENT_SECRET: 'csecret-value',
  WEB_OIDC_REDIRECT_URI: 'http://127.0.0.1:8787/auth/callback',
  DASHBOARD_ALLOWED_EMAIL: 'owner@example.test',
};
const sha = (v: string): string => createHash('sha256').update(v).digest('hex');
const sessionOf = (hh: Harness, cookie: string) => hh.call('GET', '/api/session', { headers: { cookie } });

describe('auth mode resolution for existing installs', () => {
  it('case 1: no WEB_AUTH_MODE with OIDC keys resolves to implicit oidc, config valid', () => {
    expect(resolveAuthMode(OIDC_ENV)).toEqual({ mode: 'oidc', implicit: true });
    const r = validateRunnerConfig(OIDC_ENV, { accountStored: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.authMode).toBe('oidc');
      expect(r.config.authModeImplicit).toBe(true);
      expect(r.config.allowedEmail).toBe('owner@example.test');
    }
  });

  it('case 3: explicit WEB_AUTH_MODE=oidc is the same minus the implicit flag', () => {
    const imp = validateRunnerConfig(OIDC_ENV, { accountStored: true });
    const exp = validateRunnerConfig({ ...OIDC_ENV, WEB_AUTH_MODE: 'oidc' }, { accountStored: true });
    expect(imp.ok && exp.ok).toBe(true);
    if (imp.ok && exp.ok) {
      expect(exp.config.authMode).toBe('oidc');
      expect(exp.config.authModeImplicit).toBe(false);
      expect({ ...exp.config, authModeImplicit: true }).toEqual(imp.config);
    }
  });

  it('case 6 (env level): implicit oidc is flagged implicit for the doctor to warn about', () => {
    expect(resolveAuthMode(OIDC_ENV)).toMatchObject({ implicit: true });
    expect(resolveAuthMode({ ...OIDC_ENV, WEB_AUTH_MODE: 'oidc' })).toMatchObject({ implicit: false });
  });
});

describe('OIDC flow with the default (unset) auth mode', () => {
  it('case 1: the same code flow as today succeeds and the session authorizes /api/session', async () => {
    h = await makeHarness(); // authMode left unset: defaults to oidc
    const { cb, cookie } = await h.login();
    expect(cb.status).toBe(302);
    expect(cookie).not.toBe('');
    expect((await sessionOf(h, cookie)).status).toBe(200);
    const kinds = listAudit(h.auth, 50).map((a) => a.kind);
    expect(kinds).toContain('login_ok');
    expect(getAllowedAccount(h.auth)?.sub).not.toBeNull(); // sub pinned on first login as before
  });

  it('case 5: /auth/login redirects to the provider in oidc mode and is 404 in token mode', async () => {
    h = await makeHarness();
    const r = await h.call('GET', '/auth/login');
    expect(r.status).toBe(302);
    expect(String(r.headers.location)).toContain(new URL(h.fake.issuer).host);
    await h.close();
    h = await makeHarness({ authMode: 'token', oidc: undefined, oidcCfg: undefined } as never, { allow: false });
    expect((await h.call('GET', '/auth/login')).status).toBe(404);
  });
});

describe('pre-8C auth sqlite', () => {
  it('case 2: opens unchanged; same account, same sessions valid, audit intact, new tables empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobber-mig-'));
    const path = join(dir, 'auth.sqlite');
    const cookieA = 'a'.repeat(64);
    const cookieB = 'b'.repeat(64);
    const t0 = new Date('2026-10-14T12:00:00.000Z');
    const exp = new Date(t0.getTime() + 3600_000).toISOString();
    const old = new BetterSqlite3(path);
    old.exec(`
      CREATE TABLE allowed_account (id INTEGER PRIMARY KEY CHECK (id = 1), email TEXT NOT NULL, sub TEXT, set_at TEXT NOT NULL, pinned_at TEXT);
      CREATE TABLE pending_login (state_hash TEXT PRIMARY KEY, nonce TEXT NOT NULL, verifier TEXT NOT NULL, reauth INTEGER NOT NULL, session_hash TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, auth_at TEXT NOT NULL, expires_at TEXT NOT NULL, ip TEXT, revoked_at TEXT);
      CREATE TABLE login_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, ip TEXT, ok INTEGER NOT NULL);
      CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, ip TEXT, note TEXT, text_hash TEXT, id_hint TEXT);
      CREATE TABLE chat_pending (token_hash TEXT PRIMARY KEY, session_hash TEXT, text_hash TEXT, expires_at TEXT, used_at TEXT);
    `);
    old.prepare('INSERT INTO allowed_account VALUES (1, ?, ?, ?, ?)').run('owner@example.test', 'sub-pinned', t0.toISOString(), t0.toISOString());
    const ins = old.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, NULL, NULL)');
    ins.run(sha(cookieA), t0.toISOString(), t0.toISOString(), t0.toISOString(), exp);
    ins.run(sha(cookieB), t0.toISOString(), t0.toISOString(), t0.toISOString(), exp);
    old.prepare('INSERT INTO audit_log (at, kind, ip) VALUES (?, ?, ?)').run(t0.toISOString(), 'login_ok', '127.0.0.1');
    old.prepare('INSERT INTO audit_log (at, kind, ip) VALUES (?, ?, ?)').run(t0.toISOString(), 'sub_pinned', '127.0.0.1');
    old.close();

    const db = openAuthStore(path);
    const acct = getAllowedAccount(db);
    expect(acct?.email).toBe('owner@example.test');
    expect(acct?.sub).toBe('sub-pinned');
    expect(validateSession(db, cookieA, t0)).not.toBeNull();
    expect(validateSession(db, cookieB, t0)).not.toBeNull();
    const rows = listAudit(db, 50);
    expect(rows.map((r) => r.kind).sort()).toEqual(['login_ok', 'sub_pinned']);
    expect((db.prepare('SELECT COUNT(*) AS n FROM access_token').get() as { n: number }).n).toBe(0);

    // and the old sessions authorize requests on a live server using that store
    h = await makeHarness({ auth: db, now: () => t0 }, { allow: false });
    expect((await sessionOf(h, `jobber_session=${cookieA}`)).status).toBe(200);
  });
});

describe('switching an OIDC install to token mode', () => {
  it('case 4: setToken revokes OIDC sessions, keeps allowed_account, keeps audit history', async () => {
    h = await makeHarness();
    const { cookie } = await h.login();
    expect((await sessionOf(h, cookie)).status).toBe(200);
    const before = getAllowedAccount(h.auth);
    const auditBefore = listAudit(h.auth, 200);
    expect(auditBefore.length).toBeGreaterThan(0);

    setToken(h.auth, 'T0kenValue_abcdefghijklmnopqrstuvwxyz0123456789ABC', h.now());

    expect((await sessionOf(h, cookie)).status).toBe(401);
    expect(getAllowedAccount(h.auth)).toEqual(before);
    const auditAfter = listAudit(h.auth, 200);
    expect(auditAfter.length).toBe(auditBefore.length);
    expect(auditAfter.map((a) => a.id).sort()).toEqual(auditBefore.map((a) => a.id).sort());
    // switching back needs no `allow`: the account is still there and pinned
    expect(before?.email).toBe('owner@example.test');
    expect(before?.sub).not.toBeNull();
  });
});
