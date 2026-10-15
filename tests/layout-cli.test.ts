import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { loadLayoutConfig, type LayoutConfig } from '../src/layout/config.js';
import { saveLayout, emptyLayout } from '../src/layout/store.js';
import type { KindMemory, LayoutFile, Variant } from '../src/layout/types.js';
import { haltPlatform, haltReason } from '../src/outreach/limits.js';
import { summarize } from '../src/layout/summary.js';
import { main, type CliDeps } from '../scripts/layout.js';

const NOW = new Date('2026-10-15T12:00:00.000Z');

function variant(over: Partial<Variant> = {}): Variant {
  return {
    id: 'abc123def456', landmarks: ['profile.name', 'profile.headline'], counts: {},
    recipes: [], first_seen: '2026-10-01T00:00:00.000Z', last_verified: '2026-10-13T12:00:00.000Z',
    obs: 5, runs: 3, run_ids: ['r1', 'r2', 'r3'], promoted: true, ok: 10, fail: 0, ...over,
  };
}
function kind(over: Partial<KindMemory> = {}): KindMemory {
  return {
    state: 'stable', variants: [variant()], counters: { match: 9, partial: 1, drift: 0 },
    drift_streak: 0, drift_window_start: null, last_drift_at: null, drift_run_ids: [], ...over,
  };
}

let dir: string;
let cfg: LayoutConfig;
let db: ReturnType<typeof openDb>;
let out: string[];
let errs: string[];
let answers: string[];
let prompts: string[];

