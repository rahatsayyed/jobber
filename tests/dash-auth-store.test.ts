// tests/dash-auth-store.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openAuthStore, getAllowedAccount, setAllowedEmail, pinSub,
  savePendingLogin, takePendingLogin, audit, listAudit,
} from '../src/dash/authStore.js';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'dash-'));
  const sub = join(dir, 'store');
  const path = join(sub, 'auth.sqlite');
  return { dir, sub, path, db: openAuthStore(path) };
}
const now = new Date('2026-10-14T10:00:00Z');

describe('authStore', () => {
  it('creates dir 700 and file 600', () => {
    const { sub, path } = fresh();
    expect(statSync(sub).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it('allowed account null then set, and re-set clears sub and sessions', () => {
    const { db } = fresh();
    expect(getAllowedAccount(db)).toBeNull();
    setAllowedEmail(db, 'a@x.com', now);
    expect(getAllowedAccount(db)?.email).toBe('a@x.com');
    expect(pinSub(db, 'sub1', now)).toBe(true);
    db.prepare(`INSERT INTO sessions (id_hash, created_at, last_seen_at, auth_at, expires_at, ip, revoked_at) VALUES ('h', 'c', 'l', 'a', 'e', NULL, NULL)`).run();
    setAllowedEmail(db, 'b@x.com', now);
    const a = getAllowedAccount(db)!;
    expect(a.email).toBe('b@x.com');
    expect(a.sub).toBeNull();
    expect(a.pinnedAt).toBeNull();
    const s = db.prepare(`SELECT revoked_at FROM sessions WHERE id_hash='h'`).get() as { revoked_at: string | null };
    expect(s.revoked_at).not.toBeNull();
  });
  it('pinSub succeeds once only', () => {
    const { db } = fresh();
    setAllowedEmail(db, 'a@x.com', now);
    expect(pinSub(db, 's1', now)).toBe(true);
    expect(pinSub(db, 's1', now)).toBe(false);
    expect(pinSub(db, 's2', now)).toBe(false);
    expect(getAllowedAccount(db)?.sub).toBe('s1');
  });
  it('pending login with a malformed expiry fails closed and is deleted', () => {
    const { db } = fresh();
    savePendingLogin(db, { stateHash: 'bad', nonce: 'n', verifier: 'v', reauth: false, sessionHash: null,
      createdAt: now.toISOString(), expiresAt: 'garbage' });
    expect(takePendingLogin(db, 'bad', now)).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS n FROM pending_login').get() as { n: number }).n).toBe(0);
  });
  it('pending login is single use and expiry deletes', () => {
    const { db } = fresh();
    const p = { stateHash: 'sh', nonce: 'n', verifier: 'v', reauth: true, sessionHash: null,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60000).toISOString() };
    savePendingLogin(db, p);
    expect(takePendingLogin(db, 'sh', now)).toEqual(p);
    expect(takePendingLogin(db, 'sh', now)).toBeNull();
    savePendingLogin(db, p);
    expect(takePendingLogin(db, 'sh', new Date(now.getTime() + 120000))).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) c FROM pending_login`).get()).toEqual({ c: 0 });
  });
  it('audit truncates and listAudit clamps', () => {
    const { db } = fresh();
    audit(db, 'login_ok', { note: 'x'.repeat(500), idHint: 'abcdefghijklmnopqrstuvwxyz', ip: '1.2.3.4' }, now);
    const row = db.prepare(`SELECT note, id_hint FROM audit_log`).get() as { note: string; id_hint: string };
    expect(row.note.length).toBe(200);
    expect(row.id_hint.length).toBe(12);
    const cols = (db.prepare(`PRAGMA table_info(audit_log)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols.some((c) => /secret|token|nonce|verifier|cookie|state|code/i.test(c))).toBe(false);
    for (let i = 0; i < 5; i++) audit(db, 'logout', {}, now);
    expect(listAudit(db, 0, undefined).length).toBe(1);
    expect(listAudit(db, 1000).length).toBe(6);
    const all = listAudit(db, 200);
    expect(listAudit(db, 200, all[2]!.id).length).toBe(3);
  });
});

describe('pending login prune and cap', () => {
  const mk = (i: number, createdMs: number, ttlMs: number) => ({
    stateHash: `h${i}`, nonce: 'n', verifier: 'v', reauth: false, sessionHash: null,
    createdAt: new Date(createdMs).toISOString(), expiresAt: new Date(createdMs + ttlMs).toISOString(),
  });
  const count = (db: ReturnType<typeof fresh>['db']) =>
    (db.prepare('SELECT COUNT(*) AS n FROM pending_login').get() as { n: number }).n;

  it('caps live rows, drops the oldest, keeps the newest takeable', () => {
    const { db } = fresh();
    const t0 = now.getTime();
    for (let i = 0; i < 150; i++) savePendingLogin(db, mk(i, t0 + i * 1000, 600_000));
    expect(count(db)).toBe(100);
    expect(takePendingLogin(db, 'h0', new Date(t0 + 200_000))).toBeNull();
    expect(takePendingLogin(db, 'h149', new Date(t0 + 200_000))).not.toBeNull();
  });

  it('removes expired rows on the next save', () => {
    const { db } = fresh();
    const t0 = now.getTime();
    for (let i = 0; i < 5; i++) savePendingLogin(db, mk(i, t0, 1000));
    expect(count(db)).toBe(5);
    savePendingLogin(db, mk(99, t0 + 5000, 600_000));
    expect(count(db)).toBe(1);
  });
});
