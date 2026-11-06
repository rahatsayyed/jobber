// One-off, idempotent release of jobs the applier parked because the form moved to another host (`host_changed`, `unknown_apply_host`,
// or an old `host_unknown` escalation), now that the host-hop policy trusts the company's own site (hostHop.ts). No browser, no network:
// it re-runs the classification in code against the stored apply URL and company. It only turns the park status back into the queued apply
// state (apply_status NULL, apply_note cleared); it never marks anything applied, and every other gate (vetoes, hard stops, caps, dedupe,
// repeat-contact, already applied or attempted) runs again in `apply_open` when the apply stage picks the row up. If the page ends up on
// an untrusted host again, the applier parks the job again.
import type BetterSqlite3 from 'better-sqlite3';
import { classifyApplyUrl } from '../apply/registry.js';
import { APPLY_HOST_PLATFORM_IDS } from '../webcore/hostCaps.js';
import { jobIdOfEscalation, resolveApplyEscalationsForJobs } from '../outreach/applyEscalations.js';
import { evaluateHost } from './hostHop.js';
import { buildHostCtx } from './companyHosts.js';

type Db = BetterSqlite3.Database;

export interface ReleaseReport { candidates: number; released: number; releasedBy: Record<string, number>; stillParked: Array<{ job_id: string; host: string; why: string }>; hosts: string[] }

interface Row {
  queue_id: number; job_id: string; apply_platform: string | null; apply_note: string | null; source: string | null;
  apply_url: string | null; job_apply_url: string | null; external_apply_url: string | null; excluded_reason: string | null;
}

const hostOf = (u: string | null | undefined): string => { try { return new URL(String(u ?? '')).hostname.toLowerCase(); } catch { return ''; } };

export function releaseHostParked(db: Db, env: NodeJS.ProcessEnv, opts: { dry?: boolean } = {}): ReleaseReport {
  // Evidence of a host park: our own note, or an apply escalation of the old `host_unknown` reason or one that names host_changed.
  const evidence = new Map<string, string>(); // job -> where the host park shows: note, escalation or queue_note
  const escHosts = new Map<string, string>();
  try {
    // Open AND resolved escalations: older runs wrote no note on the queue row, the escalation text is the only trace.
    const esc = db.prepare("SELECT reason, detail, thread_ref FROM escalations WHERE platform = 'apply' AND reason LIKE 'apply:%'").all() as Array<{ reason: string; detail: string | null; thread_ref: string | null }>;
    for (const e of esc) {
      const d = String(e.detail ?? '');
      if (e.reason === 'apply:unknown_apply_host' || e.reason === 'apply:host_unknown' || /host_changed/.test(d)) {
        const job = jobIdOfEscalation(db, d, e.thread_ref);
        if (job) { if (!evidence.has(job)) evidence.set(job, 'escalation'); const h = /\bhost=([A-Za-z0-9.-]{1,253})/.exec(d)?.[1]; if (h && e.reason === 'apply:unknown_apply_host') escHosts.set(job, h.toLowerCase()); }
      }
    }
  } catch { /* no escalations table */ }
  const rows = db.prepare(`
    SELECT q.id AS queue_id, q.job_id AS job_id, q.apply_platform AS apply_platform, q.apply_note AS apply_note, j.source AS source,
           q.apply_url AS apply_url, j.apply_url AS job_apply_url, j.external_apply_url AS external_apply_url, j.excluded_reason AS excluded_reason
      FROM outreach_queue q JOIN jobs j ON j.id = q.job_id
     WHERE q.apply_status IN ('needs_owner', 'manual_review') AND COALESCE(q.status, '') = 'queued'
       AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = q.job_id AND a.status IN ('submitted', 'manual_review'))`).all() as Row[];

  const report: ReleaseReport = { candidates: 0, released: 0, releasedBy: {}, stillParked: [], hosts: [] };
  const toRelease: Row[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const note = String(r.apply_note ?? '');
    const noted = note.startsWith('unknown_apply_host:');
    const queueNoted = /host_changed/.test(note);
    if (!noted && !queueNoted && !evidence.has(r.job_id)) continue;
    if (seen.has(r.job_id)) continue;
    seen.add(r.job_id);
    report.candidates += 1;
    const parkedHost = (noted ? note.slice('unknown_apply_host:'.length) : escHosts.get(r.job_id) ?? '').toLowerCase();
    const url = (r.external_apply_url ?? '').trim() || r.job_apply_url || r.apply_url || '';
    const still = (why: string): void => { report.stillParked.push({ job_id: r.job_id, host: parkedHost || hostOf(url) || 'unknown', why }); };
    if (r.excluded_reason) { still('vetoed'); continue; }
    const cls = classifyApplyUrl(url, r.source, env);
    if (cls.platform === 'none' || cls.tier === 'never' || !(APPLY_HOST_PLATFORM_IDS as readonly string[]).includes(cls.platform)) { still(cls.reason ?? 'not_apply_capable'); continue; }
    if (parkedHost && parkedHost !== 'invalid') {
      // The host the page moved to is on record: it must pass the policy now (judged as a hop from the stored apply host).
      const v = evaluateHost({ host: hostOf(url), hops: 0 }, `https://${parkedHost}/`, buildHostCtx(db, r.job_id, env));
      if (v.kind === 'refused') { still('unknown_apply_host'); continue; }
    }
    toRelease.push(r);
    const src = noted ? 'note' : queueNoted ? 'queue_note' : evidence.get(r.job_id) ?? 'escalation';
    report.releasedBy[src] = (report.releasedBy[src] ?? 0) + 1;
  }
  report.hosts = [...new Set(report.stillParked.map((s) => s.host))].sort();
  if (opts.dry) { report.released = toRelease.length; return report; }
  const upd = db.prepare("UPDATE outreach_queue SET apply_status = NULL, apply_note = NULL, updated_at = datetime('now') WHERE id = ? AND apply_status IN ('needs_owner', 'manual_review')");
  db.transaction(() => { for (const r of toRelease) report.released += upd.run(r.queue_id).changes; })();
  resolveApplyEscalationsForJobs(db, toRelease.map((r) => r.job_id));
  return report;
}