function deps(over: Partial<CliDeps> = {}): CliDeps {
  return {
    cfg, now: () => NOW, db: () => db,
    prompt: async (q) => { prompts.push(q); return answers.shift() ?? ''; },
    out: (l) => out.push(l), err: (l) => errs.push(l), ...over,
  };
}
const fileOf = (p: string) => path.join(dir, `${p}.json`);
function put(platform: 'linkedin' | 'naukri', kinds: Record<string, KindMemory>): void {
  const f: LayoutFile = { ...emptyLayout(platform, NOW), kinds };
  saveLayout(fileOf(platform), f, cfg.maxBytes);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-cli-'));
  cfg = { ...loadLayoutConfig({}), dir };
  db = openDb(':memory:');
  out = []; errs = []; answers = []; prompts = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('summarize', () => {
  it('reports an absent file', () => {
    const s = summarize('linkedin', cfg, NOW, db);
    expect(s).toMatchObject({ platform: 'linkedin', present: false, valid: true, updated_at: null, age_days: null, kinds: [], halted_for_layout: false, enforce: 'warn' });
  });
  it('summarizes kinds, hit rate, drift and age', () => {
    put('linkedin', { profile: kind({ drift_streak: 2, counters: { match: 6, partial: 2, drift: 2 } }) });
    const s = summarize('linkedin', cfg, NOW, db);
    expect(s.present).toBe(true);
    expect(s.valid).toBe(true);
    expect(s.age_days).toBe(0);
    expect(s.kinds).toEqual([{ kind: 'profile', state: 'stable', variants: 1, hit_rate: 0.6, drift_streak: 2, drift_total: 2, verified_days_ago: 2 }]);
  });
  it('hit_rate is null with no observations', () => {
    put('linkedin', { profile: kind({ counters: { match: 0, partial: 0, drift: 0 } }) });
    expect(summarize('linkedin', cfg, NOW, db).kinds[0].hit_rate).toBeNull();
  });
  it('flags a corrupt file as invalid without touching it', () => {
    fs.writeFileSync(fileOf('linkedin'), '{nope');
    const s = summarize('linkedin', cfg, NOW, db);
    expect(s.present).toBe(true);
    expect(s.valid).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(['linkedin.json']);
  });
  it('halted_for_layout only for a layout_drift reason', () => {
    haltPlatform(db, 'linkedin', 'layout_drift:profile', NOW);
    expect(summarize('linkedin', cfg, NOW, db).halted_for_layout).toBe(true);
    haltPlatform(db, 'linkedin', 'checkpoint', NOW);
    expect(summarize('linkedin', cfg, NOW, db).halted_for_layout).toBe(false);
  });
});

describe('layout cli', () => {
  it('rejects unknown commands and platforms', async () => {
    expect(await main([], deps())).toBe(2);
    expect(await main(['frobnicate'], deps())).toBe(2);
    expect(await main(['show', 'myspace'], deps())).toBe(2);
    expect(errs.length).toBe(3);
  });

  it('status prints one row per kind for both platforms', async () => {
    put('linkedin', { profile: kind() });
    expect(await main(['status'], deps())).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('linkedin');
    expect(text).toContain('profile');
    expect(text).toContain('naukri');
    expect(text).toMatch(/no layout memory/);
  });

  it('show prints the rendered memory', async () => {
    put('linkedin', { profile: kind() });
    expect(await main(['show', 'linkedin'], deps())).toBe(0);
    expect(out.join('\n')).toContain('profile: stable v1 verified 2026-10-13');
  });

  it('show on an absent file says none yet', async () => {
    expect(await main(['show', 'naukri'], deps())).toBe(0);
    expect(out.join('\n')).toContain('layout memory: none yet');
  });

  it('reset needs a typed yes and moves the file aside', async () => {
    put('linkedin', { profile: kind() });
    answers = ['no'];
    expect(await main(['reset', 'linkedin'], deps())).toBe(1);
    expect(fs.existsSync(fileOf('linkedin'))).toBe(true);
    answers = ['yes'];
    expect(await main(['reset', 'linkedin'], deps())).toBe(0);
    expect(fs.existsSync(fileOf('linkedin'))).toBe(false);
    const moved = fs.readdirSync(dir).filter((n) => n.startsWith('linkedin.json.reset-'));
    expect(moved).toHaveLength(1);
    expect(prompts.length).toBe(2);
  });

  it('reset --yes skips the prompt', async () => {
    put('linkedin', { profile: kind() });
    expect(await main(['reset', 'linkedin', '--yes'], deps())).toBe(0);
    expect(prompts).toHaveLength(0);
    expect(fs.existsSync(fileOf('linkedin'))).toBe(false);
  });

  it('reset --kind moves only that kind, keeping a copy', async () => {
    put('linkedin', { profile: kind(), search: kind() });
    expect(await main(['reset', 'linkedin', '--kind', 'profile', '--yes'], deps())).toBe(0);
    const left = JSON.parse(fs.readFileSync(fileOf('linkedin'), 'utf8')) as LayoutFile;
    expect(Object.keys(left.kinds)).toEqual(['search']);
    const moved = fs.readdirSync(dir).filter((n) => n.startsWith('linkedin.json.reset-'));
    expect(moved).toHaveLength(1);
    const copy = JSON.parse(fs.readFileSync(path.join(dir, moved[0]), 'utf8')) as LayoutFile;
    expect(Object.keys(copy.kinds)).toEqual(['profile']);
  });

  it('reset refuses an unknown or absent kind and a missing file', async () => {
    put('linkedin', { profile: kind() });
    expect(await main(['reset', 'linkedin', '--kind', 'bogus', '--yes'], deps())).toBe(2);
    expect(await main(['reset', 'linkedin', '--kind', 'search', '--yes'], deps())).toBe(1);
    expect(await main(['reset', 'naukri', '--yes'], deps())).toBe(1);
    expect(fs.existsSync(fileOf('linkedin'))).toBe(true);
  });

  it('reset never overwrites an earlier reset file', async () => {
    put('linkedin', { profile: kind() });
    await main(['reset', 'linkedin', '--yes'], deps());
    put('linkedin', { search: kind() });
    await main(['reset', 'linkedin', '--yes'], deps());
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('linkedin.json.reset-'))).toHaveLength(2);
  });

  it('clear-halt clears a layout_drift halt', async () => {
    haltPlatform(db, 'linkedin', 'layout_drift:profile', NOW);
    expect(await main(['clear-halt', 'linkedin', '--yes'], deps())).toBe(0);
    expect(haltReason(db, 'linkedin')).toBeNull();
  });

  it('clear-halt refuses any other reason', async () => {
    haltPlatform(db, 'linkedin', 'checkpoint', NOW);
    expect(await main(['clear-halt', 'linkedin', '--yes'], deps())).toBe(1);
    expect(haltReason(db, 'linkedin')).toBe('checkpoint');
    expect(errs.join('\n')).toMatch(/not a layout halt/);
  });

  it('clear-halt refuses a global halt', async () => {
    haltPlatform(db, 'all', 'stop', NOW);
    expect(await main(['clear-halt', 'linkedin', '--yes'], deps())).toBe(1);
    expect(haltReason(db, 'all')).toBe('stop');
  });

  it('clear-halt resets the streak, window and run ids of the halting kind only', async () => {
    put('linkedin', {
      profile: kind({
        state: 'drifted', drift_streak: 7, drift_window_start: '2026-10-15T01:00:00.000Z',
        last_drift_at: '2026-10-15T11:00:00.000Z', drift_run_ids: ['r1', 'r2'], counters: { match: 9, partial: 1, drift: 7 },
      }),
      search: kind({ drift_streak: 2, drift_window_start: '2026-10-15T02:00:00.000Z', drift_run_ids: ['r1'] }),
    });
    haltPlatform(db, 'linkedin', 'layout_drift:profile', NOW);
    expect(await main(['clear-halt', 'linkedin', '--yes'], deps())).toBe(0);
    expect(haltReason(db, 'linkedin')).toBeNull();
    const sum = summarize('linkedin', cfg, NOW, db);
    const p = sum.kinds.find((k) => k.kind === 'profile')!;
    expect(p.drift_streak).toBe(0);
    expect(p.drift_total).toBe(7); // totals are history, kept
    const text = JSON.parse(fs.readFileSync(path.join(cfg.dir, 'linkedin.json'), 'utf8'));
    expect(text.kinds.profile.drift_window_start).toBeNull();
    expect(text.kinds.profile.drift_run_ids).toEqual([]);
    expect(text.kinds.search.drift_streak).toBe(2);
    expect(text.kinds.search.drift_run_ids).toEqual(['r1']);
    expect(out.join('\n')).toMatch(/streak of kind profile reset/);
  });

  it('clear-halt works without a layout file', async () => {
    haltPlatform(db, 'linkedin', 'layout_drift:profile', NOW);
    expect(await main(['clear-halt', 'linkedin', '--yes'], deps())).toBe(0);
    expect(haltReason(db, 'linkedin')).toBeNull();
  });

  it('clear-halt does not claim to clear an all halt that carries a layout_drift reason', async () => {
    haltPlatform(db, 'all', 'layout_drift:profile', NOW);
    expect(await main(['clear-halt', 'linkedin', '--yes'], deps())).toBe(1);
    expect(haltReason(db, 'all')).toBe('layout_drift:profile');
    expect(out.join('\n')).not.toMatch(/cleared/);
    expect(errs.join('\n')).toMatch(/all halt/);
  });

  it('clear-halt without --yes needs a typed yes', async () => {
    haltPlatform(db, 'naukri', 'layout_drift:job', NOW);
    answers = ['n'];
    expect(await main(['clear-halt', 'naukri'], deps())).toBe(1);
    expect(haltReason(db, 'naukri')).not.toBeNull();
    answers = ['yes'];
    expect(await main(['clear-halt', 'naukri'], deps())).toBe(0);
    expect(haltReason(db, 'naukri')).toBeNull();
  });

  it('clear-halt with no halt is a no-op', async () => {
    expect(await main(['clear-halt', 'linkedin', '--yes'], deps())).toBe(0);
    expect(out.join('\n')).toMatch(/no active halt/);
  });

  it('learn prints promotion progress per learning variant', async () => {
    put('linkedin', {
      profile: kind({ state: 'learning', variants: [variant({ promoted: false, obs: 2, runs: 1, id: 'aaaa11112222' })] }),
    });
    expect(await main(['learn', 'linkedin'], deps())).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('profile');
    expect(text).toContain('aaaa11112222');
    expect(text).toContain(`obs 2/${cfg.promoteN}`);
    expect(text).toContain(`runs 1/${cfg.promoteRuns}`);
  });

  it('uses the injected fs for the move', async () => {
    put('linkedin', { profile: kind() });
    const moves: Array<[string, string]> = [];
    const d = deps({ fs: { exists: (p) => fs.existsSync(p), rename: (a, b) => { moves.push([a, b]); fs.renameSync(a, b); } } });
    expect(await main(['reset', 'linkedin', '--yes'], d)).toBe(0);
    expect(moves).toHaveLength(1);
    expect(moves[0][1]).toContain('.reset-2026-10-15T12-00-00-000Z');
  });

  it('does not touch scripts/linkedin-clear-halt.ts behavior', async () => {
    const { run } = await import('../scripts/linkedin-clear-halt.js');
    haltPlatform(db, 'linkedin', 'checkpoint', NOW);
    expect(run(db, [], NOW).code).toBe(1);
    expect(run(db, ['--yes'], NOW).code).toBe(0);
  });
});
