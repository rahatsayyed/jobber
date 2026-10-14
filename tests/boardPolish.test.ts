import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchRecruitee, normalizeRecruitee } from '../src/sources/boards/recruitee.js';
import { fetchPersonio, normalizePersonioXml } from '../src/sources/boards/personio.js';
import { normalizeWorkable } from '../src/sources/boards/workable.js';
import { fetchWorkday, validExternalPath } from '../src/sources/boards/workday.js';
import { fetchHackerNews, normalizeHnThread, resolveLatestThread, resolveLatestThreadId, sanitizeCompany } from '../src/sources/boards/hackernews.js';
import { settleBoard } from '../src/sources/boards/greenhouse.js';
import { extraConfigProblem } from '../src/sources/boards/filters.js';

afterEach(() => vi.unstubAllGlobals());
const rc = { name: 'Acme', ats: 'recruitee' as const, slug: 'acme', enabled: true };
const pe = { name: 'Acme GmbH', ats: 'personio' as const, slug: 'acme', enabled: true };
const wk = { name: 'Acme', ats: 'workable' as const, slug: 'acme', enabled: true };
const wd = { name: 'Acme', ats: 'workday' as const, slug: 'acme', wd: 'wd5', site: 'External', enabled: true };
const hn = { name: 'HN', ats: 'hackernews' as const, slug: 'whoishiring', enabled: true };

describe('polish: description warnings (recruitee, personio)', () => {
  it('recruitee warns once per board with N of M when postings have no description', () => {
    const warn = vi.fn();
    normalizeRecruitee({ offers: [{ id: 1, title: 'a', description: 'x' }, { id: 2, title: 'b' }, { id: 3, title: 'c', description: '' }] }, rc, { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^2 of 3 postings had no description/);
    const quiet = vi.fn();
    normalizeRecruitee({ offers: [{ id: 1, title: 'a', description: 'x' }] }, rc, { warn: quiet });
    expect(quiet).not.toHaveBeenCalled();
  });
  it('personio warns once per board, also through fetchPersonio', async () => {
    const xml = '<workzag-jobs><position><id>1</id><name>A</name></position><position><id>2</id><name>B</name><jobDescriptions><jobDescription><value>hi</value></jobDescription></jobDescriptions></position></workzag-jobs>';
    const warn = vi.fn();
    normalizePersonioXml(xml, pe, { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^1 of 2 postings had no description/);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(xml, { status: 200 })));
    const w2 = vi.fn();
    expect((await settleBoard(fetchPersonio, pe, { warn: w2 })).warnings).toHaveLength(1);
    expect(w2).toHaveBeenCalledTimes(1);
  });
  it('recruitee fetch passes ctx through', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ offers: [{ id: 1, title: 'a' }] }), { status: 200 })));
    expect((await settleBoard(fetchRecruitee, rc)).warnings).toHaveLength(1);
  });
});

describe('polish: vendor URL strictness, safe ids, dates, empty locations', () => {
  it('workable and recruitee fall back to canonical for ports and upper-case hosts', () => {
    const w = normalizeWorkable({ jobs: [
      { title: 'a', shortcode: 'AAA', shortlink: 'https://apply.workable.com:8443/x', url: 'https://apply.workable.com:443/y' },
      { title: 'b', shortcode: 'BBB', shortlink: 'https://APPLY.workable.com/x', url: 'https://Apply.Workable.com/y' },
    ] }, wk);
    expect(w.map((j) => j.url)).toEqual(['https://apply.workable.com/acme/j/AAA/', 'https://apply.workable.com/acme/j/BBB/']);
    const r = normalizeRecruitee({ offers: [
      { id: 1, title: 'a', slug: 'x', careers_url: 'https://acme.recruitee.com:8443/o/x', url: 'https://ACME.recruitee.com/o/x' },
    ] }, rc);
    expect(r[0].url).toBe('https://acme.recruitee.com/o/x');
    expect(r[0].apply_url).toBe('https://acme.recruitee.com/o/x');
    expect(normalizeRecruitee({ offers: [{ id: 1, title: 'a', slug: 'x', careers_url: 'https://acme.recruitee.com/o/other' }] }, rc)[0].url).toBe('https://acme.recruitee.com/o/other');
  });
  it('recruitee: unsafe integer ids use the hashed id', () => {
    const [j] = normalizeRecruitee({ offers: [{ id: 2 ** 60, title: 'a' }] }, rc);
    expect(j.id).toMatch(/^rc:acme:[0-9a-f]{12}$/);
  });
  it('workable reads a "UTC" suffixed published_on', () => {
    const [j] = normalizeWorkable({ jobs: [{ title: 'a', shortcode: 'A1', published_on: '2026-10-02 08:00:00 UTC' }] }, wk);
    expect(j.posted_at).toBe('2026-10-02');
  });
  it('empty locations are [] not [""] in workable, recruitee and personio', () => {
    expect(normalizeWorkable({ jobs: [{ title: 'a', shortcode: 'A1' }] }, wk)[0].locations).toEqual([]);
    expect(normalizeRecruitee({ offers: [{ id: 1, title: 'a' }] }, rc)[0].locations).toEqual([]);
    expect(normalizePersonioXml('<workzag-jobs><position><id>1</id><name>A</name></position></workzag-jobs>', pe)[0].locations).toEqual([]);
  });
});

