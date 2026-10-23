// Wellfound message bookkeeping shared by the arm tool (gates) and the commit path (record after send).
// Same behaviour as src/naukri/sendState.ts: the person row and contact state, the cadence snapshot, the
// idempotency key, the consecutive-failure counter that halts wellfound, and the record written once a send
// is confirmed. The person loader and the cadence snapshot are platform neutral and reused from there.
import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { planNextTouch } from '../outreach/cadence.js';
import { haltPlatform } from '../outreach/limits.js';
import type { Tuning } from '../outreach/tuning.js';
import { getState, setState } from '../scheduler/runLog.js';
import { cadenceSnapshot, loadNaukriPerson, norm, sentMessages, type NaukriPersonRow } from '../naukri/sendState.js';

type Db = BetterSqlite3.Database;

export { cadenceSnapshot, norm, sentMessages };
export type WellfoundPersonRow = NaukriPersonRow;
export const loadWellfoundPerson = loadNaukriPerson;

export const MAX_WELLFOUND_MESSAGE_CHARS = 1800;
export const FAILURE_LIMIT = 3;

export function wellfoundIdempotencyKey(personId: number, kind: string, normalized: string): string {
  return `wellfound:${personId}:${kind}:${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;
}

export const failKey = (runId: string | null, now: Date): string =>
  `wellfound_send_failures_${runId ?? `adhoc_${now.toISOString().slice(0, 10)}`}`;
export const threadStateKey = (personId: number): string => `wellfound_thread_${personId}`;

/** Count one send failure for this run; the third halts wellfound. Returns the new count. */
export function bumpFailures(db: Db, runId: string | null, now: Date): number {
  const k = failKey(runId, now);
  const n = (Number.parseInt(getState(db, k) ?? '0', 10) || 0) + 1;
  setState(db, k, String(n), now);
  if (n >= FAILURE_LIMIT) haltPlatform(db, 'wellfound', `${n} consecutive wellfound send failures`, now);
  return n;
}

/**
 * Bookkeeping after a confirmed send (the touch row is already 'sent'): reset the failure counter,
 * remember the confirmed thread, and move contact_state forward. Returns false when it failed; a
 * bookkeeping error never downgrades the send.
 */
export function recordWellfoundSent(
  db: Db, p: WellfoundPersonRow, threadRef: string, kind: string, runId: string | null, now: Date, tuning: Tuning,
): boolean {
  try {
    setState(db, failKey(runId, now), '0', now);
    setState(db, threadStateKey(p.id), threadRef, now);
    const next = planNextTouch(cadenceSnapshot(p, sentMessages(db, p)), now, tuning.cadenceGapsDays);
    const at = now.toISOString();
    db.prepare('INSERT OR IGNORE INTO contact_state (person_id) VALUES (?)').run(p.id);
    db.prepare(
      `UPDATE contact_state SET stage = CASE WHEN stage = 'new' THEN 'active' ELSE stage END,
         last_touch_at = ?, followups_sent = followups_sent + ?, next_due_at = ?,
         cycle_started_at = COALESCE(cycle_started_at, ?), updated_at = ? WHERE person_id = ?`,
    ).run(at, kind === 'followup' ? 1 : 0, next ? next.dueAt.toISOString() : null, at, at, p.id);
    return true;
  } catch {
    return false;
  }
}
