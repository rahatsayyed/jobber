import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const spy = vi.fn();
vi.mock('../src/sources/boards/registry.js', () => ({
  FETCHERS: { greenhouse: (c: any, ctx: any) => spy(c, ctx), lever: vi.fn(), ashby: vi.fn() },
}));

afterEach(() => spy.mockReset());

function config(companies: any[]) {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'ctx-')), 'portals.json');
  writeFileSync(f, JSON.stringify({
    tracked_companies: companies,
    title_filter: { positive: ['frontend'], negative: ['manager'] },
    location_filter: { allow: ['india'], global: ['remote'] },
  }));
  return f;
}
const job = (id: string, title: string, locations: string[], remote = false) =>
  ({ id, source: 'greenhouse', title, company: 'A', url: 'u', apply_url: 'u', description: 'd', locations, remote });

describe('fetchBoards hands each provider a context', () => {
  it('gives a prefilter built from portals.json, the isKnown callback and a deadline inside the board budget', async () => {
    const { fetchBoards } = await import('../src/sources/boards/index.js');
    spy.mockResolvedValue([]);
    const isKnown = (id: string) => id === 'x';
    await fetchBoards({ configPath: config([{ name: 'A', ats: 'greenhouse', slug: 'a', enabled: true }]), isKnown, boardTimeoutMs: 10_000 });
    const ctx = spy.mock.calls[0][1];
    expect(ctx.isKnown).toBe(isKnown);
    expect(ctx.deadlineAt).toBeGreaterThan(Date.now());
    expect(ctx.deadlineAt).toBeLessThanOrEqual(Date.now() + 8_000);
    expect(ctx.prefilter('Frontend Engineer', ['India'], false)).toBe(true);
    expect(ctx.prefilter('Frontend Manager', ['India'], false)).toBe(false);
    expect(ctx.prefilter('Frontend Engineer', ['Berlin'], false)).toBe(false);
    expect(ctx.prefilter('Frontend Engineer', ['Remote'], true)).toBe(true);
    expect(ctx.titleOk('Frontend Engineer')).toBe(true);
    expect(ctx.titleOk('Frontend Manager')).toBe(false);
  });
  it('turns provider warnings into board errors labelled with the vendor and slug', async () => {
    const { fetchBoards } = await import('../src/sources/boards/index.js');
    spy.mockImplementation(async (_c: any, ctx: any) => { ctx.warn('partial: 40 of 400 postings detailed'); return [job('gh:a:1', 'Frontend Engineer', ['India'])]; });
    const r = await fetchBoards({ configPath: config([{ name: 'A', ats: 'greenhouse', slug: 'a', enabled: true }]) });
    expect(r.jobs.map((j) => j.id)).toEqual(['gh:a:1']);
    expect(r.errors).toEqual(['greenhouse a: partial: 40 of 400 postings detailed']);
    expect(r.stats).toEqual([{ company: 'A', ats: 'greenhouse', fetched: 1, kept: 1 }]);
  });
  it('keeps warnings collected before a per-board timeout', async () => {
    const { fetchBoards } = await import('../src/sources/boards/index.js');
    spy.mockImplementation(async (_c: any, ctx: any) => { ctx.warn('partial: 5 of 50 detailed'); return new Promise(() => {}); });
    const r = await fetchBoards({ configPath: config([{ name: 'A', ats: 'greenhouse', slug: 'a', enabled: true }]), boardTimeoutMs: 50 });
    expect(r.errors).toEqual(['greenhouse a: partial: 5 of 50 detailed', 'greenhouse a: timeout']);
  });
});
