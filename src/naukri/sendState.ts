// Naukri message bookkeeping shared by the arm tool (gates) and the commit path (record after send).
// Moved out of the old naukriSendMessage; behaviour is unchanged: the person row and contact state, the
// cadence snapshot, the idempotency key, the consecutive-failure counter that halts naukri, and the
// record written once a send is confirmed.
import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { planNextTouch, type ContactSnapshot, type TouchKind } from '../outreach/cadence.js';
import { haltPlatform } from '../outreach/limits.js';
import type { Tuning } from '../outreach/tuning.js';
import { getState, setState } from '../scheduler/runLog.js';

type Db = BetterSqlite3.Database;

export const MAX_NAUKRI_MESSAGE_CHARS = 1800;
export const FAILURE_LIMIT = 3;

export function naukriIdempotencyKey(personId: number, kind: string, normalized: string): string {
  return `naukri:${personId}:${kind}:${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;
}

export const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
export const failKey = (runId: string | null, now: Date): string =>
  `naukri_send_failures_${runId ?? `adhoc_${now.toISOString().slice(0, 10)}`}`;
export const threadStateKey = (personId: number): string => `naukri_thread_${personId}`;

export interface NaukriPersonRow {
  id: number; platform: string; profile_key: string; name: string | null; company_key: string;
  category: 'recruiter' | 'hiring_manager' | 'peer' | 'connection';
  stage: string | null; variant: 'rapport_first' | 'direct_referral' | null;
  cycle_started_at: string | null; cooldown_until: string | null; paused_reason: string | null;
}

export function loadNaukriPerson(db: Db, id: number): NaukriPersonRow | null {
  const r = db.prepare(
    `SELECT p.id, p.platform, p.profile_key, p.name, p.company_key, p.category,
            c.stage, c.variant, c.cycle_started_at, c.cooldown_until, c.paused_reason
       FROM people p LEFT JOIN contact_state c ON c.person_id = p.id WHERE p.id = ?`,
  ).get(id) as NaukriPersonRow | undefined;
  return r ?? null;
}

export function sentMessages(db: Db, p: NaukriPersonRow): { kind: TouchKind; sentAt: Date }[] {
  const rows = db.prepare(
    `SELECT kind, sent_at FROM touches WHERE person_id = ? AND status = 'sent' AND kind != 'connect'
       AND sent_at IS NOT NULL AND (? IS NULL OR sent_at >= ?) ORDER BY sent_at ASC, id ASC`,
  ).all(p.id, p.cycle_started_at, p.cycle_started_at) as { kind: TouchKind; sent_at: string }[];
  return rows.map((r) => ({ kind: r.kind, sentAt: new Date(r.sent_at) }));
}

// Naukri has no connect step: the connect anchor is the epoch so the first message is due at once.
export function cadenceSnapshot(p: NaukriPersonRow, messages: { kind: TouchKind; sentAt: Date }[]): ContactSnapshot {
  return {
    category: p.category, variant: p.variant, connected: true, connectedAt: null,
    connectSentAt: new Date(0), messages, replied: false, pausedReason: null, cooldownUntil: null,
  };
}

/** Count one send failure for this run; the third halts naukri. Returns the new count. */
export function bumpFailures(db: Db, runId: string | null, now: Date): number {
  const k = failKey(runId, now);
  const n = (Number.parseInt(getState(db, k) ?? '0', 10) || 0) + 1;
  setState(db, k, String(n), now);
  if (n >= FAILURE_LIMIT) haltPlatform(db, 'naukri', `${n} consecutive naukri send failures`, now);
  return n;
}

/**
 * Bookkeeping after a confirmed send (the touch row is already 'sent'): reset the failure counter,
 * remember the confirmed thread, and move contact_state forward. Returns false when it failed; a
 * bookkeeping error never downgrades the send.
 */
export function recordNaukriSent(
  db: Db, p: NaukriPersonRow, threadRef: string, kind: string, runId: string | null, now: Date, tuning: Tuning,
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
