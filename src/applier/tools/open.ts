// apply_open({job_id}): the only tool that navigates. The URL is read from the job row (never an input);
// every pre-flight refusal happens before the apply_attempt counter and before any browser use (G9: the
// submit counters are NOT consumed here).
import { z } from 'zod';
import { getExcludedReason, getFirstHardStop } from '../../db.js';
import { classifyApplyUrl, ATS_REGISTRY } from '../../apply/registry.js';
import { hostMatches } from '../../lib/hostClass.js';
import { hostAllowed } from '../../webcore/runtime.js';
import { guardHopPage, settleHost, settleTransit, parkUnknownHost } from '../hostGuard.js';
import { APPLY_HOST_PLATFORM_IDS, resolveHostCap } from '../../webcore/hostCaps.js';
import { loadWebConfig } from '../../webcore/config.js';
import { loadOutreachConfig } from '../../outreach/config.js';
import { ceilings, tryConsume } from '../../outreach/limits.js';
import { hostCoolingDown, hostOfUrl, readPage } from '../../webcore/login.js';
import { hostCooledDown } from '../cooldown.js';
import { findPreparedResumePath, validateResumePath, DEFAULT_RESUME_ROOT } from '../resume.js';
import {
  blockedResult, envOf, failedResult, hostDayCount, nowOf, preflight, refuse, type ApplierDeps, type ApplyResult, type OpenJob,
} from './common.js';
import { screenedState } from './state.js';

export const OpenInput = z.object({ job_id: z.string().regex(/^[\w.:@-]{1,200}$/) }).strict();
export type OpenInputT = z.infer<typeof OpenInput>;

interface JobRow { id: string; source: string | null; apply_url: string | null; external_apply_url: string | null; description: string | null }

const firstLocation = (description: string | null): string | undefined => {
  const m = /^Location:\s*(.+)$/m.exec(String(description ?? '').slice(0, 400));
  return m ? m[1].trim().slice(0, 300) : undefined;
};

export async function handleOpen(input: OpenInputT, deps: ApplierDeps): Promise<ApplyResult> {
  try {
    return await open(input, deps);
  } catch {
    console.error('[applier] apply_open failed');
    return failedResult();
  }
}

