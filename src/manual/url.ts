// Manual request URLs: validation and classification, all in code (the model never decides what a URL is).
// A manual request is an owner-submitted job URL or careers page; this file only decides whether the string is acceptable and
// which fetch path it takes. Nothing here touches the network.
import { hostMatches, lookAlikeAtsHost } from '../lib/hostClass.js';
import { slugProblem, SITE_RE, WD_RE, type CompanyAts } from '../sources/boards/filters.js';
import { canonicalJobUrl, extractLinkedInJobId } from '../linkedin/jobIds.js';
import { extractNaukriJobId } from '../sources/naukri.js';
import { extractWellfoundJobId } from '../wellfound/page.js';

export type ManualPlatform = 'linkedin' | 'naukri' | 'wellfound';

export const MANUAL_URL_MAX_CHARS = 500;

export type ManualUrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/** https only, no credentials, no port, no look-alike ATS host, no bare IP or localhost, length cap, no fragment. */
export function validateManualUrl(raw: unknown): ManualUrlCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'url must be a string' };
  const text = raw.trim();
  if (!text) return { ok: false, reason: 'url is empty' };
  if (text.length > MANUAL_URL_MAX_CHARS) return { ok: false, reason: `url is longer than ${MANUAL_URL_MAX_CHARS} characters` };
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return { ok: false, reason: 'url must not contain spaces or control characters' };
  let u: URL;
  try { u = new URL(text); } catch { return { ok: false, reason: 'not a valid url' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'only https urls are accepted' };
  if (u.username || u.password) return { ok: false, reason: 'urls with credentials are refused' };
  if (u.port) return { ok: false, reason: 'urls with a port are refused' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: 'host must be a public domain name' };
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[')) return { ok: false, reason: 'ip addresses are refused' };
  if (lookAlikeAtsHost(text)) return { ok: false, reason: 'host imitates a known job site and is refused' };
  u.hash = '';
  return { ok: true, url: u.toString() };
}

export type ManualClass =
  | { kind: 'ats'; ats: CompanyAts; slug: string; wd?: string; site?: string; region?: 'eu'; domain?: 'de' | 'com'; jobToken: string | null; sourceKind: string; requestKind: 'url' | 'careers' }
  | { kind: 'platform'; platform: ManualPlatform; jobId: string; canonicalUrl: string; sourceKind: string; requestKind: 'url' }
  | { kind: 'other'; sourceKind: 'manual:other'; requestKind: 'url' | 'careers' }
  | { kind: 'unsupported'; reason: string };

const LOCALE = /^[a-z]{2}(?:-[A-Za-z]{2})?$/;

function segs(u: URL): string[] {
  return u.pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
}

function ats(
  a: CompanyAts, slug: string | undefined, token: string | null, extra: Partial<Extract<ManualClass, { kind: 'ats' }>> = {},
): ManualClass {
  if (!slug) return { kind: 'unsupported', reason: `could not read the ${a} board name from the url` };
  const problem = slugProblem(a, slug);
  if (problem) return { kind: 'unsupported', reason: `${a} board name rejected: ${problem}` };
  return { kind: 'ats', ats: a, slug, jobToken: token, sourceKind: `manual:${a}`, requestKind: token ? 'url' : 'careers', ...extra };
}

const SINGLE_JOB_PATH = /\/(?:jobs?|positions?|openings?|vacanc\w*|requisitions?|roles?|postings?)\/[^/]*\d[^/]*|\/(?:jobs?|positions?|openings?|careers?)\/[^/]{12,}|[?&](?:gh_jid|jid|jobid|job_id|id)=[\w-]{3,}|\/[0-9a-f]{8}-[0-9a-f]{4}-/i;

/** Which fetch path a validated URL takes. LinkedIn, Naukri and Wellfound job pages go to their platform operator; other pages of those sites are refused. */
export function classifyManualUrl(validUrl: string): ManualClass {
  let u: URL;
  try { u = new URL(validUrl); } catch { return { kind: 'unsupported', reason: 'not a valid url' }; }
  const plat = (platform: ManualPlatform, jobId: string, canonicalUrl: string): ManualClass =>
    ({ kind: 'platform', platform, jobId, canonicalUrl, sourceKind: `manual:${platform}`, requestKind: 'url' });
  if (hostMatches(validUrl, 'linkedin.com')) {
    const cur = u.searchParams.get('currentJobId') ?? '';
    const id = extractLinkedInJobId(u.pathname) ?? (/^\/jobs\/(?:search|collections)/.test(u.pathname) && /^\d{5,15}$/.test(cur) ? cur : null);
    return id ? plat('linkedin', `li-job:${id}`, canonicalJobUrl(id)) : { kind: 'unsupported', reason: 'only a LinkedIn job page (linkedin.com/jobs/view/<id>) is supported; send that link or the company careers page' };
  }
  if (hostMatches(validUrl, 'naukri.com')) {
    const id = extractNaukriJobId(`${u.origin}${u.pathname}`);
    const path = u.pathname.replace(/\/+$/, '');
    return id && /job-listings-/.test(path) ? plat('naukri', `naukri:${id}`, `${u.origin}${path}`) : { kind: 'unsupported', reason: 'only a Naukri job page (naukri.com/job-listings-...) is supported; send that link or the company careers page' };
  }
  if (hostMatches(validUrl, 'wellfound.com')) {
    const id = extractWellfoundJobId(validUrl);
    return id ? plat('wellfound', `wellfound:${id}`, `${u.origin}${u.pathname}`) : { kind: 'unsupported', reason: 'only a Wellfound job page (wellfound.com/jobs/<id> or /company/<name>/jobs/<id>) is supported' };
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const p = segs(u);
  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io' || host === 'boards.eu.greenhouse.io' || host === 'job-boards.eu.greenhouse.io') {
    const token = p[1] === 'jobs' && p[2] ? p[2] : u.searchParams.get('gh_jid');
    return ats('greenhouse', p[0], token);
  }
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    return ats('lever', p[0], p[1] ?? null, host === 'jobs.eu.lever.co' ? { region: 'eu' } : {});
  }
  if (host === 'jobs.ashbyhq.com') return ats('ashby', p[0], p[1] ?? null);
  if (host === 'apply.workable.com') return ats('workable', p[0], p[1] === 'j' && p[2] ? p[2] : null);
  if (host === 'jobs.smartrecruiters.com' || host === 'careers.smartrecruiters.com') return ats('smartrecruiters', p[0], p[1] ?? null);
  const rec = /^([a-z0-9-]+)\.recruitee\.com$/.exec(host);
  if (rec) return ats('recruitee', rec[1], p[0] === 'o' && p[1] ? p[1] : null);
  const per = /^([a-z0-9-]+)\.jobs\.personio\.(de|com)$/.exec(host);
  if (per) return ats('personio', per[1], p[0] === 'job' && p[1] ? p[1] : null, { domain: per[2] as 'de' | 'com' });
  const wd = /^([a-z0-9-]+)\.(wd\d{1,3})\.myworkdayjobs\.com$/.exec(host);
  if (wd) {
    const rest = p.filter((s, i) => !(i === 0 && LOCALE.test(s) && p.length > 1 && s !== 'job'));
    const site = rest[0];
    const ji = rest.indexOf('job');
    const token = ji >= 0 && rest[rest.length - 1] ? rest[rest.length - 1]! : null;
    if (!site || !SITE_RE.test(site) || site === 'job' || !WD_RE.test(wd[2]!)) return { kind: 'unsupported', reason: 'could not read the workday site name from the url' };
    return ats('workday', wd[1], token, { wd: wd[2], site });
  }
  const single = SINGLE_JOB_PATH.test(`${u.pathname}${u.search}`);
  return { kind: 'other', sourceKind: 'manual:other', requestKind: single ? 'url' : 'careers' };
}
