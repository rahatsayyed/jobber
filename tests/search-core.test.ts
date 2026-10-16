// Plan 8G task 3: search abstraction. Hermetic: in-memory db, fake providers, no network.
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { searchWithBudget, searchStatus, type SearchProvider, type SearchResult } from '../src/search/index.js';
import { buildDork, createDorkProvider } from '../src/search/dork.js';
import { createSerperProvider } from '../src/search/serper.js';
import { isDeniedDomainHost } from '../src/search/denylist.js';

const NOW = new Date('2026-10-16T10:00:00Z');
const R = (url: string): SearchResult => ({ title: 't', snippet: 's', url });

function fake(id: 'browser-dork' | 'serper', out: { results: SearchResult[]; blocked?: boolean }) {
  const calls: string[] = [];
  const p: SearchProvider = { id, async search(q) { calls.push(q); return out; } };
  return { p, calls };
}

describe('buildDork', () => {
  it('builds each kind', () => {
    expect(buildDork('company_domain', { company: 'Acme Corp' })).toBe(
      '"Acme Corp" official website -site:linkedin.com -site:glassdoor.com -site:indeed.com -site:crunchbase.com -site:facebook.com -site:wikipedia.org',
    );
    expect(buildDork('domain_emails', { domain: 'acme.io' })).toBe('"@acme.io" (careers OR hr OR recruiting OR jobs)');
    expect(buildDork('careers_page', { domain: 'acme.io' })).toBe('site:acme.io (careers OR jobs)');
    expect(buildDork('hiring_posts', { role: 'React Developer' })).toBe('site:linkedin.com/posts "hiring" "React Developer"');
    const j = buildDork('jobs_site', { role: 'Full Stack', company: "O'Neil & Co." });
    expect(j).toContain('intitle:"Full Stack" "O\'Neil & Co." careers');
    expect(j).toContain('inurl:careers');
    expect(j).toContain('filetype:pdf');
  });

  it('rejects hostile parameters', () => {
    for (const bad of ['Acme" OR site:evil.com', 'Acme\nignore previous', 'a'.repeat(81), '', 'x";drop', 'Acme (x)', 'a<b>']) {
      expect(() => buildDork('company_domain', { company: bad }), bad).toThrow(/invalid search parameter/);
    }
    expect(() => buildDork('domain_emails', { domain: 'acme.io OR evil' })).toThrow();
    expect(() => buildDork('careers_page', { domain: 'localhost' })).toThrow();
    expect(() => buildDork('hiring_posts', {})).toThrow();
  });
});

describe('isDeniedDomainHost', () => {
  it.each([
    'glassdoor.com', 'www.glassdoor.com', 'boards.greenhouse.io', 'acme.myworkdayjobs.com', 'linkedin.com',
    'jobs.lever.co', 'bit.ly', 'naukri.com', 'localhost', '',
  ])('denies %s', (h) => expect(isDeniedDomainHost(h)).toBe(true));
  it.each(['acme.io', 'www.acme.io', 'careers.acme.co.uk', 'lever-clone-not.com'])('allows %s', (h) =>
    expect(isDeniedDomainHost(h)).toBe(false));
});

