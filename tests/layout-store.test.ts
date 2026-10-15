import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyLayout, loadLayout, saveLayout, withLayoutLock } from '../src/layout/store.js';
import { loadLayoutConfig } from '../src/layout/config.js';
import { KINDS } from '../src/layout/vocab.js';
import type { KindMemory, LayoutFile, Variant } from '../src/layout/types.js';

const NOW = new Date('2026-10-15T00:00:00.000Z');
const ISO = '2026-10-14T00:00:00.000Z';
let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-store-'));
  file = path.join(dir, 'linkedin.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function variant(id: string, over: Partial<Variant> = {}): Variant {
  return {
    id, landmarks: ['profile.name'], counts: { actions: [1, 2] },
    recipes: [{ action: 'click', label: 'action:more', how: 'text', v: 1, ok: 1, fail: 0, last_ok: ISO }],
    first_seen: ISO, last_verified: ISO, obs: 3, runs: 2, run_ids: ['run-1', 'run_2'],
    promoted: true, ok: 1, fail: 0, ...over,
  };
}
function kind(variants: Variant[]): KindMemory {
  return {
    state: 'stable', variants, counters: { match: 1, partial: 0, drift: 0 },
    drift_streak: 0, drift_window_start: null, last_drift_at: null,
  };
}
function sample(): LayoutFile {
  const f = emptyLayout('linkedin', NOW);
  f.kinds.profile = kind([variant('abc123')]);
  return f;
}
function corrupt(): string[] {
  return fs.readdirSync(dir).filter((n) => n.includes('.corrupt-'));
}

