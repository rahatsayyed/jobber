// src/outreach/applyEscalations.ts
// Open `apply:*` escalations and the job they are about. Two jobs:
//  1. parse the job, host and url out of an escalation's stored detail (new rows carry `job=<id>`; old rows only host and url);
//  2. close an escalation (resolved_note "job moved on") once its job left the failing states, so the Inbox does not keep a card for a job
//     that was applied to, skipped, closed or put back in the queue. Rows are never deleted.
// Dependency-light on purpose: db.ts, the apply code and the owner scripts all import it.
import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

/** apply_status values that mean the job still waits for the owner (or is parked). Anything else means the job moved on. */
export const FAILING_APPLY_STATUSES = ['manual_review', 'needs_owner', 'needs_answer', 'needs_human', 'held'] as const;
export const JOB_MOVED_ON_NOTE = 'job moved on';

export interface ApplyDetail { jobId: string | null; host: string | null; url: string | null }

const JOB_ID = '[\\w.:@-]{1,200}';
const JOB_EQ_RE = new RegExp(`\\bjob=(${JOB_ID})`);
const JOB_FOR_RE = new RegExp(`\\bfor job (${JOB_ID})`);
const JOB_ASSIST_RE = new RegExp(`apply:assist -- (${JOB_ID})`);
const HOST_RE = /\bhost=([A-Za-z0-9.-]{1,253})/;
const URL_RE = /\burl=(https?:\/\/[^\s]{1,300})/i;
const sanitizeRef = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, '_');

/** Defensive parse of an apply escalation's detail: new rows have `job=<id>`, old ones only `host=` and `url=`. Never throws. */
export function parseApplyDetail(detail: string | null | undefined, threadRef?: string | null): ApplyDetail {
  const d = String(detail ?? '');
  const host = HOST_RE.exec(d)?.[1]?.toLowerCase() ?? null;
  const url = URL_RE.exec(d)?.[1] ?? null;
  const jobId = JOB_EQ_RE.exec(d)?.[1] ?? JOB_FOR_RE.exec(d)?.[1] ?? JOB_ASSIST_RE.exec(d)?.[1] ?? null;
  const ref = /^easyapply:(.+)$/.exec(String(threadRef ?? ''));
  return { jobId: jobId ?? (ref ? ref[1] : null), host, url };
}

function hasTable(db: Db, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}
function hasColumn(db: Db, table: string, name: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === name);
}

/** The job whose stored address equals this url (jobs first, then the queue row's own apply url). Null when none. */
export function findJobByUrl(db: Db, url: string | null | undefined): string | null {
  const u = String(url ?? '').trim();
  if (!u || !hasTable(db, 'jobs')) return null;
  try {
    const ext = hasColumn(db, 'jobs', 'external_apply_url') ? ' OR external_apply_url = @u' : '';
    const j = db.prepare(`SELECT id FROM jobs WHERE apply_url = @u OR url = @u${ext} ORDER BY id LIMIT 1`).get({ u }) as { id: string | number } | undefined;
    if (j) return String(j.id);
    if (hasTable(db, 'outreach_queue')) {
      const q = db.prepare('SELECT job_id FROM outreach_queue WHERE apply_url = ? ORDER BY id LIMIT 1').get(u) as { job_id: string | number } | undefined;
      if (q) return String(q.job_id);
    }
  } catch { /* a database without these columns: no match */ }
  return null;
}

/** The job id the escalation is about: the stored id (checked against jobs when it exists), else the job found by its stored url. */
export function jobIdOfEscalation(db: Db, detail: string | null, threadRef?: string | null): string | null {
  const p = parseApplyDetail(detail, threadRef);
  if (p.jobId) {
    if (!hasTable(db, 'jobs')) return p.jobId;
    try {
      const exact = db.prepare('SELECT id FROM jobs WHERE id = ?').get(p.jobId) as { id: string | number } | undefined;
      if (exact) return String(exact.id);
      // easyapply thread refs hold a sanitized id
      const loose = (db.prepare('SELECT id FROM jobs').all() as { id: string | number }[]).find((r) => sanitizeRef(String(r.id)) === p.jobId);
      if (loose) return String(loose.id);
    } catch { /* fall through to the url */ }
  }
  return findJobByUrl(db, p.url);
}

/** True when the job has queue rows and none of them is in a failing state (applied, skipped, closed, requeued ...). Unknown job: false. */
export function jobMovedOn(db: Db, jobId: string): boolean {
  if (!hasTable(db, 'outreach_queue')) return false;
  const rows = db.prepare('SELECT apply_status FROM outreach_queue WHERE job_id = ?').all(jobId) as { apply_status: string | null }[];
  if (!rows.length) return false;
  return !rows.some((r) => (FAILING_APPLY_STATUSES as readonly string[]).includes(String(r.apply_status ?? '')));
}

