// One-off, idempotent maintenance (owner runs it; never a wake): marks `linkedin-posts` rows that the old extractor
// stored with the AUTHOR PROFILE as url (/in/) and no company as status 'bad_extraction' with an excluded_reason, so no
// stage outreaches them. Re-discovery with the fixed extractor stores the same posts properly under permalink ids.
// Usage: npx tsx scripts/fix-linkedin-posts.ts [--dry]   (database: JOBAPPLIER_DB, default data.sqlite)
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { POST_SOURCE } from '../src/lib/postSignals.js';

export const BAD_EXTRACTION_STATUS = 'bad_extraction';
export const BAD_EXTRACTION_REASON = 'bad extraction: post url is the author profile and company is empty';

export interface FixResult { matched: number; marked: number; queue_skipped: number; ids: string[] }

export function fixLinkedinPosts(db: BetterSqlite3.Database, opts: { dry?: boolean } = {}): FixResult {
  const rows = db
    .prepare(
      `SELECT id, status, excluded_reason FROM jobs
       WHERE source = ? AND url LIKE '%/in/%' AND (company IS NULL OR trim(company) = '')`,
    )
    .all(POST_SOURCE) as Array<{ id: string; status: string | null; excluded_reason: string | null }>;
  const todo = rows.filter((r) => r.status !== BAD_EXTRACTION_STATUS || r.excluded_reason == null);
  if (opts.dry) return { matched: rows.length, marked: 0, queue_skipped: 0, ids: todo.map((r) => r.id) };
  const upd = db.prepare('UPDATE jobs SET status = ?, excluded_reason = COALESCE(excluded_reason, ?) WHERE id = ?');
  const queueCols = new Set((db.prepare('PRAGMA table_info(outreach_queue)').all() as Array<{ name: string }>).map((c) => c.name));
  const skipQ = queueCols.has('status') ? db.prepare("UPDATE outreach_queue SET status = 'skipped' WHERE job_id = ? AND status = 'queued'") : null;
  let marked = 0;
  let queueSkipped = 0;
  db.transaction(() => {
    for (const r of todo) {
      marked += upd.run(BAD_EXTRACTION_STATUS, BAD_EXTRACTION_REASON, r.id).changes;
      if (skipQ) queueSkipped += skipQ.run(r.id).changes;
    }
  })();
  return { matched: rows.length, marked, queue_skipped: queueSkipped, ids: todo.map((r) => r.id) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = openDb(dbPath());
  try {
    const r = fixLinkedinPosts(db, { dry: process.argv.includes('--dry') });
    console.log(`linkedin-posts rows with a profile url and no company: ${r.matched}; marked ${BAD_EXTRACTION_STATUS}: ${r.marked}; queued outreach rows skipped: ${r.queue_skipped}`);
  } finally {
    db.close();
  }
}
