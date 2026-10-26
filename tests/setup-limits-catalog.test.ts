// tests/setup-limits-catalog.test.ts
import { describe, expect, it } from 'vitest';
import { LIMITS, specFor, validateLimit, validatePairs } from '../src/setup/limitsCatalog.js';
import { loadOutreachConfig, type OutreachConfig } from '../src/outreach/config.js';
import { loadTuning } from '../src/outreach/tuning.js';
import { COOLDOWN_DAYS, GAPS_DAYS } from '../src/outreach/cadence.js';

function spec(key: string) {
  const s = specFor(key);
  if (!s) throw new Error(`missing spec ${key}`);
  return s;
}

describe('limits catalog drift against code defaults', () => {
  it('outreach config keys match loadOutreachConfig({})', () => {
    const map: Record<string, keyof OutreachConfig> = {
      LINKEDIN_MAX_INVITES_PER_WEEK: 'linkedinMaxInvitesPerWeek',
      LINKEDIN_MAX_MESSAGES_PER_WEEK: 'linkedinMaxMessagesPerWeek',
      NAUKRI_MAX_APPLIES_PER_DAY: 'naukriMaxAppliesPerDay',
      NAUKRI_MAX_MESSAGES_PER_DAY: 'naukriMaxMessagesPerDay',
      COMPANY_CONTACT_LIMIT: 'companyContactLimit',
      SPECULATIVE_COMPANY_LIMIT: 'speculativeCompanyLimit',
      QUIET_HOURS_START: 'quietStartHour',
      QUIET_HOURS_END: 'quietEndHour',
    };
    const cfg = loadOutreachConfig({});
    for (const [key, field] of Object.entries(map)) {
      expect(spec(key).default, key).toBe(cfg[field]);
    }
  });

  it('tuning keys match loadTuning({}) and cadence constants', () => {
    const t = loadTuning({});
    expect(spec('COOLDOWN_IGNORED_DAYS').default).toBe(COOLDOWN_DAYS.ignored);
    expect(spec('COOLDOWN_NOT_NOW_DAYS').default).toBe(COOLDOWN_DAYS.not_now);
    expect(spec('COOLDOWN_EXPLICIT_STOP_DAYS').default).toBe(COOLDOWN_DAYS.explicit_stop);
    expect(spec('CADENCE_GAPS_DAYS').default).toBe(GAPS_DAYS.join(','));
    expect(spec('CADENCE_GAPS_DAYS').default).toBe(t.cadenceGapsDays.join(','));
  });

  it('ranges match what the loaders accept', () => {
    // A value at max is accepted by the loader, one above falls back to default.
    const at = (k: string, v: number) => loadOutreachConfig({ [k]: String(v) });
    expect(at('QUIET_HOURS_START', 23).quietStartHour).toBe(23);
    expect(at('QUIET_HOURS_START', 24).quietStartHour).toBe(1);
    expect(at('COMPANY_CONTACT_LIMIT', 100000).companyContactLimit).toBe(100000);
    expect(at('COMPANY_CONTACT_LIMIT', 100001).companyContactLimit).toBe(5);
    expect(spec('QUIET_HOURS_START').max).toBe(23);
    expect(spec('COMPANY_CONTACT_LIMIT').max).toBe(100000);
    expect(spec('COOLDOWN_IGNORED_DAYS').max).toBe(3650);
  });

  it('direct env readers keep their documented defaults', () => {
    expect(spec('MATCH_THRESHOLD').default).toBe(60);
    expect(spec('SEND_LIMIT_PER_RUN').default).toBe(1);
    expect(spec('MAX_APPLIES_PER_DAY').default).toBe(5);
    expect(spec('MAX_LINKEDIN_SEARCHES_PER_DAY').default).toBe(20);
    expect(spec('HUNTER_MONTHLY_CAP').default).toBe(50);
  });
});

describe('validateLimit', () => {
  const quiet = () => spec('QUIET_HOURS_START');
  it('accepts boundary values', () => {
    expect(validateLimit(quiet(), '0')).toBeNull();
    expect(validateLimit(quiet(), '23')).toBeNull();
    expect(validateLimit(spec('EMAIL_DRIP_MIN_BATCH'), '1')).toBeNull();
    expect(validateLimit(spec('EMAIL_DRIP_MAX_BATCH'), '20')).toBeNull();
  });
  it('rejects empty, non-numeric, fractional, negative and over max', () => {
    for (const raw of ['', 'abc', '1.5', '-1', '24']) {
      expect(validateLimit(quiet(), raw), raw).not.toBeNull();
    }
    expect(validateLimit(spec('EMAIL_DRIP_MIN_BATCH'), '0')).not.toBeNull();
    expect(validateLimit(spec('EMAIL_DRIP_MAX_BATCH'), '21')).not.toBeNull();
  });
  it('validates the cadence list: same length, each 1..365', () => {
    const s = spec('CADENCE_GAPS_DAYS');
    expect(validateLimit(s, '3,4,5,7,10')).toBeNull();
    expect(validateLimit(s, '1, 2, 3, 4, 365')).toBeNull();
    expect(validateLimit(s, '3,4,5,7')).not.toBeNull();
    expect(validateLimit(s, '3,4,5,7,10,12')).not.toBeNull();
    expect(validateLimit(s, '3,4,5,7,0')).not.toBeNull();
    expect(validateLimit(s, '3,4,5,7,366')).not.toBeNull();
    expect(validateLimit(s, '3,4,5,7,x')).not.toBeNull();
    expect(validateLimit(s, '')).not.toBeNull();
  });
});

describe('validatePairs', () => {
  it('flags a min above its max for drip batch, gap and pause', () => {
    const msgs = validatePairs({
      EMAIL_DRIP_MIN_BATCH: '5',
      EMAIL_DRIP_MAX_BATCH: '2',
      EMAIL_DRIP_MIN_GAP_MIN: '500',
      EMAIL_DRIP_MAX_GAP_MIN: '100',
      EMAIL_DRIP_INTRA_PAUSE_MIN_SEC: '50',
      EMAIL_DRIP_INTRA_PAUSE_MAX_SEC: '10',
    });
    expect(msgs).toHaveLength(3);
    expect(msgs.join(' ')).toContain('EMAIL_DRIP_MIN_BATCH');
  });
  it('is quiet when ordered, equal, or a side is missing', () => {
    expect(validatePairs({ EMAIL_DRIP_MIN_BATCH: '2', EMAIL_DRIP_MAX_BATCH: '2' })).toEqual([]);
    expect(validatePairs({ EMAIL_DRIP_MIN_BATCH: '9' })).toEqual([]);
    expect(validatePairs({})).toEqual([]);
  });
});

describe('catalog shape', () => {
  it('has unique well-formed keys and a non-empty explanation', () => {
    const keys = LIMITS.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const l of LIMITS) {
      expect(l.key).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(l.what.trim().length, l.key).toBeGreaterThan(0);
      expect(l.min).toBeLessThanOrEqual(l.max);
    }
  });
});