describe('polish: domain config only validated for personio', () => {
  it('a bad domain is a config problem only for personio', () => {
    expect(extraConfigProblem({ ats: 'personio', domain: 'fr' })).toMatch(/domain/);
    expect(extraConfigProblem({ ats: 'greenhouse', domain: 'fr' })).toBeNull();
    expect(extraConfigProblem({ ats: 'workable', domain: 5 })).toBeNull();
    expect(extraConfigProblem({ ats: 'personio', domain: 'com' })).toBeNull();
  });
});

describe('polish: workday', () => {
  it('re-validates wd and site inside fetchWorkday before any request', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    for (const bad of [{ wd: 'wd5.evil.io' }, { wd: 'WD5' }, { site: 'a/b' }, { site: '-x' }, { site: 'x'.repeat(41) }]) {
      expect((await settleBoard(fetchWorkday, { ...wd, ...bad })).error).toBe('workday acme: invalid wd or site');
    }
    expect(f).not.toHaveBeenCalled();
  });
  it('rejects percent-encoded dots and slashes in any case', () => {
    expect(validExternalPath('/job/Pune/Dev_R-1')).toBe(true);
    for (const p of ['/job/%2e%2e/x', '/job/a%2Fb', '/job/a%2fb', '/job/a%2E/b', '/job/%2E%2e/x']) expect(validExternalPath(p)).toBe(false);
  });
  it('a posting with no location anywhere gets [] locations', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init: any) => {
      if (init.method === 'POST') return new Response(JSON.stringify({ total: 1, jobPostings: [{ title: 'Dev', externalPath: '/job/x/Dev_R-1' }] }), { status: 200 });
      return new Response(JSON.stringify({ jobPostingInfo: { jobDescription: '<p>hi</p>' } }), { status: 200 });
    }));
    const r = await settleBoard(fetchWorkday, wd);
    expect(r.error).toBeNull();
    expect(r.jobs[0].locations).toEqual([]);
  });
});

