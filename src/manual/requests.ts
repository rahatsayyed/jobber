// manual_requests lifecycle: pending -> running (a wake ingested it) -> done | failed. Code only; the model never touches this table.
import type BetterSqlite3 from 'better-sqlite3';
import { saveJob, type Job } from '../db.js';
import { classifyManualUrl, validateManualUrl, type ManualPlatform } from './url.js';

type Db = BetterSqlite3.Database;

export type ManualStatus = 'pending' | 'running' | 'done' | 'failed';
export interface ManualRequest {
  id: number; url: string; kind: 'url' | 'careers'; status: ManualStatus; force: number;
  created_at: string; started_at: string | null; finished_at: string | null; run_id: string | null;
  job_ids: string | null; report: string | null;
}

export const MANUAL_REPORT_MAX_CHARS = 3500;
/** Most jobs one request may hold (a careers page of 200 postings must not flood the priority lane). */
export const MANUAL_MAX_JOBS_PER_REQUEST = 25;

export type CreateResult = { ok: true; id: number; duplicate: boolean; kind: 'url' | 'careers' } | { ok: false; reason: string };

/** Validates the URL (validateManualUrl, classifyManualUrl) and stores a pending request. An identical open request is returned, not duplicated. */
export function createManualRequest(db: Db, rawUrl: unknown, opts: { force?: boolean; now?: Date } = {}): CreateResult {
  const v = validateManualUrl(rawUrl);
  if (!v.ok) return v;
  const cls = classifyManualUrl(v.url);
  if (cls.kind === 'unsupported') return { ok: false, reason: cls.reason };
  const open = db.prepare("SELECT id, force FROM manual_requests WHERE url = ? AND status IN ('pending', 'running') ORDER BY id LIMIT 1").get(v.url) as { id: number; force: number } | undefined;
  if (open) {
    if (opts.force && !open.force) {
      db.prepare('UPDATE manual_requests SET force = 1 WHERE id = ?').run(open.id);
      // The force override lifts a repeat_contact mark the guard already put on this request's jobs.
      for (const id of jobIdsOf(db.prepare('SELECT job_ids FROM manual_requests WHERE id = ?').get(open.id) as { job_ids: string | null })) {
        db.prepare("UPDATE jobs SET status = NULL, prep_offers = 0 WHERE id = ? AND status = 'repeat_contact'").run(id);
      }
    }
    return { ok: true, id: open.id, duplicate: true, kind: cls.requestKind };
  }
  const at = (opts.now ?? new Date()).toISOString();
  const r = db.prepare('INSERT INTO manual_requests (url, kind, status, force, created_at) VALUES (?, ?, ?, ?, ?)').run(v.url, cls.requestKind, 'pending', opts.force ? 1 : 0, at);
  return { ok: true, id: Number(r.lastInsertRowid), duplicate: false, kind: cls.requestKind };
}

export function manualRequestsPending(db: Db): number {
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM manual_requests WHERE status = 'pending'").get() as { n: number }).n;
  } catch {
    return 0;
  }
}

/**
 * Owner-submitted job pages per platform operator: queued manual_url tasks of that platform, plus pending requests whose URL classifies to it
 * (their task is created when the wake starts, after the plan was made).
 */
export function manualPlatformTasks(db: Db): Record<ManualPlatform, number> {
  const out: Record<ManualPlatform, number> = { linkedin: 0, naukri: 0, wellfound: 0 };
  try {
    for (const r of db.prepare("SELECT platform, COUNT(*) AS n FROM source_tasks WHERE reason = 'manual_url' AND state = 'queued' AND platform <> 'manual' GROUP BY platform").all() as { platform: string; n: number }[]) {
      if (r.platform in out) out[r.platform as ManualPlatform] += r.n;
    }
    for (const r of db.prepare("SELECT url FROM manual_requests WHERE status = 'pending'").all() as { url: string }[]) {
      const c = classifyManualUrl(r.url);
      if (c.kind === 'platform') out[c.platform]++;
    }
  } catch {
    // counts are advisory
  }
  return out;
}

export function listManualRequests(db: Db, statuses: ManualStatus[]): ManualRequest[] {
  if (statuses.length === 0) return [];
  return db.prepare(`SELECT * FROM manual_requests WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at ASC, id ASC`).all(...statuses) as ManualRequest[];
}

export function getManualRequest(db: Db, id: number): ManualRequest | undefined {
  return db.prepare('SELECT * FROM manual_requests WHERE id = ?').get(id) as ManualRequest | undefined;
}

export function jobIdsOf(r: Pick<ManualRequest, 'job_ids'>): string[] {
  try {
    const v = JSON.parse(r.job_ids ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function markRunning(db: Db, id: number, runId: string, now: Date): void {
  db.prepare("UPDATE manual_requests SET status = 'running', run_id = ?, started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'pending'").run(runId, now.toISOString(), id);
}

export function finishManualRequest(db: Db, id: number, status: 'done' | 'failed', report: string, now: Date): void {
  db.prepare("UPDATE manual_requests SET status = ?, finished_at = ?, report = ? WHERE id = ?").run(status, now.toISOString(), report.slice(0, MANUAL_REPORT_MAX_CHARS), id);
}

/**
 * Saves owner-submitted jobs at priority 1 under source `<sourceKind>` and links them to the request. A job that is already stored keeps its
 * source and score, gets priority 1 and fresh retry counters (its veto, if any, stays: a manual request never skips a gate; a duplicate or repeat_contact mark is cleared so the guard is judged again).
 * Returns the ids linked (at most MANUAL_MAX_JOBS_PER_REQUEST in total) and how many were cut.
 */
export function saveManualJobs(db: Db, requestId: number, jobs: Job[], sourceKind: string): { linked: string[]; fresh: number; existing: number; truncated: number } {
  const req = getManualRequest(db, requestId);
  if (!req) return { linked: [], fresh: 0, existing: 0, truncated: jobs.length };
  const have = jobIdsOf(req);
  const room = Math.max(0, MANUAL_MAX_JOBS_PER_REQUEST - have.length);
  const take = jobs.filter((j, i) => jobs.findIndex((x) => x.id === j.id) === i && !have.includes(j.id)).slice(0, room);
  let fresh = 0, existing = 0;
  db.transaction(() => {
    for (const j of take) {
      const before = db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(j.id);
      if (before) {
        existing++;
        db.prepare(`UPDATE jobs SET priority = MAX(priority, 1), prep_offers = 0, match_fails = 0,
          status = CASE WHEN status IN ('duplicate', 'repeat_contact') THEN NULL ELSE status END WHERE id = ?`).run(j.id);
      } else {
        saveJob(db, { ...j, source: sourceKind, priority: 1 });
        fresh++;
      }
    }
    const all = [...have, ...take.map((j) => j.id)];
    db.prepare('UPDATE manual_requests SET job_ids = ? WHERE id = ?').run(JSON.stringify(all), requestId);
  })();
  return { linked: take.map((j) => j.id), fresh, existing, truncated: Math.max(0, jobs.length - take.length - jobs.filter((j) => have.includes(j.id)).length) };
}
