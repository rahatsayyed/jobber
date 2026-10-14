// src/dash/account.ts
// Single allowed dashboard account: email AND pinned OIDC sub are both required.
import { getAllowedAccount, pinSub, setAllowedEmail, type AuthDb } from './authStore.js';

export type LoginDecision =
  | { ok: true; pinned: boolean }
  | { ok: false; reason: 'no_account' | 'email_mismatch' | 'sub_mismatch' | 'unverified' };

const EMAIL_MAX = 254;

export function normaliseEmail(s: string): string | null {
  if (typeof s !== 'string') return null;
  const e = s.trim().toLowerCase();
  if (e.length === 0 || e.length > EMAIL_MAX) return null;
  if (/\s/.test(e)) return null;
  const parts = e.split('@');
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) return null;
  return e;
}

export function evaluateLogin(
  db: AuthDb,
  identity: { sub: string; email: string; emailVerified: boolean },
  now: Date,
): LoginDecision {
  const acct = getAllowedAccount(db);
  if (!acct) return { ok: false, reason: 'no_account' };
  if (!identity.emailVerified) return { ok: false, reason: 'unverified' };
  if (normaliseEmail(identity.email) !== acct.email) return { ok: false, reason: 'email_mismatch' };
  if (!identity.sub) return { ok: false, reason: 'sub_mismatch' };
  if (acct.sub === null) {
    if (pinSub(db, identity.sub, now)) return { ok: true, pinned: true };
    const again = getAllowedAccount(db);
    if (again?.sub === identity.sub) return { ok: true, pinned: false };
    return { ok: false, reason: 'sub_mismatch' };
  }
  if (acct.sub !== identity.sub) return { ok: false, reason: 'sub_mismatch' };
  return { ok: true, pinned: false };
}

export function allowAccount(db: AuthDb, email: string, now: Date): { ok: true } | { ok: false; reason: 'invalid_email' } {
  const e = normaliseEmail(email);
  if (e === null) return { ok: false, reason: 'invalid_email' };
  setAllowedEmail(db, e, now);
  return { ok: true };
}

export function accountStatus(
  db: AuthDb, now: Date,
): { email: string; pinned: boolean; pinnedAt: string | null; activeSessions: number } | null {
  const a = getAllowedAccount(db);
  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ?',
  ).get(now.toISOString()) as { n: number };
  if (!a) return null;
  return { email: a.email, pinned: a.sub !== null, pinnedAt: a.pinnedAt, activeSessions: row.n };
}
