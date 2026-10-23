import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { checkShape } from '../src/sources/shape.js';
import type { Provider } from '../src/sources/runner.js';
import type { TrackedCompany } from '../src/sources/boards/filters.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('checkShape', () => {
  const spec = z.object({ id: z.number(), title: z.string() }).passthrough();
  it('is ok for matching items and the hash ignores values and item order', () => {
    const a = checkShape(spec, [{ id: 1, title: 'a', extra: { x: 1 } }, { id: 2, title: 'b' }]);
    const b = checkShape(spec, [{ id: 2, title: 'b' }, { extra: { x: 9 }, id: 1, title: 'zzz' }]);
    expect(a.ok).toBe(true);
    expect(a.problems).toEqual([]);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(b.hash);
  });
  it('a renamed key is a problem and changes the hash', () => {
    const good = checkShape(spec, [{ id: 1, title: 'a' }]);
    const bad = checkShape(spec, [{ id: 1, name: 'a' }]);
    expect(bad.ok).toBe(false);
    expect(bad.problems.join(' ')).toContain('title');
    expect(bad.hash).not.toBe(good.hash);
  });
  it('never puts item values into the problems', () => {
    const r = checkShape(spec, [{ id: 'SECRET-VALUE', title: 'a' }]);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).not.toContain('SECRET-VALUE');
  });
  it('only looks at the first 5 items', () => {
    const items = [...Array.from({ length: 5 }, (_, i) => ({ id: i, title: 't' })), { nope: true }];
    expect(checkShape(spec, items).ok).toBe(true);
  });
  it('an empty sample is ok and has an empty hash (nothing to compare)', () => {
    expect(checkShape(spec, [])).toEqual({ ok: true, hash: '', problems: [] });
  });
});

const company = (ats: string, extra: Partial<TrackedCompany> = {}): TrackedCompany => ({ name: 'Acme', ats, slug: 'acme', enabled: true, ...extra } as TrackedCompany);
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
const xml = (s: string) => new Response(s, { status: 200 });

async function boardCase(mod: string, c: TrackedCompany, respond: (url: string) => Response): Promise<{ provider: Provider; sample: unknown[] }> {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => respond(String(url))));
  const { provider } = (await import(mod)) as { provider: Provider };
  const r = await provider.fetch({ company: c });
  return { provider, sample: r.sample };
}