interface EscRow { id: number; reason: string; detail: string | null; thread_ref: string | null }

function openApplyRows(db: Db): EscRow[] {
  if (!hasTable(db, 'escalations')) return [];
  return db.prepare("SELECT id, reason, detail, thread_ref FROM escalations WHERE platform = 'apply' AND resolved_at IS NULL AND reason LIKE 'apply:%' ORDER BY id").all() as EscRow[];
}

function resolveRows(db: Db, ids: number[], now: Date): number {
  if (!ids.length) return 0;
  const withNote = hasColumn(db, 'escalations', 'resolved_note');
  const stmt = withNote
    ? db.prepare('UPDATE escalations SET resolved_at = ?, resolved_note = ? WHERE id = ? AND resolved_at IS NULL')
    : db.prepare('UPDATE escalations SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL');
  return db.transaction(() => ids.reduce((n, id) => n + (withNote ? stmt.run(now.toISOString(), JOB_MOVED_ON_NOTE, id) : stmt.run(now.toISOString(), id)).changes, 0))();
}

/** Host-level cards (`answers:<host>`, `assist:<host>`) are stale when nothing of that host still waits. */
function hostRowStale(db: Db, r: EscRow): boolean {
  const m = /^(answers|assist):(.+)$/.exec(r.thread_ref ?? '');
  if (!m) return false;
  const host = m[2].toLowerCase();
  try {
    if (m[1] === 'answers' && /^apply:needs_answer/.test(r.reason)) {
      if (!hasTable(db, 'apply_questions')) return false;
      const n = (db.prepare("SELECT COUNT(*) AS n FROM apply_questions WHERE status = 'open' AND lower(host) = ?").get(host) as { n: number }).n;
      return n === 0;
    }
    if (m[1] === 'assist' && /^apply:needs_human/.test(r.reason) && hasTable(db, 'outreach_queue') && hasTable(db, 'jobs')) {
      const parked = db.prepare("SELECT COALESCE(NULLIF(j.external_apply_url, ''), j.apply_url) AS url FROM outreach_queue q JOIN jobs j ON j.id = q.job_id WHERE q.apply_status = 'needs_human'").all() as { url: string | null }[];
      return !parked.some((p) => { try { return new URL(p.url ?? '').hostname.toLowerCase().replace(/^www\./, '') === host.replace(/^www\./, ''); } catch { return false; } });
    }
  } catch { /* unknown shape: leave it open */ }
  return false;
}

/**
 * Call after any write that moves a job's apply_status. Resolves the job's open `apply:*` escalations (note "job moved on") when the job is NOT
 * in a failing state now, and the host-level cards that nothing waits for any more. Safe on any database; returns the rows closed. Never throws.
 */
export function resolveApplyEscalationsForJob(db: Db, jobId: string, now: Date = new Date()): number {
  try {
    const rows = openApplyRows(db);
    if (!rows.length) return 0;
    const ids: number[] = [];
    const moved = jobMovedOn(db, jobId);
    for (const r of rows) {
      if (/^(answers|assist):/.test(r.thread_ref ?? '')) { if (hostRowStale(db, r)) ids.push(r.id); continue; }
      if (!moved) continue;
      const p = parseApplyDetail(r.detail, r.thread_ref);
      if (p.jobId === jobId || (p.jobId && sanitizeRef(jobId) === p.jobId) || (!p.jobId && p.url !== null && findJobByUrl(db, p.url) === jobId)) ids.push(r.id);
    }
    return resolveRows(db, ids, now);
  } catch {
    return 0;
  }
}

/** Same call for several jobs (the scripts). */
export function resolveApplyEscalationsForJobs(db: Db, jobIds: Iterable<string>, now: Date = new Date()): number {
  let n = 0;
  for (const id of new Set(jobIds)) n += resolveApplyEscalationsForJob(db, id, now);
  return n;
}

export interface StaleReport { scanned: number; stale: number; resolved: number; ids: number[]; unmatched: number }

/** One-time cleanup: every open apply escalation whose job is no longer in a failing state (or whose host-level wait is over). Idempotent. */
export function resolveStaleApplyEscalations(db: Db, opts: { dry?: boolean; now?: Date } = {}): StaleReport {
  const rows = openApplyRows(db);
  const ids: number[] = [];
  let unmatched = 0;
  for (const r of rows) {
    if (/^(answers|assist):/.test(r.thread_ref ?? '')) { if (hostRowStale(db, r)) ids.push(r.id); continue; }
    const jobId = jobIdOfEscalation(db, r.detail, r.thread_ref);
    if (!jobId) { unmatched += 1; continue; }
    if (jobMovedOn(db, jobId)) ids.push(r.id);
  }
  const resolved = opts.dry ? 0 : resolveRows(db, ids, opts.now ?? new Date());
  return { scanned: rows.length, stale: ids.length, resolved, ids, unmatched };
}
