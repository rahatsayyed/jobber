import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { openDb } from '../src/db.js';
import { runScriptSources, type Provider } from '../src/sources/runner.js';
import { recordRun } from '../src/sources/status.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
// Hermetic: no test may reach the network; a test that cares re-stubs fetch itself.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ jobs: [] }), { status: 200 })));
});

const dir = mkdtempSync(path.join(tmpdir(), 'runner-'));
function file(name: string, body: unknown): string { const f = path.join(dir, `${Math.random().toString(36).slice(2)}-${name}`); writeFileSync(f, JSON.stringify(body)); return f; }
const portals = () => file('portals.json', {
  tracked_companies: [{ name: 'A', ats: 'greenhouse', slug: 'a', enabled: true }],
  title_filter: { positive: ['frontend'], negative: ['manager'] },
  location_filter: { allow: ['india', 'bengaluru'], global: ['remote'] },
});
const registry = (extra: any[] = []) => file('platforms.json', { platforms: [
  { id: 'greenhouse', kind: 'board', label: 'Greenhouse', provider: 'boards/greenhouse', tier: 'script', enabled: true, stability: 'fixture' },
  ...extra,
] });
const apiRow = (id: string, extra: object = {}) => ({ id, kind: 'api', label: id, provider: id, tier: 'script', enabled: true, stability: 'fixture', ...extra });

const ghItem = (over: object = {}) => ({ id: 1, title: 'Frontend Engineer', absolute_url: 'https://boards.greenhouse.io/a/jobs/1', location: { name: 'Bengaluru' }, content: 'body', ...over });
const ghFetch = (jobs: unknown[]) => vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ jobs }), { status: 200 })));

const okSpec = z.object({ id: z.number(), title: z.string() }).passthrough();
const fakeProvider = (id: string, run: () => Promise<{ jobs: any[]; sample: unknown[] }>): Provider => ({ id, shapeSpec: okSpec, fetch: run });
const job = (id: string, source: string) => ({ id, source, title: 'T', company: 'C', url: 'u', apply_url: 'u', description: 'd' });

const NOW = new Date('2026-10-16T10:00:00Z');
const tasks = (db: ReturnType<typeof openDb>) => db.prepare('SELECT platform, company, reason, state FROM source_tasks ORDER BY id').all() as any[];

