// tests/dash-access-token.test.ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { openAuthStore } from '../src/dash/authStore.js';
import { createSession } from '../src/dash/sessions.js';
import {
  TOKEN_BYTES, generateToken, hashToken, setToken, tokenStatus, verifyToken,
} from '../src/dash/accessToken.js';

const now = new Date('2026-10-15T10:00:00Z');
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'jobber-'));
  return openAuthStore(join(dir, 'auth.sqlite'));
}

describe('accessToken', () => {
  it('generates 43 base64url chars, distinct per call', () => {
    expect(TOKEN_BYTES).toBe(32);
    const a = generateToken(); const b = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
  it('hashToken is 64 hex and hides the token', () => {
    const t = generateToken();
    const h = hashToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(t);
  });
  it('set then verify; wrong, empty, non-string, oversized are false', () => {
    const db = fresh();
    const t = generateToken();
    expect(setToken(db, t, now)).toEqual({ rotated: false });
    expect(verifyToken(db, t)).toBe(true);
    expect(verifyToken(db, generateToken())).toBe(false);
    expect(verifyToken(db, '')).toBe(false);
    expect(verifyToken(db, 123)).toBe(false);
    expect(verifyToken(db, null)).toBe(false);
    expect(verifyToken(db, 'a'.repeat(129))).toBe(false);
    expect(verifyToken(db, 'bad token!')).toBe(false);
  });
  it('no stored token returns false without throwing', () => {
    const db = fresh();
    expect(verifyToken(db, generateToken())).toBe(false);
    expect(tokenStatus(db)).toEqual({ set: false, createdAt: null, rotatedAt: null });
  });
  it('rotation: old token dies, sessions revoked, status has no hash', () => {
    const db = fresh();
    const t1 = generateToken(); const t2 = generateToken();
    setToken(db, t1, now);
    const s1 = createSession(db, '127.0.0.1', now, now);
    const s2 = createSession(db, '127.0.0.1', now, now);
    const later = new Date(now.getTime() + 1000);
    expect(setToken(db, t2, later)).toEqual({ rotated: true });
    expect(verifyToken(db, t1)).toBe(false);
    expect(verifyToken(db, t2)).toBe(true);
    for (const s of [s1, s2]) {
      const r = db.prepare('SELECT revoked_at FROM sessions WHERE id_hash = ?').get(s.session.idHash) as { revoked_at: string | null };
      expect(r.revoked_at).not.toBeNull();
    }
    const st = tokenStatus(db);
    expect(st).toEqual({ set: true, createdAt: now.toISOString(), rotatedAt: later.toISOString() });
    expect(JSON.stringify(st)).not.toContain(hashToken(t2));
  });
  it('stores only the hash', () => {
    const db = fresh();
    const t = generateToken();
    setToken(db, t, now);
    const r = db.prepare('SELECT * FROM access_token').get() as Record<string, unknown>;
    expect(JSON.stringify(r)).not.toContain(t);
    expect(r.token_hash).toBe(hashToken(t));
  });
  it('uses timingSafeEqual on match, mismatch, invalid-input and no-token paths', () => {
    const db = fresh();
    const lens: number[] = [];
    const spy = vi.fn((a: Buffer, b: Buffer) => { lens.push(a.length); return timingSafeEqual(a, b); });
    expect(verifyToken(db, generateToken(), spy)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const t = generateToken();
    setToken(db, t, now);
    expect(verifyToken(db, t, spy)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(verifyToken(db, generateToken(), spy)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(verifyToken(db, 'x'.repeat(200), spy)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(4);
    expect(verifyToken(db, 42, spy)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(5);
    expect(new Set(lens)).toEqual(new Set([32]));
  });
  it('source has no secret string equality', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'dash', 'accessToken.ts'), 'utf8');
    for (const bad of ['token_hash ===', 'hash ===', '== presented']) expect(src).not.toContain(bad);
  });
});
