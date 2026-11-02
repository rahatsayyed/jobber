// Owner CLI, one-time repair: Naukri "Apply on company site" rows that ended `manual_review` with NO note and no resolved company URL
// (the old resolver gave up silently) go back to pending so the fixed resolver runs again in the next wake's apply stage.
//   npm run apply:requeue-company-site [-- --dry]
// Idempotent: a second run finds nothing. Rows with a note (a real reason such as external:host_unknown) are left alone. Sends nothing.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { resolveApplyEscalationsForJobs } from '../src/outreach/applyEscalations.js';

export interface CliDeps { db?: BetterSqlite3.Database }

const WHERE = `apply_platform = 'naukri' AND apply_status = 'manual_review' AND COALESCE(TRIM(apply_note), '') = ''
  AND job_id IN (SELECT id FROM jobs WHERE COALESCE(TRIM(external_apply_url), '') = '')`;

export function run(argv: string[], deps: CliDeps = {}): { code: number; lines: string[] } {
  const dry = argv.includes('--dry');
  if (argv.some((a) => a !== '--dry')) return { code: 2, lines: ['usage: npm run apply:requeue-company-site [-- --dry]'] };
  const db = deps.db ?? openDb(dbPath());
  try {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM outreach_queue WHERE ${WHERE}`).get() as { n: number }).n;
    if (dry) return { code: 0, lines: [`dry: ${n} Naukri manual_review row(s) without a note would go back to pending`] };
    const jobIds = (db.prepare(`SELECT job_id FROM outreach_queue WHERE ${WHERE}`).all() as { job_id: string }[]).map((r) => r.job_id);
    const c = db.prepare(`UPDATE outreach_queue SET apply_status = NULL, updated_at = datetime('now') WHERE ${WHERE}`).run().changes;
    resolveApplyEscalationsForJobs(db, jobIds);
    return { code: 0, lines: [`requeued ${c} row(s); the next wake's apply stage resolves them again`] };
  } finally {
    if (!deps.db) db.close();
  }
}

if (process.env.VITEST !== 'true' && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = run(process.argv.slice(2));
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}
