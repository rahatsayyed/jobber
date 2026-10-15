import { describe, it, expect } from 'vitest';
import { runChecks, type DoctorContext } from '../src/platform/doctor.js';
import { layoutChecks } from '../src/platform/checksLayout.js';
import { openDb } from '../src/db.js';
import { haltPlatform } from '../src/outreach/limits.js';
import type { KindMemory, LayoutFile, Variant } from '../src/layout/types.js';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const DIR = '/p/.jobber/layout';

function variant(over: Partial<Variant> = {}): Variant {
  return {
    id: 'abc123def456', landmarks: [], counts: {}, recipes: [],
    first_seen: '2026-10-01T00:00:00.000Z', last_verified: '2026-10-13T12:00:00.000Z',
    obs: 5, runs: 3, run_ids: ['r1'], promoted: true, ok: 1, fail: 0, ...over,
  };
}
function kind(over: Partial<KindMemory> = {}): KindMemory {
  return { state: 'stable', variants: [variant()], counters: { match: 5, partial: 0, drift: 0 },
    drift_streak: 0, drift_window_start: null, last_drift_at: null, drift_run_ids: [], ...over };
}
function file(platform: 'linkedin' | 'naukri', kinds: Record<string, KindMemory>, updated = '2026-10-14T00:00:00.000Z'): string {
  const f: LayoutFile = { schema: 1, platform, updated_at: updated, kinds };
  return JSON.stringify(f);
}
// critical kinds: linkedin profile/search/invitations, naukri job/thread
const allStable = (): Record<string, string> => ({
  [`${DIR}/linkedin.json`]: file('linkedin', { profile: kind(), search: kind(), invitations: kind() }),
  [`${DIR}/naukri.json`]: file('naukri', { job: kind(), thread: kind() }),
});

interface Opts { env?: NodeJS.ProcessEnv; modes?: Record<string, number>; list?: string[]; envFile?: string }
function ctxWith(files: Record<string, string>, o: Opts = {}): DoctorContext {
  const all = { ...files };
  if (o.envFile !== undefined) all['/p/.env'] = o.envFile;
  return {
    root: '/p', env: o.env ?? {}, run: async () => ({ stdout: '', code: 1 }),
    fs: {
      exists: (p) => p in all || p === DIR && Object.keys(all).some((k) => k.startsWith(DIR + '/')),
      read: (p) => all[p],
      mode: (p) => (p in (o.modes ?? {}) ? o.modes![p] : p === DIR ? (Object.keys(all).some((k) => k.startsWith(DIR + '/')) ? 0o700 : null) : p in all ? 0o600 : null),
      list: (p) => (p === DIR ? [...Object.keys(all).filter((k) => k.startsWith(DIR + '/')).map((k) => k.slice(DIR.length + 1)), ...(o.list ?? [])] : []),
    },
    now: () => NOW,
  };
}
async function run(ctx: DoctorContext, db = openDb(':memory:')) {
  const res = await runChecks(layoutChecks({ db: () => db }), ctx);
  return Object.fromEntries(res.map((r) => [r.id, r.result]));
}

describe('layout_store', () => {
  it('passes for valid files', async () => {
    expect((await run(ctxWith(allStable()))).layout_store.status).toBe('pass');
  });
  it('skips when nothing exists', async () => {
    expect((await run(ctxWith({}))).layout_store.status).toBe('skip');
  });
  it('fails on invalid json', async () => {
    const r = await run(ctxWith({ ...allStable(), [`${DIR}/linkedin.json`]: '{bad' }));
    expect(r.layout_store.status).toBe('fail');
  });
  it('fails over the size cap', async () => {
    const r = await run(ctxWith(
      { ...allStable(), [`${DIR}/linkedin.json`]: file('linkedin', {}) + ' '.repeat(5000) },
      { env: { LAYOUT_MAX_BYTES: '4096' } },
    ));
    expect(r.layout_store.status).toBe('fail');
  });
  it('warns when the directory is group or world accessible', async () => {
    const r = await run(ctxWith(allStable(), { modes: { [DIR]: 0o755 } }));
    expect(r.layout_store.status).toBe('warn');
  });
  it('warns on a .corrupt file older than 7 days, ignores a recent one', async () => {
    const old = await run(ctxWith(allStable(), { list: ['linkedin.json.corrupt-2026-10-01T00-00-00-000Z'] }));
    expect(old.layout_store.status).toBe('warn');
    const recent = await run(ctxWith(allStable(), { list: ['linkedin.json.corrupt-2026-10-14T00-00-00-000Z'] }));
    expect(recent.layout_store.status).toBe('pass');
  });
});