async function open(input: OpenInputT, deps: ApplierDeps): Promise<ApplyResult> {
  const env = envOf(deps);
  const db = deps.db;
  const now = nowOf(deps);
  const jobId = input.job_id;

  const job = db.prepare('SELECT id, source, apply_url, external_apply_url, description FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
  if (!job) return refuse('unknown_job', 'no such job');
  const veto = getExcludedReason(db, jobId);
  if (veto) return refuse('vetoed', 'the job is excluded');
  const hardStop = getFirstHardStop(db, jobId);
  if (hardStop) return refuse('hard_stop', 'the job has a hard stop');
  if (db.prepare("SELECT 1 FROM applications WHERE job_id = ? AND status = 'submitted' LIMIT 1").get(jobId)) {
    return refuse('already_applied', 'an application was already submitted for this job');
  }

  // A browser submit that was clicked but never confirmed waits for the owner; it is not retried by code.
  if (db.prepare("SELECT 1 FROM applications WHERE job_id = ? AND method = 'browser' AND status = 'manual_review' LIMIT 1").get(jobId)) {
    return refuse('already_attempted', 'a submit was clicked but not confirmed; check it by hand');
  }

  // Code-authoritative class: re-derived from the stored URL, then narrowed by the queued row's own tier.
  // A platform job whose Apply leads to the company site is applied to at the URL setExternalApply stored; every refusal below still runs on it.
  const url = job.external_apply_url?.trim() || job.apply_url || '';
  const cls = classifyApplyUrl(url, job.source, env);
  const queued = db.prepare('SELECT apply_tier, apply_platform FROM outreach_queue WHERE job_id = ? ORDER BY id DESC LIMIT 1')
    .get(jobId) as { apply_tier: string | null; apply_platform: string | null } | undefined;
  if (cls.platform === 'none' || cls.tier === 'never' || queued?.apply_tier === 'never' || queued?.apply_platform === 'none') {
    return refuse('class_none', cls.reason ?? 'this job is not applied to through the browser');
  }
  if (!(APPLY_HOST_PLATFORM_IDS as readonly string[]).includes(cls.platform)) {
    return refuse('unsupported_platform', 'the web applier does not drive this platform');
  }
  const platform = cls.platform;

  const resume = validateResumePath(findPreparedResumePath(db, jobId), deps.resumeRoot ?? DEFAULT_RESUME_ROOT);
  if (!resume) return refuse('no_resume', 'no prepared resume PDF for this job');

  const g = preflight(deps);
  if (g) return g;

  const host = hostOfUrl(url);
  if (deps.state.escalated?.has(jobId)) return refuse('escalated_this_run', 'this job was handed to the owner; it is not retried in this run');
  if (hostCoolingDown(host) || hostCooledDown(db, host, env, now)) return refuse('host_cooldown', 'the host is cooling down after blocks');
  const gapSec = loadWebConfig(env).minGapSec;
  const last = deps.state.lastOpen.get(host);
  if (last !== undefined && gapSec > 0) {
    const wait = Math.ceil((gapSec * 1000 - (now.getTime() - last)) / 1000);
    if (wait > 0) return { ...refuse('host_gap', 'too soon after the last open on this host'), retry_after_sec: wait };
  }
  const ocfg = loadOutreachConfig(env);
  if (!ceilings(db, ocfg, now).apply_attempt.ok) {
    return { status: 'rate_limited', code: 'attempt_cap', reason: 'APPLY_MAX_ATTEMPTS_PER_DAY reached' };
  }
  if (hostDayCount(db, host) >= resolveHostCap(platform, env).cap) {
    return { status: 'rate_limited', code: 'host_cap', reason: 'host_cap' };
  }

  // Pre-flight passed: the only counter consumed here is apply_attempt.
  if (!tryConsume(db, 'apply_attempt', ocfg, now)) {
    return { status: 'rate_limited', code: 'attempt_cap', reason: 'APPLY_MAX_ATTEMPTS_PER_DAY reached' };
  }
  deps.state.lastOpen.set(host, now.getTime());

  const entry = ATS_REGISTRY.find((a) => a.id === platform);
  const allowedHosts = entry ? entry.apexes.filter((a) => hostMatches(url, a)) : [host];
  const baseHosts = allowedHosts.length ? allowedHosts : [host];
  // A redirect of the stored URL may end on another host (vendor, same domain, the company site); settleHost judges the final host in code right after.
  const nav = await deps.runtime.open(url, { allowedHosts: baseHosts, jobId, redirectAny: true });
  if (!nav.ok) {
    deps.state.cur = null;
    if (nav.code === 'halted') return refuse('halted', nav.reason);
    if (nav.code === 'refused') {
      // The session is already closed by the runtime. A final host is known: it is not trusted, park the job (no retry loop).
      if (nav.host) { const parked = parkUnknownHost(deps, { jobId }, nav.host, 'redirect'); deps.state.pendingClose = false; return parked; }
      return refuse('host_changed', nav.reason);
    }
    return { status: 'failed', code: nav.code, reason: nav.reason };
  }
  const candidate: OpenJob = {
    jobId, platform, host: hostAllowed(nav.url, baseHosts) ? hostOfUrl(nav.url) : host, url, allowedHosts: baseHosts,
    location: firstLocation(job.description), steps: 0, submitted: false,
  };
  if (!hostAllowed(nav.url, baseHosts)) {
    const pg = deps.runtime.page();
    if (pg) await deps.runtime.serial(() => settleTransit(deps, pg, candidate));
    const hop = settleHost(deps, candidate, pg ? pg.url() : nav.url);
    if (hop) {
      deps.state.pendingClose = false;
      await deps.runtime.close();
      deps.state.cur = null;
      return hop;
    }
  }

  const read = await deps.runtime.serial(async () => {
    const page = deps.runtime.page();
    return page ? readPage(page) : null;
  });
  if (!read) { deps.state.cur = null; return failedResult(); }
  if (read.model.block) {
    const r = blockedResult(deps, read.model);
    await deps.runtime.close();
    deps.state.cur = null;
    return r;
  }
  const unsafe = guardHopPage(deps, candidate, read.raw);
  if (unsafe) {
    deps.state.pendingClose = false;
    await deps.runtime.close();
    deps.state.cur = null;
    return unsafe;
  }
  const s = await screenedState(read.model, 'read', deps);
  if (!s.ok) {
    await deps.runtime.close();
    deps.state.cur = null;
    return s.result;
  }
  deps.state.cur = candidate;
  return { status: 'ok', code: 'opened', platform: candidate.platform, host: candidate.host, state: s.state };
}
