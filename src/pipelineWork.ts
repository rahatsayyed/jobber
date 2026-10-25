import type BetterSqlite3 from 'better-sqlite3';
import { classifyApplyUrl } from './apply/registry.js';

/** The pipeline stage considers every job saved in the last PIPELINE_WINDOW_HOURS hours (jobs.created_at, UTC), not a fixed count. */
export const PIPELINE_WINDOW_HOURS = 24;
/** Hard safety ceiling on unscored jobs one wake reads, so a runaway source cannot blow the token or wall budget. */
export const PIPELINE_MAX_JOBS_PER_WAKE_CEILING = 400;
/** A job whose company and title already has an outreach, connection or application on file this recent is not offered again. */
export const REPEAT_CONTACT_DAYS = 90;
/** A job whose twin (same company and title key) was scored this recently counts as already considered. */
export const DUPLICATE_LOOKBACK_DAYS = 90;

/** Closed `jobs.status` values the pipeline writes; the row is kept, only no longer offered. */
export const JOB_STATUS_DUPLICATE = 'duplicate';
export const JOB_STATUS_REPEAT_CONTACT = 'repeat_contact';
export const PIPELINE_SKIP_STATUSES = [JOB_STATUS_DUPLICATE, JOB_STATUS_REPEAT_CONTACT] as const;
export const PIPELINE_SKIP_SQL = `(status IS NULL OR status NOT IN ('${JOB_STATUS_DUPLICATE}', '${JOB_STATUS_REPEAT_CONTACT}'))`;

export interface PipelineSkip {
  job_id: string;
  reason: typeof JOB_STATUS_DUPLICATE | typeof JOB_STATUS_REPEAT_CONTACT;
  /** The job (or earlier twin) that caused the skip. */
  of: string;
}

interface Cand {
  id: string;
  source: string | null;
  apply_url: string | null;
  created_at: string;
  company_key: string | null;
  title_key: string | null;
  rid: number;
}

/** SQLite `datetime('now')` format (UTC, no zone), comparable as text with jobs.created_at. */
export function sqlTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export interface PipelineWorkOpts {
  now?: Date;
  windowHours?: number;
  /** Rejected match saves after which a job is given up on (MATCH_FAIL_LIMIT). */
  failLimit: number;
  /** With a threshold, matched jobs without an outreach row are also checked for the repeated-contact rule. */
  matchThreshold?: number;
  prepOfferLimit?: number;
}

export interface PipelineWork {
  /** Unscored candidates that are offered: inside the window, not duplicates, not repeats. */
  offer: string[];
  /** Matched jobs (score >= matchThreshold, no outreach row, prep offers left) that are offered: not skipped as repeat contacts. Empty without a matchThreshold. */
  matchedOffer: string[];
  skips: PipelineSkip[];
}

const hasKeys = (r: Cand): boolean => !!r.company_key && !!r.title_key;

/**
 * Pure read: decides which unscored jobs of the window are offered and which are skipped as a duplicate (same company_key and
 * title_key as a job already scored, or as an earlier/ATS-hosted job in the same batch) or as a repeated contact (same company
 * and title already has an outreach, connection or application within REPEAT_CONTACT_DAYS). Writes nothing.
 */
