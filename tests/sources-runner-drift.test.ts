import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { openDb } from '../src/db.js';
import { runScriptSources, type Provider } from '../src/sources/runner.js';
import { recordRun } from '../src/sources/status.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ jobs: [] }), { status: 200 })));
});

const dir = mkdtempSync(path.join(tmpdir(), 'runner-drift-'));
let n = 0;
function file(name: string, body: unknown): string { const f = path.join(dir, `${n++}-${name}`); writeFileSync(f, JSON.stringify(body)); return f; }
const portals = () => file('portals.json', {
  tracked_companies: [{ name: 'A', ats: 'greenhouse', slug: 'a', enabled: true }],
  title_filter: { positive: ['frontend'], negative: ['manager'] },
  location_filter: { allow: ['india', 'bengaluru'], global: ['remote'] },
});
const registry = (extra: any[] = []) => file('platforms.json', { platforms: [
  { id: 'greenhouse', kind: 'board', label: 'Greenhouse', provider: 'boards/greenhouse', tier: 'script', enabled: true, stability: 'fixture' },
  ...extra,
] });
const apiRow = (id: string) => ({ id, kind: 'api', label: id, provider: id, tier: 'script', enabled: true, stability: 'fixture' });
const ghItem = (over: object = {}) => ({ id: 1, title: 'Frontend Engineer', absolute_url: 'https://boards.greenhouse.io/a/jobs/1', location: { name: 'Bengaluru' }, content: 'body', ...over });
const ghFetch = (jobs: unknown[]) => vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ jobs }), { status: 200 })));
const NOW = new Date('2026-10-16T10:00:00Z');
const tasks = (db: ReturnType<typeof openDb>) => db.prepare('SELECT platform, company, reason, state FROM source_tasks ORDER BY id').all() as any[];
const optsOf = () => ({ role: 'r', portalsPath: portals(), registryPath: registry(), now: () => NOW });
const ghRow = (r: { rows: any[] }) => r.rows.find((x) => x.source === 'greenhouse')!;

// Seed the stored baseline (hash of this item shape, kept = `kept`) the way list_new_jobs would after a run.
async function seed(db: ReturnType<typeof openDb>, item: object, kept: number): Promise<string> {
  ghFetch([item]);
  const first = await runScriptSources(db, optsOf());
  const h = first.outcomes.find((o) => o.id === 'greenhouse')!.shape_hash!;
  recordRun(db, 'greenhouse', { fetched: 1, kept, new: 0, shape_hash: h });
  return h;
}

