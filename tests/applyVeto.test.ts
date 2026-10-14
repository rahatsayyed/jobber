import { describe, it, expect, vi } from 'vitest';
import { openDb, saveJob, setJobExcluded, getExcludedReason } from '../src/db.js';
import { applyEasyApply } from '../src/apply/linkedin.js';
import { applyExternal } from '../src/apply/external.js';

const job = (id: string, url: string) => ({
  id, source: 't', title: 'T', company: 'C', url, apply_url: url, description: 'd',
});

describe('getExcludedReason', () => {
  it('returns the reason, null when not vetoed, null for unknown jobs', () => {
    const db = openDb(':memory:');
    saveJob(db, job('a', 'https://boards.greenhouse.io/x/jobs/1'));
    expect(getExcludedReason(db, 'a')).toBeNull();
    setJobExcluded(db, 'a', 'location');
    expect(getExcludedReason(db, 'a')).toBe('location');
    expect(getExcludedReason(db, 'nope')).toBeNull();
  });
});

describe('apply tools refuse vetoed jobs (fail closed, never throw)', () => {
  it('applyEasyApply returns manual_review and never launches a browser', async () => {
    const db = openDb(':memory:');
    const launch = vi.fn();
    saveJob(db, job('v1', 'https://linkedin.com/jobs/view/1'));
    setJobExcluded(db, 'v1', 'location');
    const r = await applyEasyApply({ job_id: 'v1' }, { db, chromium: { launch } });
    expect(r.status).toBe('manual_review');
    expect(r.reason).toBe('excluded by veto: location');
    expect(launch).not.toHaveBeenCalled();
  });

  it('applyExternal returns manual_review and never launches a browser', async () => {
    const db = openDb(':memory:');
    const launch = vi.fn();
    saveJob(db, job('v2', 'https://boards.greenhouse.io/x/jobs/1'));
    setJobExcluded(db, 'v2', 'language');
    const r = await applyExternal({ job_id: 'v2' }, { db, chromium: { launch } });
    expect(r.status).toBe('manual_review');
    expect(r.reason).toBe('excluded by veto: language');
    expect(launch).not.toHaveBeenCalled();
  });

  it('a non-vetoed job is not refused by the veto guard', async () => {
    const db = openDb(':memory:');
    saveJob(db, job('ok', 'https://boards.greenhouse.io/x/jobs/2'));
    const r = await applyExternal({ job_id: 'ok' }, { db, chromium: { launch: vi.fn() } });
    expect(r.reason ?? '').not.toContain('excluded by veto');
  });
});

// Final review M2: a non-empty hard_stops list also blocks the apply tools (next to the excluded_reason guard).
describe('apply tools refuse jobs with stored hard stops', () => {
  const withStops = (id: string, url: string, stops: string | null) => {
    const db = openDb(':memory:');
    saveJob(db, job(id, url));
    if (stops !== null) db.prepare('UPDATE jobs SET hard_stops = ? WHERE id = ?').run(stops, id);
    return db;
  };
  it('applyEasyApply refuses with "hard stop: <first>" and never launches a browser', async () => {
    const db = withStops('h1', 'https://linkedin.com/jobs/view/1', JSON.stringify(['Go (5+ years)', 'Rust']));
    const launch = vi.fn();
    const r = await applyEasyApply({ job_id: 'h1' }, { db, chromium: { launch } });
    expect(r.status).toBe('manual_review');
    expect(r.reason).toBe('hard stop: Go (5+ years)');
    expect(launch).not.toHaveBeenCalled();
  });
  it('applyExternal refuses with "hard stop: <first>" and never launches a browser', async () => {
    const db = withStops('h2', 'https://boards.greenhouse.io/x/jobs/1', JSON.stringify(['Go (5+ years)']));
    const launch = vi.fn();
    const r = await applyExternal({ job_id: 'h2' }, { db, chromium: { launch } });
    expect(r.status).toBe('manual_review');
    expect(r.reason).toBe('hard stop: Go (5+ years)');
    expect(launch).not.toHaveBeenCalled();
  });
  it('an empty list, null and an empty string do not block', async () => {
    for (const stops of ['[]', null, '']) {
      const db = withStops('h3', 'https://boards.greenhouse.io/x/jobs/3', stops);
      const r = await applyExternal({ job_id: 'h3' }, { db, chromium: { launch: vi.fn() } });
      expect(r.reason ?? '').not.toContain('hard stop');
    }
  });
  it('corrupt hard_stops data fails closed', async () => {
    const db = withStops('h4', 'https://boards.greenhouse.io/x/jobs/4', '{not json');
    const r = await applyExternal({ job_id: 'h4' }, { db, chromium: { launch: vi.fn() } });
    expect(r.status).toBe('manual_review');
    expect(r.reason).toBe('hard stop: unreadable hard_stops data');
  });
});
