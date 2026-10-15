import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyObservation, classify } from '../src/layout/classify.js';
import { loadLayoutConfig } from '../src/layout/config.js';
import { emptyLayout, loadLayout, saveLayout } from '../src/layout/store.js';
import type { KindMemory, LayoutFile, Observation, Variant } from '../src/layout/types.js';

const cfg = loadLayoutConfig({}, '/proj'); // promoteN 3, promoteRuns 2, match .9, partial .6, stale 30d, escalate 3, halt 5, window 24h
const T0 = new Date('2026-10-15T00:00:00.000Z');
const hours = (d: Date, h: number) => new Date(d.getTime() + h * 3600_000);
const FULL = ['action:connect', 'action:more', 'profile.degree', 'profile.headline', 'profile.name'];

function obs(landmarks: string[], over: Partial<Observation> = {}): Observation {
  return {
    platform: 'linkedin', kind: 'profile', landmarks: [...landmarks].sort(),
    counts: { actions: 2 }, shell: true, nonDrift: null, ...over,
  };
}
function variant(id: string, landmarks: string[], over: Partial<Variant> = {}): Variant {
  return {
    id, landmarks: [...landmarks].sort(), counts: { actions: [2, 2] }, recipes: [],
    first_seen: T0.toISOString(), last_verified: T0.toISOString(), obs: 3, runs: 2, run_ids: ['r1', 'r2'],
    promoted: true, ok: 0, fail: 0, ...over,
  };
}
function fileWith(variants: Variant[], over: Partial<KindMemory> = {}): LayoutFile {
  const f = emptyLayout('linkedin', T0);
  f.kinds.profile = {
    state: 'stable', variants, counters: { match: 0, partial: 0, drift: 0 },
    drift_streak: 0, drift_window_start: null, last_drift_at: null, ...over,
  };
  return f;
}
const run = (f: LayoutFile, o: Observation, now = T0, runId: string | null = 'r1') =>
  applyObservation(f, o, { now, runId }, cfg);

describe('classify', () => {
  const f = fileWith([variant('v1', FULL)]);
  const table: Array<[string, LayoutFile, Observation, string]> = [
    ['match', f, obs(FULL), 'match'],
    ['partial: non-critical missing', f, obs(FULL.filter((l) => l !== 'action:more')), 'partial'],
    ['drift: critical missing', f, obs(FULL.filter((l) => l !== 'profile.name')), 'drift'],
    ['drift: score under partialMin', f, obs(['profile.name']), 'drift'],
    ['unknown: no variant', emptyLayout('linkedin', T0), obs(FULL), 'unknown'],
    ['unknown: only learning variant', fileWith([variant('l', FULL, { promoted: false })]), obs(FULL), 'unknown'],
    ['unloaded: shell absent', f, obs(['profile.name'], { shell: false }), 'unloaded'],
    ['blocked', f, obs([], { nonDrift: 'blocked', shell: false }), 'blocked'],
    ['logged_out', f, obs([], { nonDrift: 'logged_out', shell: false }), 'logged_out'],
  ];
  it.each(table)('%s', (_n, file, o, cls) => {
    expect(classify(file, o, cfg).class).toBe(cls);
  });

  it('reports score, missing and variant', () => {
    const v = classify(f, obs(FULL.filter((l) => l !== 'action:more')), cfg);
    expect(v).toEqual({ class: 'partial', score: 0.8, missing: ['action:more'], variant: 'v1' });
  });

  it('A/B: two promoted variants, either matches', () => {
    const B = ['action:follow', 'action:message', 'profile.headline', 'profile.name'];
    const ab = fileWith([variant('a', FULL), variant('b', B)]);
    expect(classify(ab, obs(FULL), cfg)).toMatchObject({ class: 'match', variant: 'a' });
    expect(classify(ab, obs(B), cfg)).toMatchObject({ class: 'match', variant: 'b', score: 1 });
  });
});

