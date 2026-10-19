// Plan 8G-2 task 24: the three new `npm run dry-run` stages (provider shape break, scout dork, applier fixture site),
// including the skip paths. Hermetic: temp dirs, in-memory/temp databases, the committed fake site; no network or browser.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { buildCtx, type VerifyCtx } from '../src/verify/engine.js';
import { allStages } from '../src/verify/stages.js';
import { applierFixture, movedCounters, providerShapeBreak, scoutDork } from '../src/verify/stagesSources.js';

const ROOT = resolve(import.meta.dirname, '..');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const fs = {
  mkdtemp: (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; },
  mkdir: (p: string) => { mkdirSync(p, { recursive: true }); },
  write: (p: string, d: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, d); },
  read: (p: string) => readFileSync(p, 'utf8'),
  exists: (p: string) => existsSync(p),
  rm: (p: string) => rmSync(p, { recursive: true, force: true }),
};
function mk(root = ROOT): VerifyCtx {
  return buildCtx({
    root, env: { PATH: process.env.PATH }, run: async () => ({ stdout: '', code: 0 }), fs, now: () => new Date('2026-10-16T10:00:00Z'),
    doctor: async () => [], openDb, startWeb: async () => ({ url: 'http://x', close: async () => {} }),
    fixtures: () => ({ jobs: [], match: [], cleanJobId: '', dealBreakerJobId: '', dealBreakers: [] }),
  } as never);
}
const emptyRoot = () => fs.mkdtemp('jobber-stage-root-');

describe('stage registration', () => {
  it('the three stages are listed, skippable, and none is the llm stage', () => {
    const ids = allStages().map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['provider-shape', 'scout-dork', 'applier-fixture']));
    for (const s of [providerShapeBreak, scoutDork, applierFixture]) expect(s.skippable).toBe(true);
  });
  it('--llm does not feed any of the three stages (they never read ctx.llm)', () => {
    for (const s of [providerShapeBreak, scoutDork, applierFixture]) expect(String(s.run)).not.toMatch(/\.llm\b/);
  });
});

describe('provider-shape stage', () => {
  it('passes: the broken provider queues exactly one shape task and the healthy one is untouched', async () => {
    const r = await providerShapeBreak.run(mk());
    expect(r.status, r.detail).toBe('pass');
    expect(r.detail).toMatch(/source_tasks row/);
  });
  it('skips with a note when the source runner is not installed', async () => {
    const r = await providerShapeBreak.run(mk(emptyRoot()));
    expect(r.status).toBe('skip');
    expect(r.detail).toMatch(/runner is not installed/);
  });
});

describe('scout-dork stage', () => {
  it('skips with a note when src/scout is not installed (this branch)', async () => {
    const r = await scoutDork.run(mk(emptyRoot()));
    expect(r.status).toBe('skip');
    expect(r.detail).toMatch(/src\/scout is not installed/);
  });
  it('skips (never fails) when serp.ts exists but the anchor-page fixtures are not installed', async () => {
    const root = emptyRoot();
    fs.write(join(root, 'src/scout/serp.ts'), 'export {};\n');
    const r = await scoutDork.run(mk(root));
    expect(r.status).toBe('skip');
    expect(r.detail).toMatch(/anchor-page fixtures/);
  });
  it('really runs: parseSerp (serp.ts) over anchor pages built from the serp fixtures, not a skip', async () => {
    const r = await scoutDork.run(mk());
    expect(r.status, r.detail).toBe('pass');
    expect(r.detail).toMatch(/serp-ok parsed 3 results; serp-blocked recognised \(bot_wall\)/);
  });
});

describe('applier-fixture stage', () => {
  it('runs the applier on the fixture site in dry mode and hold mode; only apply_attempt moves', async () => {
    const r = await applierFixture.run(mk());
    expect(r.status, r.detail).toBe('pass');
    expect(r.detail).toMatch(/dry dry_run; hold held/);
    expect(r.detail).toMatch(/only apply_attempt moved/);
  });
  it('skips with a note when the fixture site is not installed', async () => {
    const r = await applierFixture.run(mk(emptyRoot()));
    expect(r.status).toBe('skip');
    expect(r.detail).toMatch(/not installed/);
  });
  it('movedCounters reports every counter that changed', () => {
    expect(movedCounters({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual(['b']);
    expect(movedCounters({ a: 1 }, { a: 1 })).toEqual([]);
  });
});
