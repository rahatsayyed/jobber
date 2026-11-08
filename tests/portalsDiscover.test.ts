import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendPortalEntries, discoverCompany, parseCareersUrl, probePlan, slugGuesses } from '../src/sources/portalsDiscover.js';
import { loadPortals } from '../src/sources/boards/filters.js';

const job = { id: 'x', source: 's', title: 't', company: 'c', url: 'https://a.example', apply_url: 'https://a.example', description: '', locations: [''], remote: false };

describe('slugGuesses and parseCareersUrl', () => {
  it('guesses from a name', () => {
    expect(slugGuesses('Razorpay Software Private Limited')).toContain('razorpay');
    expect(slugGuesses('Urban Company')).toEqual(['urban', 'urbancompany', 'urban-company']);
    expect(slugGuesses('Cal.com')).toEqual(['calcom', 'cal-com']);
  });
  it('reads vendor and slug from https ATS urls only', () => {
    expect(parseCareersUrl('https://jobs.lever.co/meesho')).toEqual({ ats: 'lever', slug: 'meesho' });
    expect(parseCareersUrl('https://boards.greenhouse.io/gitlab/jobs/1')).toEqual({ ats: 'greenhouse', slug: 'gitlab' });
    expect(parseCareersUrl('https://jobs.ashbyhq.com/Linear')).toEqual({ ats: 'ashby', slug: 'Linear' });
    expect(parseCareersUrl('https://apply.workable.com/acme/')).toEqual({ ats: 'workable', slug: 'acme' });
    expect(parseCareersUrl('https://acme.recruitee.com/')).toEqual({ ats: 'recruitee', slug: 'acme' });
    expect(parseCareersUrl('https://acme.jobs.personio.com/')).toEqual({ ats: 'personio', slug: 'acme', domain: 'com' });
    expect(parseCareersUrl('http://jobs.lever.co/meesho')).toBeNull();
    expect(parseCareersUrl('https://evil.example/jobs.lever.co/meesho')).toBeNull();
    expect(parseCareersUrl('https://user:pw@jobs.lever.co/meesho')).toBeNull();
    expect(parseCareersUrl('nonsense')).toBeNull();
  });
  it('probe plan puts the url hint first and drops invalid slugs', () => {
    const plan = probePlan({ name: 'Acme Corp', url: 'https://jobs.lever.co/acme-real' });
    expect(plan[0]).toEqual({ ats: 'lever', slug: 'acme-real' });
    expect(probePlan({ name: '!!!' })).toEqual([]);
    expect(probePlan({ name: 'Acme', vendors: ['lever'] }).every((t) => t.ats === 'lever')).toBe(true);
  });
});

describe('discoverCompany (fake fetchers, no network)', () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  it('keeps a slug only when the probe returns postings, stops at the first hit, pauses between probes', async () => {
    const seen: string[] = [];
    const fetchers: any = {
      greenhouse: async (c: any) => { seen.push(`gh:${c.slug}`); throw new Error('HTTP 404'); },
      lever: async (c: any) => { seen.push(`lever:${c.slug}`); return c.slug === 'acme' ? [job] : []; },
      ashby: async () => { seen.push('ashby'); return [job]; },
    };
    const r = await discoverCompany({ name: 'Acme' }, { fetchers, sleep, delayMs: 50, vendors: ['greenhouse', 'lever', 'ashby'] });
    expect(r.entry).toEqual({ name: 'Acme', ats: 'lever', slug: 'acme', enabled: true });
    expect(seen).not.toContain('ashby');
    expect(r.errors).toBeGreaterThan(0);
    expect(sleeps.length).toBe(r.tried - 1);
  });
  it('an empty board or an error is not a hit; nothing is invented', async () => {
    const fetchers: any = { greenhouse: async () => [], lever: async () => { throw new Error('x'); } };
    const r = await discoverCompany({ name: 'Ghost Co' }, { fetchers, sleep, delayMs: 0, vendors: ['greenhouse', 'lever'] });
    expect(r.entry).toBeNull();
    expect(r.hits).toEqual([]);
  });
  it('a seed hint is probed first but still has to answer', async () => {
    const order: string[] = [];
    const fetchers: any = { greenhouse: async (c: any) => { order.push(c.slug); return []; }, lever: async () => [] };
    await discoverCompany({ name: 'GitLab', hint: { ats: 'greenhouse', slug: 'gitlab' } }, { fetchers, sleep, delayMs: 0, vendors: ['greenhouse'] });
    expect(order[0]).toBe('gitlab');
  });
});

describe('appendPortalEntries', () => {
  const start = `{
  "tracked_companies": [
    { "name": "GitLab", "ats": "greenhouse", "slug": "gitlab", "enabled": true },
    { "name": "Linear", "ats": "ashby", "slug": "linear", "enabled": true }
  ],
  "title_filter": { "positive": ["react"], "negative": [] },
  "location_filter": { "allow": ["india"] }
}
`;
  const mk = () => { const f = path.join(mkdtempSync(path.join(tmpdir(), 'pd-')), 'portals.json'); writeFileSync(f, start); return f; };
  it('appends a validated, deduped entry and keeps the file loadable and the rest byte-identical', () => {
    const f = mk();
    const r = appendPortalEntries(f, [
      { name: 'Meesho', ats: 'lever', slug: 'meesho', enabled: true },
      { name: 'Gitlab Again', ats: 'greenhouse', slug: 'GitLab', enabled: true }, // same vendor+slug, different case
      { name: 'linear', ats: 'ashby', slug: 'other', enabled: true }, // same name
      { name: 'Bad', ats: 'recruitee', slug: 'Bad_Slug', enabled: true },
    ]);
    expect(r.added).toEqual(['Meesho']);
    expect(r.skipped.map((s) => s.name)).toEqual(['Gitlab Again', 'linear', 'Bad']);
    const text = readFileSync(f, 'utf8');
    expect(text.startsWith(start.slice(0, start.indexOf('\n  ],')))).toBe(true);
    expect(text.endsWith(start.slice(start.indexOf('\n  ],')))).toBe(true);
    const { config, warnings } = loadPortals(f);
    expect(warnings).toEqual([]);
    expect(config?.tracked_companies.map((c) => c.slug)).toEqual(['gitlab', 'linear', 'meesho']);
  });
  it('dryRun writes nothing', () => {
    const f = mk();
    const r = appendPortalEntries(f, [{ name: 'Meesho', ats: 'lever', slug: 'meesho', enabled: true }], { dryRun: true });
    expect(r.added).toEqual(['Meesho']);
    expect(readFileSync(f, 'utf8')).toBe(start);
  });
});
