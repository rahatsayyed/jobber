// Owner CLI: after the policy changed (APPLY_SUBMIT_MODE=submit, APPLY_ALLOW_UNKNOWN_HOSTS=true), put apply rows that were parked under the OLD
// policy with NO note (unknown company host -> manual_review / needs_owner) back in the apply queue, gradually.
//   npm run apply:requeue-parked                              (dry: prints counts per platform and host, writes nothing)
//   npm run apply:requeue-parked -- --yes [--limit N] [--platform browser,greenhouse,...]
// Eligible: queue row status 'queued', apply_status manual_review or needs_owner, EMPTY apply_note, platform in the list below, job not excluded,
// no outcome, no applications row submitted or manual_review (a submit click may have happened), and the stored apply URL passes the CURRENT
// classification (classifyApplyUrl with this env, same code as the apply stage). A row the code would park again right away is reported as
// "would be parked again" and left alone. Rows with a note (captcha, login, needs_answer, no_relevant_role, unsafe_apply_page, unknown_apply_host...)
// are never touched. The write sets apply_status NULL, apply_note NULL and updated_at, and closes the open apply escalations of those jobs.
// Nothing is submitted here: the next wake's apply stage does it inside every cap, gate, quiet hour and the dry-run flag. Idempotent.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { classifyApplyUrl } from '../src/apply/registry.js';
import { APPLY_HOST_PLATFORM_IDS } from '../src/webcore/hostCaps.js';
import { resolveApplyEscalationsForJobs } from '../src/outreach/applyEscalations.js';

export interface CliDeps { db?: BetterSqlite3.Database; env?: NodeJS.ProcessEnv }

export const DEFAULT_PLATFORMS = ['browser', 'greenhouse', 'lever', 'smartrecruiters', 'workday', 'wellfound'] as const;
export const DEFAULT_LIMIT = 25;
const USAGE = 'usage: npm run apply:requeue-parked [-- --yes] [-- --dry] [-- --platform browser,greenhouse,...] [-- --limit N]';

interface Row {
  queue_id: number; job_id: string; apply_platform: string; source: string | null;
  apply_url: string | null; job_apply_url: string | null; external_apply_url: string | null;
}

const hostOf = (u: string | null | undefined): string => { try { return new URL(String(u ?? '')).hostname.toLowerCase(); } catch { return 'unknown'; } };

export interface RequeueReport {
  candidates: number; eligible: number; released: number;
  byPlatform: Record<string, number>; hosts: Record<string, number>;
  parkedAgain: Array<{ job_id: string; platform: string; host: string; why: string }>;
}

