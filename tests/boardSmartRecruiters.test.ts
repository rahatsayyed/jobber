import { describe, it, expect, vi, afterEach } from 'vitest';
import { descriptionFromDetail, fetchSmartRecruiters } from '../src/sources/boards/smartrecruiters.js';
import { settleBoard } from '../src/sources/boards/greenhouse.js';
import { FETCHERS } from '../src/sources/boards/registry.js';

afterEach(() => vi.unstubAllGlobals());
const company = { name: 'Acme', ats: 'smartrecruiters' as const, slug: 'AcmeCorp', enabled: true };
const ROOT = 'https://api.smartrecruiters.com/v1/companies/AcmeCorp/postings';
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });

// Shapes read from career-ops providers/smartrecruiters.mjs.
const item = (n: number, over: Record<string, unknown> = {}) => ({
  id: `7430000000${n}`, name: `Frontend Engineer ${n}`, ref: `${ROOT}/7430000000${n}`, refNumber: `REF${n}`, language: { code: 'en' },
  location: { fullLocation: 'Dubai, United Arab Emirates', city: 'Dubai', country: 'ae', remote: false }, ...over,
});
const detail = { jobAd: { sections: {
  companyDescription: { text: '<p>About <b>Acme</b></p>' }, jobDescription: { text: '<p>Build React apps &amp; more</p>' },
  qualifications: { text: '<ul><li>TypeScript</li></ul>' }, additionalInformation: { text: '' } } }, releasedDate: '2026-10-04T08:00:00.000Z' };

function stub(pages: any[][], details: (id: string) => Response = () => json(detail)) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init: any) => {
    calls.push(url);
    expect(init.redirect).toBe('error');
    const m = /\/postings\/([^?]+)$/.exec(url);
    if (m) return details(m[1]);
    const offset = Number(/offset=(\d+)/.exec(url)?.[1] ?? 0);
    return json({ content: pages[offset / 100] ?? [] });
  }));
  return calls;
}

describe('descriptionFromDetail', () => {
  it('joins the four sections in order as plain text and tolerates missing parts', () => {
    expect(descriptionFromDetail(detail)).toBe('About Acme\n\nBuild React apps & more\n\nTypeScript');
    expect(descriptionFromDetail({})).toBe('');
    expect(descriptionFromDetail({ jobAd: { sections: { jobDescription: { text: 5 } } } })).toBe('');
  });
});

