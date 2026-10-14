import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { boardStatusPayload, dropBoardDuplicates, dropBoardDuplicatesDetailed, recordDroppedDuplicates, fetchBoards, getLastBoardsResult } from '../src/sources/boards/index.js';
import { companyKey, titleIdentityKey } from '../src/reposts.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function config(companies: any[]) {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'boards-')), 'portals.json');
  writeFileSync(f, JSON.stringify({
    tracked_companies: companies,
    title_filter: { positive: ['frontend'], negative: ['manager'] },
    location_filter: { allow: ['india', 'bengaluru'], global: ['remote', 'anywhere', 'worldwide', 'global'] },
  }));
  return f;
}
const gh = { jobs: [
  { id: 1, title: 'Frontend Engineer', absolute_url: 'https://boards.greenhouse.io/a/jobs/1', location: { name: 'Bengaluru' }, content: 'x' },
  { id: 2, title: 'Frontend Engineer', absolute_url: 'https://boards.greenhouse.io/a/jobs/2', location: { name: 'Remote, United States' }, content: 'x' },
  { id: 3, title: 'Frontend Manager', absolute_url: 'https://boards.greenhouse.io/a/jobs/3', location: { name: 'Bengaluru' }, content: 'x' },
  { id: 4, title: 'Data Analyst', absolute_url: 'https://boards.greenhouse.io/a/jobs/4', location: { name: 'Bengaluru' }, content: 'x' },
  { id: 5, title: 'Frontend Developer', absolute_url: 'https://boards.greenhouse.io/a/jobs/5', location: { name: 'Remote, Canada; Remote, India' }, content: 'x' },
  { id: 6, title: 'Frontend Developer', absolute_url: 'https://boards.greenhouse.io/a/jobs/6', location: { name: 'Remote, Sweden' }, content: 'x' },
] };