describe('applyObservation: counters and non-drift', () => {
  it.each(['blocked', 'logged_out', 'unloaded'] as const)('%s leaves the file untouched', (nd) => {
    const base = fileWith([variant('v1', FULL)], { drift_streak: 2, drift_window_start: T0.toISOString() });
    const before = JSON.stringify(base);
    const r = run(base, obs([], { nonDrift: nd, shell: false }));
    expect(r.verdict.class).toBe(nd);
    expect(r.events).toEqual([]);
    expect(JSON.stringify(r.file)).toBe(before);
  });

  it('shell absent with missing landmarks is unloaded and changes no counter', () => {
    const base = fileWith([variant('v1', FULL)], { drift_streak: 1, drift_window_start: T0.toISOString() });
    const r = run(base, obs(['profile.name'], { shell: false }));
    expect(r.verdict.class).toBe('unloaded');
    expect(r.file.kinds.profile.counters).toEqual({ match: 0, partial: 0, drift: 0 });
    expect(r.file.kinds.profile.drift_streak).toBe(1);
  });

  it('does not mutate the input', () => {
    const base = fileWith([variant('v1', FULL)]);
    const frozen = JSON.stringify(base);
    run(base, obs(FULL.filter((l) => l !== 'profile.name')));
    run(base, obs(FULL));
    expect(JSON.stringify(base)).toBe(frozen);
  });

  it('match bumps counter, last_verified and the run id list', () => {
    const later = hours(T0, 5);
    const r = run(fileWith([variant('v1', FULL, { obs: 3, runs: 2, run_ids: ['r1', 'r2'] })]), obs(FULL), later, 'r3');
    const v = r.file.kinds.profile.variants[0];
    expect(r.file.kinds.profile.counters.match).toBe(1);
    expect(v.last_verified).toBe(later.toISOString());
    expect(v.obs).toBe(4);
    expect(v.run_ids).toEqual(['r1', 'r2', 'r3']);
    expect(v.runs).toBe(3);
  });

  it('run_ids keep the 5 most recent and null/invalid ids count as norun', () => {
    let f = fileWith([variant('v1', FULL, { run_ids: [], runs: 0, obs: 0 })]);
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) f = run(f, obs(FULL), T0, id).file;
    expect(f.kinds.profile.variants[0].run_ids).toEqual(['b', 'c', 'd', 'e', 'f']);
    f = run(f, obs(FULL), T0, null).file;
    f = run(f, obs(FULL), T0, 'bad id!').file;
    const ids = f.kinds.profile.variants[0].run_ids;
    expect(ids.at(-1)).toBe('norun');
    expect(ids.filter((x) => x === 'norun')).toHaveLength(1);
  });
});