describe('every ported board provider accepts a fixture of its own format', () => {
  const cases: Array<[string, string, TrackedCompany, (url: string) => Response]> = [
    ['greenhouse', '../src/sources/boards/greenhouse.js', company('greenhouse'), () => json({ jobs: [{ id: 1, title: 'Frontend Engineer', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1', location: { name: 'Bengaluru' }, content: 'x' }] })],
    ['lever', '../src/sources/boards/lever.js', company('lever'), () => json([{ id: 'abc-1', text: 'Frontend', hostedUrl: 'https://jobs.lever.co/acme/abc-1', categories: { location: 'Remote' }, descriptionPlain: 'x' }])],
    ['ashby', '../src/sources/boards/ashby.js', company('ashby'), () => json({ jobs: [{ id: 'abc-1', title: 'Frontend', location: 'Remote', jobUrl: 'https://jobs.ashbyhq.com/acme/abc-1', descriptionPlain: 'x' }] })],
    ['workable', '../src/sources/boards/workable.js', company('workable'), () => json({ jobs: [{ title: 'Frontend', shortcode: 'ABC123', city: 'Pune', country: 'India', description: 'x' }] })],
    ['recruitee', '../src/sources/boards/recruitee.js', company('recruitee'), () => json({ offers: [{ id: 5, title: 'Frontend', slug: 'frontend', description: 'x' }] })],
    ['personio', '../src/sources/boards/personio.js', company('personio'), () => xml('<workzag-jobs><position><id>12</id><name>Frontend</name><office>Berlin</office><createdAt>2026-10-01</createdAt></position></workzag-jobs>')],
    ['smartrecruiters', '../src/sources/boards/smartrecruiters.js', company('smartrecruiters'), (u) => (u.includes('/postings/') && !u.includes('?') ? json({}) : json({ content: [{ id: '743999', name: 'Frontend', location: { city: 'Pune', country: 'in' } }], totalFound: 1 }))],
    ['workday', '../src/sources/boards/workday.js', company('workday', { wd: 'wd5', site: 'External' } as any), () => json({ total: 1, jobPostings: [{ title: 'Frontend', externalPath: '/job/Remote/Frontend_R1', locationsText: 'Remote', postedOn: 'Posted Today' }] })],
    ['hackernews', '../src/sources/boards/hackernews.js', company('hackernews'), (u) => (u.includes('/items/') ? json({ children: [] }) : json({ hits: [{ author: 'whoishiring', objectID: '123', title: 'Ask HN: Who is hiring? (October 2026)', created_at_i: Math.floor(Date.now() / 1000) }] }))],
    ['himalayas', '../src/sources/boards/himalayas.js', company('himalayas'), () => json({ jobs: [{ title: 'Frontend', companyName: 'Acme', applicationLink: 'https://himalayas.app/jobs/x', description: 'x', locationRestrictions: [] }] })],
    ['weworkremotely', '../src/sources/boards/weworkremotely.js', company('weworkremotely'), () => xml('<rss><channel><item><title>Acme: Frontend</title><link>https://weworkremotely.com/remote-jobs/acme-frontend</link><description>x</description></item></channel></rss>')],
  ];
  for (const [name, mod, c, respond] of cases) {
    it(name, async () => {
      const { provider, sample } = await boardCase(mod, c, respond);
      expect(provider.id).toBe(name);
      expect(sample.length).toBeGreaterThan(0);
      const rep = checkShape(provider.shapeSpec, sample);
      expect(rep.problems).toEqual([]);
      expect(rep.ok).toBe(true);
      expect(rep.hash).not.toBe('');
    });
  }

  it('a renamed key in the greenhouse payload fails the shape', async () => {
    const { provider, sample } = await boardCase('../src/sources/boards/greenhouse.js', company('greenhouse'), () => json({ jobs: [{ id: 1, name: 'Frontend Engineer', location: { name: 'x' } }] }));
    expect(checkShape(provider.shapeSpec, sample).ok).toBe(false);
  });
  it('a renamed envelope key fails the shape instead of looking like an empty board', async () => {
    const { provider, sample } = await boardCase('../src/sources/boards/greenhouse.js', company('greenhouse'), () => json({ postings: [{ id: 1, title: 'x' }] }));
    expect(checkShape(provider.shapeSpec, sample).ok).toBe(false);
  });
  it('a genuinely empty board is ok with nothing to compare', async () => {
    const { provider, sample } = await boardCase('../src/sources/boards/greenhouse.js', company('greenhouse'), () => json({ jobs: [] }));
    expect(checkShape(provider.shapeSpec, sample)).toEqual({ ok: true, hash: '', problems: [] });
  });
});

describe('ported API providers', () => {
  it('remotive', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ jobs: [{ id: 3, title: 'Dev', company_name: 'Co', url: 'https://remotive.com/x', description: 'd', publication_date: '2026-10-01' }] })));
    const { provider } = await import('../src/sources/remotive.js');
    const r = await provider.fetch({ params: { role: 'dev' } });
    expect(checkShape(provider.shapeSpec, r.sample).ok).toBe(true);
  });
  it('remoteok skips the legal-notice first element', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json([{ legal: 'terms' }, { id: '1', slug: 'dev', position: 'React Dev', company: 'Co', url: 'https://remoteok.com/x', tags: ['react'] }])));
    const { provider } = await import('../src/sources/remoteok.js');
    const r = await provider.fetch({});
    expect(r.jobs).toHaveLength(1);
    expect(r.sample).toHaveLength(1);
    expect(checkShape(provider.shapeSpec, r.sample).ok).toBe(true);
  });
  it('naukri card spec accepts scraped cards and rejects a changed card shape', async () => {
    const { shapeSpec, provider } = await import('../src/sources/naukri.js');
    expect(provider.id).toBe('naukri');
    const card = { titleText: 'Dev', companyText: 'Co', hrefRaw: 'https://www.naukri.com/job-listings-dev-co-1', descriptionText: 'd' };
    expect(checkShape(shapeSpec, [card]).ok).toBe(true);
    expect(checkShape(shapeSpec, [{ title: 'Dev', href: 'x' }]).ok).toBe(false);
  });
});
