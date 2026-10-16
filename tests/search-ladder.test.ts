// Plan 8G task 3 (fix round 1): domain ladder, contacts wiring and search edge cases. Hermetic.
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { searchWithBudget, searchStatus, type SearchProvider, type SearchResult } from '../src/search/index.js';
import { cacheGet } from '../src/search/budget.js';
import { resolveCompanyDomain, resolveDomainForJob, hostMatchesCompany } from '../src/search/ladder.js';

const NOW = new Date('2026-10-16T10:00:00Z');
const R = (url: string): SearchResult => ({ title: 't', snippet: 's', url });

function fake(id: 'browser-dork' | 'serper', out: { results: SearchResult[]; blocked?: boolean }) {
  const calls: string[] = [];
  const p: SearchProvider = { id, async search(q) { calls.push(q); return out; } };
  return { p, calls };
}

describe('resolveCompanyDomain ladder', () => {
  const deps = (serper: SearchProvider) => ({ now: () => NOW, env: { SERPER_API_KEY: 'k', DORK_ENABLED: 'false' }, serper });

  it('explicit param wins, is reduced to the registrable domain, and calls no provider', async () => {
    const s = fake('serper', { results: [R('https://zzz.io')] });
    const r = await resolveCompanyDomain(openDb(':memory:'), { company: 'Acme', explicit: 'WWW.Acme.io', applyUrl: 'https://other.io/j' }, deps(s.p));
    expect(r).toEqual({ domain: 'acme.io', domain_source: 'param' });
    const sub = await resolveCompanyDomain(openDb(':memory:'), { company: 'Acme', explicit: 'careers.acme.co.uk' }, deps(s.p));
    expect(sub).toEqual({ domain: 'acme.co.uk', domain_source: 'param' });
    expect(s.calls).toHaveLength(0);
  });

  it('explicit param on the denylist or malformed is rejected and the ladder falls through', async () => {
    for (const bad of ['linkedin.com', 'jobs.lever.co', 'bit.ly', 'not a host', 'acme', 'a@b.io']) {
      const s = fake('serper', { results: [R('https://found.io/')] });
      const r = await resolveCompanyDomain(openDb(':memory:'), { company: 'Acme', explicit: bad }, deps(s.p));
      expect(r, bad).toEqual({ domain: 'found.io', domain_source: 'search' });
    }
    const none = fake('serper', { results: [] });
    expect(await resolveCompanyDomain(openDb(':memory:'), { company: 'Acme', explicit: 'linkedin.com' }, deps(none.p))).toEqual({ domain: null, domain_source: null });
  });

  it('registrable domain for multi-part suffixes', async () => {
    const s = fake('serper', { results: [] });
    const rows = [
      ['careers.acme.co.in', 'acme.co.in'], ['x.acme.com.au', 'acme.com.au'], ['hr.acme.co.ae', 'acme.co.ae'],
      ['a.b.acme.co.jp', 'acme.co.jp'], ['jobs.acme.com.br', 'acme.com.br'], ['jobs.acme.co.za', 'acme.co.za'],
      ['jobs.acme.com.sg', 'acme.com.sg'], ['careers.acme.io', 'acme.io'],
    ];
    for (const [h, want] of rows) {
      const r = await resolveCompanyDomain(openDb(':memory:'), { company: 'Acme', explicit: h }, deps(s.p));
      expect(r.domain, h).toBe(want);
    }
  });

  it('apply_url host is trusted only with a company-name token; otherwise falls to search', async () => {
    const s = fake('serper', { results: [R('https://www.found.io/about')] });
    const a = await resolveCompanyDomain(openDb(':memory:'), { company: 'Acme Inc', applyUrl: 'https://careers.acme.io/jobs/1' }, deps(s.p));
    expect(a).toEqual({ domain: 'acme.io', domain_source: 'apply_url' });
    expect(s.calls).toHaveLength(0);
    const b = await resolveCompanyDomain(openDb(':memory:'), { company: 'Acme', applyUrl: 'https://jobs.somehiringportal.io/acme/1' }, deps(s.p));
    expect(b).toEqual({ domain: 'found.io', domain_source: 'search' });
    const c = await resolveCompanyDomain(openDb(':memory:'), { company: 'Acme', applyUrl: 'https://boards.greenhouse.io/acme/jobs/1' }, deps(s.p));
    expect(c.domain_source).toBe('search');
  });

  it('hostMatchesCompany needs a 3+ char non-legal-form token', () => {
    expect(hostMatchesCompany('acme.io', 'Acme Inc')).toBe(true);
    expect(hostMatchesCompany('inc.io', 'Acme Inc')).toBe(false);
    expect(hostMatchesCompany('ab.io', 'AB')).toBe(false);
    expect(hostMatchesCompany('globex-corp.com', 'Globex Corporation')).toBe(true);
  });

  it('HN posting domain before search', async () => {
    const s = fake('serper', { results: [R('https://zzz.io')] });
    const r = await resolveCompanyDomain(
      openDb(':memory:'),
      { company: 'Acme', job: { source: 'hackernews', description: 'Apply at https://acme.dev/jobs or see https://github.com/acme' } },
      deps(s.p),
    );
    expect(r).toEqual({ domain: 'acme.dev', domain_source: 'hn_posting' });
    expect(s.calls).toHaveLength(0);
  });

  it('search skips denied hosts and returns null when nothing usable', async () => {
    const s = fake('serper', { results: [R('https://glassdoor.com/acme'), R('https://www.linkedin.com/company/acme'), R('https://acme.io/')] });
    expect(await resolveCompanyDomain(openDb(':memory:'), { company: 'Acme' }, deps(s.p))).toEqual({ domain: 'acme.io', domain_source: 'search' });
    const n = fake('serper', { results: [R('https://glassdoor.com/acme')] });
    expect(await resolveCompanyDomain(openDb(':memory:'), { company: 'Acme' }, deps(n.p))).toEqual({ domain: null, domain_source: null });
  });
});

