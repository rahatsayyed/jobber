import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../src/db.js';
import { createGooglePseProvider } from '../src/search/googlePse.js';
import { createTavilyProvider } from '../src/search/tavily.js';
import { searchWithBudget, searchStatus, type SearchProvider } from '../src/search/index.js';
import { usageToday } from '../src/search/budget.js';

const NOW = new Date('2026-11-02T10:00:00Z');
const prov = (id: SearchProvider['id'], url: string) => {
  const search = vi.fn(async () => ({ results: [{ title: 't', snippet: 's', url }] }));
  return { p: { id, search } as SearchProvider, search };
};

describe('google_pse and tavily providers', () => {
  it('google_pse maps items and puts key and cx in the query', async () => {
    const f = vi.fn(async (_u: string) => ({ ok: true, json: async () => ({ items: [{ title: 'A', snippet: 'B', link: 'https://x.example/a' }, { title: 'no link' }] }) }));
    const out = await createGooglePseProvider('K1', 'CX1', f).search('q w', { kind: 'linkedin_people' });
    expect(out.results).toEqual([{ title: 'A', snippet: 'B', url: 'https://x.example/a' }]);
    const u = new URL(f.mock.calls[0]![0]);
    expect(u.origin + u.pathname).toBe('https://www.googleapis.com/customsearch/v1');
    expect(u.searchParams.get('cx')).toBe('CX1');
    expect(u.searchParams.get('num')).toBe('10');
  });

  it('tavily maps results, uses bearer auth and a POST body', async () => {
    const f = vi.fn(async (_u: string, _i: { method: string; headers: Record<string, string>; body: string }) => ({
      ok: true, json: async () => ({ results: [{ title: 'A', content: 'C', url: 'https://x.example/a' }] }),
    }));
    const out = await createTavilyProvider('TK', f).search('q', { kind: 'linkedin_people' });
    expect(out.results).toEqual([{ title: 'A', snippet: 'C', url: 'https://x.example/a' }]);
    const init = f.mock.calls[0]![1];
    expect(init.headers.Authorization).toBe('Bearer TK');
    expect(JSON.parse(init.body)).toEqual({ query: 'q', max_results: 10 });
  });

  it('failed http or a thrown fetch gives no results', async () => {
    expect((await createTavilyProvider('K', async () => ({ ok: false, json: async () => ({}) })).search('q', { kind: 'jobs_site' })).results).toEqual([]);
    expect((await createGooglePseProvider('K', 'C', async () => { throw new Error('x'); }).search('q', { kind: 'jobs_site' })).results).toEqual([]);
  });
});

describe('searchWithBudget with the new providers', () => {
  const params = { company: 'Acme Robotics', category: 'recruiter' as const };

  it('layered google_pse with no key is skipped with no_google_pse_key', async () => {
    const db = openDb(':memory:');
    const out = await searchWithBudget(db, 'linkedin_people', params, {
      env: {}, now: () => NOW, skip: { dork: true, tavily: true, serper: true },
    });
    expect(out.provider).toBe('none');
    expect(out.reason).toContain('no_google_pse_key');
  });

  it('layered google_pse counts usage and returns its results', async () => {
    const db = openDb(':memory:');
    const g = prov('google_pse', 'https://www.linkedin.com/in/a-b');
    const out = await searchWithBudget(db, 'linkedin_people', params, {
      env: {}, now: () => NOW, google_pse: g.p, skip: { dork: true, tavily: true, serper: true },
    });
    expect(out.provider).toBe('google_pse');
    expect(usageToday(db, 'google_pse', NOW)).toBe(1);
  });

  it('daily budget stops google_pse (default 90) and tavily (default 30)', async () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 30; i++) db.prepare("INSERT INTO search_usage (day, provider, count) VALUES ('2026-11-02','tavily',30) ON CONFLICT(day, provider) DO NOTHING").run();
    const t = prov('tavily', 'https://www.linkedin.com/in/a-b');
    const out = await searchWithBudget(db, 'linkedin_people', params, {
      env: {}, now: () => NOW, tavily: t.p, skip: { dork: true, google_pse: true, serper: true },
    });
    expect(out.reason).toContain('tavily_daily_budget');
    expect(t.search).not.toHaveBeenCalled();
    expect(searchStatus(db, { env: {}, now: () => NOW }).tavily.dailyBudget).toBe(30);
    expect(searchStatus(db, { env: {}, now: () => NOW }).google_pse.dailyBudget).toBe(90);
  });

  it('implicit chain falls from an empty dork to google_pse, and status never leaks keys', async () => {
    const db = openDb(':memory:');
    const g = prov('google_pse', 'https://x.example/a');
    const env = { GOOGLE_PSE_API_KEY: 'SECRETKEY', GOOGLE_PSE_CX: 'CX' };
    const out = await searchWithBudget(db, 'company_domain', { company: 'Acme' }, { env, now: () => NOW, google_pse: g.p });
    expect(out.provider).toBe('google_pse');
    const st = searchStatus(db, { env, now: () => NOW });
    expect(st.google_pse.keySet).toBe(true);
    expect(JSON.stringify(st)).not.toContain('SECRETKEY');
  });
});
