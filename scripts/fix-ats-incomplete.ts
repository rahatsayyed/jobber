// One-off, idempotent maintenance: queue rows whose job description is a snippet or cut off get ats_coverage NULL and ats_note
// 'jd_incomplete' (the old number measured the snippet, not the job). Rows with a full description are not touched.
//   npx tsx scripts/fix-ats-incomplete.ts [--dry]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { ATS_NOTE_JD_INCOMPLETE, isJdIncomplete } from '../src/atsJd.js';

export function run(argv: string[], db?: BetterSqlite3.Database): { code: number; lines: string[] } {
  const dry = argv.includes('--dry');
  if (argv.some((a) => a !== '--dry')) return { code: 2, lines: ['usage: npx tsx scripts/fix-ats-incomplete.ts [--dry]'] };
  const h = db ?? openDb(dbPath());
  try {
    const rows = h.prepare('SELECT q.id, j.description FROM outreach_queue q LEFT JOIN jobs j ON j.id = q.job_id WHERE q.ats_coverage IS NOT NULL AND q.ats_note IS NULL').all() as { id: number; description: string | null }[];
    const ids = rows.filter((r) => isJdIncomplete(r.description)).map((r) => r.id);
    if (!dry) {
      const up = h.prepare('UPDATE outreach_queue SET ats_coverage = NULL, ats_note = ? WHERE id = ?');
      h.transaction(() => { for (const id of ids) up.run(ATS_NOTE_JD_INCOMPLETE, id); })();
    }
    return { code: 0, lines: [`${dry ? 'would mark' : 'marked'} ${ids.length} of ${rows.length} scored row(s) as ${ATS_NOTE_JD_INCOMPLETE}`] };
  } finally {
    if (!db) h.close();
  }
}

if (process.env.VITEST !== 'true' && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = run(process.argv.slice(2));
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}
