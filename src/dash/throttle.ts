// src/dash/throttle.ts
// Login throttling backed by the auth store's login_attempts table.
import type { AuthDb } from './authStore.js';

export interface ThrottleDecision { allowed: boolean; retryAfterSec: number; scope: 'ip' | 'global' | null }

const MIN = 60_000;
const IP_FAILS = 10;
const IP_WINDOW_MS = 10 * MIN;
const IP_LOCK_MS = 15 * MIN;
const GLOBAL_FAILS = 20;
const GLOBAL_WINDOW_MS = 60 * MIN;
const GLOBAL_LOCK_MS = 60 * MIN;
const KEEP_MS = 24 * 60 * MIN;

/** A lock applies when the N most recent failures fit inside the window; it lasts lockMs after the newest one. */
function lockRemainingMs(times: string[], n: number, windowMs: number, lockMs: number, now: Date): number {
  if (times.length < n) return 0;
  const newest = Date.parse(times[0]!);
  const oldest = Date.parse(times[n - 1]!);
  if (newest - oldest > windowMs) return 0;
  return Math.max(0, newest + lockMs - now.getTime());
}

export function checkLogin(db: AuthDb, ip: string, now: Date): ThrottleDecision {
  const ipTimes = (db.prepare(
    'SELECT at FROM login_attempts WHERE ok = 0 AND ip = ? ORDER BY at DESC LIMIT ?',
  ).all(ip, IP_FAILS) as { at: string }[]).map((r) => r.at);
  const allTimes = (db.prepare(
    'SELECT at FROM login_attempts WHERE ok = 0 ORDER BY at DESC LIMIT ?',
  ).all(GLOBAL_FAILS) as { at: string }[]).map((r) => r.at);
  const ipLeft = lockRemainingMs(ipTimes, IP_FAILS, IP_WINDOW_MS, IP_LOCK_MS, now);
  const globalLeft = lockRemainingMs(allTimes, GLOBAL_FAILS, GLOBAL_WINDOW_MS, GLOBAL_LOCK_MS, now);
  if (ipLeft <= 0 && globalLeft <= 0) return { allowed: true, retryAfterSec: 0, scope: null };
  const useGlobal = globalLeft >= ipLeft;
  const left = useGlobal ? globalLeft : ipLeft;
  return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(left / 1000)), scope: useGlobal ? 'global' : 'ip' };
}

export function recordLogin(db: AuthDb, ip: string, ok: boolean, now: Date): void {
  db.transaction(() => {
    db.prepare('DELETE FROM login_attempts WHERE at < ?').run(new Date(now.getTime() - KEEP_MS).toISOString());
    db.prepare('INSERT INTO login_attempts (at, ip, ok) VALUES (?, ?, ?)').run(now.toISOString(), ip, ok ? 1 : 0);
  })();
}
