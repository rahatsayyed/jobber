import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRegistry } from '../src/sources/registry.js';
import { AGGREGATOR_ATS, COMPANY_ATS } from '../src/sources/boards/filters.js';

function tmpConfig(content: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'platforms-'));
  const p = path.join(dir, 'platforms.json');
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}
const good = (id: string, extra: Record<string, unknown> = {}) => ({
  id, kind: 'board', label: id, provider: `boards/${id}`, tier: 'script', enabled: true, stability: 'unverified', ...extra,
});

describe('shipped config/platforms.json', () => {
  const { platforms, errors } = loadRegistry();
  it('loads without errors and has unique ids', () => {
    expect(errors).toEqual([]);
    const ids = platforms.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('contains every company and aggregator ATS id', () => {
    const ids = new Set(platforms.map((p) => p.id));
    for (const id of [...COMPANY_ATS, ...AGGREGATOR_ATS]) expect(ids.has(id), id).toBe(true);
  });
  it('seeds the api, naukri and the operator-only linkedin entries', () => {
    const by = new Map(platforms.map((p) => [p.id, p]));
    for (const id of ['remotive', 'remoteok', 'naukri']) expect(by.get(id)?.tier, id).toBe('script');
    for (const id of ['linkedin-jobs', 'linkedin-posts']) {
      expect(by.get(id)?.tier, id).toBe('agent');
      expect(by.get(id)?.provider, id).toBeNull();
    }
    expect(by.get('greenhouse')?.kind).toBe('board');
    expect(by.get('hackernews')?.kind).toBe('aggregator');
  });
});

describe('wellfound registry row', () => {
  it('is an enabled, unverified, agent-tier generated row with no provider', () => {
    const { platforms, errors } = loadRegistry();
    expect(errors).toEqual([]);
    expect(platforms.find((p) => p.id === 'wellfound')).toEqual({
      id: 'wellfound', kind: 'generated', label: 'Wellfound', provider: null, tier: 'agent', enabled: true, stability: 'unverified',
    });
  });
});

describe('loadRegistry validation', () => {
  it('reports an invalid row and still loads the others', () => {
    const p = tmpConfig({ platforms: [good('a'), { id: 'b', kind: 'nonsense' }, good('c')] });
    const r = loadRegistry(p);
    expect(r.platforms.map((x) => x.id)).toEqual(['a', 'c']);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/b/);
  });
  it('rejects bad kind, tier, stability and a duplicate id', () => {
    const r = loadRegistry(tmpConfig({ platforms: [
      good('a'), good('a'),
      good('t', { tier: 'robot' }),
      good('s', { stability: 'great' }),
      good('k', { kind: 'zzz' }),
    ] }));
    expect(r.platforms.map((x) => x.id)).toEqual(['a']);
    expect(r.errors).toHaveLength(4);
    expect(r.errors.some((e) => /duplicate/i.test(e))).toBe(true);
  });
  it('a script row needs a provider; an agent row may have none; enabled must be a boolean', () => {
    const r = loadRegistry(tmpConfig({ platforms: [
      good('x', { provider: null }),
      good('y', { tier: 'agent', provider: null }),
      good('z', { enabled: 'true' }),
    ] }));
    expect(r.platforms.map((x) => x.id)).toEqual(['y']);
    expect(r.errors).toHaveLength(2);
  });
  it('keeps attribution when valid', () => {
    const r = loadRegistry(tmpConfig({ platforms: [good('a', { attribution: { source: 's', license: 'l', url: 'https://x.test' } })] }));
    expect(r.platforms[0].attribution).toEqual({ source: 's', license: 'l', url: 'https://x.test' });
  });
  it('a missing or malformed file gives an error and no platforms, never throws', () => {
    expect(loadRegistry(path.join(tmpdir(), 'no-such-platforms.json'))).toMatchObject({ platforms: [], errors: [expect.stringMatching(/platforms\.json/)] });
    const bad = loadRegistry(tmpConfig('{not json'));
    expect(bad.platforms).toEqual([]);
    expect(bad.errors).toHaveLength(1);
    const notArr = loadRegistry(tmpConfig({ platforms: 'x' }));
    expect(notArr.errors).toHaveLength(1);
  });
});
