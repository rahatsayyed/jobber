import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWorkday, parsePostedOn, validExternalPath } from '../src/sources/boards/workday.js';
import { settleBoard } from '../src/sources/boards/greenhouse.js';
import { FETCHERS } from '../src/sources/boards/registry.js';
import { loadPortals } from '../src/sources/boards/filters.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

afterEach(() => vi.unstubAllGlobals());
const company = { name: 'Acme', ats: 'workday' as const, slug: 'acme', wd: 'wd5', site: 'External', enabled: true };
const BASE = 'https://acme.wd5.myworkdayjobs.com';
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });

// Shapes read from career-ops providers/workday.mjs (list) and its detail helpers (jobPostingInfo.location, additionalLocations, startDate);
// jobDescription is read by career-ops browser-extract.mjs.
const posting = (n: number, over: Record<string, unknown> = {}) => ({ title: `Frontend Engineer ${n}`, externalPath: `/job/Bengaluru/Frontend-Engineer-${n}_R-${1000 + n}`, locationsText: 'Bengaluru', postedOn: 'Posted 5 Days Ago', ...over });
const detailFor = (n: number) => ({ jobPostingInfo: { jobDescription: `<p>Build <b>React</b> apps ${n}</p>`, location: 'Bengaluru, India', additionalLocations: ['Pune, India'], startDate: '2026-10-03' } });

/** Routes list POSTs and detail GETs; records every call. */
function stub(listPages: any[], details: (path: string) => Response = (p) => json(detailFor(Number(/-(\d+)_R/.exec(p)?.[1] ?? 0)))) {
  const calls: Array<{ url: string; init: any }> = [];
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init: any) => {
    calls.push({ url, init });
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      return json(listPages[body.offset / 20] ?? { total: 0, jobPostings: [] });
    }
    return details(url.slice(`${BASE}/wday/cxs/acme/External`.length));
  }));
  return calls;
}

describe('parsePostedOn / validExternalPath', () => {
  it('turns relative labels into days and leaves unbounded or unknown labels undated', () => {
    const now = Date.UTC(2026, 9, 13, 12);
    expect(parsePostedOn('Posted Today', now)).toBe('2026-10-13');
    expect(parsePostedOn('Posted Yesterday', now)).toBe('2026-10-12');
    expect(parsePostedOn('Posted 5 Days Ago', now)).toBe('2026-10-08');
    expect(parsePostedOn('Posted 30+ Days Ago', now)).toBeUndefined();
    expect(parsePostedOn(undefined, now)).toBeUndefined();
    expect(parsePostedOn('Soon', now)).toBeUndefined();
  });
  it('accepts only plain job paths', () => {
    expect(validExternalPath('/job/Bengaluru/Frontend-Engineer_R-1000')).toBe(true);
    expect(validExternalPath('/job/US-CA-San-Jose/Dev---Remote_JR1-2')).toBe(true);
    for (const bad of ['/other/x', 'job/x', '/job/', '/job/a/../b', '/job/a?x=1', '/job/a#x', 'https://evil.example/job/x', '/job//x', '/job/a b', `/job/${'a'.repeat(400)}`, 5, null]) expect(validExternalPath(bad)).toBe(false);
  });
});

