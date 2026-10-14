// tests/dash-account.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAuthStore, getAllowedAccount, pinSub, type AuthDb } from '../src/dash/authStore.js';
import { normaliseEmail, evaluateLogin, allowAccount, accountStatus } from '../src/dash/account.js';
import { parseArgs } from '../scripts/dashboard.js';

const now = new Date('2026-10-14T10:00:00Z');
let dir: string;
let db: AuthDb;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'acct-')); db = openAuthStore(join(dir, 'a.sqlite')); });
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
const id = (sub: string, email = 'me@example.com', emailVerified = true) => ({ sub, email, emailVerified });

describe('normaliseEmail', () => {
  it('trims and lowercases', () => expect(normaliseEmail('  Me@Example.COM ')).toBe('me@example.com'));
  it('rejects bad input', () => {
    for (const s of ['a@b@c', '', 'no-at', 'a b@c.d', '@']) expect(normaliseEmail(s)).toBeNull();
    expect(normaliseEmail('a@' + 'b'.repeat(260))).toBeNull();
  });
});

describe('evaluateLogin', () => {
  it('no account', () => {
    expect(evaluateLogin(db, id('s1'), now)).toEqual({ ok: false, reason: 'no_account' });
  });
  it('pins on first login, passes second', () => {
    allowAccount(db, 'me@example.com', now);
    expect(evaluateLogin(db, id('s1'), now)).toEqual({ ok: true, pinned: true });
    expect(evaluateLogin(db, id('s1'), now)).toEqual({ ok: true, pinned: false });
  });
  it('same email, different sub', () => {
    allowAccount(db, 'me@example.com', now);
    evaluateLogin(db, id('s1'), now);
    expect(evaluateLogin(db, id('s2'), now)).toEqual({ ok: false, reason: 'sub_mismatch' });
  });
  it('same sub, changed email', () => {
    allowAccount(db, 'me@example.com', now);
    evaluateLogin(db, id('s1'), now);
    expect(evaluateLogin(db, id('s1', 'other@example.com'), now)).toEqual({ ok: false, reason: 'email_mismatch' });
  });
  it('different account: denied, no state change', () => {
    allowAccount(db, 'me@example.com', now);
    const before = getAllowedAccount(db);
    expect(evaluateLogin(db, id('s9', 'x@example.com'), now)).toEqual({ ok: false, reason: 'email_mismatch' });
    expect(getAllowedAccount(db)).toEqual(before);
  });
  it('unverified denied before pinning', () => {
    allowAccount(db, 'me@example.com', now);
    expect(evaluateLogin(db, id('s1', 'me@example.com', false), now)).toEqual({ ok: false, reason: 'unverified' });
    expect(getAllowedAccount(db)?.sub).toBeNull();
  });
  it('case-insensitive but exact', () => {
    allowAccount(db, 'me@example.com', now);
    expect(evaluateLogin(db, id('s1', 'ME@Example.com'), now).ok).toBe(true);
    expect(evaluateLogin(db, id('s1', 'me+tag@example.com'), now)).toEqual({ ok: false, reason: 'email_mismatch' });
    expect(evaluateLogin(db, id('s1', 'me@sub.example.com'), now)).toEqual({ ok: false, reason: 'email_mismatch' });
  });
  it('concurrent pins: exactly one wins', () => {
    allowAccount(db, 'me@example.com', now);
    expect(pinSub(db, 'a', now)).toBe(true);
    expect(pinSub(db, 'b', now)).toBe(false);
    expect(getAllowedAccount(db)?.sub).toBe('a');
    expect(evaluateLogin(db, id('b'), now)).toEqual({ ok: false, reason: 'sub_mismatch' });
  });
});

describe('allowAccount', () => {
  it('clears pin and revokes sessions', () => {
    allowAccount(db, 'me@example.com', now);
    evaluateLogin(db, id('s1'), now);
    db.prepare("INSERT INTO sessions (id_hash, created_at, last_seen_at, auth_at, expires_at) VALUES ('h','t','t','t','2099-01-01T00:00:00Z')").run();
    expect(accountStatus(db, now)!.activeSessions).toBe(1);
    expect(allowAccount(db, 'New@Example.com', now)).toEqual({ ok: true });
    const a = getAllowedAccount(db)!;
    expect(a.email).toBe('new@example.com');
    expect(a.sub).toBeNull();
    expect(accountStatus(db, now)!.activeSessions).toBe(0);
  });
  it('rejects invalid emails', () => {
    for (const s of ['a@b@c', '', 'a b@c.d']) {
      expect(allowAccount(db, s, now)).toEqual({ ok: false, reason: 'invalid_email' });
    }
    expect(getAllowedAccount(db)).toBeNull();
  });
});

describe('parseArgs', () => {
  it('parses commands', () => {
    expect(parseArgs(['allow', 'a@b.co'])).toEqual({ ok: true, cmd: 'allow', email: 'a@b.co' });
    expect(parseArgs(['status'])).toEqual({ ok: true, cmd: 'status' });
    expect(parseArgs(['audit'])).toEqual({ ok: true, cmd: 'audit', n: 50 });
    expect(parseArgs(['audit', '500'])).toEqual({ ok: true, cmd: 'audit', n: 200 });
    expect(parseArgs(['audit', '7'])).toEqual({ ok: true, cmd: 'audit', n: 7 });
  });
  it('rejects bad args', () => {
    for (const a of [[], ['bogus'], ['allow'], ['allow', 'a', 'b'], ['status', 'x'], ['audit', 'x'], ['audit', '0'], ['audit', '-3']]) {
      expect(parseArgs(a).ok).toBe(false);
    }
  });
});
