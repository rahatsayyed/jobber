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
// workable and smartrecruiters are 'agent' until task 19 ships their recipes, which flips them to 'fast'.
export const ATS_REGISTRY: AtsDef[] = [
  { id: 'greenhouse', label: 'Greenhouse', apexes: ['greenhouse.io'], tier: 'fast', accountRequired: false, recipeId: 'greenhouse' },
  { id: 'lever', label: 'Lever', apexes: ['lever.co'], tier: 'fast', accountRequired: false, recipeId: 'lever' },
  { id: 'ashby', label: 'Ashby', apexes: ['ashbyhq.com'], tier: 'fast', accountRequired: false, recipeId: 'ashby' },
  { id: 'workable', label: 'Workable', apexes: ['workable.com'], tier: 'agent', accountRequired: 'maybe', recipeId: null },
  { id: 'smartrecruiters', label: 'SmartRecruiters', apexes: ['smartrecruiters.com'], tier: 'agent', accountRequired: 'maybe', recipeId: null },
  { id: 'workday', label: 'Workday', apexes: ['myworkdayjobs.com'], tier: 'agent', accountRequired: true, recipeId: null },
  { id: 'recruitee', label: 'Recruitee', apexes: ['recruitee.com'], tier: 'agent', accountRequired: 'maybe', recipeId: null },
  { id: 'personio', label: 'Personio', apexes: ['personio.de', 'personio.com'], tier: 'agent', accountRequired: 'maybe', recipeId: null },
];

export interface ApplyClass { platform: string; tier: ApplyTier; reason?: string }

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
    return env.APPLY_LINKEDIN_EASY === 'true' ? { platform: 'linkedin_easy', tier: 'agent' } : none('easy_apply_off');
  }
  if (hostMatches(url, 'naukri.com')) return { platform: 'naukri', tier: 'agent' };
  for (const a of ATS_REGISTRY) {
    if (a.apexes.some((x) => hostMatches(url, x))) return { platform: a.id, tier: a.tier };
  }
  if (lookAlikeAtsHost(url)) return none('look_alike_host');
  if (env.APPLY_ALLOW_UNKNOWN_HOSTS === 'true') return { platform: 'browser', tier: 'agent' };
  return none('host_unknown');
}
