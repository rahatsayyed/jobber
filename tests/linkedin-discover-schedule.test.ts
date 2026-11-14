import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { setState, getState } from '../src/scheduler/runLog.js';
import {
  DISCOVER_MAX_GAP_MIN, DISCOVER_MIN_GAP_MIN, discoverGapMs, linkedinDiscoverDue, recordDiscoverRun,
} from '../src/scheduler/discoverNext.js';
import { countDue } from '../src/scheduler/due.js';
import { TUNING_DEFAULTS } from '../src/outreach/tuning.js';
import { markSearchTried, rotateNames } from '../src/linkedin/discoverRotation.js';
import { pickDiscoverNames, LINKEDIN_DISCOVER_MAX_PER_WAKE } from '../src/scheduler/plan.js';

const T0 = new Date('2026-11-14T10:00:00Z');
const min = (m: number): Date => new Date(T0.getTime() + m * 60000);

describe('linkedin discover jitter', () => {
  it('stays inside 45..90 minutes for a fake RNG', () => {
    expect(discoverGapMs(() => 0)).toBe(DISCOVER_MIN_GAP_MIN * 60000);
    expect(discoverGapMs(() => 0.5)).toBe(67.5 * 60000);
    expect(discoverGapMs(() => 0.9999999999)).toBeLessThanOrEqual(DISCOVER_MAX_GAP_MIN * 60000);
    for (let i = 0; i < 50; i++) {
      const g = discoverGapMs();
      expect(g).toBeGreaterThanOrEqual(45 * 60000);
      expect(g).toBeLessThanOrEqual(90 * 60000);
    }
  });
  it('recordDiscoverRun stores last_at and next_at', () => {
    const db = openDb(':memory:');
    recordDiscoverRun(db, T0, () => 0);
    expect(getState(db, 'linkedin_discover_last_at')).toBe(T0.toISOString());
    expect(getState(db, 'linkedin_discover_next_at')).toBe(min(45).toISOString());
  });
});

describe('linkedinDiscoverDue', () => {
  it('is due when nothing is stored (owner cleared markers)', () => {
    expect(linkedinDiscoverDue(openDb(':memory:'), T0)).toBe(true);
  });
  it('waits for next_at, then is due', () => {
    const db = openDb(':memory:');
    recordDiscoverRun(db, T0, () => 0.5);
    expect(linkedinDiscoverDue(db, min(60))).toBe(false);
    expect(linkedinDiscoverDue(db, min(68))).toBe(true);
  });
  it('falls back to last_at + 60 minutes when next_at is missing', () => {
    const db = openDb(':memory:');
    setState(db, 'linkedin_discover_last_at', T0.toISOString(), T0);
    expect(linkedinDiscoverDue(db, min(59))).toBe(false);
    expect(linkedinDiscoverDue(db, min(60))).toBe(true);
  });
  it('countDue exposes it for the planner', () => {
    const db = openDb(':memory:');
    recordDiscoverRun(db, T0, () => 0);
    expect(countDue(db, min(30), TUNING_DEFAULTS).linkedinDiscoverDue).toBe(false);
    expect(countDue(db, min(46), TUNING_DEFAULTS).linkedinDiscoverDue).toBe(true);
  });
});

describe('rotation covers every search', () => {
  it('least recently tried first, 2 per run, all names hit within a few runs', () => {
    const db = openDb(':memory:');
    const all = { jobs: ['j1', 'j2', 'j3'], posts: ['p1', 'p2', 'p3', 'p4', 'p5'] };
    const seen = new Set<string>();
    for (let run = 0; run < 5; run++) {
      const at = min(run * 60);
      const picked = pickDiscoverNames(
        { jobs: rotateNames(db, 'search_jobs', all.jobs), posts: rotateNames(db, 'search_posts', all.posts) },
        LINKEDIN_DISCOVER_MAX_PER_WAKE,
      );
      for (const n of picked.jobs) { seen.add(n); markSearchTried(db, 'search_jobs', n, at); }
      for (const n of picked.posts) { seen.add(n); markSearchTried(db, 'search_posts', n, at); }
    }
    expect(seen.size).toBe(8);
  });
});
