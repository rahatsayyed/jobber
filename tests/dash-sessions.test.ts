// tests/dash-sessions.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openAuthStore, type AuthDb } from '../src/dash/authStore.js';
import { checkLogin, recordLogin } from '../src/dash/throttle.js';
import {
  createSession, validateSession, refreshAuth, isFresh, revokeSession, csrfFor, csrfOk,
} from '../src/dash/sessions.js';
import {
  parseCookies, sessionCookieName, oidcCookieName, serializeSession, serializeOidc, clearCookie,
} from '../src/dash/cookies.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const T0 = new Date('2026-10-14T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;

let db: AuthDb;
beforeEach(() => {
  db = openAuthStore(join(mkdtempSync(join(tmpdir(), 'dash-sess-')), 'auth.sqlite'));
});

describe('throttle', () => {
  it('locks one ip after 10 failures for 15 minutes, others still allowed', () => {
    for (let i = 0; i < 10; i++) recordLogin(db, '1.1.1.1', false, at(i * 1000));
    const d = checkLogin(db, '1.1.1.1', at(20_000));
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSec).toBeGreaterThan(0);
    expect(d.scope).toBe('ip');
    expect(checkLogin(db, '2.2.2.2', at(20_000)).allowed).toBe(true);
    expect(checkLogin(db, '1.1.1.1', at(14 * MIN)).allowed).toBe(false);
    expect(checkLogin(db, '1.1.1.1', at(25 * MIN)).allowed).toBe(true);
  });

  it('9 failures do not lock', () => {
    for (let i = 0; i < 9; i++) recordLogin(db, '1.1.1.1', false, at(i * 1000));
    expect(checkLogin(db, '1.1.1.1', at(10_000)).allowed).toBe(true);
  });

  it('20 failures across ips lock everyone for an hour', () => {
    for (let i = 0; i < 20; i++) recordLogin(db, `10.0.0.${i % 5}`, false, at(i * 1000));
    const d = checkLogin(db, '9.9.9.9', at(30_000));
    expect(d.allowed).toBe(false);
    expect(d.scope).toBe('global');
    expect(checkLogin(db, '9.9.9.9', at(59 * MIN)).allowed).toBe(false);
    expect(checkLogin(db, '9.9.9.9', at(61 * MIN)).allowed).toBe(true);
  });

  it('a success does not reset the global count', () => {
    for (let i = 0; i < 19; i++) recordLogin(db, `10.0.0.${i % 5}`, false, at(i * 1000));
    recordLogin(db, '10.0.0.1', true, at(20_000));
    recordLogin(db, '10.0.0.2', false, at(21_000));
    expect(checkLogin(db, '9.9.9.9', at(30_000)).allowed).toBe(false);
  });

  it('prunes rows older than 24 hours', () => {
    recordLogin(db, '1.1.1.1', false, T0);
    recordLogin(db, '1.1.1.1', false, at(25 * 60 * MIN));
    const n = (db.prepare('SELECT COUNT(*) c FROM login_attempts').get() as { c: number }).c;
    expect(n).toBe(1);
  });
});

