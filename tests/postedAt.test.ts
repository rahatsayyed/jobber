import { describe, it, expect } from 'vitest';
import { getJob, openDb, saveJob, toIsoDay } from '../src/db.js';
import { normalizeRemotive } from '../src/sources/remotive.js';
import { normalizeRemoteok } from '../src/sources/remoteok.js';
import { normalizeAdzuna } from '../src/sources/adzuna.js';

describe('toIsoDay', () => {
  it.each([
    ['2026-09-30T10:11:12', '2026-09-30'],
    ['2026-09-30T23:30:00Z', '2026-09-30'],
    ['2026-09-30', '2026-09-30'],
    [1759190400, '2025-09-30'],
    [1759190400000, '2025-09-30'],
    ['2026-02-30', undefined],
    ['2026-02-30T00:00:00Z', undefined],
    ['2026-13-01T10:00:00', undefined],
    ['2026-09-31 08:00:00', undefined],
    ['yesterday', undefined],
    [null, undefined],
    [undefined, undefined],
  ])('%s -> %s', (input, out) => { expect(toIsoDay(input)).toBe(out); });
});

describe('toIsoDay range and extremes', () => {
  const nextYear = new Date().getUTCFullYear() + 1;
  it.each([
    ['1999-12-31', undefined],
    ['2000-01-01', '2000-01-01'],
    [`${nextYear}-06-01`, `${nextYear}-06-01`],
    [`${nextYear + 1}-01-01`, undefined],
    [8.64e15, undefined],
    [-1e12, undefined],
    [-5, undefined],
    [Number.MAX_SAFE_INTEGER, undefined],
  ])('%s -> %s', (input, out) => { expect(toIsoDay(input)).toBe(out); });
});

describe('sources emit posted_at', () => {
  it('remotive publication_date', () => {
    expect(normalizeRemotive({ jobs: [{ id: 1, title: 't', company_name: 'c', url: 'u', description: 'd', publication_date: '2026-09-30T10:11:12' }] })[0].posted_at).toBe('2026-09-30');
  });
  it('remoteok date or epoch', () => {
    expect(normalizeRemoteok([{ id: 1, position: 'React dev', company: 'c', url: 'u', date: '2026-10-01T08:00:00+00:00' }])[0].posted_at).toBe('2026-10-01');
    expect(normalizeRemoteok([{ id: 2, position: 'React dev', company: 'c', url: 'u', epoch: 1759190400 }])[0].posted_at).toBe('2025-09-30');
  });
  it('adzuna created', () => {
    expect(normalizeAdzuna({ results: [{ id: 1, title: 't', company: { display_name: 'c' }, redirect_url: 'u', description: 'd', created: '2026-10-02T12:00:00Z' }] })[0].posted_at).toBe('2026-10-02');
  });
  it('no date -> property absent (keeps existing toEqual tests valid)', () => {
    expect('posted_at' in normalizeRemotive({ jobs: [{ id: 1, title: 't', company_name: 'c', url: 'u', description: 'd' }] })[0]).toBe(false);
  });
});

describe('saveJob persists posted_at and the new columns exist', () => {
  it('round-trips posted_at', () => {
    const db = openDb(':memory:');
    saveJob(db, { id: 'j1', source: 'remotive', title: 'Dev', company: 'Acme', url: 'u', apply_url: 'u', description: 'd', posted_at: '2026-09-30' });
    expect(getJob(db, 'j1')!.posted_at).toBe('2026-09-30');
    const cols = (db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['posted_at', 'deadline', 'language_note', 'score_dims', 'requirements', 'strengths', 'gaps', 'hard_stops', 'confidence', 'title_key', 'company_key', 'legitimacy', 'legitimacy_signals', 'gate_flags', 'jd_snapshot', 'jd_snapshot_at', 'deadline_reported']));
  });
});