export function planPipelineWork(db: BetterSqlite3.Database, o: PipelineWorkOpts): PipelineWork {
  const now = o.now ?? new Date();
  const cutoff = sqlTime(new Date(now.getTime() - (o.windowHours ?? PIPELINE_WINDOW_HOURS) * 3600_000));
  const cutoffRepeat = sqlTime(new Date(now.getTime() - REPEAT_CONTACT_DAYS * 86400_000));
  const cutoffDup = sqlTime(new Date(now.getTime() - DUPLICATE_LOOKBACK_DAYS * 86400_000));
  const cols = 'id, source, apply_url, created_at, company_key, title_key, rowid AS rid';
  const fresh = db.prepare(
    `SELECT ${cols} FROM jobs
      WHERE score IS NULL AND excluded_reason IS NULL AND match_fails < ? AND created_at >= ? AND priority = 0 AND ${PIPELINE_SKIP_SQL}`,
  ).all(o.failLimit, cutoff) as Cand[];
  const matched = typeof o.matchThreshold === 'number'
    ? db.prepare(
      `SELECT ${cols} FROM jobs
        WHERE score >= ? AND excluded_reason IS NULL AND prep_offers < ? AND priority = 0 AND ${PIPELINE_SKIP_SQL}
          AND NOT EXISTS (SELECT 1 FROM outreach_queue q WHERE q.job_id = jobs.id)`,
    ).all(o.matchThreshold, o.prepOfferLimit ?? 4) as Cand[]
    : [];
  const repeatStmt = db.prepare(
    `SELECT j2.id AS id FROM jobs j2
      WHERE j2.id != ? AND j2.company_key = ? AND j2.title_key = ? AND (
        EXISTS (SELECT 1 FROM outreach_queue q WHERE q.job_id = j2.id AND q.created_at >= ? AND coalesce(q.status, '') != 'skipped')
        OR EXISTS (SELECT 1 FROM outreach o WHERE o.job_id = j2.id AND o.created_at >= ? AND o.status = 'sent')
        OR EXISTS (SELECT 1 FROM connections c WHERE c.job_id = j2.id AND c.created_at >= ?)
        OR EXISTS (SELECT 1 FROM applications a WHERE a.job_id = j2.id AND a.created_at >= ?))
      LIMIT 1`,
  );
  const scoredTwinStmt = db.prepare(
    `SELECT id FROM jobs WHERE id != ? AND company_key = ? AND title_key = ? AND created_at >= ?
        AND (score IS NOT NULL OR excluded_reason IS NOT NULL) LIMIT 1`,
  );
  const skips: PipelineSkip[] = [];
  const skipped = new Set<string>();
  const repeatOf = (r: Cand): string | undefined =>
    hasKeys(r) ? (repeatStmt.get(r.id, r.company_key, r.title_key, cutoffRepeat, cutoffRepeat, cutoffRepeat, cutoffRepeat) as { id: string } | undefined)?.id : undefined;

  for (const r of matched) {
    const of = repeatOf(r);
    if (of) { skips.push({ job_id: r.id, reason: JOB_STATUS_REPEAT_CONTACT, of }); skipped.add(r.id); }
  }
  const survivors: Cand[] = [];
  for (const r of fresh) {
    const rep = repeatOf(r);
    if (rep) { skips.push({ job_id: r.id, reason: JOB_STATUS_REPEAT_CONTACT, of: rep }); skipped.add(r.id); continue; }
    const twin = hasKeys(r) ? (scoredTwinStmt.get(r.id, r.company_key, r.title_key, cutoffDup) as { id: string } | undefined)?.id : undefined;
    if (twin) { skips.push({ job_id: r.id, reason: JOB_STATUS_DUPLICATE, of: twin }); skipped.add(r.id); continue; }
    survivors.push(r);
  }
  // Same posting from several sources in this batch: keep the ATS-hosted one, then the oldest.
  const groups = new Map<string, Cand[]>();
  for (const r of survivors) {
    if (!hasKeys(r)) continue;
    const k = `${r.company_key}\u0000${r.title_key}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const atsRank = (r: Cand): number => (classifyApplyUrl(r.apply_url, r.source).platform !== 'none' ? 0 : 1);
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => atsRank(a) - atsRank(b) || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0) || a.rid - b.rid);
    for (const r of g.slice(1)) { skips.push({ job_id: r.id, reason: JOB_STATUS_DUPLICATE, of: g[0].id }); skipped.add(r.id); }
  }
  return {
    offer: survivors.filter((r) => !skipped.has(r.id)).map((r) => r.id),
    matchedOffer: matched.filter((r) => !skipped.has(r.id)).map((r) => r.id),
    skips,
  };
}

/** The id of another job with the same company and title that was contacted (outreach, connection, application) within REPEAT_CONTACT_DAYS, if any. */
export function repeatContactOf(db: BetterSqlite3.Database, jobId: string, now: Date = new Date()): string | undefined {
  const j = db.prepare('SELECT company_key, title_key FROM jobs WHERE id = ?').get(jobId) as { company_key: string | null; title_key: string | null } | undefined;
  if (!j || !j.company_key || !j.title_key) return undefined;
  const c = sqlTime(new Date(now.getTime() - REPEAT_CONTACT_DAYS * 86400_000));
  return (db.prepare(
    `SELECT j2.id AS id FROM jobs j2
      WHERE j2.id != ? AND j2.company_key = ? AND j2.title_key = ? AND (
        EXISTS (SELECT 1 FROM outreach_queue q WHERE q.job_id = j2.id AND q.created_at >= ? AND coalesce(q.status, '') != 'skipped')
        OR EXISTS (SELECT 1 FROM outreach o WHERE o.job_id = j2.id AND o.created_at >= ? AND o.status = 'sent')
        OR EXISTS (SELECT 1 FROM connections c WHERE c.job_id = j2.id AND c.created_at >= ?)
        OR EXISTS (SELECT 1 FROM applications a WHERE a.job_id = j2.id AND a.created_at >= ?))
      LIMIT 1`,
  ).get(jobId, j.company_key, j.title_key, c, c, c, c) as { id: string } | undefined)?.id;
}

/**
 * Owner-submitted (priority) rows keep the 90-day repeat-contact guard. A row of a forced request (`forced` truthy) passes it.
 * Any other row that repeats is marked jobs.status 'repeat_contact' (kept, never deleted) and dropped from the offer; the owner report says so.
 */
export function applyPriorityRepeats<T extends Record<string, unknown>>(db: BetterSqlite3.Database, rows: T[], now: Date = new Date()): T[] {
  const skips: PipelineSkip[] = [];
  const kept = rows.filter((r) => {
    if (r['forced']) return true;
    const of = repeatContactOf(db, String(r['id']), now);
    if (!of) return true;
    skips.push({ job_id: String(r['id']), reason: JOB_STATUS_REPEAT_CONTACT, of });
    return false;
  });
  applyPipelineSkips(db, skips);
  return kept;
}

/** Persists skips as `jobs.status`; rows are never deleted. Returns rows changed. */
export function applyPipelineSkips(db: BetterSqlite3.Database, skips: PipelineSkip[]): number {
  if (!skips.length) return 0;
  const upd = db.prepare(`UPDATE jobs SET status = ? WHERE id = ? AND ${PIPELINE_SKIP_SQL}`);
  let n = 0;
  db.transaction(() => { for (const s of skips) n += upd.run(s.reason, s.job_id).changes; })();
  return n;
}
