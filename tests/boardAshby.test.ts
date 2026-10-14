import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchAshby, normalizeAshby } from '../src/sources/boards/ashby.js';

afterEach(() => vi.unstubAllGlobals());
const company = { name: 'Linear', ats: 'ashby' as const, slug: 'linear', enabled: true };
const raw = { jobs: [
  { id: 'u1', title: 'Senior Fullstack Engineer', location: 'Europe', secondaryLocations: [{ location: 'India' }], workplaceType: 'Remote', isRemote: true, jobUrl: 'https://jobs.ashbyhq.com/linear/u1', publishedAt: '2021-04-27T20:13:45.158+00:00', descriptionPlain: 'At Linear...', isListed: true },
  { id: 'u2', title: 'Office Engineer', location: 'Bengaluru', workplaceType: 'OnSite', isRemote: true, jobUrl: 'https://jobs.ashbyhq.com/linear/u2', publishedAt: null, descriptionPlain: 'x', isListed: true },
  { id: 'u3', title: 'Hidden', location: 'Remote', jobUrl: 'https://jobs.ashbyhq.com/linear/u3', isListed: false },
  { id: 'u4', title: 'Legacy Remote', location: 'Remote', isRemote: true, jobUrl: 'https://jobs.ashbyhq.com/linear/u4' },
] };

describe('normalizeAshby', () => {
  it('maps listed jobs; workplaceType beats isRemote', () => {
    expect(normalizeAshby(raw, company)).toEqual([
      { id: 'ashby:linear:u1', source: 'ashby', title: 'Senior Fullstack Engineer', company: 'Linear', url: 'https://jobs.ashbyhq.com/linear/u1', apply_url: 'https://jobs.ashbyhq.com/linear/u1/application', description: 'At Linear...', posted_at: '2021-04-27', locations: ['Europe', 'India'], remote: true },
      { id: 'ashby:linear:u2', source: 'ashby', title: 'Office Engineer', company: 'Linear', url: 'https://jobs.ashbyhq.com/linear/u2', apply_url: 'https://jobs.ashbyhq.com/linear/u2/application', description: 'x', locations: ['Bengaluru'], remote: false },
      { id: 'ashby:linear:u4', source: 'ashby', title: 'Legacy Remote', company: 'Linear', url: 'https://jobs.ashbyhq.com/linear/u4', apply_url: 'https://jobs.ashbyhq.com/linear/u4/application', description: '', locations: ['Remote'], remote: true },
    ]);
  });
  it('replaces foreign-host or missing URLs with the canonical vendor URL', () => {
    const bad = { jobs: [
      { id: 'u5', title: 'Frontend', location: 'India', jobUrl: 'https://evil.example.com/linear/u5', applyUrl: 'https://jobs.ashbyhq.com.evil.io/x' },
      { id: 'u6', title: 'Frontend', location: 'India' },
    ] };
    const out = normalizeAshby(bad, company);
    expect(out.map((j) => [j.url, j.apply_url])).toEqual([
      ['https://jobs.ashbyhq.com/linear/u5', 'https://jobs.ashbyhq.com/linear/u5/application'],
      ['https://jobs.ashbyhq.com/linear/u6', 'https://jobs.ashbyhq.com/linear/u6/application'],
    ]);
  });
  it('tolerates junk, rejects odd ids and caps descriptions', () => {
    expect(normalizeAshby(null, company)).toEqual([]);
    expect(normalizeAshby({ jobs: [null, { id: 'a/b', title: 'x' }, { id: 'ok', title: 'Big', descriptionPlain: 'q'.repeat(30000) }] }, company).map((j) => [j.id, j.description.length])).toEqual([['ashby:linear:ok', 8000]]);
  });
});

describe('normalizeAshby limits', () => {
  it('caps jobs, clips text, skips long ids, falls back on long url', () => {
    expect(normalizeAshby({ jobs: Array.from({ length: 100000 }, (_, i) => ({ id: `i${i}`, title: 't' })) }, company)).toHaveLength(2000);
    const [j] = normalizeAshby({ jobs: [{ id: 'ok', title: 'x'.repeat(1_000_000), location: 'l'.repeat(9999), jobUrl: 'https://jobs.ashbyhq.com/' + 'z'.repeat(3000) }] }, company);
    expect(j.title).toHaveLength(300);
    expect(j.locations[0]).toHaveLength(300);
    expect(j.url).toBe('https://jobs.ashbyhq.com/linear/ok');
    expect(normalizeAshby({ jobs: [{ id: 'a'.repeat(150), title: 't' }] }, company)).toEqual([]);
  });
  it('strips query and fragment before appending the application suffix', () => {
    const [j] = normalizeAshby({ jobs: [{ id: 'q', title: 't', jobUrl: 'https://jobs.ashbyhq.com/linear/q?utm=1#x' }] }, company);
    expect(j.apply_url).toBe('https://jobs.ashbyhq.com/linear/q/application');
  });
});

describe('fetchAshby', () => {
  it('calls the posting API with compensation', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify(raw), { status: 200 }));
    vi.stubGlobal('fetch', f);
    expect(await fetchAshby(company)).toHaveLength(3);
    expect(f.mock.calls[0][0]).toBe('https://api.ashbyhq.com/posting-api/job-board/linear?includeCompensation=true');
  });
  it('reports 404 and 429 as errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    await expect(fetchAshby(company)).rejects.toThrow('ashby linear: HTTP 404');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 429 })));
    await expect(fetchAshby(company)).rejects.toThrow('ashby linear: HTTP 429');
  });
  it('rejects an invalid slug before any network call', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(fetchAshby({ ...company, slug: '..' })).rejects.toThrow(/invalid board slug/);
    expect(f).not.toHaveBeenCalled();
  });
});
