// The session side of a host hop (owner decision 2026-11-06, see hostHop.ts for the rules). One synchronous call per tool, before the tool
// touches the page: `settleHost(deps, job, page.url())` returns null when the work may go on (same host, or an allowed hop that was applied
// to the open job) and a result when it may not.
//
//  - allowed hop: the open job moves to the new host (host, allowedHosts, the registry platform when the new host is a registry vendor so the
//    shipped recipe and the APPLY_MAX_PER_HOST(_<ID>) cap of that platform apply, hop counter), the per-host gap is stamped for the new host, one
//    `host_hop` line goes to the log (host names only, never a URL, never a notice or an alert). Nothing is typed by this step.
//  - any other host: the job is parked `needs_owner` with the note `unknown_apply_host:<host>`, one quiet info notice and one inbox escalation
//    are raised, the job is closed for this run and the result is the old refusal `host_changed` (reason `unknown_apply_host: <host>`).
//    A host that is cooling down after blocks closes the job for this run without a park.
// It never closes the browser itself (it can run inside the runtime queue): it sets `state.pendingClose`, which `inPage` and `apply_open` honour.
import { addEscalation } from '../outreach/service.js';
import { hostCoolingDown } from '../webcore/login.js';
import { resolveHostCap } from '../webcore/hostCaps.js';
import { hostCooledDown } from './cooldown.js';
import { evaluateHost, safeHostName, unsafeApplyPage, type HostVerdict } from './hostHop.js';
import { loadWebConfig } from '../webcore/config.js';
import type { LiPage } from '../webcore/launch.js';
import { buildHostCtx } from './companyHosts.js';
import type { ApplierDeps, ApplyResult, OpenJob } from './tools/common.js';

const hostDayCountOf = (deps: ApplierDeps, host: string): number => {
  const row = deps.db.prepare("SELECT count FROM apply_host_day WHERE host = ? AND day = date('now')").get(host) as { count: number } | undefined;
  return row?.count ?? 0;
};

/** Park a job whose form moved to a host the code does not trust. Host name only in every text. */
export function parkUnknownHost(deps: ApplierDeps, job: Pick<OpenJob, 'jobId'>, hostRaw: string, why: string, code: 'unknown_apply_host' | 'unsafe_apply_page' = 'unknown_apply_host'): ApplyResult {
  const host = safeHostName(hostRaw);
  const now = (deps.now ?? (() => new Date()))();
  try {
    deps.db.prepare("UPDATE outreach_queue SET apply_status = 'needs_owner', apply_note = ?, updated_at = datetime('now') WHERE job_id = ?")
      .run(`${code}:${host}`, job.jobId);
    addEscalation(deps.db, {
      runId: null, platform: 'apply', reason: `apply:${code}`,
      detail: `${code === 'unsafe_apply_page' ? 'apply page asks for something unsafe' : 'apply form moved to an unknown host'} host=${host} job=${job.jobId} (${why}); apply by hand: npm run apply:manual -- list`,
    }, now);
  } catch { console.error('[applier] park failed'); }
  try { deps.escalate?.(code, host); } catch { console.error('[applier] notice failed'); }
  (deps.state.escalated ??= new Set<string>()).add(job.jobId);
  deps.state.cur = null;
  deps.state.pendingClose = true;
  if (code === 'unsafe_apply_page') return { status: 'refused', code: 'unsafe_apply_page', reason: `unsafe_apply_page: ${host} (${why})`, host };
  return { status: 'refused', code: 'host_changed', reason: `unknown_apply_host: ${host}`, host };
}

/** After a hop only: the page may not ask for payment, a government ID number or bank details. Parks the job (unsafe_apply_page) when it does. */
export function guardHopPage(deps: ApplierDeps, job: OpenJob, raw: Parameters<typeof unsafeApplyPage>[0]): ApplyResult | null {
  if ((job.hops ?? 0) === 0) return null;
  const bad = unsafeApplyPage(raw);
  return bad ? parkUnknownHost(deps, job, job.host, bad, 'unsafe_apply_page') : null;
}

/**
 * Redirect chains and interstitials: when the page is on a host the policy does not accept YET, give the page's own redirects a moment (at most 3
 * short waits, a fraction of WEB_SETTLE_MS each) before it is judged. Nothing is clicked or typed; a no-op when the settle time is 0.
 */
export async function settleTransit(deps: ApplierDeps, page: LiPage, job: OpenJob): Promise<void> {
  const wait = Math.min(2000, Math.max(0, loadWebConfig(deps.env ?? process.env).settleMs) * 2);
  if (wait <= 0) return;
  for (let i = 0; i < 3; i++) {
    const v = judgeHost(deps, job, page.url());
    if (!(v.kind === 'refused' && v.why === 'unknown_host')) return;
    await page.waitForTimeout(wait).catch(() => undefined);
  }
}

/** evaluateHost with the company context (name, domains on file, owner list) read only when the cheap rules cannot decide. */
export function judgeHost(deps: ApplierDeps, job: Pick<OpenJob, 'jobId' | 'host' | 'hops'>, pageUrl: string): HostVerdict {
  const v = evaluateHost(job, pageUrl);
  if (v.kind === 'refused' && v.why === 'unknown_host') return evaluateHost(job, pageUrl, buildHostCtx(deps.db, job.jobId, deps.env ?? process.env));
  return v;
}

export function settleHost(deps: ApplierDeps, job: OpenJob, pageUrl: string): ApplyResult | null {
  const v = judgeHost(deps, job, pageUrl);
  if (v.kind === 'same') return null;
  if (v.kind === 'refused') return parkUnknownHost(deps, job, v.host, v.why);

  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();
  if (hostCoolingDown(v.host) || hostCooledDown(deps.db, v.host, env, now)) {
    (deps.state.escalated ??= new Set<string>()).add(job.jobId);
    deps.state.cur = null;
    deps.state.pendingClose = true;
    return { status: 'refused', code: 'host_cooldown', reason: 'the host is cooling down after blocks', host: v.host };
  }
  const platform = v.platform ?? job.platform;
  // The per-host cap counts the host where the form really is.
  if (hostDayCountOf(deps, v.host) >= resolveHostCap(platform, env).cap) {
    return { status: 'rate_limited', code: 'host_cap', reason: 'host_cap', host: v.host };
  }
  const from = job.host;
  job.host = v.host;
  job.platform = platform;
  job.allowedHosts = v.allowedHosts;
  job.hops = (job.hops ?? 0) + 1;
  (job.hopLog ??= []).push(`${from}>${v.host}`);
  deps.state.lastOpen.set(v.host, now.getTime());
  try { deps.runtime.setAllowedHosts?.(v.allowedHosts); } catch { /* the runtime guard keeps the older set */ }
  console.error(`[applier] host_hop ${from} -> ${v.host} (${v.via}, hop ${job.hops})`);
  return null;
}
