import { describe, it, expect } from 'vitest';
import { openDb, saveJob, setJobExcluded, getExcludedReason } from '../src/db.js';

// The scripted apply tools that used to be tested here are gone (plan 8G-2 task 23); the applier refuses a vetoed job
// in apply_open (tests/applier-*.test.ts).
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
