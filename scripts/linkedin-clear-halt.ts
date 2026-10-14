// Owner-only: clears the LinkedIn halt flag. No tool clears it. Requires --yes.
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { clearHalt, haltReason } from '../src/outreach/limits.js';

export function run(db: BetterSqlite3.Database, argv: string[], now: Date = new Date()): { code: number; lines: string[] } {
  const own = db
    .prepare('SELECT reason FROM halt_flags WHERE platform = ? AND cleared_at IS NULL')
    .get('linkedin') as { reason: string } | undefined;
  const lines = [`Current LinkedIn halt: ${own?.reason ?? 'none'}`];
  const all = haltReason(db, 'all');
  if (all !== null) lines.push(`Global halt (all) is also active and is not cleared here: ${all}`);
  if (!argv.includes('--yes')) {
    lines.push('Re-run with --yes to clear it.');
    return { code: 1, lines };
  }
  clearHalt(db, 'linkedin', now);
  lines.push('Cleared LinkedIn halt.');
  return { code: 0, lines };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = openDb(dbPath());
  const r = run(db, process.argv.slice(2));
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}
