// One-off, idempotent maintenance (owner runs it; never a wake): converts old `unconfirmed` LinkedIn connect touches
// that provably never reached Send into the terminal, retryable status `no_dialog`. A touch qualifies when no
// `connections` row exists for the person and no `linkedin_invite` ceiling usage was recorded in the window right after
// the touch was created (the ceiling is consumed right before the Send click, so no usage means no Send click).
// Prints counts only. Usage: npx tsx scripts/release-no-dialog-touches.ts [--dry]   (database: JOBAPPLIER_DB, default data.sqlite)
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';

/** A ceiling event this long after the reserve still belongs to that touch's attempt. */
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

export interface ReleaseResult { candidates: number; released: number; kept: number }

export function releaseNoDialogTouches(db: BetterSqlite3.Database, opts: { dry?: boolean; now?: Date } = {}): ReleaseResult {
  const now = opts.now ?? new Date();
  const rows = db
    .prepare(
      `SELECT t.id, t.created_at, p.profile_key
         FROM touches t JOIN people p ON p.id = t.person_id
        WHERE t.kind = 'connect' AND t.status = 'unconfirmed'`,
    )
    .all() as Array<{ id: number; created_at: string; profile_key: string }>;
  const hasConnection = db.prepare('SELECT 1 AS hit FROM connections WHERE profile_url LIKE ? LIMIT 1');
  const hasUsage = db.prepare('SELECT 1 AS hit FROM rate_events WHERE key = ? AND at >= ? AND at <= ? LIMIT 1');
  const upd = db.prepare(
    `UPDATE touches SET status = 'no_dialog', sent_at = NULL, no_dialog_count = 1, released_at = ?
      WHERE id = ? AND status = 'unconfirmed' AND kind = 'connect'`,
  );
  let released = 0;
  const todo = rows.filter((r) => {
    const t = Date.parse(r.created_at.includes('T') ? r.created_at : `${r.created_at.replace(' ', 'T')}Z`);
    if (Number.isNaN(t)) return false;
    if (hasConnection.get(`%${r.profile_key}%`)) return false;
    const from = new Date(t - 60_000).toISOString();
    const to = new Date(t + ATTEMPT_WINDOW_MS).toISOString();
    return hasUsage.get('linkedin_invite', from, to) === undefined;
  });
  if (!opts.dry) {
    db.transaction(() => {
      for (const r of todo) released += upd.run(now.toISOString(), r.id).changes;
    })();
  }
  return { candidates: todo.length, released, kept: rows.length - todo.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = openDb(dbPath());
  try {
    const dry = process.argv.includes('--dry');
    const r = releaseNoDialogTouches(db, { dry });
    console.log(`unconfirmed connect touches kept (Send possible): ${r.kept}; eligible for no_dialog: ${r.candidates}; released to no_dialog: ${r.released}${dry ? ' (dry run, nothing written)' : ''}`);
  } finally {
    db.close();
  }
}
