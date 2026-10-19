// Finding 8: a failed API source has no board or target URL, so the source-operator could only fail its task
// every wake. It gets a note in source_status instead of a source_task; board sources still queue one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { openDb } from '../src/db.js';
import { runScriptSources, type Provider } from '../src/sources/runner.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ jobs: [] }), { status: 200 })));
});

const dir = mkdtempSync(path.join(tmpdir(), 'runner-notarget-'));
const file = (name: string, body: unknown): string => { const f = path.join(dir, `${Math.random().toString(36).slice(2)}-${name}`); writeFileSync(f, JSON.stringify(body)); return f; };
const portals = () => file('portals.json', {
  tracked_companies: [{ name: 'A', ats: 'greenhouse', slug: 'a', enabled: true }],
  title_filter: { positive: ['frontend'], negative: ['manager'] },
  location_filter: { allow: ['india'], global: ['remote'] },
});
const apiRow = (id: string) => ({ id, kind: 'api', label: id, provider: id, tier: 'script', enabled: true, stability: 'fixture' });
const registry = (rows: unknown[]) => file('platforms.json', { platforms: [
  { id: 'greenhouse', kind: 'board', label: 'Greenhouse', provider: 'boards/greenhouse', tier: 'script', enabled: true, stability: 'fixture' },
  ...rows,
] });
const spec = z.object({ id: z.number(), title: z.string() }).passthrough();
const failing = (id: string): Provider => ({ id, shapeSpec: spec, fetch: async () => { throw new Error('Adzuna request failed: 400 (params: app_id, what)'); } });
const NOW = new Date('2026-10-19T10:00:00Z');
const tasks = (db: ReturnType<typeof openDb>) => db.prepare('SELECT platform, company, reason FROM source_tasks').all();

describe('failed source without a target URL', () => {
  it('an API source that throws gets an error and a note, and no source_task', async () => {
    const db = openDb(':memory:');
    const r = await runScriptSources(db, { role: 'r', portalsPath: portals(), registryPath: registry([apiRow('adzuna')]), providers: { adzuna: failing('adzuna') }, now: () => NOW });
    const row = r.rows.find((x) => x.source === 'adzuna')!;
    expect(row.error).toMatch(/400/);
    expect(row.fallback_used).toBe(false);
    expect(row.note).toMatch(/no board url/);
    expect(tasks(db).filter((t: any) => t.platform === 'adzuna')).toEqual([]);
  });

  it('a shape-failed API source is handled the same way', async () => {
    const db = openDb(':memory:');
    const bad: Provider = { id: 'remotive', shapeSpec: spec, fetch: async () => ({ jobs: [], sample: [{ id: 'x', nope: 1 }] }) };
    const r = await runScriptSources(db, { role: 'r', portalsPath: portals(), registryPath: registry([apiRow('remotive')]), providers: { remotive: bad }, now: () => NOW });
    expect(r.rows.find((x) => x.source === 'remotive')).toMatchObject({ fallback_used: false });
    expect(tasks(db).filter((t: any) => t.platform === 'remotive')).toEqual([]);
  });

  it('a board failure still queues its task', async () => {
    const db = openDb(':memory:');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('nope', { status: 500 })));
    await runScriptSources(db, { role: 'r', portalsPath: portals(), registryPath: registry([]), now: () => NOW });
    expect(tasks(db).some((t: any) => t.platform === 'greenhouse')).toBe(true);
  });
});