describe('runScriptSources', () => {
  it('runs boards and api providers, keeps filters and the location line, queues nothing when healthy', async () => {
    const db = openDb(':memory:');
    ghFetch([ghItem(), ghItem({ id: 2, title: 'Data Analyst' })]);
    const adz = fakeProvider('naukri', async () => ({ jobs: [job('naukri:1', 'naukri')], sample: [{ id: 1, title: 't' }] }));
    const r = await runScriptSources(db, { role: 'r', portalsPath: portals(), registryPath: registry([apiRow('naukri')]), providers: { naukri: adz }, now: () => NOW });
    expect(r.jobs.map((j) => j.id).sort()).toEqual(['gh:a:1', 'naukri:1']);
    expect(r.jobs.find((j) => j.id === 'gh:a:1')!.description.startsWith('Location: Bengaluru\n\n')).toBe(true);
    const gh = r.rows.find((x) => x.source === 'greenhouse')!;
    expect(gh).toMatchObject({ fetched: 2, kept: 1, fallback_used: false, kind: 'script', group: 'board' });
    expect(gh.error).toBeUndefined();
    expect(r.rows.find((x) => x.source === 'naukri')).toMatchObject({ fetched: 1, kept: 1, fallback_used: false });
    expect(tasks(db)).toEqual([]);
    expect(r.outcomes.find((o) => o.id === 'greenhouse')!.shape_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a renamed key breaks the shape and queues exactly one source_tasks row, once per day', async () => {
    const db = openDb(':memory:');
    ghFetch([ghItem({ title: undefined, name: 'Frontend Engineer' })]);
    const opts = { role: 'r', portalsPath: portals(), registryPath: registry(), now: () => NOW };
    const r1 = await runScriptSources(db, opts);
    const gh = r1.rows.find((x) => x.source === 'greenhouse')!;
    expect(gh.fallback_used).toBe(true);
    expect(gh.error).toMatch(/shape/);
    expect(tasks(db)).toEqual([{ platform: 'greenhouse', company: 'A', reason: 'shape', state: 'queued' }]);
    await runScriptSources(db, opts);
    expect(tasks(db)).toHaveLength(1);
    await runScriptSources(db, { ...opts, now: () => new Date('2026-10-17T10:00:00Z') });
    expect(tasks(db)).toHaveLength(2);
  });

  it('a shape-failed provider keeps the valid jobs it returned', async () => {
    const db = openDb(':memory:');
    const p = fakeProvider('naukri', async () => ({ jobs: [job('naukri:1', 'naukri')], sample: [{ id: 'x', nope: 1 }] }));
    const r = await runScriptSources(db, { role: 'r', portalsPath: portals(), registryPath: registry([apiRow('naukri')]), providers: { naukri: p }, now: () => NOW });
    expect(r.jobs.map((j) => j.id)).toContain('naukri:1');
    expect(r.rows.find((x) => x.source === 'naukri')).toMatchObject({ fallback_used: false, note: expect.stringMatching(/no board url/) });
    expect(r.rows.find((x) => x.source === 'naukri')!.error).toMatch(/shape/);
    // an API source has no target URL: a note, not a source task (finding 8)
    expect(tasks(db)).toEqual([]);
  });

  it('hash change with zero kept after kept>0 is drift', async () => {
    const db = openDb(':memory:');
    recordRun(db, 'greenhouse', { fetched: 5, kept: 3, new: 0, shape_hash: 'a'.repeat(64) });
    ghFetch([ghItem({ title: 'Data Analyst', extraNewKey: 'x' })]);
    const r = await runScriptSources(db, { role: 'r', portalsPath: portals(), registryPath: registry(), now: () => NOW });
    const gh = r.rows.find((x) => x.source === 'greenhouse')!;
    expect(gh.fallback_used).toBe(true);
    expect(gh.error).toMatch(/drift/);
    expect(tasks(db)).toEqual([{ platform: 'greenhouse', company: null, reason: 'drift', state: 'queued' }]);
  });

  it('the same hash with zero kept is not drift, and a changed hash with jobs kept is not drift', async () => {
    const db = openDb(':memory:');
    ghFetch([ghItem({ title: 'Data Analyst' })]);
    const opts = { role: 'r', portalsPath: portals(), registryPath: registry(), now: () => NOW };
    const first = await runScriptSources(db, opts);
    recordRun(db, 'greenhouse', { fetched: 1, kept: 2, new: 0, shape_hash: first.outcomes.find((o) => o.id === 'greenhouse')!.shape_hash });
    expect((await runScriptSources(db, opts)).rows.find((x) => x.source === 'greenhouse')!.fallback_used).toBe(false);
    recordRun(db, 'greenhouse', { fetched: 1, kept: 2, new: 0, shape_hash: 'b'.repeat(64) });
    ghFetch([ghItem({ extraNewKey: 'x' })]);
    expect((await runScriptSources(db, opts)).rows.find((x) => x.source === 'greenhouse')!.fallback_used).toBe(false);
    expect(tasks(db)).toEqual([]);
  });

  it('a throwing provider does not affect the others, queues an error task, and a timeout is an error too', async () => {
    const db = openDb(':memory:');
    ghFetch([ghItem()]);
    const boom = fakeProvider('remotive', async () => { throw new Error('remotive down app_key=SECRET'); });
    const hang = fakeProvider('remoteok', () => new Promise(() => {}));
    const ok = fakeProvider('naukri', async () => ({ jobs: [job('naukri:1', 'naukri')], sample: [] }));
    const r = await runScriptSources(db, {
      role: 'r', portalsPath: portals(), providerTimeoutMs: 30, now: () => NOW,
      registryPath: registry([apiRow('naukri'), apiRow('remotive'), apiRow('remoteok')]),
      providers: { naukri: ok, remotive: boom, remoteok: hang },
    });
    expect(r.jobs.map((j) => j.id).sort()).toEqual(['gh:a:1', 'naukri:1']);
    const rem = r.rows.find((x) => x.source === 'remotive')!;
    expect(rem.error).toContain('remotive down');
    expect(rem.error).not.toContain('SECRET');
    expect(rem.fallback_used).toBe(false);
    expect(rem.note).toMatch(/no board url/);
    expect(r.rows.find((x) => x.source === 'remoteok')!.error).toMatch(/timeout/);
    expect(tasks(db)).toEqual([]);
  });

  it('a board that errors queues an error task for that company', async () => {
    const db = openDb(':memory:');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));
    const r = await runScriptSources(db, { role: 'r', portalsPath: portals(), registryPath: registry(), now: () => NOW });
    expect(r.rows.find((x) => x.source === 'greenhouse')).toMatchObject({ fallback_used: true });
    expect(tasks(db)).toEqual([{ platform: 'greenhouse', company: 'A', reason: 'error', state: 'queued' }]);
  });

  it('three failures in a row mark the platform flaky', async () => {
    const db = openDb(':memory:');
    recordRun(db, 'remotive', { fetched: 0, kept: 0, new: 0, error: 'x' });
    recordRun(db, 'remotive', { fetched: 0, kept: 0, new: 0, error: 'x' });
    const boom = fakeProvider('remotive', async () => { throw new Error('down'); });
    const r = await runScriptSources(db, { role: 'r', portalsPath: portals(), registryPath: registry([apiRow('remotive')]), providers: { remotive: boom }, now: () => NOW });
    const row = r.rows.find((x) => x.source === 'remotive')!;
    expect(row.flaky).toBe(true);
    expect(row.note).toMatch(/flaky/);
    const once = await runScriptSources(openDb(':memory:'), { role: 'r', portalsPath: portals(), registryPath: registry([apiRow('remotive')]), providers: { remotive: boom }, now: () => NOW });
    expect(once.rows.find((x) => x.source === 'remotive')!.flaky).toBeUndefined();
  });

  it('a disabled api row is not run', async () => {
    const db = openDb(':memory:');
    ghFetch([]);
    const p = fakeProvider('naukri', async () => { throw new Error('should not run'); });
    const r = await runScriptSources(db, { role: 'r', portalsPath: portals(), registryPath: registry([apiRow('naukri', { enabled: false })]), providers: { naukri: p }, now: () => NOW });
    expect(r.rows.find((x) => x.source === 'naukri')).toBeUndefined();
  });
});
