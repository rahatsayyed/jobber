// src/dash/sessions.ts
// Server-side sessions. The cookie holds 32 random bytes (hex); only its SHA-256 is stored.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthDb } from './authStore.js';

export interface SessionInfo { idHash: string; createdAt: string; authAt: string; expiresAt: string; csrf: string }

/**
 * The dashboard is a single-owner console. Keep its persistent session usable
 * for a normal work week, while retaining the existing per-action reauth
 * checks for sensitive operations.
 */
export const DASHBOARD_SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;
const IDLE_MS = DASHBOARD_SESSION_MAX_AGE_SEC * 1000;
const ABSOLUTE_MS = DASHBOARD_SESSION_MAX_AGE_SEC * 1000;
const TOUCH_MS = 60_000;
const MAX_SESSIONS = 3;

/** Random per process start; CSRF tokens do not survive a restart (sessions do). */
const PROCESS_KEY = randomBytes(32);

const hashId = (v: string): string => createHash('sha256').update(v).digest('hex');

export function csrfFor(sessionIdHash: string, serverKey: Buffer): string {
  return createHmac('sha256', serverKey).update(sessionIdHash).digest('hex');
}

export function csrfOk(expected: string, provided: string | undefined): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(provided).digest();
  return timingSafeEqual(a, b);
}

function info(idHash: string, createdAt: string, authAt: string, expiresAt: string): SessionInfo {
  return { idHash, createdAt, authAt, expiresAt, csrf: csrfFor(idHash, PROCESS_KEY) };
}

export function createSession(
  db: AuthDb, ip: string, authAt: Date, now: Date,
): { cookieValue: string; session: SessionInfo } {
  const cookieValue = randomBytes(32).toString('hex');
  const idHash = hashId(cookieValue);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ABSOLUTE_MS).toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO sessions (id_hash, created_at, last_seen_at, auth_at, expires_at, ip, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    ).run(idHash, createdAt, createdAt, authAt.toISOString(), expiresAt, ip);
    const live = db.prepare(
      'SELECT id_hash FROM sessions WHERE revoked_at IS NULL ORDER BY created_at DESC, rowid DESC',
    ).all() as { id_hash: string }[];
    for (const r of live.slice(MAX_SESSIONS)) {
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE id_hash = ?').run(createdAt, r.id_hash);
    }
  })();
  return { cookieValue, session: info(idHash, createdAt, authAt.toISOString(), expiresAt) };
}

export function validateSession(db: AuthDb, cookieValue: string | undefined, now: Date): SessionInfo | null {
  if (typeof cookieValue !== 'string' || !/^[0-9a-f]{64}$/.test(cookieValue)) return null;
  const idHash = hashId(cookieValue);
  const r = db.prepare(
    'SELECT created_at, last_seen_at, auth_at, expires_at, revoked_at FROM sessions WHERE id_hash = ?',
  ).get(idHash) as
    { created_at: string; last_seen_at: string; auth_at: string; expires_at: string; revoked_at: string | null } | undefined;
  if (!r || r.revoked_at) return null;
  const t = now.getTime();
  if (Date.parse(r.expires_at) <= t) return null;
  const seen = Date.parse(r.last_seen_at);
  if (t - seen >= IDLE_MS) return null;
  if (t - seen >= TOUCH_MS) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(now.toISOString(), idHash);
  }
  return info(idHash, r.created_at, r.auth_at, r.expires_at);
}

export function refreshAuth(db: AuthDb, idHash: string, authAt: Date): void {
  db.prepare('UPDATE sessions SET auth_at = ? WHERE id_hash = ?').run(authAt.toISOString(), idHash);
}

export function isFresh(s: SessionInfo, now: Date, maxAgeSec: number): boolean {
  const a = Date.parse(s.authAt);
  return Number.isFinite(a) && now.getTime() - a <= maxAgeSec * 1000;
}

/** `now` is injectable for tests; callers in the server pass the request time. */
export function revokeSession(db: AuthDb, cookieValue: string, now: Date = new Date()): void {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL')
    .run(now.toISOString(), hashId(cookieValue));
}
