import { describe, expect, it } from 'vitest';
import { APPLY_HOST_PLATFORM_IDS, resolveHostCap, hostCapWarnings } from '../src/webcore/hostCaps.js';
import { LIMITS, specFor } from '../src/setup/limitsCatalog.js';
import { openDb } from '../src/db.js';

describe('resolveHostCap', () => {
  const r = (env: Record<string, string>, id = 'greenhouse') => resolveHostCap(id, env as NodeJS.ProcessEnv);

  it('defaults to 10', () => {
    expect(r({})).toEqual({ cap: 10, source: 'default', warnings: [] });
  });
  it('specific valid wins over top-level', () => {
    expect(r({ APPLY_MAX_PER_HOST_GREENHOUSE: '8', APPLY_MAX_PER_HOST: '12' })).toMatchObject({ cap: 8, source: 'specific' });
  });
  it('specific invalid falls through to top-level', () => {
    expect(r({ APPLY_MAX_PER_HOST_GREENHOUSE: 'abc', APPLY_MAX_PER_HOST: '12' })).toMatchObject({ cap: 12, source: 'top_level' });
    expect(r({ APPLY_MAX_PER_HOST_GREENHOUSE: '', APPLY_MAX_PER_HOST: '12' })).toMatchObject({ cap: 12, source: 'top_level' });
    expect(r({ APPLY_MAX_PER_HOST_GREENHOUSE: '1.5', APPLY_MAX_PER_HOST: '12' })).toMatchObject({ cap: 12, source: 'top_level' });
  });
  it('top-level invalid falls through to 10', () => {
    expect(r({ APPLY_MAX_PER_HOST: 'x' })).toMatchObject({ cap: 10, source: 'default' });
    expect(r({ APPLY_MAX_PER_HOST: '  ' })).toMatchObject({ cap: 10, source: 'default' });
  });
  it('0 clamps to 1 with a warning', () => {
    const v = r({ APPLY_MAX_PER_HOST: '0' });
    expect(v.cap).toBe(1);
    expect(v.source).toBe('top_level');
    expect(v.warnings).toHaveLength(1);
    expect(v.warnings[0]).toContain('APPLY_MAX_PER_HOST');
  });
  it('99 clamps to 50 with a warning (specific, does not fall through)', () => {
    const v = r({ APPLY_MAX_PER_HOST_LEVER: '99', APPLY_MAX_PER_HOST: '7' }, 'lever');
    expect(v).toMatchObject({ cap: 50, source: 'specific' });
    expect(v.warnings[0]).toContain('APPLY_MAX_PER_HOST_LEVER');
  });
  it('non-numeric never throws and falls through', () => {
    expect(() => r({ APPLY_MAX_PER_HOST_GREENHOUSE: 'NaN', APPLY_MAX_PER_HOST: 'Infinity' })).not.toThrow();
    expect(r({ APPLY_MAX_PER_HOST_GREENHOUSE: 'NaN', APPLY_MAX_PER_HOST: 'Infinity' }).cap).toBe(10);
  });
  it('hostCapWarnings lists every clamp once', () => {
    const w = hostCapWarnings({ APPLY_MAX_PER_HOST: '0', APPLY_MAX_PER_HOST_ASHBY: '99' } as NodeJS.ProcessEnv);
    expect(w.filter((x) => x.includes('APPLY_MAX_PER_HOST=0')).length).toBe(1);
    expect(w.some((x) => x.includes('APPLY_MAX_PER_HOST_ASHBY'))).toBe(true);
    expect(hostCapWarnings({} as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe('catalog family', () => {
  it('platform ids are the registry ids', () => {
    expect([...APPLY_HOST_PLATFORM_IDS]).toEqual([
      'greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters', 'workday', 'recruitee', 'personio', 'browser',
    ]);
  });
  it('catalog carries one entry per id plus the top-level key, defaults equal the code default', () => {
    const family = LIMITS.filter((l) => l.key.startsWith('APPLY_MAX_PER_HOST')).map((l) => l.key).sort();
    const want = ['APPLY_MAX_PER_HOST', ...APPLY_HOST_PLATFORM_IDS.map((i) => `APPLY_MAX_PER_HOST_${i.toUpperCase()}`)].sort();
    expect(family).toEqual(want);
    for (const k of family) {
      const s = specFor(k)!;
      expect(s.default).toBe(resolveHostCap('greenhouse', {}).cap);
      expect([s.min, s.max, s.unit]).toEqual([1, 50, 'per host per day']);
    }
  });
});

describe('apply_host_day table', () => {
  it('exists with (host, day) primary key', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO apply_host_day (host, day, count) VALUES (?, ?, ?)').run('a.example', '2026-10-16', 1);
    expect(() => db.prepare('INSERT INTO apply_host_day (host, day, count) VALUES (?, ?, ?)').run('a.example', '2026-10-16', 2)).toThrow();
  });
});
