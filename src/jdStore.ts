// file: src/jdStore.ts
// Persistence rules of the job-description (JD) flow. Pure SQL over better-sqlite3, no browser, no model. Rows are never deleted.
//
//   status `jd_pending`     a job of a snippet-only source (JD_FETCH_SOURCES) whose JD is incomplete; the pipeline does not offer it
//   saveFetchedJd           a complete JD arrived: description stored, the job returns to unscored (score and match fields cleared)
//   markJdUnavailable       the page says the job is gone, or the page never gave a complete JD: excluded `jd_unavailable`
//   queue status `needs_reprep`  a row prepared WITHOUT a JD: not sendable, not applicable, rebuilt after the JD arrives
import type BetterSqlite3 from 'better-sqlite3';
import {
  EXCLUDED_JD_UNAVAILABLE, JD_FETCH_MAX_ATTEMPTS, JD_FETCH_SOURCES, JD_NOTE_REPREP, JOB_STATUS_JD_PENDING, QUEUE_STATUS_NEEDS_REPREP,
  isJdComplete, jdFetchPlatform, needsJdFetch,
} from './jdComplete.js';

type Db = BetterSqlite3.Database;

const PENDING_WINDOW_HOURS = 168;
/** A job whose last page read failed or was incomplete is not picked again for this long. */
export const JD_RETRY_COOLDOWN_MIN = 15;

/** SQLite `datetime('now')` text for a Date (UTC, no zone). */
const sqlTime = (d: Date): string => d.toISOString().slice(0, 19).replace('T', ' ');

/**
 * SQL true when anything has already been SENT or DONE for the job `<alias>` (email, connect, DM, application, outreach row, touch).
 * A job like that is never reset or excluded by the JD flow: its follow-ups must survive.
 */
export function jobActedSql(alias = 'jobs'): string {
  return `(
    EXISTS (SELECT 1 FROM outreach_queue aq WHERE aq.job_id = ${alias}.id
      AND (aq.email_sent_at IS NOT NULL OR COALESCE(aq.email_status, '') NOT IN ('', 'queued') OR COALESCE(aq.connect_status, '') NOT IN ('', 'queued')
           OR COALESCE(aq.apply_status, '') NOT IN ('', 'queued', 'manual_review', 'needs_owner')))
    OR EXISTS (SELECT 1 FROM outreach ao WHERE ao.job_id = ${alias}.id AND ao.status = 'sent')
    OR EXISTS (SELECT 1 FROM applications aa WHERE aa.job_id = ${alias}.id)
    OR EXISTS (SELECT 1 FROM connections ac WHERE ac.job_id = ${alias}.id)
    OR EXISTS (SELECT 1 FROM touches at2 WHERE at2.job_id = ${alias}.id))`;
}

const sourcesSql = (platform: 'naukri' | 'linkedin' | 'any'): string =>
  JD_FETCH_SOURCES.filter((s) => platform === 'any' || jdFetchPlatform(s) === platform).map((s) => `'${s}'`).join(', ');

/** Marks one job `jd_pending` (never over duplicate or repeat_contact, never a vetoed or acted job). True when the row changed. */
export function markJdPending(db: Db, jobId: string): boolean {
  return db.prepare(
    `UPDATE jobs SET status = ? WHERE id = ? AND excluded_reason IS NULL AND (status IS NULL OR status NOT IN ('duplicate', 'repeat_contact', ?))
       AND NOT ${jobActedSql('jobs')}`,
  ).run(JOB_STATUS_JD_PENDING, jobId, JOB_STATUS_JD_PENDING).changes > 0;
}

// Everything the match, veto and prepare stages wrote about a job from a snippet: cleared so the job is scored again on its full JD.
const RESET_MATCH_SQL = `score = NULL, match_reasons = NULL, match_missing = NULL, location_verdict = NULL, language_gate = NULL, language_note = NULL,
  score_dims = NULL, requirements = NULL, strengths = NULL, gaps = NULL, hard_stops = NULL, confidence = NULL, score_cap_reason = NULL, deadline = NULL,
  legitimacy = NULL, legitimacy_signals = NULL, gate_flags = NULL, match_fails = 0, prep_offers = 0`;

