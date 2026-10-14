// src/dash/queries/jobs.ts
// Read-only job list, bucket counts and job detail for the dashboard. Buckets are derived from existing rows, never stored.
// description, jd_snapshot and message bodies are never selected.
import type BetterSqlite3 from 'better-sqlite3';
import { clampLimit, likePattern, tableExists, type Page } from '../readDb.js';
import { cleanRow, cleanText } from '../clean.js';
import { CONTACTED } from '../../funnel.js';

type Db = BetterSqlite3.Database;

export type JobBucket = 'discovered' | 'matched' | 'applied' | 'pending' | 'failed';
export const JOB_BUCKETS: readonly JobBucket[] = ['discovered', 'matched', 'applied', 'pending', 'failed'];

// Status vocabularies as written by the code (nothing here is invented):
// applications.status: 'submitted' | 'manual_review' | 'failed' | 'needs_answer'  (src/db.ts:481; written by src/apply/linkedin.ts:258
//   and src/apply/external.ts:192; 'rate_limited' is returned to the caller but never stored as a row status).
export const APPLICATION_SUBMITTED = 'submitted';
export const APPLICATION_FAILED = 'failed';
export const APPLICATION_AWAITING_ACTION = ['manual_review', 'needs_answer'] as const;
// outreach_queue.status: DEFAULT 'queued' (src/db.ts:130), 'done' / 'skipped' via update_outreach_status (src/mcp/db.ts:326, src/db.ts:628).
// outreach_queue.email_status / connect_status / apply_status: 'sent' (src/db.ts:229, src/funnel.ts:20), 'submitted' (src/db.ts:761),
//   'failed' (.claude/agents/sender.md:44,57), written through the same updatable-field list (src/db.ts:628).
export const QUEUE_PENDING = 'queued';
export const QUEUE_FAILED = 'failed';

export interface JobRow {
  id: string; title: string; company: string; source: string; score: number | null; confidence: string | null;
  excluded_reason: string | null; posted_at: string | null; deadline: string | null; created_at: string;
  bucket: JobBucket[]; flags: string[];
}

export interface JobDetail extends JobRow {
  url: string | null; apply_url: string | null; strengths: string[]; gaps: string[]; requirements: string[];
  queue: { id: number; status: string; email_status: string | null; connect_status: string | null; apply_status: string | null; ats_coverage: number | null }[];
  applications: { platform: string | null; method: string | null; status: string | null; reason: string | null; applied_at: string | null }[];
  outcomes: { outcome: string; note: string | null; created_at: string }[];
}

const LIMITS: Record<string, number> = {
  id: 200, title: 300, company: 200, source: 64, confidence: 32, excluded_reason: 500, posted_at: 64, deadline: 64, created_at: 64,
  url: 1000, apply_url: 1000, platform: 64, method: 64, status: 64, reason: 500, applied_at: 64, email_status: 32, connect_status: 32,
  apply_status: 32, outcome: 64, note: 1000,
};

const sqlList = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(', ');

interface Exprs { matched: string; applied: string; pending: string; failed: string }
/** Bucket predicates over the `jobs` alias `j`; a missing table makes its predicates constant false. */
function bucketExprs(db: Db): Exprs {
  const hasApps = tableExists(db, 'applications');
  const hasQueue = tableExists(db, 'outreach_queue');
  const app = (cond: string) => `EXISTS (SELECT 1 FROM applications a WHERE a.job_id = j.id AND ${cond})`;
  const que = (cond: string) => `EXISTS (SELECT 1 FROM outreach_queue q WHERE q.job_id = j.id AND ${cond})`;
  const any = (parts: string[]) => (parts.length ? `(${parts.join(' OR ')})` : '0');
  return {
    // Same as funnelStats (src/funnel.ts): an excluded job still counts once contacted. CONTACTED reads three tables.
    matched: tableExists(db, 'outreach') && hasApps && hasQueue
      ? `(j.score >= @threshold AND (j.excluded_reason IS NULL OR j.id IN (${CONTACTED})))`
      : '(j.score >= @threshold AND j.excluded_reason IS NULL)',
    applied: hasApps ? app(`a.status = '${APPLICATION_SUBMITTED}'`) : '0',
    pending: any([
      ...(hasQueue ? [que(`q.status = '${QUEUE_PENDING}'`)] : []),
      ...(hasApps ? [app(`a.status IN (${sqlList(APPLICATION_AWAITING_ACTION)})`)] : []),
    ]),
    failed: any([
      ...(hasApps ? [app(`a.status = '${APPLICATION_FAILED}'`)] : []),
      ...(hasQueue ? [que(`(q.email_status = '${QUEUE_FAILED}' OR q.connect_status = '${QUEUE_FAILED}' OR q.apply_status = '${QUEUE_FAILED}')`)] : []),
    ]),
  };
}

function parseList(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => cleanText(x, 500)) : [];
  } catch {
    return [];
  }
}

const COLS = `j.rowid AS rid, j.id, j.title, j.company, j.source, j.score, j.confidence, j.excluded_reason, j.posted_at, j.deadline,
  j.created_at, j.gate_flags`;

