// One-off, idempotent maintenance: jobs from Naukri or LinkedIn jobs that were matched, tailored, emailed or applied to on a snippet
// (no job description) wait for their description (jd_pending); their unsent queue rows become needs_reprep and their match score is cleared,
// so they are scored and prepared again once the description was fetched. Already emailed, applied or messaged jobs are only flagged
// (jd_note = prepared_without_jd). Rows are never deleted.
//   npm run jd:backfill [-- --dry]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { formatJdBackfill, runJdBackfill } from '../src/jdBackfill.js';

export function run(argv: string[], db?: BetterSqlite3.Database): { code: number; lines: string[] } {
  const dry = argv.includes('--dry');
  if (argv.some((a) => a !== '--dry')) return { code: 2, lines: ['usage: npm run jd:backfill [-- --dry]'] };
  const h = db ?? openDb(dbPath());
  try {
    const r = runJdBackfill(h, { dry });
    return { code: 0, lines: [dry ? 'dry run: nothing was written' : 'backfill done', ...formatJdBackfill(r, dry)] };
  } finally {
    if (!db) h.close();
  }
}

if (process.env.VITEST !== 'true' && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = run(process.argv.slice(2));
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}