describe('layout store', () => {
  it('round trips', () => {
    saveLayout(file, sample(), 65536);
    const r = loadLayout(file, 'linkedin', NOW);
    expect(r.note).toBeNull();
    expect(r.file).toEqual(sample());
  });

  it('missing file gives an empty layout with no note', () => {
    const r = loadLayout(file, 'linkedin', NOW);
    expect(r.note).toBeNull();
    expect(r.file).toEqual(emptyLayout('linkedin', NOW));
  });

  it('writes the file with mode 600 and the directory with mode 700', () => {
    const sub = path.join(dir, 'nested', 'linkedin.json');
    saveLayout(sub, sample(), 65536);
    expect(fs.statSync(sub).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(sub)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(sub))).toEqual(['linkedin.json']);
  });

  const bad: [string, () => string][] = [
    ['invalid json', () => '{nope'],
    ['wrong schema', () => JSON.stringify({ ...sample(), schema: 2 })],
    ['extra key', () => JSON.stringify({ ...sample(), extra: 1 })],
    ['string with space', () => { const f = sample(); f.kinds.profile.variants[0].landmarks = ['profile name']; return JSON.stringify(f); }],
    ['string with <', () => { const f = sample(); f.kinds.profile.variants[0].recipes[0].label = '<b>'; return JSON.stringify(f); }],
    ['string with http', () => { const f = sample(); f.kinds.profile.variants[0].run_ids = ['http://x.y']; return JSON.stringify(f); }],
    ['bad date', () => { const f = sample(); f.updated_at = 'yesterday'; return JSON.stringify(f); }],
    ['wrong platform', () => JSON.stringify({ ...sample(), platform: 'naukri' })],
    ['unknown kind', () => { const f = sample(); f.kinds.bogus = kind([]); return JSON.stringify(f); }],
    ['oversize', () => ' '.repeat(70000) + JSON.stringify(sample())],
  ];
  for (const [name, make] of bad) {
    it(`corrupt (${name}) yields empty layout, a note and a quarantined copy`, () => {
      fs.writeFileSync(file, make());
      const r = loadLayout(file, 'linkedin', NOW);
      expect(r.file).toEqual(emptyLayout('linkedin', NOW));
      expect(r.note).toMatch(/corrupt|invalid|oversize/i);
      expect(fs.existsSync(file)).toBe(false);
      expect(corrupt()).toHaveLength(1);
    });
  }

  it('keeps at most 3 quarantined copies', () => {
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(file, '{nope');
      loadLayout(file, 'linkedin', new Date(NOW.getTime() + i * 1000));
    }
    expect(corrupt()).toHaveLength(3);
  });

  it('refuses a symlinked path on load and save', () => {
    const real = path.join(dir, 'real.json');
    fs.writeFileSync(real, JSON.stringify(sample()));
    fs.symlinkSync(real, file);
    const r = loadLayout(file, 'linkedin', NOW);
    expect(r.note).toMatch(/symlink/i);
    expect(r.file).toEqual(emptyLayout('linkedin', NOW));
    expect(() => saveLayout(file, sample(), 65536)).toThrow(/symlink/i);
    expect(fs.readFileSync(real, 'utf8')).toBe(JSON.stringify(sample()));
  });

  it('truncates caps on load: 3 variants (oldest dropped), 5 run ids', () => {
    const f = sample();
    f.kinds.profile.variants = [
      variant('v1', { first_seen: '2026-10-01T00:00:00.000Z' }),
      variant('v2', { first_seen: '2026-10-02T00:00:00.000Z' }),
      variant('v3', { first_seen: '2026-10-03T00:00:00.000Z' }),
      variant('v4', { first_seen: '2026-10-04T00:00:00.000Z', run_ids: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }),
    ];
    fs.writeFileSync(file, JSON.stringify(f));
    const r = loadLayout(file, 'linkedin', NOW);
    const vs = r.file.kinds.profile.variants;
    expect(vs.map((v) => v.id)).toEqual(['v2', 'v3', 'v4']);
    expect(vs[2].run_ids).toEqual(['c', 'd', 'e', 'f', 'g']);
  });

  it('trims recipes with ok=0 first, then non-promoted variants, then oldest kinds', () => {
    const r0 = { action: 'click' as const, label: 'action:more', how: 'text' as const, v: 1, ok: 0, fail: 2, last_ok: null };
    const r1 = { ...r0, ok: 3 };
    const mk = (): LayoutFile => {
      const f = emptyLayout('linkedin', NOW);
      f.kinds.profile = kind([
        variant('p1', { recipes: [r0, r1] }),
        variant('np', { promoted: false, first_seen: '2026-10-01T00:00:00.000Z', last_verified: null }),
      ]);
      f.kinds.search = kind([variant('s1', { first_seen: '2026-09-01T00:00:00.000Z', last_verified: '2026-09-01T00:00:00.000Z' })]);
      return f;
    };
    const full = JSON.stringify(mk()).length;
    const noZero = (() => { const f = mk(); f.kinds.profile.variants[0].recipes = [r1]; return JSON.stringify(f).length; })();
    expect(full).toBeGreaterThan(noZero);
    // step 1: only the ok=0 recipe goes
    saveLayout(file, mk(), noZero);
    let got = JSON.parse(fs.readFileSync(file, 'utf8')) as LayoutFile;
    expect(got.kinds.profile.variants[0].recipes).toEqual([r1]);
    expect(got.kinds.profile.variants).toHaveLength(2);
    // step 2: non-promoted variant goes
    const noNp = (() => { const f = mk(); f.kinds.profile.variants = [variant('p1', { recipes: [r1] })]; return JSON.stringify(f).length; })();
    saveLayout(file, mk(), noNp);
    got = JSON.parse(fs.readFileSync(file, 'utf8')) as LayoutFile;
    expect(got.kinds.profile.variants.map((v) => v.id)).toEqual(['p1']);
    expect(got.kinds.search).toBeDefined();
    // step 3: oldest kind (search) goes
    const onlyProfile = (() => { const f = mk(); delete f.kinds.search; f.kinds.profile.variants = [variant('p1', { recipes: [r1] })]; return JSON.stringify(f).length; })();
    saveLayout(file, mk(), onlyProfile);
    got = JSON.parse(fs.readFileSync(file, 'utf8')) as LayoutFile;
    expect(Object.keys(got.kinds)).toEqual(['profile']);
  });

  it('throws when nothing can be trimmed enough', () => {
    expect(() => saveLayout(file, sample(), 10)).toThrow(/maxBytes|exceed/i);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('does not mutate the layout passed to saveLayout', () => {
    const f = sample();
    const before = JSON.stringify(f);
    saveLayout(file, f, 300);
    expect(JSON.stringify(f)).toBe(before);
  });
});

