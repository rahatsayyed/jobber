// One-off, idempotent maintenance (owner runs it; never a wake): the Wellfound card's logo alt text leaked into
// jobs.company ("Distill company logo"). This rewrites source `wellfound` rows whose company changes under
// cleanCompanyName (src/wellfound/company.ts) and recomputes company_key; people/contacts/outreach_queue rows that
// carry the same polluted name are repaired too. Re-running changes nothing.
// Usage: npx tsx scripts/fix-wellfound-companies.ts [--dry]   (database: JOBAPPLIER_DB, default data.sqlite)
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { companyKey } from '../src/reposts.js';
import { WELLFOUND_SOURCE, cleanCompanyName } from '../src/wellfound/company.js';

export interface FixCompaniesResult { matched: number; fixed: number; related: number; ids: string[] }

function hasCol(db: BetterSqlite3.Database, table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === col);
}

export function fixWellfoundCompanies(db: BetterSqlite3.Database, opts: { dry?: boolean } = {}): FixCompaniesResult {
  const rows = db
    .prepare("SELECT id, company, company_key FROM jobs WHERE source = ? AND company IS NOT NULL AND trim(company) <> ''")
    .all(WELLFOUND_SOURCE) as Array<{ id: string; company: string; company_key: string | null }>;
  const todo = rows
    .map((r) => ({ ...r, clean: cleanCompanyName(r.company) }))
    .filter((r) => r.clean && r.clean !== r.company);
  const ids = todo.map((r) => r.id);
  if (opts.dry) return { matched: rows.length, fixed: 0, related: 0, ids };
  const upd = db.prepare('UPDATE jobs SET company = ?, company_key = ? WHERE id = ?');
  const names = new Map<string, string>();
  let related = 0;
  db.transaction(() => {
    for (const r of todo) {
      upd.run(r.clean, companyKey(r.clean), r.id);
      names.set(r.company, r.clean);
    }
    for (const [dirty, clean] of names) {
      if (hasCol(db, 'people', 'company') && hasCol(db, 'people', 'company_key')) {
        related += db.prepare('UPDATE people SET company = ?, company_key = ? WHERE company = ?').run(clean, companyKey(clean), dirty).changes;
      }
      if (hasCol(db, 'contacts', 'company')) related += db.prepare('UPDATE contacts SET company = ? WHERE company = ?').run(clean, dirty).changes;
      if (hasCol(db, 'outreach_queue', 'connect_company')) related += db.prepare('UPDATE outreach_queue SET connect_company = ? WHERE connect_company = ?').run(clean, dirty).changes;
    }
  })();
  return { matched: rows.length, fixed: todo.length, related, ids };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = openDb(dbPath());
  try {
    const dry = process.argv.includes('--dry');
    const r = fixWellfoundCompanies(db, { dry });
    console.log(`wellfound rows with a company: ${r.matched}; ${dry ? 'would fix' : 'fixed'}: ${dry ? r.ids.length : r.fixed}; related rows repaired: ${r.related}`);
  } finally {
    db.close();
  }
}