describe('applyObservation: learning and promotion', () => {
  it('needs both N observations and distinct runs', () => {
    let f = emptyLayout('linkedin', T0);
    const o = obs(FULL);
    for (let i = 0; i < 3; i++) f = run(f, o, T0, 'r1').file;
    expect(f.kinds.profile.variants).toHaveLength(1);
    expect(f.kinds.profile.variants[0]).toMatchObject({ promoted: false, obs: 3, runs: 1 });
    const r = run(f, o, T0, 'r2');
    expect(r.events).toEqual(['promoted']);
    expect(r.file.kinds.profile.variants[0]).toMatchObject({ promoted: true, obs: 4, runs: 2 });
    expect(r.file.kinds.profile.state).toBe('stable');
    expect(r.file.kinds.profile.variants[0].id).toMatch(/^[0-9a-f]{12}$/);
  });

  it('two runs without enough observations do not promote', () => {
    let f = run(emptyLayout('linkedin', T0), obs(FULL), T0, 'r1').file;
    const r = run(f, obs(FULL), T0, 'r2');
    expect(r.events).toEqual([]);
    expect(r.file.kinds.profile.variants[0].promoted).toBe(false);
  });

  it('MIN_SET gate: a poisoned observation (no MIN_SET) is never learned', () => {
    let f = emptyLayout('linkedin', T0);
    const poisoned = obs(['action:connect', 'profile.degree']); // no profile.name / headline
    for (let i = 0; i < 6; i++) f = run(f, poisoned, T0, `r${i}`).file;
    expect(f.kinds.profile?.variants ?? []).toHaveLength(0);
    const noShell = obs(FULL, { shell: false });
    f = run(f, noShell).file;
    expect(f.kinds.profile?.variants ?? []).toHaveLength(0);
  });

  it('kinds without a MIN_SET entry are never learned', () => {
    const r = run(emptyLayout('linkedin', T0), obs(['notice.present'], { kind: 'feed' }));
    expect(r.verdict.class).toBe('unknown');
    expect(r.file.kinds.feed?.variants ?? []).toHaveLength(0);
  });

  it('observations with a different landmark set seed a separate learning variant', () => {
    let f = run(emptyLayout('linkedin', T0), obs(FULL)).file;
    f = run(f, obs([...FULL, 'profile.about'])).file;
    expect(f.kinds.profile.variants).toHaveLength(2);
  });

  it('counts within one bucket feed the same variant, farther ones seed another', () => {
    let f = run(emptyLayout('linkedin', T0), obs(FULL, { counts: { actions: 2 } })).file;
    f = run(f, obs(FULL, { counts: { actions: 3 } })).file;
    expect(f.kinds.profile.variants).toHaveLength(1);
    expect(f.kinds.profile.variants[0].counts.actions).toEqual([2, 3]);
    f = run(f, obs(FULL, { counts: { actions: 4 } })).file;
    expect(f.kinds.profile.variants).toHaveLength(2);
  });

  it('variant cap of 3: promotion drops the least recently verified', () => {
    const mk = (id: string, extra: string[], verified: string) =>
      variant(id, ['profile.name', 'profile.headline', ...extra], { last_verified: verified });
    const f0 = fileWith([
      mk('old', ['action:follow', 'action:message', 'profile.pending', 'dialog.open'], '2026-10-01T00:00:00.000Z'),
      mk('mid', ['action:follow', 'action:message', 'profile.pending', 'notice.present'], '2026-10-10T00:00:00.000Z'),
      mk('new', ['action:follow', 'action:message', 'profile.pending', 'profile.bell'], '2026-10-14T00:00:00.000Z'),
    ]);
    const o = obs(['profile.name', 'profile.headline', 'profile.about', 'profile.degree']);
    // With 3 promoted variants a drifting observation is never accumulated: no promoted variant is
    // lost and variant_replaced is never emitted, however long the drift lasts (owner reset is the remedy).
    let f = f0;
    const events: string[] = [];
    for (const id of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']) {
      const last = run(f, o, T0, id);
      f = last.file;
      events.push(...last.events);
    }
    expect(events).not.toContain('variant_replaced');
    expect(events).not.toContain('promoted');
    expect(f.kinds.profile.variants.map((v) => v.id)).toEqual(['old', 'mid', 'new']);
    expect(f.kinds.profile.counters.drift).toBe(7);
    expect(f.kinds.profile.drift_streak).toBe(7);
  });

  it('six null-runId observations never promote', () => {
    let f = emptyLayout('linkedin', T0);
    for (let i = 0; i < 6; i++) f = run(f, obs(FULL), T0, null).file;
    expect(f.kinds.profile.variants[0]).toMatchObject({ promoted: false, obs: 6, runs: 1, run_ids: ['norun'] });
  });

  it('clamps obs, runs and counters so the result stays valid', () => {
    const big = 1_000_000;
    const f = fileWith([variant('v1', FULL, { obs: big, runs: big })], { counters: { match: big, partial: 0, drift: 0 } });
    const r = run(f, obs(FULL), T0, 'fresh');
    const v = r.file.kinds.profile.variants[0];
    expect(v.obs).toBe(big);
    expect(v.runs).toBe(big);
    expect(r.file.kinds.profile.counters.match).toBe(big);
  });

  it('an observation for another platform is unknown and changes nothing', () => {
    const f = fileWith([variant('v1', FULL)]);
    const o = obs(FULL, { platform: 'naukri' });
    expect(classify(f, o, cfg).class).toBe('unknown');
    const r = run(f, o);
    expect(r.verdict.class).toBe('unknown');
    expect(JSON.stringify(r.file)).toBe(JSON.stringify(f));
  });

  it('does not seed beyond 3 variants when all are promoted', () => {
    const vs = ['a', 'b', 'c'].map((id) => variant(id, ['profile.name', 'profile.headline', `action:${id === 'a' ? 'follow' : id === 'b' ? 'more' : 'pending'}`, 'dialog.open', 'notice.present']));
    const r = run(fileWith(vs), obs(['profile.name', 'profile.headline', 'profile.about']));
    expect(r.file.kinds.profile.variants).toHaveLength(3);
  });

  it('a result always round-trips through the store', () => {
    let f = emptyLayout('linkedin', T0);
    for (const id of ['r1', 'r1', 'r1', 'r2', 'r3']) f = run(f, obs(FULL), T0, id).file;
    f = run(f, obs(FULL.filter((l) => l !== 'profile.name'))).file;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-classify-'));
    try {
      const p = path.join(dir, 'linkedin.json');
      saveLayout(p, f, cfg.maxBytes, 'linkedin');
      const back = loadLayout(p, 'linkedin', T0);
      expect(back.note).toBeNull();
      expect(back.file.kinds.profile.variants).toHaveLength(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('applyObservation: drift', () => {
  const driftObs = obs(FULL.filter((l) => l !== 'profile.name'));
  const base = () => fileWith([variant('v1', FULL)]);

  it('increments counters and streak, marks state drifted', () => {
    const r = run(base(), driftObs);
    const k = r.file.kinds.profile;
    expect(r.verdict.class).toBe('drift');
    expect(k.counters.drift).toBe(1);
    expect(k.drift_streak).toBe(1);
    expect(k.state).toBe('drifted');
    expect(k.last_drift_at).toBe(T0.toISOString());
    expect(k.drift_window_start).toBe(T0.toISOString());
  });

  it('match and partial reset the streak', () => {
    let f = run(run(base(), driftObs).file, driftObs).file;
    expect(f.kinds.profile.drift_streak).toBe(2);
    const m = run(f, obs(FULL));
    expect(m.file.kinds.profile.drift_streak).toBe(0);
    expect(m.file.kinds.profile.state).toBe('stable');
    const p = run(f, obs(FULL.filter((l) => l !== 'action:more')));
    expect(p.verdict.class).toBe('partial');
    expect(p.file.kinds.profile.drift_streak).toBe(0);
    expect(p.file.kinds.profile.counters.partial).toBe(1);
  });

  it('window elapsed restarts the streak', () => {
    let f = run(base(), driftObs).file;
    f = run(f, driftObs, hours(T0, 1)).file;
    expect(f.kinds.profile.drift_streak).toBe(2);
    f = run(f, driftObs, hours(T0, 25)).file;
    expect(f.kinds.profile.drift_streak).toBe(1);
  });

  it('escalates once at the threshold, halts at the halt threshold', () => {
    let f = base();
    const evs: string[][] = [];
    for (let i = 0; i < 6; i++) {
      const r = run(f, driftObs, hours(T0, i));
      f = r.file;
      evs.push(r.events);
    }
    expect(evs[0]).toEqual([]);
    expect(evs[1]).toEqual([]);
    expect(evs[2]).toEqual(['drift_escalate']);
    expect(evs[3]).toEqual([]);
    expect(evs[4]).toContain('drift_halt');
    expect(evs[4]).not.toContain('drift_escalate');
  });

  it('a drift observation that holds MIN_SET feeds a learning variant', () => {
    const o = obs(['profile.name', 'profile.headline', 'profile.about', 'profile.bell', 'profile.pending']);
    const r = run(base(), o);
    expect(r.verdict.class).toBe('drift');
    expect(r.file.kinds.profile.variants.filter((v) => !v.promoted)).toHaveLength(1);
  });
});

describe('applyObservation: staleness', () => {
  it('marks stale after staleDays and a match refreshes it', () => {
    const f = fileWith([variant('v1', FULL)]);
    const late = hours(T0, 24 * 40);
    const p = run(f, obs(FULL.filter((l) => l !== 'action:more')), late);
    expect(p.verdict.class).toBe('partial');
    expect(p.file.kinds.profile.state).toBe('stale');
    const m = run(f, obs(FULL), late);
    expect(m.verdict.class).toBe('match');
    expect(m.file.kinds.profile.state).toBe('stable');
    expect(m.file.kinds.profile.variants[0].last_verified).toBe(late.toISOString());
  });

  it('is not stale inside the window', () => {
    const r = run(fileWith([variant('v1', FULL)]), obs(FULL.filter((l) => l !== 'action:more')), hours(T0, 24 * 10));
    expect(r.file.kinds.profile.state).toBe('stable');
  });
});
