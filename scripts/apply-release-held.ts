// Owner CLI: after you set APPLY_SUBMIT_MODE=submit, put the applications that were prepared but HELD back in the apply queue.
//   npm run apply:release-held [-- --dry]
// Sets apply_status to NULL for held rows of the generic apply platforms (ATS ids and `browser`, never naukri, wellfound or linkedin_easy,
// which have their own native flow). Idempotent: a second run finds nothing. Nothing is submitted here; the next wake's apply stage does it,
// inside every cap, gate and the dry-run flag.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { APPLY_HOST_PLATFORM_IDS } from '../src/webcore/hostCaps.js';

export interface CliDeps { db?: BetterSqlite3.Database }

export function run(argv: string[], deps: CliDeps = {}): { code: number; lines: string[] } {
  const dry = argv.includes('--dry');
  if (argv.some((a) => a !== '--dry')) return { code: 2, lines: ['usage: npm run apply:release-held [-- --dry]'] };
  const db = deps.db ?? openDb(dbPath());
  try {
    const marks = APPLY_HOST_PLATFORM_IDS.map(() => '?').join(',');
    const where = `apply_status = 'held' AND status = 'queued' AND apply_platform IN (${marks})`;
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM outreach_queue WHERE ${where}`).get(...APPLY_HOST_PLATFORM_IDS) as { n: number }).n;
    const lines: string[] = [];
    if (process.env.APPLY_SUBMIT_MODE !== 'submit') lines.push('note: APPLY_SUBMIT_MODE is not "submit" in this shell, so a released row would be held again until it is set for the scheduler.');
    if (dry) return { code: 0, lines: [...lines, `dry: ${n} held row(s) would be released`] };
    const c = db.prepare(`UPDATE outreach_queue SET apply_status = NULL, updated_at = datetime('now') WHERE ${where}`).run(...APPLY_HOST_PLATFORM_IDS).changes;
    return { code: 0, lines: [...lines, `released ${c} held row(s); the next wake's apply stage picks them up`] };
  } finally {
    if (!deps.db) db.close();
  }
}

if (process.env.VITEST !== 'true' && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = run(process.argv.slice(2));
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}
