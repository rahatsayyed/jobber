// Pure search-query builders (plan 8G task 3). Parameters are validated tokens, never raw model
// strings. The browser engine that runs these queries arrives in Task 7; here the provider takes an
// injected executor so no browser is launched by this module.
import type { SearchKind, SearchProvider, SearchResult } from './index.js';

export interface DorkParams {
  company?: string;
  domain?: string;
  role?: string;
}

const TOKEN_RE = /^[\p{L}\p{N} .&'\-]{1,80}$/u;
const DOMAIN_RE = /^(?=.{3,80}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export function isSafeToken(s: unknown): s is string {
  return typeof s === 'string' && TOKEN_RE.test(s) && s.trim().length > 0;
}

function token(name: string, v: string | undefined): string {
  if (!isSafeToken(v)) throw new Error(`invalid search parameter: ${name}`);
  return v.trim();
}

function domainParam(v: string | undefined): string {
  const d = (v ?? '').trim().toLowerCase();
  if (!DOMAIN_RE.test(d)) throw new Error('invalid search parameter: domain');
  return d;
}

const NOISE = ['linkedin.com', 'glassdoor.com', 'indeed.com', 'crunchbase.com', 'facebook.com', 'wikipedia.org'];

export function buildDork(kind: SearchKind, p: DorkParams): string {
  switch (kind) {
    case 'company_domain':
      return `"${token('company', p.company)}" official website ${NOISE.map((h) => `-site:${h}`).join(' ')}`;
    case 'domain_emails':
      return `"@${domainParam(p.domain)}" (careers OR hr OR recruiting OR jobs)`;
    case 'careers_page':
      return `site:${domainParam(p.domain)} (careers OR jobs)`;
    case 'hiring_posts':
      return `site:linkedin.com/posts "hiring" "${token('role', p.role)}"`;
    case 'jobs_site':
      return `intitle:"${token('role', p.role)}" "${token('company', p.company)}" careers (inurl:careers OR inurl:jobs OR filetype:pdf)`;
    default:
      throw new Error('unknown search kind');
  }
}

export type DorkExecutor = (q: string, o: { kind: SearchKind }) => Promise<{ results: SearchResult[]; blocked?: boolean }>;

/** The browser-dork provider. The executor (Task 7 engine) is injected; without one nothing runs. */
export function createDorkProvider(exec: DorkExecutor): SearchProvider {
  return {
    id: 'browser-dork',
    async search(q, o) {
      return exec(q, o);
    },
  };
}