describe('sessions', () => {
  it('stays valid for one week, then rejects on expiry or revoke', () => {
    const { cookieValue, session } = createSession(db, '1.1.1.1', T0, T0);
    expect(cookieValue).toMatch(/^[0-9a-f]{64}$/);
    expect(validateSession(db, cookieValue, at(6 * 24 * 60 * MIN))?.idHash).toBe(session.idHash);
    expect(validateSession(db, cookieValue, at(7 * 24 * 60 * MIN))).toBeNull();

    const b = createSession(db, '1.1.1.1', T0, T0);
    expect(validateSession(db, b.cookieValue, at(6 * 24 * 60 * MIN))).not.toBeNull();
    expect(validateSession(db, b.cookieValue, at(7 * 24 * 60 * MIN))).toBeNull();

    const c = createSession(db, '1.1.1.1', T0, T0);
    revokeSession(db, c.cookieValue);
    expect(validateSession(db, c.cookieValue, at(MIN))).toBeNull();
  });

  it('rejects missing or unknown cookie', () => {
    expect(validateSession(db, undefined, T0)).toBeNull();
    expect(validateSession(db, 'nope', T0)).toBeNull();
  });

  it('4th session revokes the oldest', () => {
    const s = [0, 1, 2, 3].map((i) => createSession(db, 'ip', T0, at(i * 1000)));
    const now = at(10_000);
    expect(validateSession(db, s[0]!.cookieValue, now)).toBeNull();
    for (const i of [1, 2, 3]) expect(validateSession(db, s[i]!.cookieValue, now)).not.toBeNull();
  });

  it('stores only the sha256 of the cookie value', () => {
    const { cookieValue, session } = createSession(db, 'ip', T0, T0);
    const rows = JSON.stringify(db.prepare('SELECT * FROM sessions').all());
    expect(rows).not.toContain(cookieValue);
    expect(rows).toContain(session.idHash);
    expect(session.idHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('touches last_seen_at at most once per minute', () => {
    const { cookieValue, session } = createSession(db, 'ip', T0, T0);
    const seen = () => (db.prepare('SELECT last_seen_at s FROM sessions WHERE id_hash = ?').get(session.idHash) as { s: string }).s;
    validateSession(db, cookieValue, at(30_000));
    expect(seen()).toBe(T0.toISOString());
    validateSession(db, cookieValue, at(61_000));
    expect(seen()).toBe(at(61_000).toISOString());
  });

  it('isFresh and refreshAuth', () => {
    const { session } = createSession(db, 'ip', T0, T0);
    expect(isFresh(session, at(299_000), 300)).toBe(true);
    expect(isFresh(session, at(301_000), 300)).toBe(false);
    refreshAuth(db, session.idHash, at(300_000));
    const row = db.prepare('SELECT auth_at a FROM sessions WHERE id_hash = ?').get(session.idHash) as { a: string };
    expect(row.a).toBe(at(300_000).toISOString());
    expect(isFresh({ ...session, authAt: row.a }, at(301_000), 300)).toBe(true);
  });
});

describe('csrf', () => {
  const key = randomBytes(32);
  it('accepts only the right token', () => {
    const t = csrfFor('abc', key);
    expect(csrfOk(t, t)).toBe(true);
    expect(csrfOk(t, undefined)).toBe(false);
    expect(csrfOk(t, t.slice(0, -2))).toBe(false);
    expect(csrfOk(t, 'f'.repeat(t.length))).toBe(false);
    expect(csrfFor('abd', key)).not.toBe(t);
    expect(csrfFor('abc', randomBytes(32))).not.toBe(t);
  });
  it('session info carries a csrf matching the same id hash', () => {
    const { session } = createSession(db, 'ip', T0, T0);
    expect(session.csrf).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('cookies', () => {
  it('parses headers', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('a=1; b=two=2;  c=%20x')).toEqual({ a: '1', b: 'two=2', c: ' x' });
  });
  it('names', () => {
    expect(sessionCookieName(true)).toBe('__Host-jobber_session');
    expect(sessionCookieName(false)).toBe('jobber_session');
    expect(oidcCookieName(true)).toBe('__Host-jobber_oidc');
    expect(oidcCookieName(false)).toBe('jobber_oidc');
  });
  it('attributes', () => {
    expect(serializeSession('v', true, 60)).toBe('__Host-jobber_session=v; HttpOnly; SameSite=Lax; Path=/; Max-Age=60; Secure');
    expect(serializeSession('v', false, 60)).toBe('jobber_session=v; HttpOnly; SameSite=Lax; Path=/; Max-Age=60');
    expect(serializeOidc('v', true)).toBe('__Host-jobber_oidc=v; HttpOnly; SameSite=Lax; Path=/; Max-Age=600; Secure');
    expect(serializeOidc('v', false)).toBe('jobber_oidc=v; HttpOnly; SameSite=Lax; Path=/; Max-Age=600');
    expect(clearCookie('x', true)).toBe('x=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure');
    expect(clearCookie('x', false)).toBe('x=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  });
});
