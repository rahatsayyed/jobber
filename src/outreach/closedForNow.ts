// src/outreach/closedForNow.ts
// After a recruiter says "no opening right now / on hold / will keep your profile" (verdict `closed_for_now`) the agent goes quiet for that job and
// company: pending follow-ups end, queued rows stop, and the people of that company are paused so no LinkedIn, Naukri or Wellfound connect, DM or
// follow-up is armed. The reason code is `closed_for_now` everywhere. The job OUTCOME is never recorded here (auto-record stays off): the existing
// reply proposal is the only outcome path. Rows already sent, sending or submitted are never touched. Idempotent. Never throws.
import type BetterSqlite3 from 'better-sqlite3';
import { skipPendingFollowups } from '../db.js';
import { companyKey } from '../reposts.js';

type Db = BetterSqlite3.Database;

export const CLOSED_FOR_NOW = 'closed_for_now';

export interface CloseResult { jobs: number; queue_rows: number; followups: number; touches: number; people_paused: number }

/** Job ids of the same company (same normalised company key) as `jobId`, the job itself included. */
function sameCompanyJobs(db: Db, jobId: string): { ids: string[]; key: string } {
  const row = db.prepare('SELECT company FROM jobs WHERE id = ?').get(jobId) as { company: string | null } | undefined;
  const key = companyKey(row?.company);
  if (!row || !key) return { ids: [jobId], key: '' };
  const ids = (db.prepare("SELECT id, company FROM jobs WHERE company IS NOT NULL AND company <> ''").all() as Array<{ id: string; company: string }>)
    .filter((j) => companyKey(j.company) === key).map((j) => j.id);
  return { ids: ids.includes(jobId) ? ids : [jobId, ...ids], key };
}

export function closeJobOutreach(db: Db, jobId: string, now: Date = new Date()): CloseResult {
  const res: CloseResult = { jobs: 0, queue_rows: 0, followups: 0, touches: 0, people_paused: 0 };
  try {
    const { ids, key } = sameCompanyJobs(db, jobId);
    res.jobs = ids.length;
    const at = now.toISOString();
    db.transaction(() => {
      for (const id of ids) {
        // Follow-ups: drafted -> skipped, approved -> cancelled (a `sending` row is left to finish).
        res.followups += skipPendingFollowups(db, id);
        // Queue rows that have not gone out: email, connect and apply parts and the row status. Sent, sending and submitted parts stay as they are.
        const r = db.prepare(
          `UPDATE outreach_queue SET
             status = CASE WHEN COALESCE(status, 'queued') IN ('queued', 'needs_reprep', 'held') THEN 'skipped' ELSE status END,
             email_status = CASE WHEN COALESCE(email_status, '') IN ('', 'queued') AND email_sent_at IS NULL THEN 'skipped' ELSE email_status END,
             connect_status = CASE WHEN COALESCE(connect_status, '') IN ('', 'queued') AND connect_profile_url IS NOT NULL THEN 'skipped' ELSE connect_status END,
             apply_status = CASE WHEN COALESCE(apply_status, '') IN ('', 'manual_review') AND COALESCE(apply_platform, '') NOT IN ('', 'none') THEN 'skipped' ELSE apply_status END,
             apply_note = CASE WHEN COALESCE(apply_status, '') IN ('', 'manual_review') AND COALESCE(apply_platform, '') NOT IN ('', 'none') THEN ? ELSE apply_note END,
             status_reason = ?, updated_at = datetime('now')
           WHERE job_id = ?
             AND (COALESCE(status, 'queued') IN ('queued', 'needs_reprep', 'held')
               OR (COALESCE(email_status, '') IN ('', 'queued') AND email_sent_at IS NULL AND email_to IS NOT NULL)
               OR (COALESCE(apply_status, '') IN ('', 'manual_review') AND COALESCE(apply_platform, '') NOT IN ('', 'none')))
             AND COALESCE(email_status, '') NOT IN ('sending', 'sent') AND COALESCE(connect_status, '') NOT IN ('sending', 'sent') AND COALESCE(apply_status, '') NOT IN ('submitted', 'sending')`,
        ).run(CLOSED_FOR_NOW, CLOSED_FOR_NOW, id);
        res.queue_rows += r.changes;
        try {
          res.touches += db.prepare("UPDATE touches SET status = 'skipped' WHERE job_id = ? AND status = 'queued'").run(id).changes;
        } catch { /* no touches table on an old database */ }
      }
      if (key) {
        // Pause every known person of the company on every platform (LinkedIn, Naukri, Wellfound): the due-touch lists, the arm tools and the
        // drip lane all refuse a person with a pause reason. An earlier pause reason is kept.
        try {
          const people = db.prepare('SELECT id FROM people WHERE company_key = ?').all(key) as Array<{ id: number }>;
          for (const p of people) {
            db.prepare('INSERT OR IGNORE INTO contact_state (person_id) VALUES (?)').run(p.id);
            res.people_paused += db.prepare('UPDATE contact_state SET paused_reason = ?, updated_at = ? WHERE person_id = ? AND paused_reason IS NULL').run(CLOSED_FOR_NOW, at, p.id).changes;
          }
        } catch { /* no people table on an old database */ }
      }
    })();
  } catch {
    // never breaks the reply check
  }
  return res;
}
