import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchLever, normalizeLever } from '../src/sources/boards/lever.js';

afterEach(() => vi.unstubAllGlobals());
const company = { name: 'Meesho', ats: 'lever' as const, slug: 'meesho', enabled: true };
const raw = [
  { id: 'abc', text: 'SDE II - Frontend', hostedUrl: 'https://jobs.lever.co/meesho/abc', applyUrl: 'https://jobs.lever.co/meesho/abc/apply', categories: { location: 'Bangalore', allLocations: ['Bangalore', 'Remote'] }, descriptionPlain: 'Build web apps.', additionalPlain: 'Benefits.', createdAt: 1759190400000, workplaceType: 'hybrid' },
  { id: 'def', text: 'Frontend Engineer', hostedUrl: 'https://jobs.lever.co/meesho/def', categories: { location: 'Remote' }, descriptionPlain: '', createdAt: 'bad', workplaceType: 'remote' },
];

describe('normalizeLever', () => {
  it('maps postings', () => {
    expect(normalizeLever(raw, company)).toEqual([
      { id: 'lever:meesho:abc', source: 'lever', title: 'SDE II - Frontend', company: 'Meesho', url: 'https://jobs.lever.co/meesho/abc', apply_url: 'https://jobs.lever.co/meesho/abc/apply', description: 'Build web apps.\n\nBenefits.', posted_at: '2025-09-30', locations: ['Bangalore', 'Remote'], remote: true },
      { id: 'lever:meesho:def', source: 'lever', title: 'Frontend Engineer', company: 'Meesho', url: 'https://jobs.lever.co/meesho/def', apply_url: 'https://jobs.lever.co/meesho/def/apply', description: '', locations: ['Remote'], remote: true },
    ]);
  });
  it('tolerates a non-array body', () => { expect(normalizeLever({ ok: false }, company)).toEqual([]); });
  it('replaces foreign-host URLs with the canonical vendor URL', () => {
    const bad = [{ id: 'ghi', text: 'Frontend Dev', hostedUrl: 'https://evil.example.com/x', applyUrl: 'https://jobs.lever.co.evil.io/apply', categories: { location: 'Remote' }, workplaceType: 'remote' }];
    const [j] = normalizeLever(bad, company);
    expect(j.url).toBe('https://jobs.lever.co/meesho/ghi');
    expect(j.apply_url).toBe('https://jobs.lever.co/meesho/ghi/apply');
    const [e] = normalizeLever(bad, { ...company, region: 'eu' });
    expect(e.url).toBe('https://jobs.eu.lever.co/meesho/ghi');
    expect(e.apply_url).toBe('https://jobs.eu.lever.co/meesho/ghi/apply');
  });
  it('refuses http vendor URLs and caps descriptions', () => {
    const [j] = normalizeLever([{ id: 'jkl', text: 'Dev', hostedUrl: 'http://jobs.lever.co/meesho/jkl', categories: {}, descriptionPlain: 'y'.repeat(30000), additionalPlain: 'z'.repeat(30000) }], company);
    expect(j.url).toBe('https://jobs.lever.co/meesho/jkl');
    expect(j.description.length).toBe(8000);
  });
});

describe('normalizeLever limits', () => {
  it('caps jobs, clips text, skips long ids, falls back on long url', () => {
    expect(normalizeLever(Array.from({ length: 100000 }, (_, i) => ({ id: `i${i}`, text: 't' })), company)).toHaveLength(2000);
    const [j] = normalizeLever([{ id: 'ok', text: 'x'.repeat(1_000_000), categories: { location: 'l'.repeat(9999) }, hostedUrl: 'https://jobs.lever.co/' + 'z'.repeat(3000) }], company);
    expect(j.title).toHaveLength(300);
    expect(j.locations[0]).toHaveLength(300);
    expect(j.url).toBe('https://jobs.lever.co/meesho/ok');
    expect(normalizeLever([{ id: 'a'.repeat(150), text: 't' }], company)).toEqual([]);
  });
  it('strips query and fragment before appending the apply suffix', () => {
    const [j] = normalizeLever([{ id: 'q', text: 't', hostedUrl: 'https://jobs.lever.co/meesho/q?lever-source=x#top', categories: {} }], company);
    expect(j.url).toBe('https://jobs.lever.co/meesho/q?lever-source=x#top');
    expect(j.apply_url).toBe('https://jobs.lever.co/meesho/q/apply');
  });
});

describe('fetchLever', () => {
  it('uses the global or EU host', async () => {
    const f = vi.fn().mockImplementation(async () => new Response(JSON.stringify(raw), { status: 200 }));
    vi.stubGlobal('fetch', f);
    await fetchLever(company);
    await fetchLever({ ...company, region: 'eu' });
    expect(f.mock.calls.map((c) => c[0])).toEqual(['https://api.lever.co/v0/postings/meesho?mode=json', 'https://api.eu.lever.co/v0/postings/meesho?mode=json']);
  });
  it('a 404 is an error to report, not an empty board', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    await expect(fetchLever(company)).rejects.toThrow('lever meesho: HTTP 404');
  });
  it('reports a 429 and a non-JSON body as errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x', { status: 429 })));
    await expect(fetchLever(company)).rejects.toThrow('lever meesho: HTTP 429');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })));
    await expect(fetchLever(company)).rejects.toThrow('lever meesho: invalid JSON');
  });
  it('rejects an invalid slug before any network call', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(fetchLever({ ...company, slug: 'a/b' })).rejects.toThrow(/invalid board slug/);
    expect(f).not.toHaveBeenCalled();
  });
});