describe('layout_age', () => {
  it('passes with fresh promoted memory', async () => {
    expect((await run(ctxWith(allStable()))).layout_age.status).toBe('pass');
  });
  it('warns when older than staleDays', async () => {
    const files = { ...allStable(), [`${DIR}/linkedin.json`]: file('linkedin', { profile: kind() }, '2026-08-01T00:00:00.000Z') };
    expect((await run(ctxWith(files))).layout_age.status).toBe('warn');
  });
  it('warns when there is no promoted variant', async () => {
    const files = { ...allStable(), [`${DIR}/naukri.json`]: file('naukri', { job: kind({ state: 'learning', variants: [variant({ promoted: false })] }) }) };
    expect((await run(ctxWith(files))).layout_age.status).toBe('warn');
  });
  it('skips when the scheduler is disabled', async () => {
    expect((await run(ctxWith({}, { env: { SCHEDULER_ENABLED: 'false' } }))).layout_age.status).toBe('skip');
  });
  it('honours LAYOUT_STALE_DAYS from the .env file', async () => {
    const r = await run(ctxWith(allStable(), { envFile: 'LAYOUT_STALE_DAYS=1\n' }));
    expect(r.layout_age.status).toBe('pass'); // updated 2026-10-14T00:00, now 10-15T12:00 = 1.5 days
  });
});

describe('layout_drift', () => {
  it('passes with zero streaks', async () => {
    expect((await run(ctxWith(allStable()))).layout_drift.status).toBe('pass');
  });
  it('warns on a non-zero streak', async () => {
    const files = { ...allStable(), [`${DIR}/linkedin.json`]: file('linkedin', { profile: kind({ drift_streak: 1 }) }) };
    expect((await run(ctxWith(files))).layout_drift.status).toBe('warn');
  });
  it('fails when halted for layout', async () => {
    const db = openDb(':memory:');
    haltPlatform(db, 'linkedin', 'layout_drift:profile', NOW);
    expect((await run(ctxWith(allStable()), db)).layout_drift.status).toBe('fail');
  });
  it('a non-layout halt is not this check\'s failure', async () => {
    const db = openDb(':memory:');
    haltPlatform(db, 'linkedin', 'checkpoint', NOW);
    expect((await run(ctxWith(allStable()), db)).layout_drift.status).toBe('pass');
  });
});

describe('layout_enforce', () => {
  it('warns with the flip suggestion when warn mode and every critical kind is stable', async () => {
    const r = (await run(ctxWith(allStable()))).layout_enforce;
    expect(r.status).toBe('warn');
    expect(r.fix).toMatch(/LAYOUT_ENFORCE=enforce/);
  });
  it('passes when a critical kind is missing', async () => {
    const files = { ...allStable(), [`${DIR}/linkedin.json`]: file('linkedin', { profile: kind() }) };
    expect((await run(ctxWith(files))).layout_enforce.status).toBe('pass');
  });
  it('passes when a critical kind has drift counters', async () => {
    const files = { ...allStable(), [`${DIR}/naukri.json`]: file('naukri', { job: kind({ counters: { match: 5, partial: 0, drift: 1 } }), thread: kind() }) };
    expect((await run(ctxWith(files))).layout_enforce.status).toBe('pass');
  });
  it('passes when a critical kind is not stable', async () => {
    const files = { ...allStable(), [`${DIR}/naukri.json`]: file('naukri', { job: kind({ state: 'stale' }), thread: kind() }) };
    expect((await run(ctxWith(files))).layout_enforce.status).toBe('pass');
  });
  it('passes when already enforcing', async () => {
    const r = await run(ctxWith(allStable(), { env: { LAYOUT_ENFORCE: 'enforce' } }));
    expect(r.layout_enforce.status).toBe('pass');
  });
});

describe('secrecy', () => {
  it('never prints .env values', async () => {
    const ctx = ctxWith(allStable(), { envFile: 'LAYOUT_STALE_DAYS=1\nGMAIL_TOKEN=sekret-value-123\n' });
    const res = await runChecks(layoutChecks({ db: () => openDb(':memory:') }), ctx);
    expect(JSON.stringify(res)).not.toContain('sekret-value-123');
  });
});
