import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetchWorkable, normalizeWorkable } from '../src/sources/boards/workable.js';
import { settleBoard } from '../src/sources/boards/greenhouse.js';
import { loadPortals } from '../src/sources/boards/filters.js';
import { FETCHERS } from '../src/sources/boards/registry.js';

afterEach(() => vi.unstubAllGlobals());
const company = { name: 'Acme', ats: 'workable' as const, slug: 'acme', enabled: true };
// Shape read from career-ops providers/workable.mjs (widget API with details=true).
const raw = {
  name: 'Acme', description: 'About',
  jobs: [
    { title: 'Frontend Engineer', shortcode: 'ABC123DEF4', shortlink: 'https://apply.workable.com/j/ABC123DEF4', url: 'https://apply.workable.com/acme/j/ABC123DEF4/', department: 'Eng', city: 'Dubai', state: 'Dubai', country: 'United Arab Emirates', telecommuting: false, published_on: '2026-10-01', description: '&lt;p&gt;Build &lt;b&gt;React&lt;/b&gt; apps&lt;/p&gt;' },
    { title: 'Full Stack Developer', shortcode: 'ZZZ999', url: 'https://apply.workable.com/acme/j/ZZZ999/', city: '', country: '', telecommuting: true, published_on: 'bad', description: '<p>Remote role</p>' },
  ],
};

describe('normalizeWorkable', () => {
  it('maps the widget payload to board jobs (discover-only source, vendor URLs, plain description, date)', () => {
    expect(normalizeWorkable(raw, company)).toEqual([
      { id: 'wk:acme:ABC123DEF4', source: 'workable', title: 'Frontend Engineer', company: 'Acme', url: 'https://apply.workable.com/j/ABC123DEF4', apply_url: 'https://apply.workable.com/j/ABC123DEF4', description: 'Build React apps', posted_at: '2026-10-01', locations: ['Dubai, United Arab Emirates'], remote: false },
      { id: 'wk:acme:ZZZ999', source: 'workable', title: 'Full Stack Developer', company: 'Acme', url: 'https://apply.workable.com/acme/j/ZZZ999/', apply_url: 'https://apply.workable.com/acme/j/ZZZ999/', description: 'Remote role', locations: ['Remote'], remote: true },
    ]);
  });
  it('never takes a foreign or non-https URL from the response: it builds the canonical one from the shortcode', () => {
    const bad = { jobs: [
      { title: 'a', shortcode: 'AAA', shortlink: 'https://evil.example.com/x', url: 'http://apply.workable.com/acme/j/AAA/' },
      { title: 'b', shortcode: 'BBB', shortlink: 'https://apply.workable.com.evil.io/x', url: 'javascript:alert(1)' },
      { title: 'c', shortcode: 'CCC', shortlink: 'https://user:pw@apply.workable.com/x' },
    ] };
    expect(normalizeWorkable(bad, company).map((j) => j.url)).toEqual([
      'https://apply.workable.com/acme/j/AAA/', 'https://apply.workable.com/acme/j/BBB/', 'https://apply.workable.com/acme/j/CCC/',
    ]);
  });
  it('skips rows without a safe shortcode or a title and tolerates junk', () => {
    expect(normalizeWorkable({ jobs: [null, { title: 't' }, { title: 't', shortcode: '../x' }, { shortcode: 'OK1' }, { title: 't', shortcode: 'a'.repeat(200) }] }, company)).toEqual([]);
    expect(normalizeWorkable(null, company)).toEqual([]);
    expect(normalizeWorkable({ jobs: 'x' }, company)).toEqual([]);
  });
  it('applies the shared limits: 2000 jobs, 300-char title and location, 8000-char description, long ids skipped', () => {
    const many = { jobs: Array.from({ length: 100000 }, (_, i) => ({ title: 't', shortcode: `S${i}` })) };
    expect(normalizeWorkable(many, company)).toHaveLength(2000);
    const [j] = normalizeWorkable({ jobs: [{ title: 'x'.repeat(100000), shortcode: 'AB', city: 'y'.repeat(5000), description: 'z'.repeat(50000) }] }, company);
    expect(j.title).toHaveLength(300);
    expect(j.locations[0]).toHaveLength(300);
    expect(j.description.length).toBe(8000);
    expect(normalizeWorkable({ jobs: [{ title: 't', shortcode: 'A' }] }, { ...company, slug: 'a'.repeat(99) })).toEqual([]);
  });
  it('rejects an invalid slug before using it', () => {
    expect(() => normalizeWorkable(raw, { ...company, slug: 'a.b' })).toThrow('invalid board slug');
    expect(() => normalizeWorkable(raw, { ...company, slug: '../x' })).toThrow('invalid board slug');
  });
});

describe('fetchWorkable', () => {
  it('calls the single widget host with details=true, browser-style origin and referer, no redirects', async () => {
    const f = vi.fn().mockImplementation(async () => new Response(JSON.stringify(raw), { status: 200 }));
    vi.stubGlobal('fetch', f);
    expect(await fetchWorkable(company)).toHaveLength(2);
    expect(f.mock.calls[0][0]).toBe('https://apply.workable.com/api/v1/widget/accounts/acme?details=true');
    const init = f.mock.calls[0][1];
    expect(init.redirect).toBe('error');
    expect(init.headers.Origin).toBe('https://apply.workable.com');
    expect(init.headers.Referer).toBe('https://apply.workable.com/acme/');
    expect(init.headers['User-Agent']).toMatch(/jobber/);
  });
  it('serializes concurrent requests (Cloudflare fronts every tenant on one host)', async () => {
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
    }));
    await Promise.all(['a', 'b', 'c'].map((slug) => fetchWorkable({ ...company, slug })));
    expect(peak).toBe(1);
  });
  it('fails soft with a labelled error when the shape differs, on HTTP errors and on an invalid slug', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })));
    expect((await settleBoard(fetchWorkable, company)).error).toBe('workable acme: unexpected response shape (no jobs array)');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('blocked', { status: 429 })));
    expect((await settleBoard(fetchWorkable, company)).error).toBe('workable acme: HTTP 429');
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect((await settleBoard(fetchWorkable, { ...company, slug: 'a/b' })).error).toContain('invalid board slug');
    expect(f).not.toHaveBeenCalled();
  });
  it('is registered and accepted by portals.json validation (vendor slug rules apply)', () => {
    expect(FETCHERS.workable).toBe(fetchWorkable);
    const f = path.join(mkdtempSync(path.join(tmpdir(), 'wk-')), 'portals.json');
    writeFileSync(f, JSON.stringify({
      tracked_companies: [{ name: 'Acme', ats: 'workable', slug: 'acme', enabled: true }, { name: 'Dots', ats: 'workable', slug: 'a.b', enabled: true }],
      title_filter: { positive: ['frontend'], negative: [] }, location_filter: { allow: ['india'], global: ['remote'] },
    }));
    const r = loadPortals(f);
    expect(r.config?.tracked_companies.map((c) => c.slug)).toEqual(['acme']);
    expect(r.warnings).toEqual(['config/portals.json: tracked_companies[1] (Dots) skipped: invalid slug (letters, digits, "_" and "-")']);
  });
});
