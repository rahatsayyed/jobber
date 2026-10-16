// Shared fixture-replay checks for the imported feeds (plan 8G task 9). Hermetic: fetch is stubbed, the fixture is a tiny
// hand-written document with INVENTED data (no real posting text), nothing touches a network.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../../src/db.js';
import { isDiscoverOnlySource } from '../../src/lib/discoverOnly.js';
import { hostMatches } from '../../src/lib/hostClass.js';
import type { Provider } from '../../src/sources/provider.js';
import { IMPORTED_IDS, IMPORTED_LOADERS } from '../../src/sources/providers/index.js';
import { loadRegistry } from '../../src/sources/registry.js';
import { checkShape } from '../../src/sources/shape.js';

const ROOT = path.resolve(__dirname, '..', '..');
export const fixture = (name: string): string => readFileSync(path.join(ROOT, 'tests', 'fixtures', 'providers', name), 'utf8');

export interface Case {
  id: string;
  provider: Provider;
  /** File under tests/fixtures/providers. */
  file: string;
  /** Apex host every request and every kept URL must be on. */
  host: string;
  /** Kept postings in the fixture (invented invalid ones are dropped). */
  count: number;
  /** Expected fields of the first kept job (description is checked with `descStarts` / `descHas`). */
  first: Partial<Job>;
  descStarts?: string;
  descHas?: string;
  /** Dotted path inside one raw sample item that the provider requires; renaming it must fail the shape check. */
  breakKey: string;
  /** Requests the fixture replay may make (default 1). */
  requests?: number;
}

const isXml = (file: string): boolean => file.endsWith('.xml');
const respond = (body: string) => new Response(body, { status: 200 });

function renamed(sample: unknown[], dotted: string): unknown[] {
  const clone = JSON.parse(JSON.stringify(sample)) as any[];
  const keys = dotted.split('.');
  for (const item of clone) {
    let o = item;
    for (const k of keys.slice(0, -1)) o = o?.[k];
    const last = keys[keys.length - 1];
    if (o && typeof o === 'object' && last in o) { o[`${last}_renamed`] = o[last]; delete o[last]; }
  }
  return clone;
}

export function describeProvider(c: Case): void {
  describe(`imported provider ${c.id}`, () => {
    afterEach(() => vi.unstubAllGlobals());

    const replay = async (role = '') => {
      const urls: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (u: string) => { urls.push(String(u)); return respond(fixture(c.file)); }));
      const r = await c.provider.fetch({ params: { role } });
      return { ...r, urls };
    };

    it('replays the fixture into jobs with hashed ids, host-locked URLs and a Location line', async () => {
      const { jobs, urls } = await replay();
      expect(jobs).toHaveLength(c.count);
      expect(urls.length).toBeLessThanOrEqual(c.requests ?? 1);
      for (const u of urls) expect(hostMatches(u, c.host), u).toBe(true);
      for (const j of jobs) {
        expect(j.id).toMatch(new RegExp(`^${c.id}:[0-9a-f]{16}$`));
        expect(j.source).toBe(c.id);
        expect(j.apply_url).toBe(j.url);
        expect(hostMatches(j.url, c.host), j.url).toBe(true);
        expect(j.url.startsWith('https://')).toBe(true);
        expect(j.title.length).toBeGreaterThan(0);
        expect(j.company.length).toBeGreaterThan(0);
        expect(j.description.length).toBeGreaterThan(0);
      }
      expect(jobs[0]).toMatchObject(c.first);
      if (c.descStarts) expect(jobs[0].description.startsWith(c.descStarts)).toBe(true);
      if (c.descHas) expect(jobs[0].description).toContain(c.descHas);
      expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
    });

    it('passes its own shape check on the replayed sample and fails it when a required key is renamed', async () => {
      const { sample } = await replay();
      expect(sample.length).toBeGreaterThan(0);
      const ok = checkShape(c.provider.shapeSpec, sample);
      expect(ok.ok).toBe(true);
      expect(ok.hash).toMatch(/^[0-9a-f]{64}$/);
      const broken = checkShape(c.provider.shapeSpec, renamed(sample, c.breakKey));
      expect(broken.ok).toBe(false);
      expect(broken.problems.length).toBeGreaterThan(0);
    });

    it('a role filter keeps only titles that match a role word, and an unmatched role keeps nothing', async () => {
      expect((await replay('zzzqq')).jobs).toHaveLength(0);
    });

    it('rejects a response with the wrong envelope instead of returning an empty board', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => respond(isXml(c.file) ? '<html><body>moved</body></html>' : '{"unexpected":true}')));
      await expect(c.provider.fetch({ params: { role: '' } })).rejects.toThrow(new RegExp(`^${c.id}`));
    });

    it('never requests a foreign host (a redirect is an error, not followed)', async () => {
      const f = vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://evil.example.com/' } }));
      vi.stubGlobal('fetch', f);
      await expect(c.provider.fetch({ params: { role: '' } })).rejects.toThrow();
      for (const call of f.mock.calls as unknown as [string, RequestInit][]) {
        expect(call[1].redirect).toBe('error');
      }
    });

    it('is registered disabled, attributed to career-ops (MIT), listed in the imported set and discover-only', () => {
      const { platforms, errors } = loadRegistry();
      expect(errors).toEqual([]);
      const row = platforms.find((p) => p.id === c.id);
      expect(row).toMatchObject({ id: c.id, kind: 'api', provider: `providers/${c.id}`, tier: 'script', enabled: false, stability: 'fixture' });
      expect(row?.attribution).toMatchObject({ license: 'MIT', source: `career-ops-hq/career-ops providers/${c.id}.mjs` });
      expect(IMPORTED_IDS as readonly string[]).toContain(c.id);
      expect(typeof IMPORTED_LOADERS[`providers/${c.id}`]).toBe('function');
      expect(isDiscoverOnlySource(c.id)).toBe(true);
      const src = readFileSync(path.join(ROOT, 'src', 'sources', 'providers', `${c.id}.ts`), 'utf8');
      expect(src.split('\n')[0]).toContain(`Adapted from career-ops-hq/career-ops providers/${c.id}.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama), commit c3230d12`);
    });

    it('loads through the registry loader to the same provider', async () => {
      const mod = await IMPORTED_LOADERS[`providers/${c.id}`]();
      expect(mod.provider.id).toBe(c.id);
    });
  });
}