describe('fetchBoards', () => {
  it('fetches enabled companies, applies title + location filters, returns plain Jobs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) =>
      url.includes('greenhouse') ? new Response(JSON.stringify(gh), { status: 200 }) : new Response('[]', { status: 200 })));
    const r = await fetchBoards({ configPath: config([
      { name: 'A', ats: 'greenhouse', slug: 'a', enabled: true },
      { name: 'Off', ats: 'lever', slug: 'off', enabled: false },
    ]) });
    expect(r.jobs.map((j) => j.id)).toEqual(['gh:a:1', 'gh:a:5']);
    expect('locations' in r.jobs[0]).toBe(false);
    expect(r.stats).toEqual([{ company: 'A', ats: 'greenhouse', fetched: 6, kept: 2 }]);
    expect(r.errors).toEqual([]);
  });
  it('isolates a failing company', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) =>
      url.includes('/boards/bad/') ? new Response('boom', { status: 500 }) : new Response(JSON.stringify(gh), { status: 200 })));
    const r = await fetchBoards({ configPath: config([
      { name: 'Bad', ats: 'greenhouse', slug: 'bad', enabled: true },
      { name: 'A', ats: 'greenhouse', slug: 'a', enabled: true },
    ]) });
    expect(r.jobs.map((j) => j.id)).toEqual(['gh:a:1', 'gh:a:5']);
    expect(r.errors).toEqual(['greenhouse bad: HTTP 500']);
  });
  it('a timeout, invalid JSON or an oversized body is an error, not a crash', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/boards/slow/')) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      if (url.includes('/boards/huge/')) return new Response('{}', { status: 200, headers: { 'content-length': String(30 * 1024 * 1024) } });
      return new Response('not json', { status: 200 });
    }));
    const r = await fetchBoards({ configPath: config([
      { name: 'Slow', ats: 'greenhouse', slug: 'slow', enabled: true },
      { name: 'Junk', ats: 'greenhouse', slug: 'junk', enabled: true },
      { name: 'Huge', ats: 'greenhouse', slug: 'huge', enabled: true },
    ]) });
    expect(r.jobs).toEqual([]);
    // The provider labels a timeout as "timeout" (adapted from the brief's raw DOMException message).
    expect(r.errors).toEqual(['greenhouse slow: timeout', 'greenhouse junk: invalid JSON', 'greenhouse huge: response too large']);
  });
  it('no config file means no boards and no network', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await fetchBoards({ configPath: path.join(tmpdir(), 'definitely-missing-portals.json') })).toEqual({ jobs: [], errors: [], stats: [] });
    expect(f).not.toHaveBeenCalled();
  });
  it('a malformed config is one error and no network', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'boards-')), 'portals.json');
    writeFileSync(file, '{not json');
    const r = await fetchBoards({ configPath: file });
    expect(r.jobs).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(f).not.toHaveBeenCalled();
  });
  it('caps jobs per company', async () => {
    const many = { jobs: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, title: 'Frontend Dev', absolute_url: `https://boards.greenhouse.io/a/jobs/${i + 1}`, location: { name: 'India' }, content: '' })) };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(many), { status: 200 })));
    const r = await fetchBoards({ configPath: config([{ name: 'A', ats: 'greenhouse', slug: 'a', enabled: true }]), maxPerCompany: 2 });
    expect(r.jobs).toHaveLength(2);
  });
  it('maxPerCompany applies after the filters, not before', async () => {
    const mixed = { jobs: [
      ...Array.from({ length: 5 }, (_, i) => ({ id: i + 1, title: 'Data Analyst', absolute_url: '', location: { name: 'India' }, content: '' })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: i + 10, title: 'Frontend Dev', absolute_url: '', location: { name: 'India' }, content: '' })),
    ] };
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify(mixed), { status: 200 })));
    const r = await fetchBoards({ configPath: config([{ name: 'A', ats: 'greenhouse', slug: 'a', enabled: true }]), maxPerCompany: 3 });
    expect(r.jobs.map((j) => j.id)).toEqual(['gh:a:10', 'gh:a:11', 'gh:a:12']);
    expect(r.stats[0]).toEqual({ company: 'A', ats: 'greenhouse', fetched: 8, kept: 3 });
  });
  it('caps each description at 8000 chars', async () => {
    const big = { jobs: [{ id: 1, title: 'Frontend Dev', absolute_url: 'https://boards.greenhouse.io/a/jobs/1', location: { name: 'India' }, content: `&lt;p&gt;${'x'.repeat(20000)}&lt;/p&gt;` }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(big), { status: 200 })));
    const r = await fetchBoards({ configPath: config([{ name: 'A', ats: 'greenhouse', slug: 'a', enabled: true }]) });
    expect(r.jobs[0].description).toHaveLength(8000);
  });
  it('never has more than 3 boards in flight', async () => {
    let inflight = 0;
    let peak = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      inflight++; peak = Math.max(peak, inflight);
      await new Promise((res) => setTimeout(res, 15));
      inflight--;
      return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
    }));
    await fetchBoards({ concurrency: 50, configPath: config(Array.from({ length: 9 }, (_, i) => ({ name: `C${i}`, ats: 'greenhouse', slug: `c${i}`, enabled: true }))) });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });
  it('a board that hangs past its timeout is a board error and the others still return', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) =>
      url.includes('/boards/hang/') ? new Promise(() => {}) : Promise.resolve(new Response(JSON.stringify(gh), { status: 200 }))));
    const r = await fetchBoards({ boardTimeoutMs: 50, configPath: config([
      { name: 'Hang', ats: 'greenhouse', slug: 'hang', enabled: true },
      { name: 'A', ats: 'greenhouse', slug: 'a', enabled: true },
    ]) });
    expect(r.errors).toEqual(['greenhouse hang: timeout']);
    expect(r.jobs.map((j) => j.id)).toEqual(['gh:a:1', 'gh:a:5']);
  });
  it('an exhausted overall budget reports the unstarted boards as errors instead of hanging', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(() => {})));
    const r = await fetchBoards({ concurrency: 1, boardTimeoutMs: 40, budgetMs: 60, configPath: config(
      Array.from({ length: 6 }, (_, i) => ({ name: `C${i}`, ats: 'greenhouse', slug: `c${i}`, enabled: true }))) });
    expect(r.jobs).toEqual([]);
    expect(r.errors).toHaveLength(6);
    expect(r.errors.some((e) => /budget/.test(e))).toBe(true);
  });
  it('records the latest result (errors and stats) for board_status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) =>
      url.includes('/boards/bad/') ? new Response('boom', { status: 500 }) : new Response(JSON.stringify(gh), { status: 200 })));
    await fetchBoards({ configPath: config([
      { name: 'Bad', ats: 'greenhouse', slug: 'bad', enabled: true },
      { name: 'A', ats: 'greenhouse', slug: 'a', enabled: true },
    ]) });
    const last = getLastBoardsResult()!;
    expect(last.errors).toEqual(['greenhouse bad: HTTP 500']);
    expect(last.stats).toEqual([{ company: 'A', ats: 'greenhouse', fetched: 6, kept: 2 }]);
    expect(Number.isNaN(Date.parse(last.at))).toBe(false);
    expect('jobs' in last).toBe(true);
  });
});

describe('boardStatusPayload', () => {
  it('reports ran:false without fetching when nothing has run, and the last result afterwards', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(boardStatusPayload(null)).toEqual({ ran: false, errors: [], stats: [], note: 'no board fetch has run in this session' });
    expect(f).not.toHaveBeenCalled();
    const p = boardStatusPayload({ jobs: [], errors: ['e'], stats: [], at: '2026-01-01T00:00:00.000Z' });
    expect(p).toEqual({ ran: true, at: '2026-01-01T00:00:00.000Z', errors: ['e'], stats: [] });
  });
});

