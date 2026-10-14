// tests/outreach-limits.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import {
  ceilings,
  clearHalt,
  countSince,
  haltPlatform,
  haltReason,
  recordEvent,
  tryConsume,
} from '../src/outreach/limits.js';

const NOW = new Date('2026-10-14T10:00:00.000Z');
const WEEK = 7 * 24 * 3600 * 1000;

describe('loadOutreachConfig', () => {
  it('uses the documented defaults', () => {
    const c = loadOutreachConfig({});
    expect(c.linkedinMaxInvitesPerWeek).toBe(100);
    expect(c.naukriMaxAppliesPerDay).toBe(30);
    expect(c.naukriMaxMessagesPerDay).toBe(40);
    expect(c.companyContactLimit).toBe(5);
    expect(c.speculativeCompanyLimit).toBe(2);
    expect(c.quietStartHour).toBe(1);
    expect(c.quietEndHour).toBe(7);
  });

  it('reads env overrides and ignores invalid values', () => {
    const c = loadOutreachConfig({
      LINKEDIN_MAX_INVITES_PER_WEEK: '80',
      NAUKRI_MAX_APPLIES_PER_DAY: 'abc',
      QUIET_HOURS_START: '30',
    });
    expect(c.linkedinMaxInvitesPerWeek).toBe(80);
    expect(c.naukriMaxAppliesPerDay).toBe(30);
    expect(c.quietStartHour).toBe(1);
  });
});

describe('rolling ceilings', () => {
  it('does not count an event exactly 7 days old, but counts one a second newer', () => {
    const db = openDb(':memory:');
    recordEvent(db, 'linkedin_invite', new Date(NOW.getTime() - WEEK));
    recordEvent(db, 'linkedin_invite', new Date(NOW.getTime() - WEEK + 1000));
    expect(countSince(db, 'linkedin_invite', new Date(NOW.getTime() - WEEK))).toBe(1);
  });

  it('tryConsume stops at the ceiling', () => {
    const db = openDb(':memory:');
    const cfg = { ...loadOutreachConfig({}), linkedinMaxInvitesPerWeek: 2 };
    expect(tryConsume(db, 'linkedin_invite', cfg, NOW)).toBe(true);
    expect(tryConsume(db, 'linkedin_invite', cfg, NOW)).toBe(true);
    expect(tryConsume(db, 'linkedin_invite', cfg, NOW)).toBe(false);
    expect(ceilings(db, cfg, NOW).linkedin_invite).toEqual({ used: 2, limit: 2, ok: false });
  });

  it('naukri ceilings use a rolling 24 hours', () => {
    const db = openDb(':memory:');
    const cfg = { ...loadOutreachConfig({}), naukriMaxAppliesPerDay: 1 };
    recordEvent(db, 'naukri_apply', new Date(NOW.getTime() - 25 * 3600 * 1000));
    expect(tryConsume(db, 'naukri_apply', cfg, NOW)).toBe(true);
    expect(tryConsume(db, 'naukri_apply', cfg, NOW)).toBe(false);
  });
});

describe('halt flags', () => {
  it('halts, reports the reason and clears', () => {
    const db = openDb(':memory:');
    expect(haltReason(db, 'linkedin')).toBeNull();
    haltPlatform(db, 'linkedin', 'restriction notice', NOW);
    expect(haltReason(db, 'linkedin')).toBe('restriction notice');
    clearHalt(db, 'linkedin', NOW);
    expect(haltReason(db, 'linkedin')).toBeNull();
  });
});