/** Clears the stored match result of one job (score, requirement table, gate results, counters) so it is scored again. True when the row changed. */
export function resetMatchFields(db: Db, jobId: string): boolean {
  return db.prepare(`UPDATE jobs SET ${RESET_MATCH_SQL} WHERE id = ?`).run(jobId).changes > 0;
}

export interface SaveJdResult {
  saved: boolean;
  /** True when the job went back to unscored (it was jd_pending): score, match fields and counters were cleared. */
  reset: boolean;
}

/**
 * Stores a complete JD in jobs.description. The text must already be cleaned and gated. A job that was `jd_pending` returns to unscored (status NULL,
 * score and every match field cleared, fail and offer counters zero) so it is matched on the full text; any other job only gets the text.
 */
export function saveFetchedJd(db: Db, jobId: string, text: string, now: Date): SaveJdResult {
  if (!isJdComplete(text)) return { saved: false, reset: false };
  return db.transaction((): SaveJdResult => {
    const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as { status: string | null } | undefined;
    if (!row) return { saved: false, reset: false };
    const stamp = sqlTime(now);
    if (row.status === JOB_STATUS_JD_PENDING) {
      db.prepare(`UPDATE jobs SET description = ?, jd_fetched_at = ?, jd_note = NULL, status = NULL, ${RESET_MATCH_SQL} WHERE id = ?`).run(text, stamp, jobId);
      return { saved: true, reset: true };
    }
    db.prepare('UPDATE jobs SET description = ?, jd_fetched_at = ? WHERE id = ?').run(text, stamp, jobId);
    return { saved: true, reset: false };
  })();
}

/**
 * True when the job must not be prepared or queued yet: it is `jd_pending`, or it comes from a snippet-only source and its stored JD is
 * incomplete. The `enqueue_outreach` tool refuses such a job (a resume, email or apply built on a snippet is a guess).
 */
export function jdBlocksPrepare(db: Db, jobId: string): boolean {
  const r = db.prepare('SELECT source, description, status FROM jobs WHERE id = ?').get(jobId) as { source: string | null; description: string | null; status: string | null } | undefined;
  if (!r) return false;
  return r.status === JOB_STATUS_JD_PENDING || needsJdFetch(r.source, r.description);
}

/** Counts one page read for the job (a read that gave no complete JD still counts). Returns the attempts so far. */
export function recordJdAttempt(db: Db, jobId: string, now: Date): number {
  db.prepare('UPDATE jobs SET jd_fetch_attempts = COALESCE(jd_fetch_attempts, 0) + 1, jd_fetch_at = ? WHERE id = ?').run(sqlTime(now), jobId);
  return (db.prepare('SELECT COALESCE(jd_fetch_attempts, 0) AS n FROM jobs WHERE id = ?').get(jobId) as { n: number } | undefined)?.n ?? 0;
}

/**
 * The job page is gone (closed, removed) or never gave a complete JD: the job is excluded `jd_unavailable` and its not-yet-used queue rows are
 * skipped. A job that was already acted on is never excluded (its follow-ups must survive): only the note is written.
 */
export function markJdUnavailable(db: Db, jobId: string, why: string): { excluded: boolean; rows_skipped: number } {
  return db.transaction(() => {
    const acted = db.prepare(`SELECT ${jobActedSql('jobs')} AS acted FROM jobs WHERE id = ?`).get(jobId) as { acted: number } | undefined;
    if (!acted) return { excluded: false, rows_skipped: 0 };
    if (acted.acted) {
      db.prepare('UPDATE jobs SET jd_note = ? WHERE id = ?').run(`jd_${why}`.slice(0, 60), jobId);
      return { excluded: false, rows_skipped: 0 };
    }
    const ex = db.prepare('UPDATE jobs SET excluded_reason = ?, jd_note = ? WHERE id = ? AND excluded_reason IS NULL').run(EXCLUDED_JD_UNAVAILABLE, why.slice(0, 60), jobId).changes > 0;
    const skipped = db.prepare(
      `UPDATE outreach_queue SET status = 'skipped', updated_at = datetime('now') WHERE job_id = ? AND status IN ('queued', 'held_review', ?)`,
    ).run(jobId, QUEUE_STATUS_NEEDS_REPREP).changes;
    return { excluded: ex, rows_skipped: skipped };
  })();
}

