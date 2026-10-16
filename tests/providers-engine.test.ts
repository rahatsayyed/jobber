import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFeedProvider, MAX_KEPT, mapItems, rssItems, roleTokens, titleMatchesRole, toJob, toMs, type FeedSpec } from '../src/sources/providers/feed.js';
import { IMPORTED_IDS, IMPORTED_LOADERS } from '../src/sources/providers/index.js';
import { runScriptSources } from '../src/sources/runner.js';
import { loadRegistry } from '../src/sources/registry.js';

afterEach(() => vi.unstubAllGlobals());
const ROOT = path.resolve(__dirname, '..');

const spec = (over: Partial<FeedSpec> = {}): FeedSpec => ({
  id: 'demo', label: 'Demo Board', hosts: ['demo.example'], pageUrl: (p) => `https://api.demo.example/jobs?page=${p}`, maxPages: 3, format: 'json',
  itemsOf: (d: any) => { if (!Array.isArray(d?.items)) throw new Error('bad envelope'); return d.items; },
  hasMore: (d: any) => d.more === true,
  map: (i: any) => ({ title: i.t, company: i.c, url: i.u, location: i.l, remote: i.r, description: i.d, posted: i.p }),
  shapeSpec: z.object({ t: z.string() }).passthrough(), ...over,
});
const item = (n: number, over: Record<string, unknown> = {}) => ({ t: `React Developer ${n}`, c: `Co ${n}`, u: `https://demo.example/jobs/${n}`, l: 'Remote', r: true, ...over });
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });

describe('feed engine helpers', () => {
  it('toMs reads epoch seconds, milliseconds and date strings, nothing else', () => {
    expect(toMs(1759400000)).toBe(1759400000000);
    expect(toMs(1759400000000)).toBe(1759400000000);
    expect(toMs('2025-10-02T10:00:00Z')).toBe(Date.parse('2025-10-02T10:00:00Z'));
    for (const bad of [undefined, null, 0, -5, 'soon', '', {}, NaN]) expect(toMs(bad)).toBeUndefined();
  });
  it('roleTokens drops short and filler words; an empty role matches everything', () => {
    expect(roleTokens('full stack developer / react')).toEqual(['full', 'stack', 'developer', 'react']);
    expect(roleTokens('')).toEqual([]);
    expect(titleMatchesRole('Anything', [])).toBe(true);
    expect(titleMatchesRole('Senior REACT Engineer', ['react'])).toBe(true);
    expect(titleMatchesRole('Chef', ['react'])).toBe(false);
  });
  it('rssItems returns one plain object per item and throws without an rss channel', () => {
    const items = rssItems('<rss><channel><item><title>A</title><link>https://x.example/a</link><x:y>z</x:y></item></channel></rss>');
    expect(items).toEqual([{ title: 'A', link: 'https://x.example/a', 'x:y': 'z' }]);
    expect(() => rssItems('<html></html>')).toThrow(/no rss channel/);
  });
});

describe('toJob', () => {
  const s = spec();
  it('keeps https on an allowed host, hashes the id, clips text and adds the Location line and a listing-only note', () => {
    const j = toJob(s, { title: ' T '.repeat(200), company: '', url: 'https://www.demo.example/jobs/1', location: 'Paris', remote: false })!;
    expect(j.id).toMatch(/^demo:[0-9a-f]{16}$/);
    expect(j.title.length).toBeLessThanOrEqual(300);
    expect(j.company).toBe('Demo Board');
    expect(j.description.startsWith('Location: Paris\n\nListing only')).toBe(true);
  });
  it.each([
    'http://demo.example/jobs/1', 'https://demo.example.evil.io/x', 'https://evil.example/demo.example', 'https://user:pw@demo.example/x',
    'https://DEMO.example/x', 'https://demo.example:8443/x', 'javascript:alert(1)', '', '//demo.example/x',
  ])('drops a posting URL like %s', (url) => {
    expect(toJob(s, { title: 'T', url })).toBeNull();
  });
  it('drops an empty title and an over-long URL', () => {
    expect(toJob(s, { title: '  ', url: 'https://demo.example/a' })).toBeNull();
    expect(toJob(s, { title: 'T', url: `https://demo.example/${'a'.repeat(2100)}` })).toBeNull();
  });
  it('uses the feed description (HTML stripped) when there is one and ignores an unreadable date', () => {
    const j = toJob(s, { title: 'T', url: 'https://demo.example/a', description: '<p>Hello <b>world</b></p>', posted: 'soon' })!;
    expect(j.description).toBe('Hello world');
    expect(j.posted_at).toBeUndefined();
  });
});

describe('mapItems', () => {
  it('skips a mapper that throws or returns null, dedupes by URL and caps at MAX_KEPT', () => {
    const s = spec({ map: (i: any) => { if (i.boom) throw new Error('x'); return i.skip ? null : { title: i.t, url: i.u }; } });
    const items = [{ boom: true }, { skip: true }, { t: 'A', u: 'https://demo.example/1' }, { t: 'A again', u: 'https://demo.example/1' }];
    expect(mapItems(s, items)).toHaveLength(1);
    const many = Array.from({ length: MAX_KEPT + 50 }, (_, n) => ({ t: 'T', u: `https://demo.example/${n}` }));
    expect(mapItems(s, many)).toHaveLength(MAX_KEPT);
  });
  it('filters by role tokens on the title', () => {
    const s = spec();
    expect(mapItems(s, [item(1), item(2, { t: 'Chef' })], roleTokens('react')).map((j) => j.title)).toEqual(['React Developer 1']);
  });
});