describe('fetchWorkday', () => {
  it('lists with the CXS POST body, details each wanted posting, and maps discover-only board jobs', async () => {
    const calls = stub([{ total: 2, jobPostings: [posting(1), posting(2)] }]);
    const jobs = await fetchWorkday(company, {});
    expect(calls[0].url).toBe(`${BASE}/wday/cxs/acme/External/jobs`);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.redirect).toBe('error');
    expect(JSON.parse(calls[0].init.body)).toEqual({ limit: 20, offset: 0, searchText: '', appliedFacets: {} });
    expect(calls[0].init.headers.Origin).toBe(BASE);
    expect(calls[0].init.headers.Referer).toBe(`${BASE}/External/`);
    expect(calls[0].init.headers['User-Agent']).toMatch(/jobber/);
    expect(calls.slice(1).map((c) => c.url)).toEqual([
      `${BASE}/wday/cxs/acme/External/job/Bengaluru/Frontend-Engineer-1_R-1001`,
      `${BASE}/wday/cxs/acme/External/job/Bengaluru/Frontend-Engineer-2_R-1002`,
    ]);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toEqual({
      id: expect.stringMatching(/^wd:acme:External:[0-9a-f]{12}$/), source: 'workday', title: 'Frontend Engineer 1', company: 'Acme',
      url: `${BASE}/External/job/Bengaluru/Frontend-Engineer-1_R-1001`, apply_url: `${BASE}/External/job/Bengaluru/Frontend-Engineer-1_R-1001`,
      description: 'Build React apps 1', posted_at: '2026-10-03', locations: ['Bengaluru, India', 'Pune, India'], remote: false,
    });
    expect(jobs[0].id).not.toBe(jobs[1].id);
  });
  it('passes the configured search text and falls back to the relative date when the detail has no startDate', async () => {
    const calls = stub([{ total: 1, jobPostings: [posting(1, { postedOn: 'Posted Today' })] }], () => json({ jobPostingInfo: { jobDescription: 'x', location: 'Remote - India' } }));
    const [j] = await fetchWorkday({ ...company, search: 'react' }, {});
    expect(JSON.parse(calls[0].init.body).searchText).toBe('react');
    expect(j.posted_at).toBe(new Date().toISOString().slice(0, 10));
    expect(j.remote).toBe(true);
  });
  it('filters BEFORE any detail request: title, known ids and a named non-matching location are never detailed; placeholders pass', async () => {
    const calls = stub([{ total: 5, jobPostings: [
      posting(1), posting(2, { title: 'Sales Manager' }), posting(3, { locationsText: 'Berlin' }), posting(4, { locationsText: '3 Locations' }), posting(5),
    ] }]);
    const known = new Set<string>();
    const ctx = {
      titleOk: (t: string) => !/manager/i.test(t),
      prefilter: (t: string, locs: string[]) => !/manager/i.test(t) && locs.every((l) => !/berlin/i.test(l)),
      isKnown: (id: string) => known.has(id),
    };
    // 5 is already stored: learn its id from a first pass, then run again with it marked known.
    const first = await fetchWorkday(company, ctx);
    expect(first.map((j) => j.title)).toEqual(['Frontend Engineer 1', 'Frontend Engineer 4', 'Frontend Engineer 5']);
    known.add(first[2].id);
    calls.length = 0;
    const second = await fetchWorkday(company, ctx);
    expect(second.map((j) => j.title)).toEqual(['Frontend Engineer 1', 'Frontend Engineer 4']);
    expect(calls.filter((c) => c.init.method === 'GET').map((c) => c.url.split('Frontend-Engineer-')[1].slice(0, 1))).toEqual(['1', '4']);
  });
  it('caps detail requests at max_detail and reports the deferred rest as a warning', async () => {
    const calls = stub([{ total: 6, jobPostings: [1, 2, 3, 4, 5, 6].map((n) => posting(n)) }]);
    const warn = vi.fn();
    const jobs = await fetchWorkday({ ...company, max_detail: 2 }, { warn });
    expect(jobs).toHaveLength(2);
    expect(calls.filter((c) => c.init.method === 'GET')).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith('partial: listed 6, 6 passed the prefilter, 2 returned; 4 posting(s) deferred to the next run (max_detail 2 or time budget)');
  });
  it('stops at the deadline: the first list page still runs, no detail does, and the postings are reported as deferred', async () => {
    const calls = stub([{ total: 2, jobPostings: [posting(1), posting(2)] }]);
    const warn = vi.fn();
    expect(await fetchWorkday(company, { deadlineAt: Date.now() - 1, warn })).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(warn.mock.calls[0][0]).toContain('2 posting(s) deferred');
  });
  it('does not return a posting whose detail failed (403 S22, 404, missing description) and says so', async () => {
    stub([{ total: 3, jobPostings: [posting(1), posting(2), posting(3)] }], (p) => {
      if (p.includes('-1_')) return json({ httpStatus: 403, errorCode: 'S22' }, 403);
      if (p.includes('-2_')) return new Response('', { status: 404 });
      return json({ jobPostingInfo: { location: 'x' } });
    });
    const warn = vi.fn();
    expect(await fetchWorkday(company, { warn })).toEqual([]);
    expect(warn.mock.calls[0][0]).toContain('3 detail request(s) failed (retried next run)');
  });
  it('paginates by 20 until a short page, honours total and max_pages, and stops on a repeated page (offset ceiling)', async () => {
    const full = (from: number) => Array.from({ length: 20 }, (_, i) => posting(from + i));
    let calls = stub([{ total: 45, jobPostings: full(0) }, { total: 45, jobPostings: full(20) }, { total: 45, jobPostings: [posting(40)] }]);
    const jobs = await fetchWorkday({ ...company, max_detail: 100 }, {});
    expect(calls.filter((c) => c.init.method === 'POST').map((c) => JSON.parse(c.init.body).offset)).toEqual([0, 20, 40]);
    expect(jobs).toHaveLength(41);
    calls = stub([{ total: 100, jobPostings: full(0) }, { total: 100, jobPostings: full(20) }, { total: 100, jobPostings: full(40) }]);
    await fetchWorkday({ ...company, max_pages: 2, max_detail: 1 }, {});
    expect(calls.filter((c) => c.init.method === 'POST')).toHaveLength(2);
    calls = stub([{ total: 5000, jobPostings: full(0) }, { total: 5000, jobPostings: full(0) }, { total: 5000, jobPostings: full(0) }]);
    const warn = vi.fn();
    await fetchWorkday({ ...company, max_detail: 1 }, { warn });
    expect(calls.filter((c) => c.init.method === 'POST')).toHaveLength(2);
    expect(warn.mock.calls[0][0]).toContain('page repeated, offset ceiling');
  });
  it('ignores postings with an unsafe externalPath or no title', async () => {
    const calls = stub([{ total: 4, jobPostings: [posting(1, { externalPath: '/job/a/../b' }), posting(2, { externalPath: 'https://evil.example/job/x' }), posting(3, { title: ' ' }), posting(4)] }]);
    expect((await fetchWorkday(company, {})).map((j) => j.title)).toEqual(['Frontend Engineer 4']);
    expect(calls.filter((c) => c.init.method === 'GET')).toHaveLength(1);
  });
  it('fails soft with labelled errors: shape, HTTP, missing config, bad tenant, non-vendor host never requested', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => json({ items: [] })));
    expect((await settleBoard(fetchWorkday, company)).error).toBe('workday acme: unexpected response shape (no jobPostings array)');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('x', { status: 422 })));
    expect((await settleBoard(fetchWorkday, company)).error).toBe('workday acme: HTTP 422');
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect((await settleBoard(fetchWorkday, { ...company, wd: undefined })).error).toBe('workday acme: config needs wd and site');
    expect((await settleBoard(fetchWorkday, { ...company, slug: 'acme.evil' })).error).toContain('invalid board slug');
    expect((await settleBoard(fetchWorkday, { ...company, wd: 'wd5.evil.io/x' })).error).toMatch(/host not allowed|invalid/);
    expect(f).not.toHaveBeenCalled();
  });
  it('is registered, and portals.json requires wd and site for workday entries', () => {
    expect(FETCHERS.workday).toBe(fetchWorkday);
    const f = path.join(mkdtempSync(path.join(tmpdir(), 'wd-')), 'portals.json');
    writeFileSync(f, JSON.stringify({
      tracked_companies: [
        { name: 'Ok', ats: 'workday', slug: 'ok', wd: 'wd3', site: 'Careers', enabled: true, max_detail: 10 },
        { name: 'NoSite', ats: 'workday', slug: 'nosite', wd: 'wd3', enabled: true },
        { name: 'BadWd', ats: 'workday', slug: 'badwd', wd: 'x', site: 'Careers', enabled: true },
      ],
      title_filter: { positive: ['frontend'], negative: [] }, location_filter: { allow: ['india'], global: ['remote'] },
    }));
    const r = loadPortals(f);
    expect(r.config?.tracked_companies).toEqual([{ name: 'Ok', ats: 'workday', slug: 'ok', enabled: true, wd: 'wd3', site: 'Careers', max_detail: 10 }]);
    expect(r.warnings).toEqual([
      'config/portals.json: tracked_companies[1] (NoSite) skipped: workday needs site (letters, digits, "_" and "-", at most 40)',
      'config/portals.json: tracked_companies[2] (BadWd) skipped: workday needs wd like "wd5"',
    ]);
  });
});