function toRow(r: Record<string, unknown>, ex: Exprs, db: Db, threshold: number): JobRow {
  const flags = parseList(r.gate_flags);
  const b = db.prepare(`SELECT 1 AS discovered, ${ex.matched} AS matched, ${ex.applied} AS applied, ${ex.pending} AS pending, ${ex.failed} AS failed
    FROM jobs j WHERE j.id = @id`).get({ id: r.id, threshold }) as Record<JobBucket, number>;
  const bucket = JOB_BUCKETS.filter((k) => b[k] === 1);
  const { rid: _rid, gate_flags: _g, ...rest } = r;
  const clean = cleanRow(rest as Record<string, unknown>, LIMITS) as Record<string, unknown>;
  return {
    id: String(clean.id), title: String(clean.title ?? ''), company: String(clean.company ?? ''), source: String(clean.source ?? ''),
    score: (clean.score as number | null) ?? null, confidence: (clean.confidence as string | null) ?? null,
    excluded_reason: (clean.excluded_reason as string | null) ?? null, posted_at: (clean.posted_at as string | null) ?? null,
    deadline: (clean.deadline as string | null) ?? null, created_at: String(clean.created_at ?? ''), bucket, flags,
  };
}

/**
 * Ordering: jobs.id is TEXT, so it cannot be a numeric keyset cursor. The table has an implicit rowid (TEXT PRIMARY KEY, not a rowid
 * alias), which increases with insertion and so tracks created_at DESC. The cursor is the rowid of the last item returned; the next
 * page is `rowid < cursor`. Caveat: VACUUM may renumber rowids of such a table, which at worst reshuffles an in-flight paging session.
 */
export function listJobs(db: Db, opts: { bucket?: JobBucket; q?: string; cursor?: number | null; limit?: number; threshold?: number }): Page<JobRow> {
  if (!tableExists(db, 'jobs')) return { items: [], nextCursor: null };
  const limit = clampLimit(opts.limit);
  const threshold = Number.isFinite(opts.threshold) ? (opts.threshold as number) : 60;
  const ex = bucketExprs(db);
  const where: string[] = [];
  const params: Record<string, unknown> = { threshold, lim: limit + 1 };
  if (opts.bucket && opts.bucket !== 'discovered') where.push(ex[opts.bucket]);
  if (opts.q && opts.q.trim() !== '') {
    where.push("(j.title LIKE @like ESCAPE '\\' OR j.company LIKE @like ESCAPE '\\')");
    params.like = likePattern(opts.q);
  }
  if (opts.cursor != null) {
    where.push('j.rowid < @cursor');
    params.cursor = opts.cursor;
  }
  const sql = `SELECT ${COLS} FROM jobs j ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY j.rowid DESC LIMIT @lim`;
  const rows = db.prepare(sql).all(params) as Array<Record<string, unknown>>;
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? (page[page.length - 1].rid as number) : null;
  return { items: page.map((r) => toRow(r, ex, db, threshold)), nextCursor };
}

export function jobCounts(db: Db, threshold: number): Record<JobBucket, number> {
  const zero: Record<JobBucket, number> = { discovered: 0, matched: 0, applied: 0, pending: 0, failed: 0 };
  if (!tableExists(db, 'jobs')) return zero;
  const ex = bucketExprs(db);
  const r = db.prepare(`SELECT COUNT(*) AS discovered,
      COALESCE(SUM(${ex.matched}), 0) AS matched, COALESCE(SUM(${ex.applied}), 0) AS applied,
      COALESCE(SUM(${ex.pending}), 0) AS pending, COALESCE(SUM(${ex.failed}), 0) AS failed FROM jobs j`).get({ threshold }) as Record<JobBucket, number>;
  return { discovered: r.discovered, matched: r.matched, applied: r.applied, pending: r.pending, failed: r.failed };
}

export function jobDetail(db: Db, id: string, threshold = 60): JobDetail | null {
  if (!tableExists(db, 'jobs')) return null;
  const ex = bucketExprs(db);
  const r = db.prepare(`SELECT ${COLS}, j.url, j.apply_url, j.strengths, j.gaps, j.requirements FROM jobs j WHERE j.id = ?`).get(id) as
    Record<string, unknown> | undefined;
  if (!r) return null;
  const { url, apply_url, strengths, gaps, requirements, ...base } = r;
  const row = toRow(base, ex, db, threshold);
  const queue = tableExists(db, 'outreach_queue')
    ? (db.prepare(`SELECT id, status, email_status, connect_status, apply_status, ats_coverage FROM outreach_queue WHERE job_id = ? ORDER BY id DESC LIMIT 50`)
      .all(id) as Array<Record<string, unknown>>).map((q) => cleanRow(q, LIMITS) as unknown as JobDetail['queue'][number])
    : [];
  const applications = tableExists(db, 'applications')
    ? (db.prepare(`SELECT platform, method, status, reason, applied_at FROM applications WHERE job_id = ? ORDER BY id DESC LIMIT 50`)
      .all(id) as Array<Record<string, unknown>>).map((a) => cleanRow(a, LIMITS) as unknown as JobDetail['applications'][number])
    : [];
  const outcomes = tableExists(db, 'job_outcomes')
    ? (db.prepare(`SELECT outcome, note, created_at FROM job_outcomes WHERE job_id = ? ORDER BY id DESC LIMIT 50`)
      .all(id) as Array<Record<string, unknown>>).map((o) => cleanRow(o, LIMITS) as unknown as JobDetail['outcomes'][number])
    : [];
  return {
    ...row,
    url: typeof url === 'string' ? cleanText(url, LIMITS.url) : null,
    apply_url: typeof apply_url === 'string' ? cleanText(apply_url, LIMITS.apply_url) : null,
    strengths: parseList(strengths), gaps: parseList(gaps), requirements: parseList(requirements),
    queue, applications, outcomes,
  };
}
