// Owner CLI: human-in-the-loop help for a job parked as `needs_human` (a login wall, sign-up, CAPTCHA or MFA on a company or ATS site).
//   npm run apply:assist -- <job_id>
// Opens that job's apply page HEADED in the project's Chrome (the same persistent profile the headless tasks use), waits while YOU log in,
// solve the check or complete MFA by hand, then saves the session for that host (profile plus the per-host session file) and puts the
// job, and every other job parked on the same host, back in the apply queue. Nothing the agent does here solves anything. Nothing you type
// is read, logged or stored by this tool, and no password is stored (stored credentials live only in secrets/site-accounts.json).
// Accounts are still created only by site_signup under APPLY_ALLOW_ACCOUNT_CREATION / SITE_MAX_ACCOUNTS_PER_DAY: those are unchanged.
import { createInterface } from 'node:readline';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { runHeaded, hostOf, type HeadedDeps, type HeadedIo } from '../src/webcore/headed.js';
import { threadRefFor } from '../src/applier/escalate.js';
import { setState } from '../src/scheduler/runLog.js';
import { resolveApplyEscalationsForJobs } from '../src/outreach/applyEscalations.js';

export interface CliDeps {
  db?: BetterSqlite3.Database;
  io?: HeadedIo;
  launcher?: HeadedDeps['launcher'];
  lockPath?: string;
  sessionDir?: string;
  profileDir?: string | null;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  stopFile?: string;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWN_SESSION_HOSTS = /(^|\.)(linkedin\.com|naukri\.com|wellfound\.com|angel\.co)$/i;
/** Block kinds an owner pass clears for the host. A bot_wall streak halt is NOT touched: only `jobber:control clear-halt apply` clears that. */
const CLEARED_BLOCKS = ['captcha', 'mfa', 'phone_verification', 'login_required', 'consent_required', 'blocked'];

function killed(env: NodeJS.ProcessEnv, stopFile: string): boolean {
  if (env.JOBBER_KILL === '1') return true;
  try { lstatSync(stopFile); return true; } catch (e) { return (e as NodeJS.ErrnoException)?.code !== 'ENOENT'; }
}

function stdinIo(): HeadedIo {
  return {
    log: (l) => console.log(l),
    ask: (q) => new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(q, () => { rl.close(); resolve(''); }); // the line is discarded: it is never read
    }),
  };
}

export async function run(argv: string[], deps: CliDeps = {}): Promise<{ code: number; lines: string[] }> {
  const env = deps.env ?? process.env;
  const jobId = argv.find((a) => !a.startsWith('--'));
  if (!jobId || argv.length !== 1) return { code: 2, lines: ['usage: npm run apply:assist -- <job_id>'] };
  if (killed(env, deps.stopFile ?? path.join(ROOT, '.jobber', 'STOP'))) return { code: 1, lines: ['the kill switch is on; clear it first (jobber:control resume)'] };
  const db = deps.db ?? openDb(dbPath());
  const out: string[] = [];
  const io = deps.io ?? stdinIo();
  const lines = (l: string) => { out.push(l); if (!deps.io) console.log(l); };
  try {
    const job = db.prepare("SELECT id, title, company, COALESCE(NULLIF(external_apply_url, ''), apply_url) AS url FROM jobs WHERE id = ?").get(jobId) as
      { id: string; title: string | null; company: string | null; url: string | null } | undefined;
    if (!job) return { code: 1, lines: [`no job ${jobId}`] };
    const q = db.prepare('SELECT apply_status FROM outreach_queue WHERE job_id = ? ORDER BY id DESC LIMIT 1').get(jobId) as { apply_status: string | null } | undefined;
    if (!q) return { code: 1, lines: [`job ${jobId} has no queue row`] };
    if (['submitted', 'unconfirmed'].includes(q.apply_status ?? '')) return { code: 1, lines: [`job ${jobId} is already ${q.apply_status}; nothing to assist`] };
    let url: URL;
    try { url = new URL(job.url ?? ''); } catch { return { code: 1, lines: ['the job has no usable apply address'] }; }
    if (url.protocol !== 'https:' || url.username || url.password) return { code: 1, lines: ['only an https address without credentials is opened'] };
    const host = hostOf(url.href);
    if (OWN_SESSION_HOSTS.test(host)) return { code: 1, lines: [`${host} has its own login command (npm run linkedin:login, naukri:login, wellfound:login); this command is for company and ATS sites`] };

    const r = await runHeaded(url.href, {
      io: { ask: io.ask, log: lines }, launcher: deps.launcher, lockPath: deps.lockPath, sessionDir: deps.sessionDir, profileDir: deps.profileDir,
    });
    if (!r.ok) return { code: 1, lines: [...out, `not saved: ${r.reason}`] };

    const now = (deps.now ?? (() => new Date()))();
    const requeued = new Set<string>([jobId]);
    db.transaction(() => {
      // Every job parked on this host can use the session now; the apply stage retries them within the usual caps and gates.
      const parked = db.prepare("SELECT q.id AS qid, q.job_id AS jid, COALESCE(NULLIF(j.external_apply_url, ''), j.apply_url) AS url FROM outreach_queue q JOIN jobs j ON j.id = q.job_id WHERE q.apply_status = 'needs_human'").all() as { qid: number; jid: string; url: string | null }[];
      for (const p of parked) {
        if (hostOf(p.url ?? '') === host) requeued.add(p.jid);
        if (hostOf(p.url ?? '') === host) db.prepare("UPDATE outreach_queue SET apply_status = NULL, apply_note = NULL, updated_at = datetime('now') WHERE id = ?").run(p.qid);
      }
      db.prepare("UPDATE outreach_queue SET apply_status = NULL, apply_note = NULL, updated_at = datetime('now') WHERE job_id = ? AND apply_status IN ('needs_human', 'needs_owner')").run(jobId);
      db.prepare(`DELETE FROM apply_host_blocks WHERE host = ? AND kind IN (${CLEARED_BLOCKS.map(() => '?').join(',')})`).run(host, ...CLEARED_BLOCKS);
      db.prepare("UPDATE escalations SET resolved_at = ? WHERE platform = 'apply' AND thread_ref = ? AND resolved_at IS NULL").run(now.toISOString(), threadRefFor('assist', host));
      setState(db, `assist_ping:${host}`, '1970-01-01T00:00:00.000Z', now); // a later wall on this host may ping again
    })();
    // The requeued jobs are no longer failing: close their open apply escalations (note "job moved on").
    resolveApplyEscalationsForJobs(db, requeued, now);
    return { code: 0, lines: [...out, `saved the session for ${host} (${r.cookies} cookies${r.profile ? ', in the browser profile' : ', in the per-host session file'}); job ${jobId} and any other job waiting on ${host} will be retried by the next apply stage`] };
  } finally {
    if (!deps.db) db.close();
  }
}

if (process.env.VITEST !== 'true' && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run(process.argv.slice(2)).then((r) => { if (r.code !== 0) for (const l of r.lines.slice(-1)) console.error(l); else console.log(r.lines[r.lines.length - 1]); process.exit(r.code); }, () => { console.error('apply:assist failed'); process.exit(1); });
}