describe('makeFeedProvider', () => {
  it('pages while hasMore is true, stops at maxPages, and returns up to 5 raw items as the sample', async () => {
    const f = vi.fn(async (u: string) => json({ items: Array.from({ length: 4 }, (_, n) => item(Number(/page=(\d)/.exec(u)![1]) * 10 + n)), more: true }));
    vi.stubGlobal('fetch', f);
    const r = await makeFeedProvider(spec()).fetch({ params: { role: 'react' } });
    expect(f).toHaveBeenCalledTimes(3);
    expect(r.jobs).toHaveLength(12);
    expect(r.sample).toHaveLength(5);
  });
  it('passes the previous document to pageUrl (cursor feeds)', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { urls.push(u); return json({ items: [item(urls.length)], more: urls.length < 2, next: 'c2' }); }));
    await makeFeedProvider(spec({ pageUrl: (_p, prev: any) => `https://api.demo.example/jobs?cursor=${prev?.next ?? 'start'}` })).fetch({});
    expect(urls).toEqual(['https://api.demo.example/jobs?cursor=start', 'https://api.demo.example/jobs?cursor=c2']);
  });
  it('a failing first page throws with the source id; a failing later page keeps the earlier ones and warns', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    await expect(makeFeedProvider(spec()).fetch({})).rejects.toThrow(/^demo/);
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (++n === 1 ? json({ items: [item(1)], more: true }) : new Response('', { status: 500 }))));
    const warns: string[] = [];
    const r = await makeFeedProvider(spec()).fetch({ warn: (m) => warns.push(m) });
    expect(r.jobs).toHaveLength(1);
    expect(warns.join(' ')).toMatch(/page 2 failed/);
  });
  it('stops starting requests after the deadline', async () => {
    const f = vi.fn(async () => json({ items: [item(1)], more: true }));
    vi.stubGlobal('fetch', f);
    const r = await makeFeedProvider(spec()).fetch({ deadlineAt: Date.now() - 1, warn: () => undefined });
    expect(f).not.toHaveBeenCalled();
    expect(r.jobs).toEqual([]);
  });
  it('a wrong envelope on page one is an error naming the source, never an empty success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ nope: 1 })));
    await expect(makeFeedProvider(spec()).fetch({})).rejects.toThrow('demo: bad envelope');
  });
});

describe('registry, files, loaders and tests stay in step', () => {
  const dir = path.join(ROOT, 'src', 'sources', 'providers');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'feed.ts' && f !== 'index.ts').map((f) => f.slice(0, -3)).sort();
  const { platforms } = loadRegistry();
  const rows = platforms.filter((p) => p.provider?.startsWith('providers/'));

  it('every provider file is listed, loadable, registered and has a test and a fixture', () => {
    expect([...IMPORTED_IDS].sort()).toEqual(files);
    expect(rows.map((r) => r.id).sort()).toEqual(files);
    expect(Object.keys(IMPORTED_LOADERS).sort()).toEqual(files.map((f) => `providers/${f}`));
    const tests = new Set(readdirSync(path.join(ROOT, 'tests', 'providers')));
    const fixtures = new Set(readdirSync(path.join(ROOT, 'tests', 'fixtures', 'providers')));
    for (const f of files) {
      expect(tests.has(`${f}.test.ts`), `${f} test`).toBe(true);
      expect(fixtures.has(`${f}.json`) || fixtures.has(`${f}.xml`), `${f} fixture`).toBe(true);
    }
  });
  it('every imported row is disabled, fixture-stability, MIT-attributed and has a unique id', () => {
    for (const r of rows) {
      expect(r.enabled, r.id).toBe(false);
      expect(r.stability, r.id).toBe('fixture');
      expect(r.attribution?.license, r.id).toBe('MIT');
      expect(r.attribution?.url, r.id).toBe('https://github.com/career-ops-hq/career-ops');
    }
    expect(new Set(platforms.map((p) => p.id)).size).toBe(platforms.length);
  });
  it('each provider id is the id of the module it loads', async () => {
    for (const id of files) expect((await IMPORTED_LOADERS[`providers/${id}`]()).provider.id).toBe(id);
  });
});

describe('runner integration', () => {
  it('runs an enabled imported row through the script-first runner and keeps the jobs; a disabled row is not run', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jobber-'));
    const reg = path.join(dir, 'platforms.json');
    const real = JSON.parse(readFileSync(path.join(ROOT, 'config', 'platforms.json'), 'utf8')) as { platforms: any[] };
    const only = real.platforms.filter((p) => p.id === 'jobicy' || p.id === 'workingnomads').map((p) => ({ ...p, enabled: p.id === 'jobicy' }));
    writeFileSync(reg, JSON.stringify({ platforms: only }));
    const f = vi.fn(async (u: string) => (String(u).includes('jobicy.com')
      ? json({ jobs: [{ jobTitle: 'React Engineer', url: 'https://jobicy.com/jobs/9-react', companyName: 'Acme', jobGeo: 'Anywhere' }] })
      : new Response('[]', { status: 200 })));
    vi.stubGlobal('fetch', f);
    const r = await runScriptSources(null, { role: 'react', registryPath: reg, portalsPath: path.join(dir, 'none.json') });
    expect(r.jobs.map((j) => j.source)).toEqual(['jobicy']);
    expect(r.outcomes.find((o) => o.id === 'jobicy')).toMatchObject({ fetched: 1, kept: 1 });
    expect(r.outcomes.find((o) => o.id === 'workingnomads')).toBeUndefined();
    expect(f.mock.calls.every((c) => String(c[0]).startsWith('https://jobicy.com/'))).toBe(true);
  });
});
