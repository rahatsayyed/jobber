import { describe, it, expect } from 'vitest';
import { renderLayout } from '../src/layout/render.js';
import { KINDS } from '../src/layout/vocab.js';
import type { KindMemory, LayoutFile, Variant } from '../src/layout/types.js';

const variant = (over: Partial<Variant> = {}): Variant => ({
  id: 'abcdef012345', landmarks: ['profile.name', 'action:connect', 'action:more'],
  counts: {}, recipes: [], first_seen: '2026-10-01T00:00:00.000Z', last_verified: '2026-10-14T09:00:00.000Z',
  obs: 5, runs: 2, run_ids: ['a', 'b'], promoted: true, ok: 41, fail: 0, ...over,
});
const kind = (over: Partial<KindMemory> = {}): KindMemory => ({
  state: 'stable', variants: [variant()], counters: { match: 10, partial: 0, drift: 0 },
  drift_streak: 0, drift_window_start: null, last_drift_at: null, ...over,
});
const file = (kinds: Record<string, KindMemory>): LayoutFile =>
  ({ schema: 1, platform: 'linkedin', updated_at: '2026-10-14T09:00:00.000Z', kinds });

const SAFE = /^[a-z0-9_.:= |,()\n.-]*$/;

describe('renderLayout', () => {
  it('one vocabulary-only line per kind in the documented format', () => {
    const f = file({
      profile: kind({
        variants: [variant({
          recipes: [
            { action: 'click', label: 'action:more', how: 'text', v: 1, ok: 3, fail: 0, last_ok: '2026-10-14T09:00:00.000Z' },
            { action: 'click', label: 'action:connect', how: 'ordinal', ordinal: 0, region: 'profile.name', v: 1, ok: 1, fail: 0, last_ok: null },
          ],
        })],
      }),
    });
    const out = renderLayout(f, 1200);
    expect(out).toBe(
      'profile: stable v1 verified 2026-10-14 ok=41 fail=0 drift=0 | needs: profile.name action:connect action:more'
      + ' | recipes: click action:more (text), click action:connect (ordinal 0 region profile.name)',
    );
    expect(out).toMatch(SAFE);
  });

  it('a learning kind has no needs or recipes', () => {
    const f = file({ search: kind({ state: 'learning', variants: [variant({ promoted: false, last_verified: null })] }) });
    expect(renderLayout(f, 1200)).toBe('search: learning v0 verified never ok=41 fail=0 drift=0');
  });

  it('empty memory says so', () => {
    expect(renderLayout(file({}), 1200)).toBe('layout memory: none yet');
    expect(renderLayout(null, 1200)).toBe('layout memory: none yet');
  });

  it('stays under the budget with 12 kinds, cuts whole lines and ends with ...', () => {
    const kinds: Record<string, KindMemory> = {};
    const names = [...KINDS.linkedin, ...KINDS.naukri.filter((k) => !KINDS.linkedin.includes(k))].slice(0, 12);
    expect(names.length).toBe(12);
    for (const k of names) kinds[k] = kind();
    const f = file(kinds);
    for (const max of [1200, 600, 300, 150, 100]) {
      const out = renderLayout(f, max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(out).toMatch(SAFE);
      const lines = out.split('\n');
      if (lines.length < 12) {
        expect(lines.at(-1)).toBe('...');
        for (const l of lines.slice(0, -1)) expect(l).toMatch(/^[a-z]+: (stable|learning|stale|drifted) v\d+ verified /);
      }
    }
    // uncut when it fits
    expect(renderLayout(f, 20000).split('\n')).toHaveLength(12);
  });

  it('never prints anything outside ids, integers and dates, even for odd state', () => {
    const f = file({ other: kind({ state: 'drifted', counters: { match: 0, partial: 0, drift: 7 } }) });
    expect(renderLayout(f, 1200)).toMatch(SAFE);
    expect(renderLayout(f, 1200)).toContain('drift=7');
  });
});
