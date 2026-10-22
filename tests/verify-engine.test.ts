// tests/verify-engine.test.ts
import { describe, expect, it } from 'vitest';
import { buildCtx, exitCodeFor, forceDryEnv, renderTable, runStages, UsageError, type Stage, type VerifyCtx } from '../src/verify/engine.js';
import { isDryRun } from '../src/safety/dryRun.js';

const fakeFs = { mkdtemp: (p: string) => `/virt/${p}x`, mkdir: () => {}, write: () => {}, exists: () => false, rm: () => {} };
function ctx(): VerifyCtx {
  return buildCtx({
    root: '/r', env: { JOBBER_KILL: '1', JOBBER_DRY_RUN: 'false', SCHEDULER_DRY_RUN: 'false', KEEP: 'a' },
    run: async () => ({ stdout: '', code: 0 }), fs: fakeFs, now: () => new Date(0),
    doctor: async () => [], openDb: () => { throw new Error('no'); },
    startWeb: async () => { throw new Error('no'); }, fixtures: () => { throw new Error('no'); },
  });
}
const st = (id: string, run: Stage['run'], skippable = true): Stage => ({ id, title: `T ${id}`, skippable, run });

describe('forceDryEnv', () => {
  it('forces dry for every input combination and drops JOBBER_KILL', () => {
    for (const j of [undefined, '', '0', 'false', '1', 'true']) {
      const out = forceDryEnv({ JOBBER_DRY_RUN: j, SCHEDULER_DRY_RUN: 'false', LINKEDIN_DRY_RUN: 'false', JOBBER_KILL: '1' }, '/t/db');
      expect(isDryRun(out)).toBe(true);
      expect(out.JOBBER_DRY_RUN).toBe('true');
      expect(out.SCHEDULER_DRY_RUN).toBeUndefined();
      expect(out.LINKEDIN_DRY_RUN).toBeUndefined();
      expect(out.JOBBER_KILL).toBeUndefined();
      expect(out.JOBAPPLIER_DB).toBe('/t/db');
    }
  });
  it('requires a db path', () => {
    expect(() => forceDryEnv({}, '')).toThrow();
  });
  it('copies nothing beyond the input', () => {
    const out = forceDryEnv({ A: '1' }, 'x');
    expect(Object.keys(out).sort()).toEqual(['A', 'JOBAPPLIER_DB', 'JOBBER_DRY_RUN']);
  });
});

describe('buildCtx', () => {
  it('puts db and stop file under the temp dir and forces dry', () => {
    const c = ctx();
    expect(c.tempDbPath.startsWith(c.tmp)).toBe(true);
    expect(c.tempStopFile).toBe(`${c.tmp}/.jobber/STOP`);
    expect(isDryRun(c.env)).toBe(true);
    expect(c.env.JOBAPPLIER_DB).toBe(c.tempDbPath);
  });
});

describe('runStages', () => {
  it('keeps order, skips, and reports fail on throw', async () => {
    const r = await runStages([
      st('a', async () => ({ status: 'pass', detail: 'ok' })),
      st('b', async () => { throw new Error('boom\nmore'); }),
      st('c', async () => ({ status: 'pass', detail: 'x' })),
    ], ctx(), { skip: ['c'], timeoutMs: 1000 });
    expect(r.map((x) => [x.id, x.status])).toEqual([['a', 'pass'], ['b', 'fail'], ['c', 'skip']]);
    expect(r[1].detail).toContain('boom');
    expect(r[1].detail).not.toContain('more');
    expect(exitCodeFor(r)).toBe(1);
  });
  it('times out a hanging stage as fail', async () => {
    const r = await runStages([st('h', () => new Promise(() => {}))], ctx(), { skip: [], timeoutMs: 20 });
    expect(r[0].status).toBe('fail');
    expect(r[0].detail).toContain('timed out');
  });
  it('exit code 0 with pass and skip only', async () => {
    const r = await runStages([st('a', async () => ({ status: 'skip', detail: 's' }))], ctx(), { skip: [], timeoutMs: 100 });
    expect(exitCodeFor(r)).toBe(0);
  });
  it('--skip of a non-skippable stage is a usage error', async () => {
    await expect(runStages([st('n', async () => ({ status: 'pass', detail: '' }), false)], ctx(), { skip: ['n'], timeoutMs: 10 }))
      .rejects.toBeInstanceOf(UsageError);
  });
});

describe('renderTable', () => {
  it('prints PASS/FAIL/SKIP, title, detail and a fix line for fail only', () => {
    const t = renderTable([
      { id: 'a', title: 'Alpha', status: 'pass', detail: 'fine', ms: 1 },
      { id: 'b', title: 'Beta', status: 'fail', detail: 'bad', fix: 'do x', ms: 1 },
      { id: 'c', title: 'Gamma', status: 'skip', detail: 'off', fix: 'ignored', ms: 0 },
    ]);
    expect(t).toMatch(/PASS.*Alpha.*fine/);
    expect(t).toMatch(/FAIL.*Beta.*bad/);
    expect(t).toContain('fix: do x');
    expect(t).toMatch(/SKIP.*Gamma.*off/);
    expect(t).not.toContain('ignored');
  });
});
