import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchHimalayas, normalizeHimalayas } from '../src/sources/boards/himalayas.js';
import { fetchWeWorkRemotely, normalizeWwr, wwrDate } from '../src/sources/boards/weworkremotely.js';
import { settleBoard } from '../src/sources/boards/greenhouse.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extraConfigProblem, loadPortals, locationAllowed } from '../src/sources/boards/filters.js';
import { FETCHERS } from '../src/sources/boards/registry.js';
import { BOARD_SOURCES } from '../src/sources/boards/index.js';

afterEach(() => vi.unstubAllGlobals());
const hm = { name: 'Himalayas', ats: 'himalayas' as const, slug: 'himalayas', enabled: true };
const wwr = { name: 'We Work Remotely', ats: 'weworkremotely' as const, slug: 'weworkremotely', enabled: true };
const LOC = { allow: ['india'], global: ['remote', 'anywhere', 'worldwide', 'global'] };

// Shape read from career-ops providers/himalayas.mjs (description is an unverified extra).
const hmJob = (n: number, over: Record<string, unknown> = {}) => ({
  title: `React Engineer ${n}`, companyName: `Co ${n}`, companySlug: `co-${n}`, locationRestrictions: [],
  applicationLink: `https://himalayas.app/companies/co-${n}/jobs/react-engineer-${n}`, guid: `https://himalayas.app/companies/co-${n}/jobs/react-engineer-${n}`,
  pubDate: 1759400000, description: '<p>Build <b>React</b> apps</p>', ...over,
});

describe('normalizeHimalayas', () => {
  it('maps jobs: himalayas.app URL, hashed id, worldwide when unrestricted, epoch-seconds date, plain description', () => {
    const { jobs } = normalizeHimalayas({ jobs: [hmJob(1), hmJob(2, { locationRestrictions: ['India', 'United Arab Emirates'] })] }, hm);
    expect(jobs[0]).toEqual({
      id: expect.stringMatching(/^himalayas:[0-9a-f]{16}$/), source: 'himalayas', title: 'React Engineer 1', company: 'Co 1',
      url: 'https://himalayas.app/companies/co-1/jobs/react-engineer-1', apply_url: 'https://himalayas.app/companies/co-1/jobs/react-engineer-1',
      description: 'Build React apps', posted_at: '2025-10-02', locations: [''], remote: true,
    });
    expect(jobs[1].locations).toEqual(['India only', 'United Arab Emirates only']);
    expect(locationAllowed(jobs[0].locations, jobs[0].remote, LOC)).toBe(true);
    expect(locationAllowed(['United States'], true, LOC)).toBe(false);
  });
  it('never keeps a URL outside himalayas.app, skips postings without url, title, company or description and counts the description gap', () => {
    const r = normalizeHimalayas({ jobs: [
      hmJob(1, { applicationLink: 'https://evil.example.com/apply', guid: 'https://himalayas.app/jobs/ok-1' }),
      hmJob(2, { applicationLink: 'javascript:alert(1)', guid: 'http://himalayas.app/x' }),
      hmJob(3, { applicationLink: 'https://himalayas.app.evil.io/x', guid: 'https://user:p@himalayas.app/x' }),
      hmJob(4, { title: ' ' }), hmJob(5, { companyName: '' }), hmJob(6, { description: undefined }), null,
    ] }, hm);
    expect(r.jobs.map((j) => j.url)).toEqual(['https://himalayas.app/jobs/ok-1']);
    expect(r.noDescription).toBe(1);
    expect(normalizeHimalayas(null, hm).jobs).toEqual([]);
    expect(normalizeHimalayas({ jobs: Array.from({ length: 100000 }, (_, i) => hmJob(i)) }, hm).jobs).toHaveLength(2000);
  });
});

