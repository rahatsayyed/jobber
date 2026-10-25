// One-off, idempotent maintenance (owner runs it; never a wake): the first live Wellfound discover saved jobs with an
// EMPTY company (see src/wellfound/company.ts). This marks source `wellfound` rows with no company as status
// 'bad_extraction' with an excluded_reason and skips their queued outreach rows. Re-discovery with the fixed extractor
// repairs such a row in place (src/wellfound/discover.ts) once a company is read.
// Usage: npx tsx scripts/fix-wellfound-jobs.ts [--dry]   (database: JOBAPPLIER_DB, default data.sqlite)
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { WELLFOUND_SOURCE } from '../src/wellfound/company.js';

export const BAD_EXTRACTION_STATUS = 'bad_extraction';
export const BAD_EXTRACTION_REASON = 'bad extraction: wellfound job has no company';

export interface FixResult { matched: number; marked: number; queue_skipped: number; ids: string[] }

export function fixWellfoundJobs(db: BetterSqlite3.Database, opts: { dry?: boolean } = {}): FixResult {
  const rows = db
    .prepare("SELECT id, status, excluded_reason FROM jobs WHERE source = ? AND (company IS NULL OR trim(company) = '')")
    .all(WELLFOUND_SOURCE) as Array<{ id: string; status: string | null; excluded_reason: string | null }>;
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
    const r = fixWellfoundJobs(db, { dry: process.argv.includes('--dry') });
    console.log(`wellfound rows with no company: ${r.matched}; marked ${BAD_EXTRACTION_STATUS}: ${r.marked}; queued outreach rows skipped: ${r.queue_skipped}`);
  } finally {
    db.close();
  }
}
