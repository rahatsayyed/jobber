// src/dash/accessToken.ts
// Dashboard access token: 32 random bytes, shown once. Only SHA-256(token) is stored.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthDb } from './authStore.js';

export const TOKEN_BYTES = 32;
const PRESENTED_MAX = 128;
const SHAPE = /^[A-Za-z0-9_-]+$/;

export type Compare = (a: Buffer, b: Buffer) => boolean;

export function generateToken(random: (n: number) => Buffer = randomBytes): string {
  return random(TOKEN_BYTES).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Replace (or create) the stored hash and revoke every session, in one transaction. */
export function setToken(db: AuthDb, token: string, now: Date): { rotated: boolean } {
  const at = now.toISOString();
  const h = hashToken(token);
  return db.transaction((): { rotated: boolean } => {
    const exists = db.prepare('SELECT 1 AS x FROM access_token WHERE id = 1').get() !== undefined;
    if (exists) {
      db.prepare('UPDATE access_token SET token_hash = ?, rotated_at = ? WHERE id = 1').run(h, at);
    } else {
      db.prepare('INSERT INTO access_token (id, token_hash, created_at, rotated_at) VALUES (1, ?, ?, NULL)').run(h, at);
    }
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL').run(at);
    return { rotated: exists };
  })();
}

export function tokenStatus(db: AuthDb): { set: boolean; createdAt: string | null; rotatedAt: string | null } {
  const r = db.prepare('SELECT created_at, rotated_at FROM access_token WHERE id = 1').get() as
    { created_at: string; rotated_at: string | null } | undefined;
  return r
    ? { set: true, createdAt: r.created_at, rotatedAt: r.rotated_at }
    : { set: false, createdAt: null, rotatedAt: null };
}

/** Constant time. Every path (no token, bad shape, mismatch) does one digest comparison. */
export function verifyToken(db: AuthDb, presented: unknown, compare: Compare = timingSafeEqual): boolean {
  const shapeOk = typeof presented === 'string' && presented.length > 0
    && presented.length <= PRESENTED_MAX && SHAPE.test(presented);
  const candidate = createHash('sha256').update(shapeOk ? (presented as string) : '', 'utf8').digest();
  let stored: Buffer | null = null;
  try {
    const r = db.prepare('SELECT token_hash FROM access_token WHERE id = 1').get() as { token_hash: string } | undefined;
    if (r && /^[0-9a-f]{64}$/.test(r.token_hash)) stored = Buffer.from(r.token_hash, 'hex');
  } catch { stored = null; }
  const target = stored ?? randomBytes(32);
  const equal = compare(candidate, target);
  return shapeOk && stored !== null && equal;
}
