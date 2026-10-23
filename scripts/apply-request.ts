// Owner CLI: hand Jobber one job URL or one company careers page to run through the full pipeline at priority.
//   npm run apply:request -- <url> [--force]
// Validates the URL in code (src/manual/url.ts), writes one pending manual_requests row and prints its id. The scheduler daemon notices the
// row within about a minute and runs a wake; the owner gets a Telegram report per request when its jobs are processed. --force prepares a
// job whose score is below MATCH_THRESHOLD anyway (vetoes and hard stops still apply). Nothing is fetched here.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { createManualRequest } from '../src/manual/requests.js';

export interface CliDeps { db?: BetterSqlite3.Database; now?: () => Date }

export function run(argv: string[], deps: CliDeps = {}): { code: number; lines: string[] } {
  const force = argv.includes('--force');
  const rest = argv.filter((a) => a !== '--force');
  const unknown = rest.filter((a) => a.startsWith('--'));
  if (unknown.length > 0 || rest.length !== 1) return { code: 2, lines: ['usage: npm run apply:request -- <https url of a job or a careers page> [--force]'] };
  const db = deps.db ?? openDb(dbPath());
  try {
    const r = createManualRequest(db, rest[0], { force, now: deps.now?.() });
    if (!r.ok) return { code: 1, lines: [`rejected: ${r.reason}`] };
    return {
      code: 0,
      lines: [
        `${r.duplicate ? 'already queued' : 'queued'}: request #${r.id} (${r.kind === 'url' ? 'single job' : 'careers page'}${force ? ', force' : ''})`,
        'The scheduler picks it up within about a minute and sends a Telegram report when its jobs are processed.',
      ],
    };
  } finally {
    if (!deps.db) db.close();
  }
}

if (process.env.VITEST !== 'true' && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = run(process.argv.slice(2));
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}