describe('fetchHimalayas', () => {
  const page = (from: number, n: number) => ({ jobs: Array.from({ length: n }, (_, i) => hmJob(from + i)) });
  it('requests ?limit=50 first (as career-ops does), then offsets, stopping on a short page', async () => {
    const f = vi.fn().mockImplementation(async (url: string) => new Response(JSON.stringify(url.includes('offset=50') ? page(50, 10) : page(0, 50)), { status: 200 }));
    vi.stubGlobal('fetch', f);
    expect(await fetchHimalayas(hm, {})).toHaveLength(60);
    expect(f.mock.calls.map((c) => c[0])).toEqual(['https://himalayas.app/jobs/api?limit=50', 'https://himalayas.app/jobs/api?limit=50&offset=50']);
    expect(f.mock.calls[0][1].redirect).toBe('error');
  });
  it('honours max_pages and stops with a warning when the offset is ignored (page repeats)', async () => {
    const f = vi.fn().mockImplementation(async () => new Response(JSON.stringify(page(0, 50)), { status: 200 }));
    vi.stubGlobal('fetch', f);
    const warn = vi.fn();
    expect(await fetchHimalayas({ ...hm, max_pages: 5 }, { warn })).toHaveLength(50);
    expect(f).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('paging stopped at page 1 (page repeated: offset not honoured?)');
    f.mockClear();
    await fetchHimalayas({ ...hm, max_pages: 1 }, {});
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('a whole page skipped for bad URLs is not a repeated page; only repeated feed identities warn', async () => {
    const bad = (n: number) => hmJob(n, { applicationLink: 'https://evil.example.com/x', guid: `https://evil.example.com/${n}` });
    const f = vi.fn().mockImplementation(async (url: string) => new Response(JSON.stringify(
      url.includes('offset=50') ? page(50, 10) : { jobs: Array.from({ length: 50 }, (_, i) => bad(i)) }), { status: 200 }));
    vi.stubGlobal('fetch', f);
    const warn = vi.fn();
    expect(await fetchHimalayas(hm, { warn })).toHaveLength(10);
    expect(f).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });
  it('a string, null, missing or mixed locationRestrictions is unknown: skipped and counted, never a bare global role', () => {
    const r = normalizeHimalayas({ jobs: [
      hmJob(1, { locationRestrictions: 'United States' }), hmJob(2, { locationRestrictions: null }), hmJob(3, { locationRestrictions: undefined }),
      hmJob(4, { locationRestrictions: ['India', 5] }), hmJob(5, { locationRestrictions: [] }),
    ] }, hm);
    expect(r.badRestrictions).toBe(4);
    expect(r.jobs.map((j) => j.title)).toEqual(['React Engineer 5']);
  });
  it('reports the skipped unknown-location postings in the fetch warning', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ jobs: [hmJob(1, { locationRestrictions: 'USA' }), hmJob(2)] }), { status: 200 })));
    const warn = vi.fn();
    expect(await fetchHimalayas(hm, { warn })).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith('1 posting(s) skipped: locationRestrictions missing or malformed (location unknown)');
  });
  it('rejects links with a port or an upper-case host', () => {
    const r = normalizeHimalayas({ jobs: [
      hmJob(1, { applicationLink: 'https://himalayas.app:443/jobs/a', guid: 'https://Himalayas.app/jobs/b' }),
      hmJob(2, { applicationLink: 'https://himalayas.app:8443/jobs/a', guid: 'https://himalayas.app/jobs/ok' }),
    ] }, hm);
    expect(r.jobs.map((j) => j.url)).toEqual(['https://himalayas.app/jobs/ok']);
  });
  it('a failing later page keeps the first page; a bad first page is a labelled error; descriptions missing are reported', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => (n++ === 0 ? new Response(JSON.stringify(page(0, 50)), { status: 200 }) : new Response('x', { status: 503 }))));
    const warn = vi.fn();
    expect(await fetchHimalayas(hm, { warn })).toHaveLength(50);
    expect(warn).toHaveBeenCalledWith('paging stopped at page 1: HTTP 503');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    expect((await settleBoard(fetchHimalayas, hm)).error).toBe('himalayas himalayas: unexpected response shape (no jobs array)');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ jobs: [hmJob(1, { description: undefined })] }), { status: 200 })));
    const warn2 = vi.fn();
    expect(await fetchHimalayas(hm, { warn: warn2 })).toEqual([]);
    expect(warn2).toHaveBeenCalledWith('1 posting(s) skipped: no description in the feed');
    expect(FETCHERS.himalayas).toBe(fetchHimalayas);
    expect(BOARD_SOURCES.has('himalayas')).toBe(false);
  });
});