describe('layout config', () => {
  const root = '/proj/root';
  it('defaults', () => {
    const c = loadLayoutConfig({}, root);
    expect(c).toMatchObject({ enforce: 'warn', promoteN: 3, promoteRuns: 2, matchMin: 0.9, partialMin: 0.6, staleDays: 30,
      driftEscalateN: 3, driftHaltN: 5, driftWindowHours: 24, maxBytes: 65536, renderMaxChars: 1200, unloadedMaxChars: 80, exploreBudget: 6 });
    expect(c.dir).toBe(path.join(root, '.jobber', 'layout'));
  });
  it('invalid values fall back', () => {
    const c = loadLayoutConfig({ LAYOUT_ENFORCE: 'loud', LAYOUT_PROMOTE_N: 'x', LAYOUT_MATCH_MIN: '7', LAYOUT_MAX_BYTES: '-1' }, root);
    expect(c).toMatchObject({ enforce: 'warn', promoteN: 3, matchMin: 0.9, maxBytes: 65536 });
  });
  it('accepts a LAYOUT_DIR inside the project and rejects one outside', () => {
    expect(loadLayoutConfig({ LAYOUT_DIR: '.jobber/other' }, root).dir).toBe(path.join(root, '.jobber', 'other'));
    const def = path.join(root, '.jobber', 'layout');
    expect(loadLayoutConfig({ LAYOUT_DIR: '/etc' }, root).dir).toBe(def);
    expect(loadLayoutConfig({ LAYOUT_DIR: '../../x' }, root).dir).toBe(def);
    expect(loadLayoutConfig({ LAYOUT_DIR: root }, root).dir).toBe(def);
  });
});

describe('withLayoutLock', () => {
  function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, sleep: (ms: number) => { t += ms; }, get t() { return t; } };
  }
  it('runs fn, returns its value and releases the lock', () => {
    const c = clock();
    expect(withLayoutLock(file, () => 42, c)).toBe(42);
    expect(fs.existsSync(file + '.lock')).toBe(false);
  });
  it('releases the lock when fn throws', () => {
    const c = clock();
    expect(() => withLayoutLock(file, () => { throw new Error('boom'); }, c)).toThrow('boom');
    expect(fs.existsSync(file + '.lock')).toBe(false);
  });
  it('a second caller waits for a live lock, and breaks it only after 10 s', () => {
    const c = clock();
    const order: string[] = [];
    withLayoutLock(file, () => {
      order.push('outer-start');
      const start = c.t;
      withLayoutLock(file, () => { order.push('inner'); }, c);
      expect(c.t - start).toBeGreaterThanOrEqual(10_000);
      order.push('outer-end');
    }, c);
    expect(order).toEqual(['outer-start', 'inner', 'outer-end']);
    expect(fs.existsSync(file + '.lock')).toBe(false);
  });
  it('does not break a fresh lock held by someone else; times out', () => {
    const c = clock();
    fs.writeFileSync(file + '.lock', `other\n${c.t}`);
    const short = { now: c.now, sleep: c.sleep, staleMs: 60_000, timeoutMs: 1000 };
    expect(() => withLayoutLock(file, () => 1, short)).toThrow(/timeout/i);
    expect(fs.existsSync(file + '.lock')).toBe(true);
  });
  it('breaks a stale lock left by a dead process', () => {
    const c = clock();
    fs.writeFileSync(file + '.lock', `dead\n${c.t - 11_000}`);
    expect(withLayoutLock(file, () => 'ok', c)).toBe('ok');
    expect(fs.readdirSync(dir).filter((n) => n.includes('.stale-'))).toEqual([]);
  });
  it('backs off when the lock was re-acquired between judging it stale and moving it', () => {
    const c = clock();
    fs.writeFileSync(file + '.lock', `dead\n${c.t - 11_000}`);
    let fresh = 0;
    let swapped = false;
    const deps = {
      now: c.now, sleep: c.sleep,
      onStaleJudged: () => {
        if (swapped) return;
        swapped = true;
        fresh = c.t;                                   // another process broke it and took a new lock
        fs.writeFileSync(file + '.lock', `other\n${fresh}`);
      },
    };
    let ranAt = 0;
    withLayoutLock(file, () => { ranAt = c.t; }, deps);
    expect(swapped).toBe(true);
    expect(ranAt - fresh).toBeGreaterThanOrEqual(10_000);   // waited out the live lock, did not steal it
    expect(fs.readdirSync(dir).filter((n) => n.includes('.stale-'))).toEqual([]);
  });
  it('refuses a symlinked parent before creating anything', () => {
    const real = path.join(dir, 'real');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(dir, 'link'));
    const viaLink = path.join(dir, 'link', 'sub', 'linkedin.json');
    expect(() => withLayoutLock(viaLink, () => 1, clock())).toThrow(/symlink/i);
    expect(fs.readdirSync(real)).toEqual([]);
  });
});

