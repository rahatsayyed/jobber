import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchKeka, normalizeKeka, extractKekaIdentifier } from '../src/sources/boards/keka.js';
import { fetchDarwinbox, normalizeDarwinbox } from '../src/sources/boards/darwinbox.js';
import { fetchHibob, normalizeHibob } from '../src/sources/boards/hibob.js';
import { fetchZohoRecruit, normalizeZohoRecruit, extractZohoRecords } from '../src/sources/boards/zohorecruit.js';
import { settleBoard } from '../src/sources/boards/greenhouse.js';
import { FETCHERS } from '../src/sources/boards/registry.js';
import { BOARD_PROVIDERS } from '../src/sources/boards/providers.js';
import { COMPANY_ATS, extraConfigProblem, loadPortals, slugProblem } from '../src/sources/boards/filters.js';
import { isDiscoverOnlySource } from '../src/lib/discoverOnly.js';
import { checkShape } from '../src/sources/shape.js';
import { withRawSink } from '../src/sources/boards/transport.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

afterEach(() => vi.unstubAllGlobals());
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const UUID = '0a1b2c3d-4e5f-6789-abcd-ef0123456789';

// Invented fixtures in the shapes career-ops reads.
const keka = { name: 'Acme', ats: 'keka' as const, slug: 'acme', enabled: true };
const kekaShell = `<html><script>fetch("/ats/documents/${UUID.toUpperCase()}/careerportal/abc123.html")</script></html>`;
const kekaJobs = [
  { id: 'a1b2', title: 'Frontend   Engineer', description: '<p>Build <b>React</b> UIs</p>', jobLocations: [{ name: 'HQ - Tower 2', city: 'Pune', state: 'MH', countryName: 'India' }, { name: 'Remote Office' }], publishedOn: '2026-10-10T08:00:00Z' },
  { id: 77, title: 'Full Stack Developer', jobLocations: [], publishedOn: 'nonsense' },
  { id: 'x/../y', title: 'Odd Id', jobLocations: [] },
  { id: 'nope' },
  null,
];

describe('keka', () => {
  it('maps postings: tenant URL, city/country locations with the office name as fallback, hashed unsafe ids', () => {
    const out = normalizeKeka(kekaJobs, keka);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      id: 'ke:acme:a1b2', source: 'keka', title: 'Frontend Engineer', company: 'Acme',
      url: 'https://acme.keka.com/careers/jobdetails/a1b2', apply_url: 'https://acme.keka.com/careers/jobdetails/a1b2',
      description: 'Build React UIs', posted_at: '2026-10-10', locations: ['Pune, India', 'Remote Office'], remote: true,
    });
    expect(out[1].id).toBe('ke:acme:77');
    expect(out[1].posted_at).toBeUndefined();
    expect(out[2].id).toMatch(/^ke:acme:[0-9a-f]{12}$/);
    expect(out[2].url).toBe(`https://acme.keka.com/careers/jobdetails/${out[2].id.split(':')[2]}`);
    expect(() => normalizeKeka({ jobs: [] }, keka)).toThrow('no jobs array');
    expect(() => normalizeKeka(kekaJobs, { ...keka, slug: 'a.evil.io' })).toThrow('invalid board slug');
  });
  it('reads the identifier from the shell and rejects a shell without one', () => {
    expect(extractKekaIdentifier(kekaShell)).toBe(UUID);
    expect(extractKekaIdentifier('<html></html>')).toBeNull();
  });
  it('fetches shell then feed on the tenant host only, no redirects; fails closed on the wrong shapes', async () => {
    const f = vi.fn().mockImplementation(async (u: string) => (u.endsWith('/careers') ? new Response(kekaShell, { status: 200 }) : json(kekaJobs)));
    vi.stubGlobal('fetch', f);
    expect(await fetchKeka(keka)).toHaveLength(3);
    expect(f.mock.calls.map((c) => c[0])).toEqual(['https://acme.keka.com/careers', `https://acme.keka.com/careers/api/embedjobs/default/active/${UUID}`]);
    expect(f.mock.calls.every((c) => c[1].redirect === 'error')).toBe(true);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('<html></html>', { status: 200 })));
    expect((await settleBoard(fetchKeka, keka)).error).toBe('keka acme: careers page has no embedjobs identifier (structure changed?)');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (u: string) => (u.endsWith('/careers') ? new Response(kekaShell) : json({ nope: 1 }))));
    expect((await settleBoard(fetchKeka, keka)).error).toBe('keka acme: unexpected response shape (no jobs array)');
    expect((await settleBoard(fetchKeka, { ...keka, slug: 'www' })).error).toBe('keka www: not a customer tenant');
  });
  it('the sample for the shape check is the jobs array, not the HTML shell', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (u: string) => (u.endsWith('/careers') ? new Response(kekaShell) : json(kekaJobs.slice(0, 2)))));
    const r = await BOARD_PROVIDERS.keka.fetch({ company: keka } as any);
    expect(r.sample).toHaveLength(2);
    expect(checkShape(BOARD_PROVIDERS.keka.shapeSpec, r.sample).ok).toBe(true);
  });
});

