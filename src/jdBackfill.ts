// file: src/jdBackfill.ts
// One-off, idempotent repair for jobs that were matched, prepared, emailed or applied to on a snippet instead of a job description (JD).
//   npm run jd:backfill [-- --dry]
// For every job of a JD-gated source (src/jdComplete.ts JD_FETCH_SOURCES) with an incomplete JD that is not vetoed:
//   * NOTHING sent or done yet (no sent email, connect, DM, application, touch): the job is marked `jd_pending`, its stored match result is cleared
//     (so it is scored again on the full JD), jd_note is `reprep` (so the fetch picks it up even outside the 7-day window), and its not-yet-used
//     queue rows get status `needs_reprep` (not sendable, not applicable; rebuilt in place by enqueue_outreach after the JD arrived).
//   * already emailed, applied to, connected or messaged: left exactly as it is, only flagged jd_note = `prepared_without_jd` so the owner can see it.
// Rows are never deleted. A second run changes nothing.
import type BetterSqlite3 from 'better-sqlite3';
import {
  JD_FETCH_SOURCES, JD_NOTE_PREPARED_WITHOUT_JD, JD_NOTE_REPREP, JOB_STATUS_JD_PENDING, QUEUE_STATUS_NEEDS_REPREP, needsJdFetch,
} from './jdComplete.js';
import { jobActedSql, resetMatchFields } from './jdStore.js';

type Db = BetterSqlite3.Database;

export interface JdBackfillResult {
  /** Jobs of a gated source with an incomplete JD that are not vetoed. */
  candidates: number;
  /** Jobs newly marked jd_pending (a second run: 0). */
  marked_pending: number;
  /** Jobs whose stored match result was cleared so they are scored again. */
  scores_cleared: number;
  /** Queue rows newly set to needs_reprep. */
  rows_needs_reprep: number;
  /** Already-acted jobs newly flagged prepared_without_jd. */
  flagged_prepared_without_jd: number;
  /** Candidates left alone because they are marked duplicate or repeat_contact. */
  skipped_other_status: number;
}

export function runJdBackfill(db: Db, opts: { dry?: boolean } = {}): JdBackfillResult {
  const dry = opts.dry === true;
  const out: JdBackfillResult = { candidates: 0, marked_pending: 0, scores_cleared: 0, rows_needs_reprep: 0, flagged_prepared_without_jd: 0, skipped_other_status: 0 };
  const sources = JD_FETCH_SOURCES.map((s) => `'${s}'`).join(', ');
  const rows = db.prepare(
    `SELECT id, source, description, status, score, jd_note, ${jobActedSql('jobs')} AS acted FROM jobs WHERE source IN (${sources}) AND excluded_reason IS NULL`,
  ).all() as Array<{ id: string; source: string; description: string | null; status: string | null; score: number | null; jd_note: string | null; acted: number }>;

  const flag = db.prepare('UPDATE jobs SET jd_note = ? WHERE id = ? AND COALESCE(jd_note, \'\') <> ?');
  const mark = db.prepare('UPDATE jobs SET status = ?, jd_note = ? WHERE id = ?');
  const setReprep = db.prepare('UPDATE jobs SET jd_note = ? WHERE id = ?');
  // Rows that were never sent or applied: nothing done on the platform yet (see jobActedSql for the same rule at job level).
  const rowsToReprep = db.prepare(
    `UPDATE outreach_queue SET status = ?, updated_at = datetime('now')
      WHERE job_id = ? AND status IN ('queued', 'held_review') AND email_sent_at IS NULL
        AND COALESCE(email_status, '') IN ('', 'queued') AND COALESCE(connect_status, '') IN ('', 'queued')
        AND COALESCE(apply_status, '') IN ('', 'queued', 'manual_review', 'needs_owner')`,
  );
  const apply = (): void => {
    for (const r of rows) {
      if (!needsJdFetch(r.source, r.description)) continue;
      out.candidates++;
      if (r.acted) {
        if (r.jd_note !== JD_NOTE_PREPARED_WITHOUT_JD) {
          out.flagged_prepared_without_jd++;
          if (!dry) flag.run(JD_NOTE_PREPARED_WITHOUT_JD, r.id, JD_NOTE_PREPARED_WITHOUT_JD);
        }
        continue;
      }
      if (r.status === 'duplicate' || r.status === 'repeat_contact') { out.skipped_other_status++; continue; }
      if (r.status !== JOB_STATUS_JD_PENDING) {
        out.marked_pending++;
        if (!dry) mark.run(JOB_STATUS_JD_PENDING, JD_NOTE_REPREP, r.id);
      }
      if (r.score !== null) {
        out.scores_cleared++;
        if (!dry) {
          resetMatchFields(db, r.id);
          setReprep.run(JD_NOTE_REPREP, r.id);
        }
      }
      if (dry) {
        out.rows_needs_reprep += (db.prepare(
          `SELECT COUNT(*) AS n FROM outreach_queue WHERE job_id = ? AND status IN ('queued', 'held_review') AND email_sent_at IS NULL
             AND COALESCE(email_status, '') IN ('', 'queued') AND COALESCE(connect_status, '') IN ('', 'queued')
             AND COALESCE(apply_status, '') IN ('', 'queued', 'manual_review', 'needs_owner')`,
        ).get(r.id) as { n: number }).n;
      } else {
        const n = rowsToReprep.run(QUEUE_STATUS_NEEDS_REPREP, r.id).changes;
        out.rows_needs_reprep += n;
        if (n > 0) setReprep.run(JD_NOTE_REPREP, r.id);
      }
    }
  };
  if (dry) apply();
  else db.transaction(apply)();
  return out;
}

export function formatJdBackfill(r: JdBackfillResult, dry: boolean): string[] {
  const w = dry ? 'would ' : '';
  return [
    `${r.candidates} job(s) from Naukri or LinkedIn jobs have no full job description`,
    `${w}mark ${r.marked_pending} job(s) jd_pending (they wait for their description; the fetch tools read it)`,
    `${w}clear the stored match score of ${r.scores_cleared} job(s) (they are scored again on the full description)`,
    `${w}set ${r.rows_needs_reprep} unsent queue row(s) to needs_reprep (not sendable, not applicable until re-prepared)`,
    `${w}flag ${r.flagged_prepared_without_jd} already emailed, applied or messaged job(s) as prepared_without_jd (left untouched)`,
    ...(r.skipped_other_status ? [`${r.skipped_other_status} job(s) left alone (duplicate or repeat_contact)`] : []),
  ];
}
