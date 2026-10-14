import type BetterSqlite3 from 'better-sqlite3';
import { hasExclusionOverride, jobHasActedWork, repostCountForJob } from './db.js';
import type { JobFacts } from './vetoes.js';

/** Per-job facts the gates need, read from the jobs table (never from the model). */
export function jobFactsFromDb(db: BetterSqlite3.Database, jobId: string): JobFacts {
  const r = db.prepare('SELECT source, url, apply_url, posted_at, deadline, hard_stops, coalesce(length(jd_snapshot), 0) AS snapshot_chars FROM jobs WHERE id = ?').get(jobId) as
    | { source: string | null; url: string | null; apply_url: string | null; posted_at: string | null; deadline: string | null; hard_stops: string | null; snapshot_chars: number }
    | undefined;
  if (!r) return {};
  let hard: string[] = [];
  let unreadable = false;
  // null / empty string / '[]' = no hard stops; anything else that is not a JSON array is corrupt (fail closed).
  if (r.hard_stops != null && r.hard_stops.trim() !== '') {
    try {
      const v = JSON.parse(r.hard_stops);
      if (Array.isArray(v)) hard = v.filter((x) => typeof x === 'string');
      else unreadable = true;
    } catch { unreadable = true; }
  }
  const f: JobFacts = { source: r.source, url: r.url, apply_url: r.apply_url, posted_at: r.posted_at, deadline: r.deadline, acted: jobHasActedWork(db, jobId), overridden: hasExclusionOverride(db, jobId), hard_stops: hard, repost_count: repostCountForJob(db, jobId), snapshot_chars: r.snapshot_chars };
  if (unreadable) f.hard_stops_unreadable = true;
  return f;
}
