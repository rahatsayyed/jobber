import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadPortals, locationAllowed, postingTooOld, seniorityRank, tierKeywords, titlePasses } from '../src/sources/boards/filters.js';
import { fetchBoards } from '../src/sources/boards/index.js';
import { fetchWorkday } from '../src/sources/boards/workday.js';

afterEach(() => { vi.unstubAllGlobals(); });

const base = { positive: ['frontend', 'react', 'software engineer'], negative: ['manager'] };
const loc = { allow: ['india'], global: ['remote'] };

function cfg(extra: Record<string, unknown>, companies: any[] = []) {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'scanlayer-')), 'portals.json');
  writeFileSync(f, JSON.stringify({ tracked_companies: companies, title_filter: base, location_filter: loc, ...extra }));
  return f;
}

describe('title layer (can only exclude or order)', () => {
  it('is identical to the plain filter when no layer key is set', () => {
    for (const t of ['Frontend Engineer', 'Frontend Manager', 'Java Developer', 'Senior Software Engineer']) {
      expect(titlePasses(t, base)).toBe(titlePasses(t, { ...base }));
    }
    expect(titlePasses('Frontend Intern', base)).toBe(true);
  });
  it('exclude and skip_tiers only remove', () => {
    expect(titlePasses('Frontend Intern', { ...base, skip_tiers: ['intern'] })).toBe(false);
    expect(titlePasses('Junior React Developer', { ...base, skip_tiers: ['junior'] })).toBe(false);
    expect(titlePasses('React Developer', { ...base, skip_tiers: ['intern', 'junior'] })).toBe(true);
    expect(titlePasses('React Developer II', { ...base, exclude: ['word:ii'] })).toBe(false);
    expect(titlePasses('React Developer (Contract)', { ...base, exclude: ['react + contract'] })).toBe(false);
    expect(tierKeywords(['Intern', 'weird'])).toContain('weird');
  });
  it('exclude never admits a title the base filter refuses', () => {
    expect(titlePasses('Accountant', { ...base, exclude: ['nothing'] })).toBe(false);
    expect(titlePasses('Frontend Manager', { ...base, exclude: ['nothing'] })).toBe(false);
  });
  it('use_role_gate excludes a title the role gate rejects, and never admits one', () => {
    const f = { positive: ['engineer'], negative: [] as string[], use_role_gate: true };
    expect(titlePasses('QA Engineer', { positive: ['engineer'], negative: [] })).toBe(true); // base filter alone lets it through
    expect(titlePasses('QA Engineer', f)).toBe(false); // role gate deny word "qa"
    expect(titlePasses('Full Stack Engineer', f)).toBe(true);
    expect(titlePasses('Mechanical Engineer', f)).toBe(false); // no target family
    expect(titlePasses('Accountant', f)).toBe(false);
  });
  it('seniority_boost only ranks', () => {
    expect(seniorityRank('Senior React Engineer', { seniority_boost: ['senior', 'lead'] })).toBe(1);
    expect(seniorityRank('React Engineer', { seniority_boost: ['senior'] })).toBe(0);
    expect(seniorityRank('React Engineer', {})).toBe(0);
    expect(titlePasses('React Engineer', { ...base, seniority_boost: ['senior'] })).toBe(true);
  });
  it('location exclude only removes', () => {
    expect(locationAllowed(['Bengaluru, India'], false, loc)).toBe(true);
    expect(locationAllowed(['Bengaluru, India'], false, { ...loc, exclude: ['bengaluru'] })).toBe(false);
    expect(locationAllowed(['Berlin'], false, { ...loc, exclude: ['nothing'] })).toBe(false);
  });
  it('loadPortals reads the new keys and ignores bad values', () => {
    const { config, warnings } = loadPortals(cfg({
      max_posting_age_days: 30, early_stop_by_age: true,
      title_filter: { ...base, exclude: ['x'], skip_tiers: ['intern'], seniority_boost: ['senior'], use_role_gate: true },
      location_filter: { ...loc, exclude: ['mars'] },
    }));
    expect(config?.max_posting_age_days).toBe(30);
    expect(config?.early_stop_by_age).toBe(true);
    expect(config?.title_filter).toMatchObject({ exclude: ['x'], skip_tiers: ['intern'], seniority_boost: ['senior'], use_role_gate: true });
    expect(config?.location_filter.exclude).toEqual(['mars']);
    expect(warnings).toEqual([]);
    const bad = loadPortals(cfg({ max_posting_age_days: 'soon' }));
    expect(bad.config?.max_posting_age_days).toBeUndefined();
    expect(bad.warnings?.[0]).toMatch(/max_posting_age_days/);
    expect(loadPortals(cfg({ max_posting_age_days: 0 })).config?.max_posting_age_days).toBeUndefined();
  });
  it('unset options leave the loaded config without the new keys', () => {
    const { config } = loadPortals(cfg({}));
    expect(Object.keys(config!.title_filter).sort()).toEqual(['negative', 'positive']);
    expect('max_posting_age_days' in config!).toBe(false);
  });
});

