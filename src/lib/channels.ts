// Which outreach and apply channels a job is eligible for, as pure data (plan 8G task 13).
// Closed reason codes only: the wake pipeline and the reports show these, never free text.
import { isDiscoverOnlySource, isHeldSource } from './discoverOnly.js';

export type Channel = 'email' | 'linkedin' | 'naukri' | 'apply';
export const CHANNELS: readonly Channel[] = ['email', 'linkedin', 'naukri', 'apply'];

export type ApplyTier = 'ats_form' | 'linkedin_easy' | 'account_gated' | 'naukri_agent' | 'unknown_host' | 'none';
export type ReasonCode =
  | 'hn_gate_pending'
  | 'no_company'
  | 'no_cold_naukri'
  | 'discover_only_source'
  | 'held_review'
  | `apply_tier:${ApplyTier}`;

export interface ChannelVerdict { channel: Channel; eligible: boolean; reason?: ReasonCode }

export interface ChannelJob {
  source: string;
  company?: string | null;
  extracted_company?: string | null;
  apply_url?: string | null;
}

export interface ChannelContext {
  /** Result of the Hacker News domain check for this job (`matched` opens email and LinkedIn). */
  hnCheck?: 'matched' | 'unmatched' | 'no_domain_in_posting' | 'unknown_job' | 'not_applicable';
  /** A recruiter thread already verified server-side on Naukri for this job. */
  naukriThread?: boolean;
  /** APPLY_LINKEDIN_EASY (ships false). */
  linkedinEasy?: boolean;
  /** APPLY_ALLOW_UNKNOWN_HOSTS (Task 16). */
  allowUnknownHosts?: boolean;
}

/** `hn`: the company name is untrusted comment text until the domain check matched. `apply`: whether the source can ever lead to an apply attempt. */
export interface SourcePolicy { hn?: boolean; apply: 'url' | 'none' }

/** One row per registry source id (config/platforms.json). A test fails when a registry id has no row. */
export const SOURCE_POLICY: Readonly<Record<string, SourcePolicy>> = {
  greenhouse: { apply: 'url' }, lever: { apply: 'url' }, ashby: { apply: 'url' },
  workable: { apply: 'none' }, recruitee: { apply: 'none' }, personio: { apply: 'none' },
  smartrecruiters: { apply: 'none' }, workday: { apply: 'none' },
  hackernews: { hn: true, apply: 'none' }, himalayas: { apply: 'none' }, weworkremotely: { apply: 'none' },
  adzuna: { apply: 'url' }, remotive: { apply: 'url' }, remoteok: { apply: 'url' },
  // Imported feeds (career-ops providers): discover-only, so email and LinkedIn contact are allowed and apply never.
  '4dayweek': { apply: 'none' }, arbeitnow: { apply: 'none' }, jobicy: { apply: 'none' }, workingnomads: { apply: 'none' },
  themuse: { apply: 'none' }, landingjobs: { apply: 'none' }, thehub: { apply: 'none' }, flowxtra: { apply: 'none' },
  yourator: { apply: 'none' }, getonbrd: { apply: 'none' }, justjoin: { apply: 'none' }, manfred: { apply: 'none' },
  cryptocurrencyjobs: { apply: 'none' }, jobspresso: { apply: 'none' }, larajobs: { apply: 'none' }, nodesk: { apply: 'none' },
  pythonorg: { apply: 'none' }, 'startup-jobs': { apply: 'none' },
  naukri: { apply: 'url' },
  'linkedin-jobs': { apply: 'url' }, 'linkedin-posts': { apply: 'none' },
};

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
    return u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}
const under = (h: string, d: string): boolean => h === d || h.endsWith(`.${d}`);

export function applyTierFor(applyUrl: string | null | undefined): ApplyTier {
  const h = hostOf(applyUrl);
  if (!h) return 'none';
  if (under(h, 'greenhouse.io') || under(h, 'lever.co') || under(h, 'ashbyhq.com')) return 'ats_form';
  if (under(h, 'myworkdayjobs.com')) return 'account_gated';
  if (under(h, 'linkedin.com')) return 'linkedin_easy';
  if (under(h, 'naukri.com')) return 'naukri_agent';
  return 'unknown_host';
}

export function channelsFor(job: ChannelJob, ctx: ChannelContext = {}): ChannelVerdict[] {
  const source = (job.source ?? '').trim().toLowerCase();
  const no = (channel: Channel, reason: ReasonCode): ChannelVerdict => ({ channel, eligible: false, reason });
  if (isHeldSource(source)) return CHANNELS.map((c) => no(c, 'held_review'));

  const policy = SOURCE_POLICY[source];
  const company = (job.company || job.extracted_company || '').trim();
  const out: ChannelVerdict[] = [];

  let people: ReasonCode | null = null;
  if (!company) people = 'no_company';
  else if (policy?.hn && ctx.hnCheck !== 'matched') people = 'hn_gate_pending';
  out.push(people ? no('email', people) : { channel: 'email', eligible: true });
  out.push(people ? no('linkedin', people) : { channel: 'linkedin', eligible: true });

  out.push(ctx.naukriThread ? { channel: 'naukri', eligible: true } : no('naukri', 'no_cold_naukri'));

  if (isDiscoverOnlySource(source) || policy?.apply === 'none') {
    out.push(no('apply', isDiscoverOnlySource(source) ? 'discover_only_source' : 'apply_tier:none'));
  } else {
    const tier = applyTierFor(job.apply_url);
    const ok = tier === 'ats_form' || (tier === 'linkedin_easy' && ctx.linkedinEasy === true) || (tier === 'unknown_host' && ctx.allowUnknownHosts === true);
    out.push(ok ? { channel: 'apply', eligible: true } : no('apply', `apply_tier:${tier}`));
  }
  return out;
}