// Shape read from career-ops providers/weworkremotely.mjs (title "Company: Role", link, pubDate, region, category); description is an unverified extra.
const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>We Work Remotely</title>
<item><title>Acme: Senior React Developer</title><region>Anywhere in the World</region><category>Programming</category><pubDate>Tue, 07 Oct 2026 12:00:00 +0000</pubDate>
<link>https://weworkremotely.com/remote-jobs/acme-senior-react-developer</link>
<description><![CDATA[<p>Build <b>React</b> apps &amp; more</p>]]></description></item>
<item><title>Globex: Full Stack Engineer &amp; Lead</title><region>USA Only</region><pubDate>Mon, 06 Oct 2026 09:00:00 +0000</pubDate>
<link>https://weworkremotely.com/remote-jobs/globex-full-stack</link><description>&lt;p&gt;Node and React&lt;/p&gt;</description></item>
<item><title>No company prefix</title><link>https://weworkremotely.com/remote-jobs/x</link><description>d</description></item>
<item><title>Evil: Dev</title><link>https://evil.example.com/remote-jobs/x</link><description>d</description></item>
<item><title>Hooli: Frontend</title><link>https://weworkremotely.com/remote-jobs/hooli</link></item>
<item><title>Initech: UI Dev</title><link>https://weworkremotely.com/remote-jobs/initech</link><description>Plain</description></item>
</channel></rss>`;

describe('normalizeWwr', () => {
  it('maps items: Company: Role split, worldwide vs restricted regions, date, plain description, wwr URL', () => {
    const { jobs, noDescription } = normalizeWwr(rss, wwr);
    expect(noDescription).toBe(1);
    expect(jobs.map((j) => j.title)).toEqual(['Senior React Developer', 'Full Stack Engineer & Lead', 'UI Dev']);
    expect(jobs[0]).toEqual({
      id: expect.stringMatching(/^wwr:[0-9a-f]{16}$/), source: 'weworkremotely', title: 'Senior React Developer', company: 'Acme',
      url: 'https://weworkremotely.com/remote-jobs/acme-senior-react-developer', apply_url: 'https://weworkremotely.com/remote-jobs/acme-senior-react-developer',
      description: 'Build React apps & more', posted_at: '2026-10-07', locations: ['Worldwide'], remote: true,
    });
    expect(jobs[1].locations).toEqual(['USA Only']);
    expect(jobs[1].description).toBe('Node and React');
    expect(jobs[2].locations).toEqual(['Unknown region']);
    expect(locationAllowed(jobs[0].locations, true, LOC)).toBe(true);
    expect(locationAllowed(jobs[1].locations, true, LOC)).toBe(false);
    expect(locationAllowed(jobs[2].locations, true, LOC)).toBe(false);
  });
  it('never maps a region with exclusion wording to bare Worldwide: the filter fails it', () => {
    const item = (region: string) => `<item><title>Acme: Dev</title><region>${region}</region><link>https://weworkremotely.com/remote-jobs/${encodeURIComponent(region).slice(0, 20)}</link><description>d</description></item>`;
    const regions = ['Worldwide (excl. India)', 'Anywhere in the World (excluding India)', 'Anywhere (but not India)', 'Worldwide, except India'];
    const { jobs } = normalizeWwr(`<rss><channel>${regions.map(item).join('')}</channel></rss>`, wwr);
    expect(jobs.map((j) => j.locations[0])).toEqual(['Worldwide (excl. India)', 'Anywhere in the World (excluding India)', 'Anywhere (excluding India)', 'Worldwide, except India']);
    for (const j of jobs) expect(locationAllowed(j.locations, true, LOC)).toBe(false);
    expect(locationAllowed(['Worldwide'], true, LOC)).toBe(true);
  });
  it('drops a date whose UTC day differs from the written day (31 Feb rollover, zone shift) or that has no readable day', () => {
    expect(wwrDate('Tue, 07 Oct 2026 12:00:00 +0000')).toBe('2026-10-07');
    expect(wwrDate('Sat, 31 Feb 2026 12:00:00 +0000')).toBeUndefined();
    expect(wwrDate('Tue, 07 Oct 2026 23:30:00 -0500')).toBeUndefined();
    expect(wwrDate('2026-10-07T12:00:00Z')).toBe('2026-10-07');
    expect(wwrDate('2026-02-31T12:00:00Z')).toBeUndefined();
    expect(wwrDate('garbage')).toBeUndefined();
    expect(wwrDate('')).toBeUndefined();
    const { jobs } = normalizeWwr(`<rss><channel><item><title>A: B</title><link>https://weworkremotely.com/x</link><pubDate>Sat, 31 Feb 2026 12:00:00 +0000</pubDate><description>d</description></item></channel></rss>`, wwr);
    expect(jobs[0]).not.toHaveProperty('posted_at');
  });
  it('rejects links with a port or an upper-case host', () => {
    const link = (u: string) => `<item><title>A: B</title><link>${u}</link><description>d</description></item>`;
    const { jobs } = normalizeWwr(`<rss><channel>${link('https://weworkremotely.com:443/a')}${link('https://WeWorkRemotely.com/b')}${link('https://weworkremotely.com/ok')}</channel></rss>`, wwr);
    expect(jobs.map((j) => j.url)).toEqual(['https://weworkremotely.com/ok']);
  });
  it('throws a labelled shape error for non-RSS and propagates xml errors', () => {
    expect(() => normalizeWwr('<html></html>', wwr)).toThrow('weworkremotely weworkremotely: unexpected response shape (no rss channel)');
    expect(() => normalizeWwr('<rss><channel>', wwr)).toThrow('xml: unclosed element');
  });
});

