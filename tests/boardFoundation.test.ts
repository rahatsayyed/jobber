import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertVendorSlug, extraConfigProblem, loadPortals, slugProblem } from '../src/sources/boards/filters.js';
import { settleBoard } from '../src/sources/boards/greenhouse.js';
import { shortHash, pastDeadline } from '../src/sources/boards/util.js';

const base = { name: 'A', enabled: true };
function cfg(companies: any[]) {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'found-')), 'portals.json');
  writeFileSync(f, JSON.stringify({
    tracked_companies: companies,
    title_filter: { positive: ['frontend'], negative: [] },
    location_filter: { allow: ['india'], global: ['remote'] },
  }));
  return f;
}

describe('slugProblem / assertVendorSlug', () => {
  it('keeps the generic rule for greenhouse, lever and ashby', () => {
    expect(slugProblem('greenhouse', 'acme.corp_1')).toBeNull();
    expect(slugProblem('lever', '..')).toBe('invalid slug');
    expect(slugProblem('ashby', 'a/b')).toBe('invalid slug');
  });
  it('host-label vendors accept only lowercase letters, digits and hyphens', () => {
    for (const v of ['recruitee', 'personio', 'workday']) {
      expect(slugProblem(v, 'acme-1')).toBeNull();
      for (const bad of ['Acme', 'a.b', 'a_b', '-a', 'a-', 'a'.repeat(64)]) expect(slugProblem(v, bad)).toMatch(/^invalid slug/);
    }
    expect(slugProblem('workday', 'a'.repeat(41))).toMatch(/at most 40/);
  });
  it('token vendors accept letters, digits, underscore and hyphen but no dots', () => {
    for (const v of ['workable', 'smartrecruiters']) {
      expect(slugProblem(v, 'Acme_Corp-2')).toBeNull();
      expect(slugProblem(v, 'acme.corp')).toMatch(/^invalid slug/);
    }
  });
  it('assertVendorSlug throws the labelled message providers rely on', () => {
    expect(() => assertVendorSlug({ ats: 'recruitee', slug: 'A.B' })).toThrow('invalid board slug "A.B"');
    expect(() => assertVendorSlug({ ats: 'greenhouse', slug: 'ok' })).not.toThrow();
  });
});

describe('extraConfigProblem', () => {
  it('accepts a complete workday entry and rejects missing or malformed vendor fields', () => {
    expect(extraConfigProblem({ ats: 'workday', wd: 'wd5', site: 'External_Careers' })).toBeNull();
    expect(extraConfigProblem({ ats: 'workday', site: 'x' })).toMatch(/wd/);
    expect(extraConfigProblem({ ats: 'workday', wd: 'wd5.evil', site: 'x' })).toMatch(/wd/);
    expect(extraConfigProblem({ ats: 'workday', wd: 'wd5', site: '../x' })).toMatch(/site/);
    expect(extraConfigProblem({ ats: 'personio', domain: 'fr' })).toMatch(/domain/);
    expect(extraConfigProblem({ ats: 'greenhouse', search: 'a\nb' })).toMatch(/search/);
    expect(extraConfigProblem({ ats: 'greenhouse', max_detail: 0 })).toMatch(/max_detail/);
    expect(extraConfigProblem({ ats: 'greenhouse', max_pages: 51 })).toMatch(/max_pages/);
    expect(extraConfigProblem({ ats: 'greenhouse', max_detail: 100, max_pages: 50, domain: 'com', search: 'react' })).toBeNull();
  });
});

describe('loadPortals vendor fields', () => {
  it('keeps the optional fields it understands and still loads the legacy shape unchanged', () => {
    const { config, warnings } = loadPortals(cfg([
      { ...base, ats: 'greenhouse', slug: 'a', region: 'eu', domain: 'com', wd: 'wd3', site: 'Ext', search: ' react ', max_detail: 10, max_pages: 3 },
      { ...base, name: 'Legacy', ats: 'lever', slug: 'legacy' },
    ]));
    expect(warnings).toEqual([]);
    expect(config?.tracked_companies[0]).toEqual({ name: 'A', ats: 'greenhouse', slug: 'a', enabled: true, region: 'eu', domain: 'com', wd: 'wd3', site: 'Ext', search: 'react', max_detail: 10, max_pages: 3 });
    expect(config?.tracked_companies[1]).toEqual({ name: 'Legacy', ats: 'lever', slug: 'legacy', enabled: true });
  });
  it('skips an entry with an invalid vendor field and reports why, other entries still load', () => {
    const { config, warnings } = loadPortals(cfg([
      { ...base, ats: 'greenhouse', slug: 'a', max_detail: 'many' },
      { ...base, name: 'B', ats: 'ashby', slug: 'b' },
    ]));
    expect(config?.tracked_companies.map((c) => c.slug)).toEqual(['b']);
    expect(warnings).toEqual(['config/portals.json: tracked_companies[0] (A) skipped: max_detail must be an integer from 1 to 100']);
  });
});

describe('settleBoard with a context', () => {
  const company = { name: 'A', ats: 'greenhouse' as const, slug: 'a', enabled: true };
  it('passes the context through and returns warnings only when there are some', async () => {
    const seen: any[] = [];
    const warned = await settleBoard(async (_c, ctx) => { seen.push(ctx); ctx?.warn?.('partial: 1 of 2'); return []; }, company, { deadlineAt: 5 });
    expect(seen[0].deadlineAt).toBe(5);
    expect(warned).toEqual({ jobs: [], error: null, warnings: ['partial: 1 of 2'] });
    expect(await settleBoard(async () => [], company)).toEqual({ jobs: [], error: null });
    const failed = await settleBoard(async (_c, ctx) => { ctx?.warn?.('half way'); throw new Error('boom'); }, company);
    expect(failed).toEqual({ jobs: [], error: 'boom', warnings: ['half way'] });
  });
});

describe('fix round 1', () => {
  it('validates wd and site for every vendor whenever present', () => {
    expect(extraConfigProblem({ ats: 'greenhouse', wd: 'wd5' + String.fromCharCode(47) + '..' + String.fromCharCode(47) + 'x' })).toMatch(/wd/);
    expect(extraConfigProblem({ ats: 'lever', site: '../x' })).toMatch(/site/);
    expect(extraConfigProblem({ ats: 'ashby', wd: 'wd5', site: 'Ext' })).toBeNull();
  });
  it('trailing hyphen slug message does not claim hyphens are fine', () => {
    expect(slugProblem('workday', 'acme-')).toMatch(/not starting or ending with "-"/);
  });
});

describe('util', () => {
  it('shortHash is stable and fixed length; pastDeadline handles undefined', () => {
    expect(shortHash('abc')).toBe(shortHash('abc'));
    expect(shortHash('abc')).toHaveLength(12);
    expect(shortHash('abc')).not.toBe(shortHash('abd'));
    expect(pastDeadline(undefined)).toBe(false);
    expect(pastDeadline(Date.now() - 1)).toBe(true);
    expect(pastDeadline(Date.now() + 60_000)).toBe(false);
    vi.useRealTimers();
  });
});