const db = { name: 'Beta', ats: 'darwinbox' as const, slug: 'beta', company_id: 'abc_123', enabled: true };
const dbRow = (n: number) => ({ id: `j${n}`, title: `Role ${n}`, tool_tip_locations: ['Bengaluru ,India', 'Bengaluru ,India'], posted_on: 1_790_000_000, jd: '<p>React</p>' });
describe('darwinbox', () => {
  it('maps postings: company_id URL, de-duplicated locations, epoch-second date, status envelope enforced', () => {
    const out = normalizeDarwinbox({ status: 'success', data: [{ ...dbRow(1), title: 'Dev &amp; Ops' }, { id: 5, title: 'Remote Dev', locations: 'Remote', created_on: '2026-09-01T00:00:00Z' }, { title: 'no id' }, null] }, db);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 'dbx:beta:j1', title: 'Dev & Ops', url: 'https://beta.darwinbox.in/ms/candidatev2/abc_123/careers/jobDetails/j1', locations: ['Bengaluru, India'], description: 'React', remote: false });
    expect(out[0].posted_at).toMatch(/^2026-/);
    expect(out[1]).toMatchObject({ id: 'dbx:beta:5', posted_at: '2026-09-01', remote: true });
    expect(() => normalizeDarwinbox({ status: 'error', data: [] }, db)).toThrow('no data array');
    expect(() => normalizeDarwinbox({ status: 'success', data: [] }, { ...db, company_id: undefined })).toThrow('company_id');
  });
  it('POSTs page by page to the tenant host, stops on a short page, keeps earlier pages when a later one fails', async () => {
    const full = Array.from({ length: 50 }, (_, i) => dbRow(i));
    const f = vi.fn().mockImplementation(async (_u: string, init: any) => {
      const page = JSON.parse(init.body).page;
      return json(page === 1 ? { status: 'success', data: full } : { status: 'success', data: [dbRow(900)] });
    });
    vi.stubGlobal('fetch', f);
    const jobs = await fetchDarwinbox(db);
    expect(jobs).toHaveLength(51);
    expect(f.mock.calls).toHaveLength(2);
    expect(f.mock.calls[0][0]).toBe('https://beta.darwinbox.in/ms/candidateapi/job/alljobs?companyId=abc_123');
    expect(f.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ companyId: 'abc_123', page: 1, sort_option: 'new', limit: 50 });
    const warns: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_u: string, init: any) => (JSON.parse(init.body).page === 1 ? json({ status: 'success', data: full }) : new Response('x', { status: 500 }))));
    expect(await fetchDarwinbox(db, { warn: (m) => warns.push(m) })).toHaveLength(50);
    expect(warns[0]).toContain('stopped at page 2');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => json({ status: 'success' })));
    expect((await settleBoard(fetchDarwinbox, db)).error).toContain('no data array');
  });
});

