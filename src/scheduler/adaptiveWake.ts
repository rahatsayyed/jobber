// src/scheduler/adaptiveWake.ts: the adaptive delay before the next wake. Zero LLM, no gate is touched.
//
// A wake that ended `ok` and made no progress at all (no operator task done or escalated, and no new or newly scored or excluded job,
// no new queue row, no new follow-up) is an EMPTY wake. Each consecutive empty wake doubles the wait: 10, 20, 40, then WAKE_IDLE_MAX_MIN
// (default 60). Any progress, a manual request, a /runhunt wake, new jobs saved by anything, or a daemon start resets it to 10.
import type BetterSqlite3 from 'better-sqlite3';
import { WAKE_INTERVAL_MIN } from '../outreach/quiet.js';
import { getState, setState } from './runLog.js';
import type { WakeCounts } from './stream.js';

type Db = BetterSqlite3.Database;

export const WAKE_IDLE_MAX_DEFAULT_MIN = 60;
export const WAKE_IDLE_MAX_LO_MIN = WAKE_INTERVAL_MIN;
export const WAKE_IDLE_MAX_HI_MIN = 240;
export const STATE_EMPTY_STREAK = 'empty_wake_streak';

/** WAKE_IDLE_MAX_MIN: default 60, clamped to 10..240 (10 means off: wakes stay a fixed 10 minutes apart). Blank or non-numeric is the default. */
export function wakeIdleMaxMin(env: NodeJS.ProcessEnv): number {
  const raw = env.WAKE_IDLE_MAX_MIN;
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) return WAKE_IDLE_MAX_DEFAULT_MIN;
  return Math.min(WAKE_IDLE_MAX_HI_MIN, Math.max(WAKE_IDLE_MAX_LO_MIN, Math.floor(n)));
}

/** Minutes to wait after `streak` consecutive empty wakes: base * 2^streak, never above `maxMin`, never below the base. */
export function adaptiveIntervalMin(streak: number, maxMin: number): number {
  const s = Number.isFinite(streak) && streak > 0 ? Math.floor(streak) : 0;
  const cap = Math.max(WAKE_INTERVAL_MIN, maxMin);
  return Math.min(cap, WAKE_INTERVAL_MIN * 2 ** Math.min(s, 20));
}

export function readEmptyStreak(db: Db): number {
  try {
    const n = Number(getState(db, STATE_EMPTY_STREAK));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

export function writeEmptyStreak(db: Db, streak: number, at: Date): void {
  try {
    setState(db, STATE_EMPTY_STREAK, String(Math.max(0, Math.floor(streak))), at);
  } catch {
    // unwritable state: the next wake simply uses the old value
  }
}

/** Row counts that move when a wake (or anything else) did real work. A null field means the query failed. */
export interface WorkFingerprint {
  jobs: number | null;
  scored: number | null;
  excluded: number | null;
  queue: number | null;
  followups: number | null;
}

export function workFingerprint(db: Db): WorkFingerprint {
  const q = (sql: string): number | null => {
    try {
      const row = db.prepare(sql).get() as { n: number } | undefined;
      return typeof row?.n === 'number' ? row.n : null;
    } catch {
      return null;
    }
  };
  return {
    jobs: q('SELECT COUNT(*) AS n FROM jobs'),
    scored: q('SELECT COUNT(*) AS n FROM jobs WHERE score IS NOT NULL'),
    excluded: q('SELECT COUNT(*) AS n FROM jobs WHERE excluded_reason IS NOT NULL'),
    queue: q('SELECT COUNT(*) AS n FROM outreach_queue'),
    followups: q('SELECT COUNT(*) AS n FROM followups'),
  };
}

/**
 * Did this wake make progress? Conservative: when unsure the answer is true, so an unreadable report or a failed query never lengthens the wait.
 * `counts` null (no final report) is unknown, so progress. Any change in a fingerprint field (up or down) is progress.
 */
export function wakeMadeProgress(counts: WakeCounts | null, before: WorkFingerprint | null, after: WorkFingerprint | null): boolean {
  if (!counts || !before || !after) return true;
  if (counts.done > 0 || counts.escalated > 0) return true;
  for (const k of Object.keys(before) as Array<keyof WorkFingerprint>) {
    const a = before[k];
    const b = after[k];
    if (a === null || b === null) return true;
    if (a !== b) return true;
  }
  return false;
}