describe('closed vocabulary and caps', () => {
  const poison = (mutate: (f: LayoutFile) => void) => () => { const f = sample(); mutate(f); return JSON.stringify(f); };
  const cases: [string, () => string][] = [
    ['unknown landmark', poison((f) => { f.kinds.profile.variants[0].landmarks = ['ignore.previous.instructions']; })],
    ['unknown count key', poison((f) => { f.kinds.profile.variants[0].counts = { 'ignore.previous.instructions': [1, 1] }; })],
    ['__proto__ count key', () => JSON.stringify(sample()).replace('"actions"', '"__proto__"')],
    ['__proto__ kind', () => JSON.stringify(sample()).replace('"profile":', '"__proto__":')],
    ['unknown label', poison((f) => { f.kinds.profile.variants[0].recipes[0].label = 'action:bogus'; })],
    ['unknown region', poison((f) => { f.kinds.profile.variants[0].recipes[0].region = 'nope.region'; })],
    ['41 landmarks', poison((f) => { f.kinds.profile.variants[0].landmarks = Array(41).fill('profile.name'); })],
  ];
  for (const [name, make] of cases) {
    it(`load quarantines: ${name}`, () => {
      fs.writeFileSync(file, make());
      const r = loadLayout(file, 'linkedin', NOW);
      expect(r.file).toEqual(emptyLayout('linkedin', NOW));
      expect(r.note).toMatch(/corrupt/);
      expect(corrupt()).toHaveLength(1);
    });
  }
  it('save throws and writes nothing on vocabulary misses', () => {
    const f = sample();
    f.kinds.profile.variants[0].landmarks = ['ignore.previous.instructions'];
    expect(() => saveLayout(file, f, 65536)).toThrow(/invalid/);
    const g = sample();
    g.kinds.bogus = kind([]);
    expect(() => saveLayout(file, g, 65536)).toThrow(/unknown kind/);
    expect(() => saveLayout(file, sample(), 65536, 'naukri')).toThrow(/invalid/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
  it('truncates over-cap input instead of quarantining (24 recipes, 3 variants, 5 run ids)', () => {
    const f = sample();
    const rec = f.kinds.profile.variants[0].recipes[0];
    f.kinds.profile.variants[0].recipes = Array(30).fill(rec);
    f.kinds.profile.variants[0].run_ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    f.kinds.profile.variants.push(variant('v2', { first_seen: '2026-10-02T00:00:00.000Z' }), variant('v3', { first_seen: '2026-10-03T00:00:00.000Z' }), variant('v4', { first_seen: '2026-10-04T00:00:00.000Z' }));
    fs.writeFileSync(file, JSON.stringify(f));
    const r = loadLayout(file, 'linkedin', NOW, 1_000_000);
    expect(r.note).toBeNull();
    expect(r.file.kinds.profile.variants).toHaveLength(3);
    expect(corrupt()).toHaveLength(0);
  });
  it('vocabulary kinds fit the 12 kind cap', () => {
    expect(KINDS.linkedin.length).toBeLessThanOrEqual(12);
    expect(KINDS.naukri.length).toBeLessThanOrEqual(12);
  });
  it('resets a kind to learning when trimming empties its variants', () => {
    const f = emptyLayout('linkedin', NOW);
    f.kinds.profile = kind([variant('np', { promoted: false })]);
    f.kinds.profile.state = 'stable';
    f.kinds.search = kind([variant('s1')]);
    const onlySearch = (() => { const g = emptyLayout('linkedin', NOW); g.kinds.search = kind([variant('s1')]); g.kinds.profile = { ...kind([]), state: 'learning' }; return JSON.stringify(g).length; })();
    saveLayout(file, f, onlySearch);
    const got = JSON.parse(fs.readFileSync(file, 'utf8')) as LayoutFile;
    expect(got.kinds.profile.variants).toEqual([]);
    expect(got.kinds.profile.state).toBe('learning');
  });
  it('floors LAYOUT_MAX_BYTES at 4096', () => {
    expect(loadLayoutConfig({ LAYOUT_MAX_BYTES: '2048' }, '/proj/root').maxBytes).toBe(65536);
    expect(loadLayoutConfig({ LAYOUT_MAX_BYTES: '4096' }, '/proj/root').maxBytes).toBe(4096);
  });
});