describe('polish: hackernews', () => {
  it('sanitizeCompany strips quotes, operators, parentheses, control and invisible chars', () => {
    expect(sanitizeCompany('Acme "Corp"')).toBe('Acme Corp');
    expect(sanitizeCompany('Acme site:evil.com')).toBe('Acme evil.com');
    expect(sanitizeCompany('Acme inurl:admin OR Globex AND Initech')).toBe('Acme admin Globex Initech');
    expect(sanitizeCompany('-Acme (YC S21) -foo')).toBe('Acme YC S21 foo');
    expect(sanitizeCompany('Ac​me\u0007 Inc')).toBe('Acme Inc');
    expect(sanitizeCompany('Acme Москва')).toBeNull();
    expect(sanitizeCompany('Acmе')).toBeNull();
    expect(sanitizeCompany('Москва')).toBe('Москва');
    expect(sanitizeCompany('"" ()')).toBeNull();
    expect(sanitizeCompany('a'.repeat(101))).toBeNull();
  });
  it('drops a posting with an unsafe company (counted in one warning) and unsafe comment ids', () => {
    const warn = vi.fn();
    const mk = (id: number, text: string) => ({ id, text, created_at: '2026-10-02T10:00:00.000Z' });
    const out = normalizeHnThread({ children: [mk(1, 'Good Co | Dev | Remote'), mk(2, '"" | Dev | Remote'), mk(3, 'Acme Москва | Dev | Remote'), mk(2 ** 60, 'Big | Dev | Remote')] }, hn, { warn });
    expect(out.map((j) => j.company)).toEqual(['Good Co']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^2 posting\(s\) dropped/);
  });
  it('anchors the title, requires the whoishiring author, and reports thread age', () => {
    const h = (o: Record<string, unknown>) => ({ hits: [{ objectID: '123', author: 'whoishiring', title: 'Ask HN: Who is hiring? (October 2026)', ...o }] });
    expect(resolveLatestThreadId(h({}))).toBe('123');
    expect(resolveLatestThreadId(h({ title: 'Re: Ask HN: Who is hiring? scam' }))).toBeNull();
    expect(resolveLatestThreadId(h({ title: 'Why Ask HN: Who is hiring? is great' }))).toBeNull();
    expect(resolveLatestThreadId(h({ author: 'someone' }))).toBeNull();
    expect(resolveLatestThreadId(h({ author: undefined }))).toBeNull();
    const now = Date.parse('2026-10-20T00:00:00Z');
    expect(resolveLatestThread(h({ created_at_i: Date.parse('2026-10-10T00:00:00Z') / 1000 }), now)?.ageDays).toBe(10);
  });
  it('warns when the newest thread is older than 45 days, not otherwise', async () => {
    const hits = (secs: number) => ({ hits: [{ objectID: '9', author: 'whoishiring', title: 'Ask HN: Who is hiring? (May 2020)', created_at_i: secs }] });
    const run = async (secs: number) => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => new Response(JSON.stringify(url.includes('search_by_date') ? hits(secs) : { children: [] }), { status: 200 })));
      const warn = vi.fn();
      await fetchHackerNews(hn, { warn });
      return warn;
    };
    const old = await run(Math.floor(Date.now() / 1000) - 60 * 86400);
    expect(old).toHaveBeenCalledTimes(1);
    expect(old.mock.calls[0][0]).toMatch(/60 days old/);
    expect(await run(Math.floor(Date.now() / 1000) - 5 * 86400)).not.toHaveBeenCalled();
  });
  it('falls back to created_at_i when created_at is present but invalid', () => {
    const [j] = normalizeHnThread({ children: [{ id: 1, text: 'Co | Dev | Remote', created_at: 'garbage', created_at_i: Date.parse('2026-10-03T12:00:00Z') / 1000 }] }, hn);
    expect(j.posted_at).toBe('2026-10-03');
  });
  it('warns when more than half of more than ten comments are not postings', async () => {
    const children = [
      ...Array.from({ length: 3 }, (_, i) => ({ id: i + 1, text: `Co${i} | Dev | Remote`, created_at: '2026-10-02T10:00:00.000Z' })),
      ...Array.from({ length: 9 }, (_, i) => ({ id: 100 + i, text: 'just prose without a header' })),
    ];
    const search = { hits: [{ objectID: '9', author: 'whoishiring', title: 'Ask HN: Who is hiring?' }] };
    const go = async (kids: unknown[]) => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => new Response(JSON.stringify(url.includes('search_by_date') ? search : { children: kids }), { status: 200 })));
      const warn = vi.fn();
      await fetchHackerNews(hn, { warn });
      return warn;
    };
    const w = await go(children);
    expect(w).toHaveBeenCalledTimes(1);
    expect(w.mock.calls[0][0]).toMatch(/^9 of 12 top-level comments were not parsed/);
    expect(await go(children.slice(0, 3).concat(children.slice(3, 6)))).not.toHaveBeenCalled();
    expect(await go(children.slice(0, 11).map((c, i) => (i < 8 ? { ...children[0], id: 500 + i } : c)))).not.toHaveBeenCalled();
  });
});
