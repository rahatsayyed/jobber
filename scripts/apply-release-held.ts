// Owner CLI: after you set APPLY_SUBMIT_MODE=submit, put the applications that were prepared but HELD back in the apply queue.
//   npm run apply:release-held [-- --dry]
//   npm run apply:release-held -- --reason host_changed [--dry]   (jobs parked because the form moved to another host, see src/applier/releaseHostParked.ts)
// Sets apply_status to NULL for held rows of the generic apply platforms (ATS ids and `browser`, never naukri, wellfound or linkedin_easy,
// which have their own native flow). Idempotent: a second run finds nothing. Nothing is submitted here; the next wake's apply stage does it,
// inside every cap, gate and the dry-run flag.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { APPLY_HOST_PLATFORM_IDS } from '../src/webcore/hostCaps.js';
import { resolveApplyEscalationsForJobs } from '../src/outreach/applyEscalations.js';
import { releaseHostParked } from '../src/applier/releaseHostParked.js';
import { telegramNotifier } from '../src/platform/notify.js';

export interface CliDeps { db?: BetterSqlite3.Database }

export function run(argv: string[], deps: CliDeps = {}): { code: number; lines: string[]; releasedHostParked?: number } {
  const dry = argv.includes('--dry');
  const usage = { code: 2, lines: ['usage: npm run apply:release-held [-- --reason host_changed] [-- --dry]'] };
  const rest = argv.filter((a) => a !== '--dry');
  let reason: string | null = null;
  if (rest.length > 0) {
    if (rest.length === 2 && rest[0] === '--reason' && rest[1] === 'host_changed') reason = rest[1];
    else return usage;
  }
  const db = deps.db ?? openDb(dbPath());
  try {
    if (reason === 'host_changed') {
      const r = releaseHostParked(db, process.env, { dry });
      const lines = [
        `${dry ? 'dry: would release' : 'released'} ${r.released} of ${r.candidates} job(s) parked for a host change`,
        `still parked: ${r.stillParked.length}${r.hosts.length ? ` (hosts: ${r.hosts.join(', ')})` : ''}`,
      ];
      for (const [k, n] of Object.entries(r.releasedBy).sort()) lines.push(`  released via ${k}: ${n}`);
      const why = new Map<string, number>();
      for (const s of r.stillParked) why.set(s.why, (why.get(s.why) ?? 0) + 1);
      for (const [k, n] of [...why].sort()) lines.push(`  ${k}: ${n}`);
      if (!dry && r.released > 0) lines.push("the next wake's apply stage picks them up; a host the policy still does not trust is parked again");
      return { code: 0, lines, ...(dry ? {} : { releasedHostParked: r.released }) };
    }
    const marks = APPLY_HOST_PLATFORM_IDS.map(() => '?').join(',');
    const where = `apply_status = 'held' AND status = 'queued' AND apply_platform IN (${marks})`;
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM outreach_queue WHERE ${where}`).get(...APPLY_HOST_PLATFORM_IDS) as { n: number }).n;
    const lines: string[] = [];
    if (process.env.APPLY_SUBMIT_MODE !== 'submit') lines.push('note: APPLY_SUBMIT_MODE is not "submit" in this shell, so a released row would be held again until it is set for the scheduler.');
    if (dry) return { code: 0, lines: [...lines, `dry: ${n} held row(s) would be released`] };
    const jobIds = (db.prepare(`SELECT job_id FROM outreach_queue WHERE ${where}`).all(...APPLY_HOST_PLATFORM_IDS) as { job_id: string }[]).map((r) => r.job_id);
    const c = db.prepare(`UPDATE outreach_queue SET apply_status = NULL, updated_at = datetime('now') WHERE ${where}`).run(...APPLY_HOST_PLATFORM_IDS).changes;
    resolveApplyEscalationsForJobs(db, jobIds);
    return { code: 0, lines: [...lines, `released ${c} held row(s); the next wake's apply stage picks them up`] };
  } finally {
    if (!deps.db) db.close();
  }
}

if (process.env.VITEST !== 'true' && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = run(process.argv.slice(2));
  for (const l of r.lines) console.log(l);
  if (r.releasedHostParked && r.releasedHostParked > 0) {
    // One quiet line to the inbox topic (never alerts).
    try { await telegramNotifier(process.env).send(`released ${r.releasedHostParked} held jobs`, { topic: 'inbox', silent: true }); } catch { /* the console line is enough */ }
  }
  process.exit(r.code);
}