export function requeueParked(db: BetterSqlite3.Database, env: NodeJS.ProcessEnv, opts: { write: boolean; platforms: readonly string[]; limit: number }): RequeueReport {
  const marks = opts.platforms.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT q.id AS queue_id, q.job_id AS job_id, q.apply_platform AS apply_platform, j.source AS source,
           q.apply_url AS apply_url, j.apply_url AS job_apply_url, j.external_apply_url AS external_apply_url
      FROM outreach_queue q JOIN jobs j ON j.id = q.job_id
     WHERE COALESCE(q.status, '') = 'queued' AND q.apply_status IN ('manual_review', 'needs_owner')
       AND COALESCE(TRIM(q.apply_note), '') = '' AND q.apply_platform IN (${marks})
       AND COALESCE(TRIM(j.excluded_reason), '') = ''
       AND NOT EXISTS (SELECT 1 FROM job_outcomes o WHERE o.job_id = q.job_id)
       AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = q.job_id AND a.status IN ('submitted', 'manual_review'))
     ORDER BY q.id ASC`).all(...opts.platforms) as Row[];
  const rep: RequeueReport = { candidates: rows.length, eligible: 0, released: 0, byPlatform: {}, hosts: {}, parkedAgain: [] };
  const picked: Row[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.job_id)) continue;
    seen.add(r.job_id);
    const url = (r.external_apply_url ?? '').trim() || r.job_apply_url || r.apply_url || '';
    const host = hostOf(url);
    const cls = classifyApplyUrl(url, r.source, env);
    const generic = (APPLY_HOST_PLATFORM_IDS as readonly string[]).includes(cls.platform);
    if (cls.platform === 'none' || cls.tier === 'never' || !(generic || cls.platform === 'wellfound')) {
      rep.parkedAgain.push({ job_id: r.job_id, platform: r.apply_platform, host, why: cls.reason ?? 'not_apply_capable' });
      continue;
    }
    rep.eligible += 1;
    if (picked.length >= opts.limit) continue;
    picked.push(r);
    rep.byPlatform[r.apply_platform] = (rep.byPlatform[r.apply_platform] ?? 0) + 1;
    rep.hosts[host] = (rep.hosts[host] ?? 0) + 1;
  }
  if (!opts.write) { rep.released = picked.length; return rep; }
  // The WHERE repeats the guards so a row that changed since the read is skipped.
  const upd = db.prepare(`UPDATE outreach_queue SET apply_status = NULL, apply_note = NULL, updated_at = datetime('now')
    WHERE id = ? AND COALESCE(status, '') = 'queued' AND apply_status IN ('manual_review', 'needs_owner') AND COALESCE(TRIM(apply_note), '') = ''`);
  const done: string[] = [];
  db.transaction(() => { for (const r of picked) if (upd.run(r.queue_id).changes > 0) { rep.released += 1; done.push(r.job_id); } })();
  resolveApplyEscalationsForJobs(db, done);
  return rep;
}

export function run(argv: string[], deps: CliDeps = {}): { code: number; lines: string[] } {
  const env = deps.env ?? process.env;
  let write = false; let dry = false; let limit = DEFAULT_LIMIT; let platforms: string[] = [...DEFAULT_PLATFORMS];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') write = true;
    else if (a === '--dry') dry = true;
    else if (a === '--limit') {
      const v = argv[++i];
      if (!v || !/^\d{1,5}$/.test(v) || Number(v) < 1) return { code: 2, lines: [USAGE] };
      limit = Number(v);
    } else if (a === '--platform') {
      const v = argv[++i];
      const list = (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (list.length === 0 || list.some((p) => !(DEFAULT_PLATFORMS as readonly string[]).includes(p))) return { code: 2, lines: [USAGE, `platforms: ${DEFAULT_PLATFORMS.join(', ')}`] };
      platforms = list;
    } else return { code: 2, lines: [USAGE] };
  }
  if (write && dry) return { code: 2, lines: [USAGE] };
  const db = deps.db ?? openDb(dbPath());
  try {
    const r = requeueParked(db, env, { write, platforms, limit });
    const lines: string[] = [];
    if (env.APPLY_SUBMIT_MODE !== 'submit') lines.push('note: APPLY_SUBMIT_MODE is not "submit" in this shell, so a released row would be held again until it is set for the scheduler.');
    if (env.APPLY_ALLOW_UNKNOWN_HOSTS !== 'true') lines.push('note: APPLY_ALLOW_UNKNOWN_HOSTS is not "true" in this shell, so company-site (browser) rows are judged as parked again.');
    lines.push(`${r.candidates} parked row(s) without a note; ${r.eligible} eligible now, ${r.parkedAgain.length} would be parked again`);
    lines.push(`${write ? 'released' : 'dry: would release'} ${r.released} (limit ${limit})`);
    for (const [k, n] of Object.entries(r.byPlatform).sort()) lines.push(`  platform ${k}: ${n}`);
    for (const [k, n] of Object.entries(r.hosts).sort((a, b) => b[1] - a[1]).slice(0, 30)) lines.push(`  host ${k}: ${n}`);
    const why = new Map<string, number>();
    for (const p of r.parkedAgain) { const k = `${p.platform} ${p.host} (${p.why})`; why.set(k, (why.get(k) ?? 0) + 1); }
    for (const [k, n] of [...why].sort().slice(0, 30)) lines.push(`  would be parked again: ${k}: ${n}`);
    if (!write) lines.push('dry run: nothing written. Add --yes to release.');
    else if (r.released > 0) lines.push("the next wake's apply stage picks them up inside every cap and gate; a page it cannot finish is parked again");
    return { code: 0, lines };
  } finally {
    if (!deps.db) db.close();
  }
}

if (process.env.VITEST !== 'true' && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = run(process.argv.slice(2));
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}
