// LinkedIn free accounts get a monthly quota of personalized invite notes. When it runs out, the 'Add a note' flow
// shows a Premium upsell. The fact is kept in scheduler_state until the 1st of the next month (IST), so later arms
// know: invites then go out without a note (arm kind connect_plain) and still use the daily invite ceiling.
import type BetterSqlite3 from 'better-sqlite3';
import { getState, setState } from '../scheduler/runLog.js';

export const NOTE_QUOTA_KEY = 'linkedin_note_quota_until';
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/** First instant of the next calendar month in IST, as a Date. */
export function nextMonthStartIst(now: Date): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 1) - IST_OFFSET_MS);
}

/** Store that the note quota is used up (until the 1st of next month IST). */
export function markNoteQuotaExhausted(db: BetterSqlite3.Database, now: Date): void {
  setState(db, NOTE_QUOTA_KEY, nextMonthStartIst(now).toISOString(), now);
}

/** When the quota resets, or null when notes are available. An expired key is cleared on read. */
export function noteQuotaUntil(db: BetterSqlite3.Database, now: Date): Date | null {
  const v = getState(db, NOTE_QUOTA_KEY);
  if (v === null) return null;
  const until = new Date(v);
  if (!Number.isNaN(until.getTime()) && now < until) return until;
  db.prepare('DELETE FROM scheduler_state WHERE key = ?').run(NOTE_QUOTA_KEY);
  return null;
}
