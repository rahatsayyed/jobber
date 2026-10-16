// Company domain ladder (plan 8G task 3): explicit param -> company-site apply_url host -> Hacker News
// posting domain -> search (cache, dork, Serper under budget).
import type BetterSqlite3 from 'better-sqlite3';
import { postingDomains } from '../lib/postingDomains.js';
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

export async function resolveCompanyDomain(
  db: BetterSqlite3.Database,
  input: DomainInput,
  deps: SearchDeps = {},
): Promise<{ domain: string | null; domain_source: DomainSource | null }> {
  const ex = (input.explicit ?? '').trim().toLowerCase().replace(/^www\./, '');
  if (ex) return { domain: ex, domain_source: 'param' };

  if (input.applyUrl) {
    const h = hostOf(input.applyUrl);
    if (h && !isDeniedDomainHost(h)) return { domain: h, domain_source: 'apply_url' };
  }

  if (input.job?.source === 'hackernews') {
    const d = postingDomains(input.job.description ?? '').find((x) => !isDeniedDomainHost(x));
    if (d) return { domain: d, domain_source: 'hn_posting' };
  }

  const out = await searchWithBudget(db, 'company_domain', { company: input.company }, deps);
  for (const r of out.results) {
    const h = hostOf(r.url);
    if (h && !isDeniedDomainHost(h)) return { domain: h, domain_source: 'search' };
  }
  return { domain: null, domain_source: null };
}