const hb = { name: 'Gamma', ats: 'hibob' as const, slug: 'gamma-641e1b', enabled: true };
describe('hibob', () => {
  const doc = { jobAdDetails: [
    { id: 'u-1', title: 'Web Engineer', site: 'Mumbai', country: 'India', workspaceTypeId: 'remote', publishedAt: '2026-10-05T10:00:00Z', description: '<p>Own the UI</p>', requirements: '<ul><li>TypeScript</li></ul>' },
    { id: 'u-2', title: 'Designer', site: 'Berlin, Germany', country: 'Germany', workspaceTypeId: 'office' },
    { title: 'No id' }, null,
  ] };
  it('maps postings with joined description, site and country, remote flag', () => {
    const out = normalizeHibob(doc, hb);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: 'hb:gamma-641e1b:u-1', source: 'hibob', title: 'Web Engineer', company: 'Gamma',
      url: 'https://gamma-641e1b.careers.hibob.com/jobs/u-1', apply_url: 'https://gamma-641e1b.careers.hibob.com/jobs/u-1',
      description: 'Own the UI TypeScript', posted_at: '2026-10-05', locations: ['Mumbai, India, Remote'], remote: true,
    });
    expect(out[1].locations).toEqual(['Berlin, Germany']);
    expect(() => normalizeHibob({ jobs: [] }, hb)).toThrow('no jobAdDetails array');
  });
  it('sends the companyidentifier header to the tenant host and maps 401 to "no such careers site"', async () => {
    const f = vi.fn().mockImplementation(async () => json(doc));
    vi.stubGlobal('fetch', f);
    expect(await fetchHibob(hb)).toHaveLength(2);
    expect(f.mock.calls[0][0]).toBe('https://gamma-641e1b.careers.hibob.com/api/job-ad');
    expect(f.mock.calls[0][1].headers.companyidentifier).toBe('gamma-641e1b');
    expect(f.mock.calls[0][1].redirect).toBe('error');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('x', { status: 401 })));
    expect((await settleBoard(fetchHibob, hb)).error).toBe('hibob gamma-641e1b: no such careers site (HTTP 401)');
  });
});

const zr = { name: 'Delta', ats: 'zohorecruit' as const, slug: 'delta', tld: 'in', enabled: true };
const zrRecords = [
  { id: 4001, Posting_Title: 'React Developer', City: 'Chennai', State: 'TN', Country: 'India', Remote_Job: false, Date_Opened: '2026-10-12', Job_Description: '<p>Build <i>UIs</i></p>' },
  { id: '4002', Job_Opening_Name: 'Remote Node Dev', Remote_Job: true },
  { id: 4003, Posting_Title: 'Filled', Is_Locked: true },
  { id: 4004, Posting_Title: 'Unpublished', Publish: false },
  { Posting_Title: 'No id' },
];
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const zrHtml = `<html><body><input type="hidden" id="other" value="x"><input type="hidden" id="jobs" value="${esc(JSON.stringify(zrRecords))}"></body></html>`;
describe('zohorecruit', () => {
  it('reads the id="jobs" input, drops filled, unpublished and id-less rows, builds URLs on the regional host', () => {
    const out = normalizeZohoRecruit(zrHtml, zr);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: 'zr:delta:4001', source: 'zohorecruit', title: 'React Developer', company: 'Delta',
      url: 'https://delta.zohorecruit.in/jobs/Careers/4001', apply_url: 'https://delta.zohorecruit.in/jobs/Careers/4001',
      description: 'Build UIs', posted_at: '2026-10-12', locations: ['Chennai, TN, India'], remote: false,
    });
    expect(out[1]).toMatchObject({ id: 'zr:delta:4002', locations: ['Remote'], remote: true });
    expect(extractZohoRecords(zrHtml)).toHaveLength(5);
  });
  it('a page without the input, bad JSON, a non-array and a bad tld are errors, an empty array is an empty board', () => {
    expect(() => normalizeZohoRecruit('<html>Page does not exist</html>', zr)).toThrow('no id="jobs" input');
    expect(() => normalizeZohoRecruit('<input id="jobs" value="{not json">', zr)).toThrow('not JSON');
    expect(() => normalizeZohoRecruit(`<input id="jobs" value="${esc('{"a":1}')}">`, zr)).toThrow('not an array');
    expect(normalizeZohoRecruit('<input id="jobs" value="[]">', zr)).toEqual([]);
    expect(() => normalizeZohoRecruit(zrHtml, { ...zr, tld: 'evil.io' })).toThrow('invalid tld');
  });
  it('fetches /jobs/Careers once on the tenant host (default tld com), no redirects; sample are the records', async () => {
    const f = vi.fn().mockImplementation(async () => new Response(zrHtml, { status: 200 }));
    vi.stubGlobal('fetch', f);
    expect(await fetchZohoRecruit({ ...zr, tld: undefined })).toHaveLength(2);
    expect(f.mock.calls[0][0]).toBe('https://delta.zohorecruit.com/jobs/Careers');
    expect(f.mock.calls[0][1].redirect).toBe('error');
    const raws: unknown[] = [];
    await withRawSink(raws, () => fetchZohoRecruit(zr));
    const sample = BOARD_PROVIDERS.zohorecruit.sampleOf(raws);
    expect(sample).toHaveLength(5);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('nope', { status: 404 })));
    expect((await settleBoard(fetchZohoRecruit, zr)).error).toBe('zohorecruit delta: HTTP 404');
  });
});

