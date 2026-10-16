import { describe, expect, it, beforeEach } from 'vitest';
import { openDb, type Job } from '../src/db.js';
import {
  boardStatusAlias, collectSources, finishRun, recordRun, resetSourceStatusForTests, setDroppedDuplicates, sourceStatusPayload,
  statsToOutcomes, type SourceProvider,
} from '../src/sources/status.js';

const job = (id: string, source: string): Job => ({ id, source, title: 't', company: 'c', url: 'u', apply_url: 'u', description: '' });

beforeEach(() => resetSourceStatusForTests());

describe('collectSources', () => {
  it('a throwing provider yields a redacted error row and the others still return', async () => {
    const providers: SourceProvider[] = [
      { id: 'adzuna', run: async () => { throw new Error('GET https://api.adzuna.com/x?app_id=1&app_key=SECRET failed'); } },
      { id: 'remotive', run: async () => [job('remotive:1', 'remotive'), job('remotive:2', 'remotive')] },
    ];
    const { jobs, outcomes } = await collectSources(providers);
    expect(jobs.map((j) => j.id)).toEqual(['remotive:1', 'remotive:2']);
    const a = outcomes.find((o) => o.id === 'adzuna')!;
    expect(a.error).toBeDefined();
    expect(a.error).not.toContain('SECRET');
    expect(a.fetched).toBe(0);
    expect(outcomes.find((o) => o.id === 'remotive')).toMatchObject({ fetched: 2, kept: 2 });
  });
  it('a provider may return per-source outcomes (boards)', async () => {
    const { outcomes } = await collectSources([{ id: 'boards', run: async () => ({ jobs: [job('gh:a:1', 'greenhouse')], outcomes: [{ id: 'greenhouse', fetched: 6, kept: 1 }] }) }]);
    expect(outcomes).toEqual([{ id: 'greenhouse', fetched: 6, kept: 1 }]);
  });
});

describe('statsToOutcomes', () => {
  it('groups board stats and errors by vendor, unattributed errors go to portals', () => {
    const o = statsToOutcomes(
      [{ company: 'A', ats: 'greenhouse', fetched: 6, kept: 2 }, { company: 'B', ats: 'greenhouse', fetched: 4, kept: 1 }],
      ['greenhouse bad: HTTP 500', 'config/portals.json: tracked_companies[0] skipped: unknown ats'],
    );
    const gh = o.find((x) => x.id === 'greenhouse')!;
    expect(gh).toMatchObject({ fetched: 10, kept: 3 });
    expect(gh.error).toBe('greenhouse bad: HTTP 500');
    expect(o.find((x) => x.id === 'portals')?.error).toMatch(/unknown ats/);
  });
});

describe('sourceStatusPayload', () => {
  it('reports ran:false before anything ran', () => {
    const db = openDb(':memory:');
    expect(sourceStatusPayload(db)).toMatchObject({ ran: false, rows: [] });
  });
  it('new counts only the jobs saved in this call, per source', async () => {
    const db = openDb(':memory:');
    const { outcomes } = await collectSources([
      { id: 'remotive', run: async () => [job('remotive:1', 'remotive'), job('remotive:2', 'remotive'), job('remotive:3', 'remotive')] },
      { id: 'adzuna', run: async () => [job('adzuna:1', 'adzuna')] },
    ]);
    finishRun(db, outcomes, [job('remotive:1', 'remotive')]);
    const p = sourceStatusPayload(db);
    expect(p.ran).toBe(true);
    const rem = p.rows.find((r) => r.source === 'remotive')!;
    expect(rem).toMatchObject({ fetched: 3, kept: 3, new: 1, kind: 'script', group: 'api', fallback_used: false });
    expect(p.rows.find((r) => r.source === 'adzuna')).toMatchObject({ new: 0 });
    // a second run overwrites new
    finishRun(db, outcomes, []);
    expect(sourceStatusPayload(db).rows.find((r) => r.source === 'remotive')!.new).toBe(0);
  });
  it('stores a redacted error and a failure streak that resets on success', () => {
    const db = openDb(':memory:');
    recordRun(db, 'adzuna', { fetched: 0, kept: 0, new: 0, error: 'bad https://x.test/?app_key=SECRET' });
    recordRun(db, 'adzuna', { fetched: 0, kept: 0, new: 0, error: 'again' });
    const streak = () => (db.prepare('SELECT streak_fail s FROM platform_status WHERE id=?').get('adzuna') as { s: number }).s;
    expect(streak()).toBe(2);
    const row = sourceStatusPayload(db).rows.find((r) => r.source === 'adzuna')!;
    expect(row.error).toBe('again');
    recordRun(db, 'adzuna', { fetched: 1, kept: 1, new: 1 });
    expect(streak()).toBe(0);
    expect(sourceStatusPayload(db).rows.find((r) => r.source === 'adzuna')!.error).toBeUndefined();
    recordRun(db, 'adzuna', { fetched: 0, kept: 0, new: 0, error: 'x?app_key=SECRET', fallback_used: true });
    const r2 = sourceStatusPayload(db).rows.find((r) => r.source === 'adzuna')!;
    expect(r2.error).not.toContain('SECRET');
    expect(r2.fallback_used).toBe(true);
  });
  it('carries dropped_duplicates', async () => {
    const db = openDb(':memory:');
    finishRun(db, [{ id: 'remotive', fetched: 1, kept: 1 }], []);
    setDroppedDuplicates([job('gh:a:1', 'greenhouse')]);
    expect(sourceStatusPayload(db).dropped_duplicates).toEqual({ count: 1, ids: ['gh:a:1'] });
  });
});

describe('board_status alias', () => {
  it('returns the old payload plus deprecated', () => {
    expect(boardStatusAlias({ ran: false, errors: [], stats: [] })).toMatchObject({ ran: false, errors: [], stats: [], deprecated: 'use source_status' });
  });
});
