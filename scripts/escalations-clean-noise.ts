// Owner CLI, one-time and idempotent: resolves open escalations that are noise (layout telemetry, ceilings, dead jobs, apply tool drift on
// listing pages) and duplicate captcha/consent/blocked cards per host. Rows are never deleted; each gets a resolved_note. Dead jobs are marked expired.
//   npm run escalations:clean-noise [-- --dry]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { noiseKind, NOISE_NOTES, dedupeHost, closeGoneJob } from '../src/outreach/escalationPolicy.js';

export interface CliDeps { db?: BetterSqlite3.Database; now?: () => Date }
interface Row { id: number; platform: string; reason: string; detail: string | null; thread_ref: string | null }

export function run(argv: string[], deps: CliDeps = {}): { code: number; lines: string[] } {
  const dry = argv.includes('--dry');
  if (argv.some((a) => a !== '--dry')) return { code: 2, lines: ['usage: npm run escalations:clean-noise [-- --dry]'] };
  const db = deps.db ?? openDb(dbPath());
  try {
    const now = (deps.now?.() ?? new Date()).toISOString();
    const rows = db.prepare('SELECT id, platform, reason, detail, thread_ref FROM escalations WHERE resolved_at IS NULL ORDER BY id DESC').all() as Row[];
    const counts: Record<string, number> = {};
    const seenHost = new Set<string>();
    const todo: { id: number; note: string }[] = [];
    let jobsClosed = 0;
    for (const r of rows) {
      const k = noiseKind(r.platform, r.reason, r.detail);
      if (k) {
        counts[k] = (counts[k] ?? 0) + 1;
        todo.push({ id: r.id, note: NOISE_NOTES[k] });
        if (k === 'job_gone' && !dry && closeGoneJob(db, r.detail, r.thread_ref)) jobsClosed += 1;
        continue;
      }
      const h = dedupeHost(r.reason, r.detail);
      if (h) {
        const key = `${r.reason}|${h}`;
        if (seenHost.has(key)) {
          counts.duplicate_per_host = (counts.duplicate_per_host ?? 0) + 1;
          todo.push({ id: r.id, note: 'duplicate of a newer open card for the same host' });
        } else seenHost.add(key);
      }
    }
    if (!dry) {
      const st = db.prepare('UPDATE escalations SET resolved_at = ?, resolved_note = ? WHERE id = ? AND resolved_at IS NULL');
      db.transaction(() => { for (const t of todo) st.run(now, t.note, t.id); })();
    }
    const parts = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'nothing';
    return { code: 0, lines: [`${dry ? 'dry: would resolve' : 'resolved'} ${todo.length} of ${rows.length} open escalation(s): ${parts}${dry ? '' : `; jobs marked expired: ${jobsClosed}`}`] };
  } finally {
    if (!deps.db) db.close();
  }
}

if (process.env.VITEST !== 'true' && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = run(process.argv.slice(2));
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}