describe('freshness', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  it('postingTooOld: only a valid old date is too old', () => {
    expect(postingTooOld('2026-11-01', 30, now)).toBe(false);
    expect(postingTooOld('2026-09-01', 30, now)).toBe(true);
    expect(postingTooOld(undefined, 30, now)).toBe(false);
    expect(postingTooOld('garbage', 30, now)).toBe(false);
    expect(postingTooOld('2020-01-01', undefined, now)).toBe(false);
    expect(postingTooOld('2020-01-01', 0, now)).toBe(false);
  });
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const gh = { jobs: [
    { id: 1, title: 'Frontend Engineer', absolute_url: 'https://boards.greenhouse.io/a/jobs/1', location: { name: 'India' }, content: 'x', first_published: day(2) },
    { id: 2, title: 'Frontend Engineer', absolute_url: 'https://boards.greenhouse.io/a/jobs/2', location: { name: 'India' }, content: 'x', first_published: day(200) },
    { id: 3, title: 'Frontend Engineer', absolute_url: 'https://boards.greenhouse.io/a/jobs/3', location: { name: 'India' }, content: 'x' },
  ] };
  const stub = () => vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify(gh), { status: 200 })));
  const co = [{ name: 'A', ats: 'greenhouse', slug: 'a', enabled: true }];
  it('off: everything kept (behaviour unchanged)', async () => {
    stub();
    const r = await fetchBoards({ configPath: cfg({}, co) });
    expect(r.jobs.map((j) => j.id)).toEqual(['gh:a:1', 'gh:a:2', 'gh:a:3']);
  });
  it('on: old dropped, undated kept', async () => {
    stub();
    const r = await fetchBoards({ configPath: cfg({ max_posting_age_days: 30 }, co) });
    expect(r.jobs.map((j) => j.id)).toEqual(['gh:a:1', 'gh:a:3']);
    expect(r.stats[0]).toMatchObject({ fetched: 3, kept: 2 });
  });
  it('seniority_boost orders kept jobs, boosted first, and is stable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ jobs: [
      { id: 1, title: 'Frontend Engineer', absolute_url: 'https://boards.greenhouse.io/a/jobs/1', location: { name: 'India' }, content: 'x' },
      { id: 2, title: 'Senior Frontend Engineer', absolute_url: 'https://boards.greenhouse.io/a/jobs/2', location: { name: 'India' }, content: 'x' },
      { id: 3, title: 'Frontend Developer', absolute_url: 'https://boards.greenhouse.io/a/jobs/3', location: { name: 'India' }, content: 'x' },
    ] }), { status: 200 })));
    const f = cfg({ title_filter: { ...base, seniority_boost: ['senior'] } }, co);
    const r = await fetchBoards({ configPath: f, maxPerCompany: 2 });
    expect(r.jobs.map((j) => j.id)).toEqual(['gh:a:2', 'gh:a:1']);
  });
});

describe('workday early stop by age', () => {
  const company = { name: 'Acme', ats: 'workday' as const, slug: 'acme', wd: 'wd5', site: 'External', enabled: true, max_pages: 5 };
  const page = (label: string, n: number, from: number) => ({ total: 100, jobPostings: Array.from({ length: n }, (_, i) => ({ title: `Frontend Engineer ${from + i}`, externalPath: `/job/x/J_${from + i}`, locationsText: 'India', postedOn: label })) });
  function stub() {
    const listCalls: number[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init?: any) => {
      if (String(url).endsWith('/jobs')) {
        const off = JSON.parse(init.body).offset as number;
        listCalls.push(off);
        return new Response(JSON.stringify(off === 0 ? page('Posted 2 Days Ago', 20, 0) : off === 20 ? page('Posted 5 Days Ago', 20, 20) : page('Posted 90 Days Ago', 20, off)), { status: 200 });
      }
      return new Response(JSON.stringify({ jobPostingInfo: { title: 'Frontend Engineer', jobDescription: '<p>x</p>', location: 'India', startDate: '2026-11-01', externalUrl: 'https://x.example' } }), { status: 200 });
    }));
    return listCalls;
  }
  it('without the option all pages are listed', async () => {
    const calls = stub();
    await fetchWorkday({ ...company, max_detail: 1 }, {});
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
  it('with earlyStopAgeDays paging ends at the first all-old page', async () => {
    const calls = stub();
    const notes: string[] = [];
    await fetchWorkday({ ...company, max_detail: 1 }, { earlyStopAgeDays: 30, warn: (m) => notes.push(m) });
    expect(calls).toEqual([0, 20, 40]);
    expect(notes.join(' ')).toMatch(/older than 30 days/);
  });
});