describe('fetchSmartRecruiters', () => {
  it('lists with the public-status query, details each wanted posting, rewrites the public URL, maps location and date', async () => {
    const calls = stub([[item(1), item(2, { location: { city: 'Pune', region: 'MH', country: 'in', remote: true } })]]);
    const jobs = await fetchSmartRecruiters(company, {});
    expect(calls).toEqual([`${ROOT}?limit=100&offset=0&status=PUBLIC`, `${ROOT}/74300000001`, `${ROOT}/74300000002`]);
    expect(jobs[0]).toEqual({
      id: 'sr:AcmeCorp:74300000001', source: 'smartrecruiters', title: 'Frontend Engineer 1', company: 'Acme',
      url: 'https://jobs.smartrecruiters.com/AcmeCorp/74300000001-frontend-engineer-1', apply_url: 'https://jobs.smartrecruiters.com/AcmeCorp/74300000001-frontend-engineer-1',
      description: 'About Acme\n\nBuild React apps & more\n\nTypeScript', posted_at: '2026-10-04', locations: ['Dubai, United Arab Emirates'], remote: false,
    });
    expect(jobs[1].locations).toEqual(['Pune, MH, in, Remote']);
    expect(jobs[1].remote).toBe(true);
  });
  it('paginates by 100 until a short page and filters BEFORE details (title, location, stored ids)', async () => {
    const page0 = Array.from({ length: 100 }, (_, i) => item(i, i === 1 ? { name: 'Sales Manager' } : i === 2 ? { location: { fullLocation: 'Berlin, Germany' } } : {}));
    const calls = stub([page0, [item(100)]]);
    const known = new Set(['sr:AcmeCorp:74300000003']);
    const jobs = await fetchSmartRecruiters({ ...company, max_detail: 100 }, {
      titleOk: (t) => !/manager/i.test(t), prefilter: (t, locs) => !/manager/i.test(t) && !locs.some((l) => /berlin/i.test(l)), isKnown: (id) => known.has(id),
    });
    expect(calls.filter((u) => u.includes('offset=')).map((u) => /offset=(\d+)/.exec(u)![1])).toEqual(['0', '100']);
    const detailed = calls.filter((u) => /\/postings\/[^?]+$/.test(u));
    expect(detailed).toHaveLength(98);
    expect(jobs).toHaveLength(98);
    expect(jobs.map((j) => j.id)).not.toContain('sr:AcmeCorp:74300000001');
    expect(jobs.map((j) => j.id)).not.toContain('sr:AcmeCorp:74300000003');
  });
  it('caps details at max_detail (default 25) with a deferred warning, and stops at the deadline', async () => {
    stub([Array.from({ length: 40 }, (_, i) => item(i))]);
    const warn = vi.fn();
    expect(await fetchSmartRecruiters(company, { warn })).toHaveLength(25);
    expect(warn).toHaveBeenCalledWith('partial: listed 40, 40 passed the prefilter, 25 returned; 15 posting(s) deferred to the next run (max_detail 25 or time budget)');
    const calls = stub([[item(1), item(2)]]);
    const warn2 = vi.fn();
    expect(await fetchSmartRecruiters(company, { deadlineAt: Date.now() - 1, warn: warn2 })).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(warn2.mock.calls[0][0]).toContain('2 posting(s) deferred');
  });
  it('does not return a posting whose detail failed or had no description', async () => {
    stub([[item(1), item(2), item(3)]], (id) => (id.endsWith('1') ? new Response('', { status: 404 }) : id.endsWith('2') ? json({ jobAd: { sections: {} } }) : json(detail)));
    const warn = vi.fn();
    const jobs = await fetchSmartRecruiters(company, { warn });
    expect(jobs.map((j) => j.id)).toEqual(['sr:AcmeCorp:74300000003']);
    expect(warn.mock.calls[0][0]).toContain('2 detail request(s) failed or had no description');
  });
  it('warns once, with a count, when the slug is so long that every id exceeds the id cap', async () => {
    const long = { ...company, slug: 'a'.repeat(98) };
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => json({ content: [item(1), item(2), item(3)] })));
    const warn = vi.fn();
    expect(await fetchSmartRecruiters(long, { warn })).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('3 posting(s) dropped: id "sr:<slug>:<id>" exceeds 100 characters (slug too long)');
  });
  it('failed details are counted in the warning and stay retriable (not stored, spend max_detail again)', async () => {
    stub([[item(1), item(2)]], () => new Response('', { status: 500 }));
    const warn = vi.fn();
    expect(await fetchSmartRecruiters(company, { warn })).toEqual([]);
    expect(warn.mock.calls[0][0]).toContain('2 detail request(s) failed or had no description (not stored, so they are retried next run');
  });
  it('skips unsafe ids and unnamed postings, never uses the response ref for the URL', async () => {
    stub([[item(1, { id: '../x' }), item(2, { name: ' ' }), item(3, { ref: 'https://evil.example/x' }), null]]);
    const jobs = await fetchSmartRecruiters(company, {});
    expect(jobs.map((j) => j.url)).toEqual(['https://jobs.smartrecruiters.com/AcmeCorp/74300000003-frontend-engineer-3']);
  });
  it('fails soft: shape, HTTP, invalid slug (no request), and a later list page failing keeps the first page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => json({ results: [] })));
    expect((await settleBoard(fetchSmartRecruiters, company)).error).toBe('smartrecruiters AcmeCorp: unexpected response shape (no content array)');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => json({}, 404)));
    expect((await settleBoard(fetchSmartRecruiters, company)).error).toBe('smartrecruiters AcmeCorp: HTTP 404');
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect((await settleBoard(fetchSmartRecruiters, { ...company, slug: 'a.b' })).error).toContain('invalid board slug');
    expect(f).not.toHaveBeenCalled();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (/\/postings\/[^?]+$/.test(url)) return json(detail);
      return n++ === 0 ? json({ content: Array.from({ length: 100 }, (_, i) => item(i)) }) : new Response('x', { status: 500 });
    }));
    const warn = vi.fn();
    expect(await fetchSmartRecruiters({ ...company, max_detail: 3 }, { warn })).toHaveLength(3);
    expect(warn.mock.calls[0][0]).toContain('list stopped at page 1: HTTP 500');
    expect(FETCHERS.smartrecruiters).toBe(fetchSmartRecruiters);
  });
});