describe('resolveDomainForJob (contacts wiring)', () => {
  const none = fake('serper', { results: [] });
  const deps = { now: () => NOW, env: { SERPER_API_KEY: 'k', DORK_ENABLED: 'false' }, serper: none.p };
  const insert = (db: ReturnType<typeof openDb>, id: string, source: string, applyUrl: string, description: string) =>
    db.prepare('INSERT INTO jobs (id, source, title, company, url, apply_url, description) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, source, 'Dev', 'Acme', applyUrl, applyUrl, description);

  it('reads apply_url and source from the jobs row and reports domain_source', async () => {
    const db = openDb(':memory:');
    insert(db, 'j1', 'adzuna', 'https://careers.acme.io/1', 'x');
    insert(db, 'j2', 'hackernews', 'https://news.ycombinator.com/item?id=1', 'Mail jobs@acme.dev');
    const a = await resolveDomainForJob(db, { company: 'Acme', job_id: 'j1' }, deps);
    expect(a.ladder).toEqual({ domain: 'acme.io', domain_source: 'apply_url' });
    const b = await resolveDomainForJob(db, { company: 'Acme', job_id: 'j2' }, deps);
    expect(b.ladder).toEqual({ domain: 'acme.dev', domain_source: 'hn_posting' });
    expect(b.job?.source).toBe('hackernews');
    const c = await resolveDomainForJob(db, { company: 'Acme', job_id: 'nope' }, deps);
    expect(c.job).toBeUndefined();
    expect(c.ladder.domain).toBeNull();
    const d = await resolveDomainForJob(db, { company: 'Acme', domain: 'acme.io' }, deps);
    expect(d.ladder.domain_source).toBe('param');
  });
});

describe('search edge cases', () => {
  const base = { now: () => NOW };

  it('DORK_ENABLED=false never calls dork', async () => {
    const db = openDb(':memory:');
    const dork = fake('browser-dork', { results: [R('https://a.io')] });
    const r = await searchWithBudget(db, 'careers_page', { domain: 'acme.io' }, { ...base, env: { DORK_ENABLED: 'false' }, dork: dork.p });
    expect(dork.calls).toHaveLength(0);
    expect(r.reason).toContain('dork_disabled');
  });

  it('dork empty falls to Serper; an empty Serper result counts usage and is not cached', async () => {
    const db = openDb(':memory:');
    const dork = fake('browser-dork', { results: [] });
    const serper = fake('serper', { results: [] });
    const deps = { ...base, env: { SERPER_API_KEY: 'k' }, dork: dork.p, serper: serper.p };
    const r = await searchWithBudget(db, 'careers_page', { domain: 'acme.io' }, deps);
    expect(r.provider).toBe('serper');
    expect(r.reason).toContain('dork_empty');
    expect(serper.calls).toHaveLength(1);
    expect(searchStatus(db, deps).serper.today).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM search_cache WHERE kind != 'cooldown'").get()).toEqual({ n: 0 });
  });

  it('a throwing Serper yields empty results with a reason, usage already counted', async () => {
    const db = openDb(':memory:');
    const serper: SearchProvider = { id: 'serper', async search() { throw new Error('net down'); } };
    const deps = { ...base, env: { SERPER_API_KEY: 'k', DORK_ENABLED: 'false' }, serper };
    const r = await searchWithBudget(db, 'careers_page', { domain: 'acme.io' }, deps);
    expect(r.results).toEqual([]);
    expect(r.reason).toContain('serper_error');
    expect(JSON.stringify(r)).not.toContain('net down');
    expect(searchStatus(db, deps).serper.today).toBe(1);
  });

  it('monthly usage sums across days and excludes other providers and other months', () => {
    const db = openDb(':memory:');
    const ins = db.prepare('INSERT INTO search_usage (day, provider, count) VALUES (?, ?, ?)');
    ins.run('2026-10-01', 'serper', 3);
    ins.run('2026-10-16', 'serper', 4);
    ins.run('2026-10-16', 'browser-dork', 9);
    ins.run('2026-09-30', 'serper', 50);
    const s = searchStatus(db, { now: () => NOW, env: {} });
    expect(s.serper.month).toBe(7);
    expect(s.serper.today).toBe(4);
  });

  it('cooldown rows are never cache hits; a NaN cached time is a miss', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO search_cache (qhash, provider, kind, result, at) VALUES ('cooldown:browser-dork', 'browser-dork', 'cooldown', '[]', ?)").run(NOW.toISOString());
    expect(cacheGet(db, 'cooldown:browser-dork', 14, NOW)).toBeNull();
    db.prepare("INSERT INTO search_cache (qhash, provider, kind, result, at) VALUES ('h1', 'serper', 'careers_page', '[]', 'garbage')").run();
    expect(cacheGet(db, 'h1', 14, NOW)).toBeNull();
    db.prepare("UPDATE search_cache SET at = ? WHERE qhash = 'h1'").run(NOW.toISOString());
    expect(cacheGet(db, 'h1', 14, NOW)).toEqual({ results: [] });
  });
});