describe('fetchWeWorkRemotely', () => {
  it('fetches the single feed URL with an xml accept header and reports skipped postings as a warning', async () => {
    const f = vi.fn().mockImplementation(async () => new Response(rss, { status: 200 }));
    vi.stubGlobal('fetch', f);
    const warn = vi.fn();
    expect(await fetchWeWorkRemotely(wwr, { warn })).toHaveLength(3);
    expect(f.mock.calls[0][0]).toBe('https://weworkremotely.com/remote-jobs.rss');
    expect(f.mock.calls[0][1].headers.Accept).toMatch(/xml/);
    expect(warn).toHaveBeenCalledWith('1 posting(s) skipped: no description in the feed');
  });
  it('fails soft with labelled errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('<rss><channel>', { status: 200 })));
    expect((await settleBoard(fetchWeWorkRemotely, wwr)).error).toBe('weworkremotely weworkremotely: xml: unclosed element');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('x', { status: 403 })));
    expect((await settleBoard(fetchWeWorkRemotely, wwr)).error).toBe('weworkremotely weworkremotely: HTTP 403');
    expect(FETCHERS.weworkremotely).toBe(fetchWeWorkRemotely);
    expect(BOARD_SOURCES.has('weworkremotely')).toBe(false);
  });
});

describe.each(['himalayas', 'weworkremotely'] as const)('aggregators config: %s', (key) => {
  const names = { himalayas: 'Himalayas', weworkremotely: 'We Work Remotely' };
  const cfg = (aggregators: unknown) => {
    const f = path.join(mkdtempSync(path.join(tmpdir(), 'agg-')), 'portals.json');
    writeFileSync(f, JSON.stringify({ tracked_companies: [], aggregators, title_filter: { positive: ['react'], negative: [] }, location_filter: { allow: ['india'], global: ['remote'] } }));
    return loadPortals(f);
  };
  it('requires enabled:true (a string stays disabled), ignores name and slug overrides and keeps a valid max_pages', () => {
    expect(cfg({ [key]: { enabled: 'true' } }).config?.tracked_companies[0].enabled).toBe(false);
    const r = cfg({ [key]: { enabled: true, max_pages: 4, name: 'Evil', slug: 'evil' } });
    expect(r.config?.tracked_companies).toEqual([{ name: names[key], slug: key, ats: key, enabled: true, max_pages: 4 }]);
  });
  it('bounds max_pages, warns on a bad shape and on a bad domain, and keeps the rest', () => {
    for (const bad of [0, 51, 1.5, '3']) {
      expect(cfg({ [key]: { enabled: true, max_pages: bad } }).warnings).toEqual([`config/portals.json: aggregators.${key} skipped: max_pages must be an integer from 1 to 50`]);
    }
    expect(cfg({ [key]: 5 }).warnings).toEqual([`config/portals.json: aggregators.${key} skipped: must be an object`]);
    const r = cfg({ [key]: { enabled: true, domain: 'bad' } });
    expect(r.config?.tracked_companies).toEqual([]);
    expect(r.warnings).toEqual([`config/portals.json: aggregators.${key} skipped: domain must be "de" or "com"`]);
    expect(extraConfigProblem({ ats: key, domain: 'bad' })).toContain('domain');
  });
});