describe('drift detection', () => {
  it('a required key changing type, raw items fetched, nothing kept after a run that kept jobs is drift', async () => {
    const db = openDb(':memory:');
    await seed(db, ghItem(), 3);
    ghFetch([ghItem({ id: 'abc', title: 'Data Analyst' })]);
    const r = await runScriptSources(db, optsOf());
    expect(ghRow(r).fallback_used).toBe(true);
    expect(ghRow(r).error).toMatch(/drift/);
    expect(tasks(db)).toEqual([{ platform: 'greenhouse', company: null, reason: 'drift', state: 'queued' }]);
  });

  it('false positive: optional fields appearing or vanishing never move the hash', async () => {
    const db = openDb(':memory:');
    const h = await seed(db, ghItem({ departments: [{ id: 1 }] }), 3);
    ghFetch([ghItem({ title: 'Data Analyst', extraNewKey: 'x', metadata: { a: 1 } })]);
    const r = await runScriptSources(db, optsOf());
    expect(r.outcomes.find((o) => o.id === 'greenhouse')!.shape_hash).toBe(h);
    expect(ghRow(r).fallback_used).toBe(false);
    expect(tasks(db)).toEqual([]);
  });

  it('false positive: a strict filter (zero kept, unchanged hash) is not drift; a changed hash with jobs kept is not drift', async () => {
    const db = openDb(':memory:');
    await seed(db, ghItem(), 3);
    ghFetch([ghItem({ title: 'Data Analyst' })]);
    expect(ghRow(await runScriptSources(db, optsOf())).fallback_used).toBe(false);
    ghFetch([ghItem({ id: '5' })]); // id number -> numeric string: the hash changes, but the posting is kept
    expect(ghRow(await runScriptSources(db, optsOf())).fallback_used).toBe(false);
    expect(tasks(db)).toEqual([]);
  });

  it('false positive: an empty board (no raw items) with a stored baseline is not drift', async () => {
    const db = openDb(':memory:');
    await seed(db, ghItem(), 3);
    ghFetch([]);
    expect(ghRow(await runScriptSources(db, optsOf())).fallback_used).toBe(false);
    expect(tasks(db)).toEqual([]);
  });

  it('an API provider: optional-field variance is not drift, a required type change with nothing kept is', async () => {
    const db = openDb(':memory:');
    const spec = z.object({ id: z.union([z.number(), z.string()]), title: z.string() }).passthrough();
    const mk = (sample: unknown[], jobsOut: any[]): Provider => ({ id: 'remotive', shapeSpec: spec, fetch: async () => ({ jobs: jobsOut, sample }) });
    const o = (p: Provider) => ({ role: 'r', portalsPath: portals(), registryPath: registry([apiRow('remotive')]), providers: { remotive: p }, now: () => NOW });
    const aj = { id: 'remotive:1', source: 'remotive', title: 'T', company: 'C', url: 'u', apply_url: 'u', description: 'd' };
    const first = await runScriptSources(db, o(mk([{ id: 1, title: 't' }], [aj])));
    recordRun(db, 'remotive', { fetched: 1, kept: 1, new: 0, shape_hash: first.outcomes.find((x) => x.id === 'remotive')!.shape_hash });
    const same = await runScriptSources(db, o(mk([{ id: 2, title: 't', extra: 1 }], [])));
    expect(same.rows.find((x) => x.source === 'remotive')!.fallback_used).toBe(false);
    const drift = await runScriptSources(db, o(mk([{ id: 'two', title: 't' }], [])));
    expect(drift.rows.find((x) => x.source === 'remotive')!.error).toMatch(/drift/);
    // an API source has no target URL: note instead of a source task (finding 8)
    expect(tasks(db).filter((t) => t.platform === 'remotive')).toEqual([]);
  });

  it('recordRun keeps the stored shape_hash when a failed run passes none', () => {
    const db = openDb(':memory:');
    recordRun(db, 'greenhouse', { fetched: 1, kept: 1, new: 0, shape_hash: 'c'.repeat(64) });
    recordRun(db, 'greenhouse', { fetched: 0, kept: 0, new: 0, error: 'boom', fallback_used: true });
    expect(db.prepare('SELECT shape_hash, streak_fail FROM platform_status WHERE id = ?').get('greenhouse')).toEqual({ shape_hash: 'c'.repeat(64), streak_fail: 1 });
  });

  it('mixed board: one company fails and another is fine -> good jobs stay, only the failing company gets a task', async () => {
    const db = openDb(':memory:');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) =>
      String(url).includes('/boards/bad/') ? new Response('boom', { status: 500 }) : new Response(JSON.stringify({ jobs: [ghItem()] }), { status: 200 })));
    const cfg = file('portals.json', {
      tracked_companies: [{ name: 'A', ats: 'greenhouse', slug: 'a', enabled: true }, { name: 'Bad', ats: 'greenhouse', slug: 'bad', enabled: true }],
      title_filter: { positive: ['frontend'], negative: [] },
      location_filter: { allow: ['bengaluru'], global: ['remote'] },
    });
    const r = await runScriptSources(db, { role: 'r', portalsPath: cfg, registryPath: registry(), now: () => NOW });
    expect(r.jobs.map((j) => j.id)).toEqual(['gh:a:1']);
    expect(ghRow(r).fallback_used).toBe(true);
    expect(tasks(db)).toEqual([{ platform: 'greenhouse', company: 'Bad', reason: 'error', state: 'queued' }]);
  });
});
