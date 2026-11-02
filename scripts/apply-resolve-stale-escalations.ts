// Owner CLI, one-time cleanup: open `apply:*` escalations whose job is no longer waiting (not in manual_review, needs_owner, needs_answer,
// needs_human or held) are marked handled with the note "job moved on". Host-level cards (needs your answer, needs a human) are closed when
// nothing of that host waits any more. Rows are never deleted. Idempotent: a second run finds nothing. Sends nothing.
//   npm run apply:resolve-stale-escalations [-- --dry]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { resolveStaleApplyEscalations } from '../src/outreach/applyEscalations.js';

export interface CliDeps { db?: BetterSqlite3.Database; now?: () => Date }

export function run(argv: string[], deps: CliDeps = {}): { code: number; lines: string[] } {
  const dry = argv.includes('--dry');
  if (argv.some((a) => a !== '--dry')) return { code: 2, lines: ['usage: npm run apply:resolve-stale-escalations [-- --dry]'] };
  const db = deps.db ?? openDb(dbPath());
  try {
    const r = resolveStaleApplyEscalations(db, { dry, now: deps.now?.() });
    const tail = r.unmatched > 0 ? ` (${r.unmatched} old row(s) have no job to check and were left open)` : '';
    if (dry) return { code: 0, lines: [`dry: ${r.stale} of ${r.scanned} open apply escalation(s) would be marked "job moved on"${tail}`] };
    return { code: 0, lines: [`resolved ${r.resolved} of ${r.scanned} open apply escalation(s) (job moved on)${tail}`] };
  } finally {
    if (!deps.db) db.close();
  }
}

if (process.env.VITEST !== 'true' && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = run(process.argv.slice(2));
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}
