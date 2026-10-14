// Owner-only: clears the LinkedIn halt flag. No tool clears it. Requires --yes.
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { clearHalt, haltReason } from '../src/outreach/limits.js';

export function run(db: BetterSqlite3.Database, argv: string[], now: Date = new Date()): { code: number; lines: string[] } {
  const reason = haltReason(db, 'linkedin');
  const lines = [`Current LinkedIn halt: ${reason ?? 'none'}`];
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
