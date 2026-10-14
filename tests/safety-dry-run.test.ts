import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { isDryRun, recordDryRun, listDryRun } from '../src/safety/dryRun.js';
import { loadLinkedinConfig } from '../src/linkedin/config.js';

const T = new Date('2026-10-15T10:00:00.000Z');

describe('isDryRun truth table', () => {
  it.each([
    [{}, true],
    [{ JOBBER_DRY_RUN: '0' }, true],
    [{ JOBBER_DRY_RUN: '0', SCHEDULER_DRY_RUN: 'true' }, true],
    [{ SCHEDULER_DRY_RUN: 'false' }, false],
    [{ SCHEDULER_DRY_RUN: 'false', JOBBER_DRY_RUN: '0' }, false],
    [{ SCHEDULER_DRY_RUN: 'false', JOBBER_DRY_RUN: '1' }, true],
    [{ SCHEDULER_DRY_RUN: 'False' }, true],
    [{ SCHEDULER_DRY_RUN: '' }, true],
  ])('%j -> %s', (env, want) => {
    expect(isDryRun(env as NodeJS.ProcessEnv)).toBe(want);
  });

  it('linkedin flag matrix', () => {
    const o = { linkedin: true };
    expect(isDryRun({ SCHEDULER_DRY_RUN: 'false' }, o)).toBe(true);
    expect(isDryRun({ SCHEDULER_DRY_RUN: 'false', LINKEDIN_DRY_RUN: 'false' }, o)).toBe(false);
    expect(isDryRun({ LINKEDIN_DRY_RUN: 'false' }, o)).toBe(true);
    expect(isDryRun({ SCHEDULER_DRY_RUN: 'false', LINKEDIN_DRY_RUN: 'false', JOBBER_DRY_RUN: '1' }, o)).toBe(true);
    // non-linkedin callers ignore the linkedin flag
    expect(isDryRun({ SCHEDULER_DRY_RUN: 'false' })).toBe(false);
  });

  it('loadLinkedinConfig honours the global flags', () => {
    expect(loadLinkedinConfig({ LINKEDIN_DRY_RUN: 'false' }).dryRun).toBe(true);
    expect(loadLinkedinConfig({ LINKEDIN_DRY_RUN: 'false', SCHEDULER_DRY_RUN: 'false' }).dryRun).toBe(false);
    expect(loadLinkedinConfig({ LINKEDIN_DRY_RUN: 'false', SCHEDULER_DRY_RUN: 'false', JOBBER_DRY_RUN: '1' }).dryRun).toBe(true);
  });
});

describe('dry run recorder', () => {
  it('round trips, newest first, filters by run', () => {
    const db = openDb(':memory:');
    const a = recordDryRun(db, { runId: 'r1', action: 'send', platform: 'email', personId: 7, payload: { to: 'a@x.test' } }, T, {});
    const b = recordDryRun(db, { runId: 'r2', action: 'connect', platform: 'linkedin', payload: { n: 1 } }, T, {});
    expect(a.status).toBe('dry_run');
    expect(b.id).toBeGreaterThan(a.id);
    const all = listDryRun(db);
    expect(all.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(all[1]).toMatchObject({ runId: 'r1', action: 'send', platform: 'email', personId: 7, payload: { to: 'a@x.test' } });
    expect(listDryRun(db, { runId: 'r1' })).toHaveLength(1);
  });

  it('JOBBER_RUN_ID overrides rec.runId', () => {
    const db = openDb(':memory:');
    recordDryRun(db, { runId: 'r1', action: 'a', platform: 'p', payload: {} }, T, { JOBBER_RUN_ID: 'env-run' });
    expect(listDryRun(db)[0].runId).toBe('env-run');
  });

  it('clamps payload and falls back to raw', () => {
    const db = openDb(':memory:');
    recordDryRun(db, { runId: null, action: 'a', platform: 'p', payload: { big: 'x'.repeat(10000) } }, T, {});
    const row = db.prepare('SELECT payload FROM dry_run_actions').get() as { payload: string };
    expect(row.payload.length).toBeLessThanOrEqual(4000);
    const r = listDryRun(db)[0];
    expect(typeof (r.payload as { raw: string }).raw).toBe('string');
  });

  it('redacts env secret values', () => {
    const db = openDb(':memory:');
    const secret = 'sup3r-secret-value-123';
    recordDryRun(db, { runId: null, action: 'a', platform: 'p', payload: { note: `token ${secret} here` } }, T, { MY_API_TOKEN: secret });
    const row = db.prepare('SELECT payload FROM dry_run_actions').get() as { payload: string };
    expect(row.payload).not.toContain(secret);
  });

  it('redacts a secret straddling the clamp boundary', () => {
    const db = openDb(':memory:');
    const secret = 'ZXCVBNMASDFGHJKL';
    const pad = 'x'.repeat(3980);
    recordDryRun(db, { runId: null, action: 'a', platform: 'p', payload: { pad, s: secret } }, T, { MY_SECRET_KEY: secret });
    const row = db.prepare('SELECT payload FROM dry_run_actions').get() as { payload: string };
    expect(row.payload.length).toBeLessThanOrEqual(4000);
    for (let i = 4; i <= secret.length; i++) expect(row.payload).not.toContain(secret.slice(0, i));
    expect(row.payload).not.toMatch(/\[r[a-z]*$/);
  });

  it('redacts JSON-escaped forms of secrets', () => {
    const db = openDb(':memory:');
    const secret = 'pa"ss\\wörd-1234';
    recordDryRun(db, { runId: null, action: 'a', platform: 'p', payload: { s: secret } }, T, { MY_PASSWORD: secret });
    const row = db.prepare('SELECT payload FROM dry_run_actions').get() as { payload: string };
    expect(row.payload).not.toContain('wörd-1234');
    expect(row.payload).not.toContain(JSON.stringify(secret).slice(1, -1));
  });

  it('clamps limit to 1..500', () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 3; i++) recordDryRun(db, { runId: null, action: 'a', platform: 'p', payload: { i } }, T, {});
    expect(listDryRun(db, { limit: 0 })).toHaveLength(1);
    expect(listDryRun(db, { limit: 9999 })).toHaveLength(3);
  });
});