describe('wiring', () => {
  it('registers every second-pass vendor: fetcher, provider, discover-only, slug and config rules', () => {
    for (const v of ['keka', 'darwinbox', 'hibob', 'zohorecruit'] as const) {
      expect(COMPANY_ATS).toContain(v);
      expect(FETCHERS[v], v).toBeTypeOf('function');
      expect(BOARD_PROVIDERS[v].id).toBe(v);
      expect(isDiscoverOnlySource(v)).toBe(true);
      expect(slugProblem(v, 'Acme')).toMatch(/invalid slug/);
      expect(slugProblem(v, 'a.evil.io')).toMatch(/invalid slug/);
      expect(slugProblem(v, 'acme-1')).toBeNull();
    }
    expect(extraConfigProblem({ ats: 'darwinbox', slug: 'x' })).toMatch(/needs company_id/);
    expect(extraConfigProblem({ ats: 'darwinbox', company_id: '../x' })).toMatch(/company_id/);
    expect(extraConfigProblem({ ats: 'darwinbox', company_id: 'ab_1' })).toBeNull();
    expect(extraConfigProblem({ ats: 'zohorecruit', tld: 'in' })).toBeNull();
    expect(extraConfigProblem({ ats: 'zohorecruit', tld: 'evil.io' })).toMatch(/tld/);
  });
  it('loadPortals keeps company_id and tld and drops a darwinbox entry without company_id', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'portals-')), 'portals.json');
    writeFileSync(file, JSON.stringify({ tracked_companies: [
      { name: 'A', ats: 'darwinbox', slug: 'a', company_id: 'abc', enabled: true },
      { name: 'B', ats: 'darwinbox', slug: 'b', enabled: true },
      { name: 'C', ats: 'zohorecruit', slug: 'c', tld: 'in', enabled: true },
      { name: 'D', ats: 'keka', slug: 'd', enabled: true },
    ], title_filter: { positive: ['react'], negative: [] }, location_filter: { allow: ['india'], global: [] } }));
    const { config, warnings } = loadPortals(file);
    expect(config?.tracked_companies.map((c) => [c.name, c.company_id, c.tld])).toEqual([['A', 'abc', undefined], ['C', undefined, 'in'], ['D', undefined, undefined]]);
    expect((warnings ?? []).join(' ')).toContain('darwinbox needs company_id');
  });
});
