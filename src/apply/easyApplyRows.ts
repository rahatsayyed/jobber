// src/apply/easyApplyRows.ts
// One code rule for "is this queue row a LinkedIn Easy Apply job?", shared by the manual apply queue (src/manual/manualApply.ts, Easy Apply off)
// and the LinkedIn drip lane picker (Easy Apply on). The stored apply_platform is decided at enqueue time and goes stale when
// APPLY_LINKEDIN_EASY flips, so the class is recomputed here from the URL with the CURRENT env (classifyApplyUrl), never read from the row.
import { hostMatches } from '../lib/hostClass.js';
import { classifyApplyUrl } from './registry.js';

/** A queue row joined with its job. All fields optional-null: missing data simply makes the row a non-candidate. */
export interface EasyApplyRow {
  /** outreach_queue.apply_url */
  apply_url?: string | null;
  /** jobs.apply_url */
  job_apply_url?: string | null;
  /** jobs.url */
  url?: string | null;
  /** jobs.source */
  source?: string | null;
  /** jobs.external_apply_url (set once linkedin_resolve_external found a company-site link) */
  external_apply_url?: string | null;
  /** outreach_queue.apply_status */
  apply_status?: string | null;
  /** jobs.excluded_reason */
  excluded_reason?: string | null;
  /** True when an applications row with status submitted exists for the job. */
  already_applied?: boolean;
}

/** apply_status values a row can have while it still has an apply to do. */
export const PENDING_APPLY_STATUSES = ['', 'queued'] as const;

/** The LinkedIn job page URL of a row (queue apply_url, then job apply_url, then job url), or null when none is a linkedin.com jobs/view page. */
export function linkedinJobPageUrl(row: EasyApplyRow): string | null {
  for (const u of [row.apply_url, row.job_apply_url, row.url]) {
    if (typeof u !== 'string' || !u.trim()) continue;
    if (!hostMatches(u, 'linkedin.com')) continue;
    try {
      if (/^\/jobs\/view\//i.test(new URL(u).pathname)) return u;
    } catch { /* next */ }
  }
  return null;
}

/**
 * True when the row is a LinkedIn job-page row that still waits to be applied to on the platform itself: a linkedin.com job page, no resolved
 * external (company-site) link, not vetoed, not applied, apply_status empty or `queued`. Rows the machine already gave up on (needs_owner,
 * manual_review) are NOT candidates: the manual queue lists those whatever the flag says. `env` only feeds the registry class check, so a
 * URL the registry refuses for another reason (credentials, bad scheme) is not a candidate. The result does not depend on
 * APPLY_LINKEDIN_EASY: the caller decides who owns the row (drip lane when the flag is true, manual queue otherwise).
 */
export function isLinkedInEasyApplyCandidate(row: EasyApplyRow, env: NodeJS.ProcessEnv = process.env): boolean {
  if (row.excluded_reason) return false;
  if (row.already_applied) return false;
  if (typeof row.external_apply_url === 'string' && row.external_apply_url.trim()) return false;
  if (!(PENDING_APPLY_STATUSES as readonly string[]).includes((row.apply_status ?? '').trim())) return false;
  const page = linkedinJobPageUrl(row);
  if (!page) return false;
  const c = classifyApplyUrl(page, row.source ?? null, env);
  return c.platform === 'linkedin_easy' || c.platform === 'linkedin' || (c.platform === 'none' && c.reason === 'easy_apply_off');
}
