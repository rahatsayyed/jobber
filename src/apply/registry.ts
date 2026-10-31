// ATS registry and the one code-authoritative classification of an apply URL (plan 8G-2, task 16).
// The model never decides the apply platform: enqueue_outreach calls classifyApplyUrl and stores its answer.
import { hostMatches, lookAlikeAtsHost } from '../lib/hostClass.js';
import { isApplyBlockedSource } from '../lib/discoverOnly.js';

export type ApplyTier = 'fast' | 'agent' | 'never';

export interface AtsDef {
  id: string;
  label: string;
  apexes: string[];
  tier: ApplyTier;
  accountRequired: boolean | 'maybe';
  recipeId: string | null;
}

// Every id here must also be in APPLY_HOST_PLATFORM_IDS (src/webcore/hostCaps.ts); a test asserts it.
// every platform with a shipped recipe in config/ats-recipes is 'fast' (a test asserts it), the rest are 'agent'.
export const ATS_REGISTRY: AtsDef[] = [
  { id: 'greenhouse', label: 'Greenhouse', apexes: ['greenhouse.io'], tier: 'fast', accountRequired: false, recipeId: 'greenhouse' },
  { id: 'lever', label: 'Lever', apexes: ['lever.co'], tier: 'fast', accountRequired: false, recipeId: 'lever' },
  { id: 'ashby', label: 'Ashby', apexes: ['ashbyhq.com'], tier: 'fast', accountRequired: false, recipeId: 'ashby' },
  { id: 'workable', label: 'Workable', apexes: ['workable.com'], tier: 'fast', accountRequired: 'maybe', recipeId: 'workable' },
  { id: 'smartrecruiters', label: 'SmartRecruiters', apexes: ['smartrecruiters.com'], tier: 'fast', accountRequired: 'maybe', recipeId: 'smartrecruiters' },
  { id: 'workday', label: 'Workday', apexes: ['myworkdayjobs.com'], tier: 'agent', accountRequired: true, recipeId: null },
  { id: 'recruitee', label: 'Recruitee', apexes: ['recruitee.com'], tier: 'agent', accountRequired: 'maybe', recipeId: null },
  { id: 'personio', label: 'Personio', apexes: ['personio.de', 'personio.com'], tier: 'agent', accountRequired: 'maybe', recipeId: null },
];

export interface ApplyClass { platform: string; tier: ApplyTier; reason?: string }

/** Sources whose jobs are LinkedIn job pages (own discovery or an owner-submitted LinkedIn URL). */
const isLinkedInJobSource = (source: string | null): boolean => source === 'linkedin-jobs' || source === 'manual:linkedin';

const none = (reason: string): ApplyClass => ({ platform: 'none', tier: 'never', reason });

export function classifyApplyUrl(url: string | null, source: string | null, env: NodeJS.ProcessEnv = process.env): ApplyClass {
  if (isApplyBlockedSource(source)) {
    return none(typeof source === 'string' && source.trim().toLowerCase().startsWith('gen:') ? 'held_review' : 'discover_only_source');
  }
  if (typeof url !== 'string' || !url.trim()) return none('no_apply_url');
  let u: URL;
  try { u = new URL(url); } catch { return none('bad_url'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return none('bad_scheme');
  if (u.username || u.password) return none('credentials_in_url');

  if (hostMatches(url, 'linkedin.com')) {
    if (env.APPLY_LINKEDIN_EASY === 'true') return { platform: 'linkedin_easy', tier: 'agent' };
    // A job from our own LinkedIn discovery may send its Apply to the company site: `linkedin_resolve_external` finds that site in code and
    // setExternalApply re-routes the row to the generic applier. apply_open never drives this class itself (not in APPLY_HOST_PLATFORM_IDS).
    if (isLinkedInJobSource(source) && /^\/jobs\/view\//i.test(u.pathname)) return { platform: 'linkedin', tier: 'agent', reason: 'external_resolve' };
    return none('easy_apply_off');
  }
  if (hostMatches(url, 'naukri.com')) return { platform: 'naukri', tier: 'agent' };
  if (hostMatches(url, 'wellfound.com')) return { platform: 'wellfound', tier: 'agent' };
  for (const a of ATS_REGISTRY) {
    if (a.apexes.some((x) => hostMatches(url, x))) return { platform: a.id, tier: a.tier };
  }
  if (lookAlikeAtsHost(url)) return none('look_alike_host');
  if (env.APPLY_ALLOW_UNKNOWN_HOSTS === 'true') return { platform: 'browser', tier: 'agent' };
  return none('host_unknown');
}
