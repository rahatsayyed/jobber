// Company domain ladder (plan 8G task 3): explicit param -> company-site apply_url host (only when it
// looks like the company) -> Hacker News posting domain -> search (cache, dork, Serper under budget).
// Every rung applies host syntax validation and the denylist, and returns the registrable domain.
import type BetterSqlite3 from 'better-sqlite3';
import { postingDomains, registrableDomain } from '../lib/postingDomains.js';
import { isDeniedDomainHost } from './denylist.js';
import { searchWithBudget, type SearchDeps } from './index.js';

export type DomainSource = 'param' | 'apply_url' | 'hn_posting' | 'search';

export interface DomainInput {
  company: string;
  explicit?: string;
  applyUrl?: string | null;
  job?: { source: string; description: string | null } | null;
}

const HOST_RE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    const h = u.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
    return HOST_RE.test(h) ? h : null;
  } catch {
    return null;
  }
}

const NAME_STOP = new Set([
  'inc', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'company', 'the', 'and', 'group', 'pvt', 'private',
  'gmbh', 'labs', 'technologies', 'technology', 'solutions', 'software', 'systems',
]);

const NON_ALNUM = /[^a-z0-9]+/;

function alnum(s: string): string {
  return s.toLowerCase().normalize('NFKD').split(NON_ALNUM).join('');
}

/** True when a company-name token (>= 3 chars, not a legal-form word) appears in the registrable domain. */
export function hostMatchesCompany(host: string, company: string): boolean {
  const dom = alnum(registrableDomain(host));
  const tokens = company.toLowerCase().normalize('NFKD').split(NON_ALNUM).filter((t) => t.length >= 3 && !NAME_STOP.has(t));
  return tokens.some((t) => dom.includes(t));
}

/** Validated, non-denied registrable domain for a host, or null. */
function usable(h: string | null): string | null {
  if (!h || !HOST_RE.test(h) || isDeniedDomainHost(h)) return null;
  const reg = registrableDomain(h);
  return reg && HOST_RE.test(reg) && !isDeniedDomainHost(reg) ? reg : null;
}

export async function resolveCompanyDomain(
  db: BetterSqlite3.Database,
  input: DomainInput,
  deps: SearchDeps = {},
): Promise<{ domain: string | null; domain_source: DomainSource | null }> {
  const ex = usable((input.explicit ?? '').trim().toLowerCase().replace(/^www\./, '') || null);
  if (ex) return { domain: ex, domain_source: 'param' };

  if (input.applyUrl) {
    const h = hostOf(input.applyUrl);
    const d = usable(h);
    if (h && d && hostMatchesCompany(h, input.company)) return { domain: d, domain_source: 'apply_url' };
  }

  if (input.job?.source === 'hackernews') {
    for (const x of postingDomains(input.job.description ?? '')) {
      const d = usable(x);
      if (d) return { domain: d, domain_source: 'hn_posting' };
    }
  }

  const out = await searchWithBudget(db, 'company_domain', { company: input.company }, deps);
  for (const r of out.results) {
    const d = usable(hostOf(r.url));
    if (d) return { domain: d, domain_source: 'search' };
  }
  return { domain: null, domain_source: null };
}

/** Pure part of the contacts tool: reads the job row (never from the model) and runs the ladder. */
export async function resolveDomainForJob(
  db: BetterSqlite3.Database,
  a: { company: string; domain?: string; job_id?: string },
  deps: SearchDeps = {},
): Promise<{
  job: { source: string; description: string | null; apply_url: string | null } | undefined;
  ladder: { domain: string | null; domain_source: DomainSource | null };
}> {
  const job = a.job_id === undefined
    ? undefined
    : (db.prepare('SELECT source, description, apply_url FROM jobs WHERE id = ?').get(a.job_id) as
        | { source: string; description: string | null; apply_url: string | null }
        | undefined);
  const ladder = await resolveCompanyDomain(db, { company: a.company, explicit: a.domain, applyUrl: job?.apply_url, job }, deps);
  return { job, ladder };
}