export interface JdCandidate { id: string; source: string; url: string; title: string; priority: number; status: string | null }

/**
 * Jobs whose JD should be fetched next, for one platform: a gated source, an incomplete JD, not vetoed, not acted on, fewer than
 * JD_FETCH_MAX_ATTEMPTS page reads, and either an owner request, inside the pipeline window, or a backfill re-prepare. Owner requests first,
 * promoted next, then the newest. Pure read (nothing is marked).
 */
export function listJdCandidates(db: Db, platform: 'naukri' | 'linkedin' | 'any', now: Date, limit = 50): JdCandidate[] {
  const windowStart = sqlTime(new Date(now.getTime() - PENDING_WINDOW_HOURS * 3600_000));
  const cooldownStart = sqlTime(new Date(now.getTime() - JD_RETRY_COOLDOWN_MIN * 60_000));
  const rows = db.prepare(
    `SELECT id, source, url, title, description, status, COALESCE(priority, 0) AS priority FROM jobs
      WHERE source IN (${sourcesSql(platform)}) AND excluded_reason IS NULL AND (status IS NULL OR status = ?)
        AND COALESCE(jd_fetch_attempts, 0) < ? AND url IS NOT NULL AND url <> ''
        AND (COALESCE(priority, 0) > 0 OR created_at >= ? OR COALESCE(jd_note, '') = ? OR status = ?)
        AND (jd_fetch_at IS NULL OR jd_fetch_at <= ?)
        AND NOT ${jobActedSql('jobs')}
      ORDER BY COALESCE(priority, 0) DESC, COALESCE(promoted, 0) DESC, created_at DESC, rowid DESC`,
  ).all(JOB_STATUS_JD_PENDING, JD_FETCH_MAX_ATTEMPTS, windowStart, JD_NOTE_REPREP, JOB_STATUS_JD_PENDING, cooldownStart) as Array<JdCandidate & { description: string | null }>;
  const out: JdCandidate[] = [];
  for (const r of rows) {
    if (!needsJdFetch(r.source, r.description)) continue;
    out.push({ id: r.id, source: r.source, url: r.url, title: r.title, priority: r.priority, status: r.status });
    if (out.length >= limit) break;
  }
  return out;
}

/** How many jobs wait for a JD fetch, per platform (same rules as listJdCandidates). */
export function countJdWaiting(db: Db, now: Date): { naukri: number; linkedin: number } {
  const n = (p: 'naukri' | 'linkedin'): number => listJdCandidates(db, p, now, 100000).length;
  return { naukri: n('naukri'), linkedin: n('linkedin') };
}

export interface JdStats {
  /** Jobs marked jd_pending. */
  pending: number;
  /** Jobs excluded `jd_unavailable`. */
  unavailable: number;
  /** JDs saved in the last 24 hours. */
  fetched24h: number;
  /** Jobs marked jd_pending plus those the next listing will mark (gated source, incomplete JD, open): the "waiting" figure. */
  waiting: number;
}

export function jdStats(db: Db, now: Date): JdStats {
  const one = (sql: string, ...a: unknown[]): number => (db.prepare(sql).get(...a) as { n: number }).n;
  const since = sqlTime(new Date(now.getTime() - 24 * 3600_000));
  return {
    pending: one(`SELECT COUNT(*) AS n FROM jobs WHERE status = ?`, JOB_STATUS_JD_PENDING),
    unavailable: one(`SELECT COUNT(*) AS n FROM jobs WHERE excluded_reason = ?`, EXCLUDED_JD_UNAVAILABLE),
    fetched24h: one(`SELECT COUNT(*) AS n FROM jobs WHERE jd_fetched_at IS NOT NULL AND jd_fetched_at >= ?`, since),
    waiting: one(`SELECT COUNT(*) AS n FROM jobs WHERE status = ? AND excluded_reason IS NULL`, JOB_STATUS_JD_PENDING)
      + listJdCandidates(db, 'any', now, 100000).filter((c) => c.status === null).length,
  };
}

/** One line for status screens and the wake report: `JD fetched N, unavailable N, waiting N`. */
export function jdReportLine(db: Db, now: Date): string {
  const s = jdStats(db, now);
  return `JD fetched ${s.fetched24h}, unavailable ${s.unavailable}, waiting ${s.waiting}`;
}
