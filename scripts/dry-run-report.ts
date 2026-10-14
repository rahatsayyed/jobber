// scripts/dry-run-report.ts
// Thin CLI over src/scheduler/report.ts: `npm run dry-run:report [-- --limit N]`. Read-only.
import BetterSqlite3 from 'better-sqlite3';
import { dbPath } from '../src/dbPath.js';
import { buildReport, formatReport } from '../src/scheduler/report.js';

function parseLimit(argv: string[]): number {
  const i = argv.indexOf('--limit');
  if (i === -1) return 20;
  const n = Number(argv[i + 1]);
  return Number.isInteger(n) && n >= 1 && n <= 500 ? n : 20;
}

try {
  const db = new BetterSqlite3(dbPath(), { readonly: true, fileMustExist: true });
  try {
    console.log(formatReport(buildReport(db, { limit: parseLimit(process.argv.slice(2)) })));
  } finally {
    db.close();
  }
} catch (e) {
  console.error(`dry-run report failed: ${e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : 'unknown'}`);
  process.exitCode = 1;
}