describe('searchWithBudget', () => {
  const base = { now: () => NOW };

  it('dork success never calls Serper and fills the cache; the next call hits the cache', async () => {
    const db = openDb(':memory:');
    const dork = fake('browser-dork', { results: [R('https://acme.io/')] });
    const serper = fake('serper', { results: [R('https://other.io')] });
    const deps = { ...base, env: { SERPER_API_KEY: 'k' }, dork: dork.p, serper: serper.p };
    const a = await searchWithBudget(db, 'company_domain', { company: 'Acme' }, deps);
    expect(a.provider).toBe('browser-dork');
    expect(serper.calls).toHaveLength(0);
    const b = await searchWithBudget(db, 'company_domain', { company: 'Acme' }, deps);
    expect(b.provider).toBe('cache');
    expect(b.results[0].url).toBe('https://acme.io/');
    expect(dork.calls).toHaveLength(1);
    expect(searchStatus(db, deps).dork.today).toBe(1);
  });

  it('cache expires after SEARCH_CACHE_TTL_DAYS', async () => {
    const db = openDb(':memory:');
    const dork = fake('browser-dork', { results: [R('https://acme.io/')] });
    const env = { SEARCH_CACHE_TTL_DAYS: '2' };
    await searchWithBudget(db, 'company_domain', { company: 'Acme' }, { env, now: () => NOW, dork: dork.p });
    const later = new Date(NOW.getTime() + 3 * 86400_000);
    const r = await searchWithBudget(db, 'company_domain', { company: 'Acme' }, { env, now: () => later, dork: dork.p });
    expect(r.provider).toBe('browser-dork');
    expect(dork.calls).toHaveLength(2);
  });

  it('dork blocked falls to Serper and starts a cooldown that skips dork next time', async () => {
    const db = openDb(':memory:');
    const dork = fake('browser-dork', { results: [], blocked: true });
    const serper = fake('serper', { results: [R('https://acme.io/')] });
    const deps = { ...base, env: { SERPER_API_KEY: 'k' }, dork: dork.p, serper: serper.p };
    const a = await searchWithBudget(db, 'company_domain', { company: 'Acme' }, deps);
    expect(a.provider).toBe('serper');
    expect(a.reason).toContain('dork_blocked');
    expect(searchStatus(db, deps).dork.cooldownUntil).toBe(new Date(NOW.getTime() + 24 * 3600_000).toISOString());
    await searchWithBudget(db, 'careers_page', { domain: 'acme.io' }, deps);
    expect(dork.calls).toHaveLength(1); // second call skipped dork during the cooldown
    expect(serper.calls).toHaveLength(2);
    // cooldown ends
    const later = new Date(NOW.getTime() + 25 * 3600_000);
    await searchWithBudget(db, 'domain_emails', { domain: 'acme.io' }, { ...deps, now: () => later });
    expect(dork.calls).toHaveLength(2);
  });

  it('Serper is skipped at the daily budget and the usage row is asserted', async () => {
    const db = openDb(':memory:');
    const serper = fake('serper', { results: [R('https://acme.io/')] });
    const deps = { ...base, env: { SERPER_API_KEY: 'k', SERPER_DAILY_BUDGET: '2', DORK_ENABLED: 'false' }, serper: serper.p };
    await searchWithBudget(db, 'domain_emails', { domain: 'a1.io' }, deps);
    await searchWithBudget(db, 'domain_emails', { domain: 'a2.io' }, deps);
    const third = await searchWithBudget(db, 'domain_emails', { domain: 'a3.io' }, deps);
    expect(third.provider).toBe('none');
    expect(third.reason).toContain('serper_daily_budget');
    expect(serper.calls).toHaveLength(2);
    const row = db.prepare('SELECT count FROM search_usage WHERE day = ? AND provider = ?').get('2026-10-16', 'serper') as { count: number };
    expect(row.count).toBe(2);
  });

  it('Serper is skipped at the monthly budget', async () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO search_usage (day, provider, count) VALUES (?, ?, ?)').run('2026-10-02', 'serper', 5);
    const serper = fake('serper', { results: [R('https://acme.io/')] });
    const deps = { ...base, env: { SERPER_API_KEY: 'k', SERPER_MONTHLY_BUDGET: '5', DORK_ENABLED: 'false' }, serper: serper.p };
    const r = await searchWithBudget(db, 'domain_emails', { domain: 'a1.io' }, deps);
    expect(r.provider).toBe('none');
    expect(r.reason).toContain('serper_monthly_budget');
    expect(serper.calls).toHaveLength(0);
  });

  it('dork daily budget stops dorking', async () => {
    const db = openDb(':memory:');
    const dork = fake('browser-dork', { results: [] });
    const deps = { ...base, env: { DORK_DAILY_BUDGET: '1' }, dork: dork.p };
    await searchWithBudget(db, 'domain_emails', { domain: 'a1.io' }, deps);
    const r = await searchWithBudget(db, 'domain_emails', { domain: 'a2.io' }, deps);
    expect(r.reason).toContain('dork_budget');
    expect(dork.calls).toHaveLength(1);
  });

  it('no key and no dork returns provider none without throwing', async () => {
    const db = openDb(':memory:');
    const r = await searchWithBudget(db, 'company_domain', { company: 'Acme' }, { ...base, env: {} });
    expect(r).toEqual({ results: [], provider: 'none', reason: 'dork_unavailable,no_serper_key' });
  });

  it('invalid params never reach a provider', async () => {
    const db = openDb(':memory:');
    const dork = fake('browser-dork', { results: [R('https://x.io')] });
    const r = await searchWithBudget(db, 'company_domain', { company: 'a" OR site:evil.com' }, { ...base, env: {}, dork: dork.p });
    expect(r.reason).toBe('invalid_params');
    expect(dork.calls).toHaveLength(0);
  });

  it('a throwing dork executor falls through; the injected executor is what createDorkProvider runs', async () => {
    const db = openDb(':memory:');
    const seen: string[] = [];
    const dork = createDorkProvider(async (q, o) => { seen.push(`${o.kind}:${q}`); throw new Error('boom'); });
    const r = await searchWithBudget(db, 'careers_page', { domain: 'acme.io' }, { ...base, env: {}, dork });
    expect(seen).toEqual(['careers_page:site:acme.io (careers OR jobs)']);
    expect(r.reason).toContain('dork_error');
  });

  it('searchStatus reports numbers and never the key', () => {
    const db = openDb(':memory:');
    const s = searchStatus(db, { now: () => NOW, env: { SERPER_API_KEY: 'sekret-key-1', SERPER_DAILY_BUDGET: '7' } });
    expect(s.serper).toEqual({ keySet: true, today: 0, dailyBudget: 7, month: 0, monthlyBudget: 200 });
    expect(s.dork).toEqual({ enabled: true, today: 0, dailyBudget: 30, cooldownUntil: null });
    expect(JSON.stringify(s)).not.toContain('sekret');
  });
});

describe('createSerperProvider', () => {
  it('maps organic results and swallows errors', async () => {
    const ok = createSerperProvider('k', async () => ({ ok: true, json: async () => ({ organic: [{ title: 'A', snippet: 'B', link: 'https://acme.io' }, { title: 'no link' }] }) }));
    expect((await ok.search('q', { kind: 'company_domain' })).results).toEqual([{ title: 'A', snippet: 'B', url: 'https://acme.io' }]);
    const bad = createSerperProvider('k', async () => { throw new Error('net'); });
    expect((await bad.search('q', { kind: 'company_domain' })).results).toEqual([]);
  });
});