describe('board_status extras', () => {
  it('missing config gives a note, invalid entries become errors, dropped duplicates are reported', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ jobs: [] }), { status: 200 })));
    await fetchBoards({ configPath: path.join(tmpdir(), 'definitely-missing-portals.json') });
    expect(boardStatusPayload()).toMatchObject({ ran: true, errors: [], note: 'config/portals.json not found' });
    await fetchBoards({ configPath: config([
      { name: 'Bad', ats: 'taleo', slug: 'x', enabled: true },
      { name: 'Slug', ats: 'greenhouse', slug: '..', enabled: true },
      { name: 'A', ats: 'greenhouse', slug: 'a', enabled: true },
    ]) });
    const p = boardStatusPayload();
    expect(p.errors).toHaveLength(2);
    expect(p.errors[0]).toMatch(/unknown ats/);
    expect(p.errors[1]).toMatch(/invalid slug/);
    expect(p.stats.map((s) => s.company)).toEqual(['A']);
    recordDroppedDuplicates([{ id: 'gh:a:1', source: 'greenhouse', title: 't', company: 'c', url: 'u', apply_url: 'u', description: '' }]);
    expect(boardStatusPayload()).toMatchObject({ dropped_duplicates: { count: 1, ids: ['gh:a:1'] } });
  });
});

describe('dropBoardDuplicates', () => {
  const job = (id: string, source: string, company: string, title: string) => ({ id, source, company, title, url: `https://x.test/${id}`, apply_url: `https://x.test/${id}`, description: '' });
  const recent = [{ id: 'li:1', source: 'linkedin', company_key: companyKey('Acme'), title_key: titleIdentityKey('Frontend Engineer') }];
  it('drops board jobs already seen from any source or earlier in the batch; never drops non-board jobs', () => {
    const jobs = [
      job('gh:acme:1', 'greenhouse', 'Acme', 'Frontend Engineer'),       // same company+title as recent linkedin row -> dropped
      job('gh:acme:2', 'greenhouse', 'Acme', 'Backend Engineer'),        // an adzuna job in this batch has the same key -> dropped
      job('adzuna:9', 'adzuna', 'Acme Inc.', 'Backend Engineer'),        // non-board, kept
      job('gh:acme:3', 'greenhouse', 'Acme', 'Data Engineer'),           // first of its key -> kept
      job('gh:acme:4', 'greenhouse', 'Acme', 'Engineer, Data'),          // same board, same key, different id (another city) -> kept
      job('li:2', 'linkedin', 'Acme', 'Frontend Engineer'),              // non-board duplicate of a recent row, kept (not our job to drop)
    ];
    expect(dropBoardDuplicates(jobs, recent).map((j) => j.id)).toEqual(['adzuna:9', 'gh:acme:3', 'gh:acme:4', 'li:2']);
  });
  it('keeps same-board same-title postings with different ids, but drops a different board or a recent row from another source', () => {
    const same = [job('gh:acme:1', 'greenhouse', 'Acme', 'Data Engineer'), job('gh:acme:2', 'greenhouse', 'Acme', 'Data Engineer')];
    expect(dropBoardDuplicates(same, []).map((j) => j.id)).toEqual(['gh:acme:1', 'gh:acme:2']);
    // same board already in the db recently: still fine
    expect(dropBoardDuplicates(same, [{ id: 'gh:acme:0', source: 'greenhouse', company_key: companyKey('Acme'), title_key: titleIdentityKey('Data Engineer') }]).map((j) => j.id)).toEqual(['gh:acme:1', 'gh:acme:2']);
    // different slug, same key: the later one drops
    const diff = [job('gh:acme:1', 'greenhouse', 'Acme', 'Data Engineer'), job('lever:acme-eu:9', 'lever', 'Acme', 'Data Engineer')];
    const r = dropBoardDuplicatesDetailed(diff, []);
    expect(r.kept.map((j) => j.id)).toEqual(['gh:acme:1']);
    expect(r.dropped.map((j) => j.id)).toEqual(['lever:acme-eu:9']);
    // a linkedin row with the same key drops the board job
    expect(dropBoardDuplicates(same, [{ id: 'li:5', source: 'linkedin', company_key: companyKey('Acme'), title_key: titleIdentityKey('Data Engineer') }])).toEqual([]);
  });
  it('keeps board jobs when the keys are empty or nothing matches', () => {
    expect(dropBoardDuplicates([job('gh:z:1', 'greenhouse', '', 'Frontend Engineer')], recent).map((j) => j.id)).toEqual(['gh:z:1']);
    expect(dropBoardDuplicates([job('gh:z:2', 'greenhouse', 'Zed', 'Frontend Engineer')], []).map((j) => j.id)).toEqual(['gh:z:2']);
  });
});
