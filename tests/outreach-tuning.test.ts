// tests/outreach-tuning.test.ts
import { describe, it, expect } from 'vitest';
import { loadTuning, TUNING_DEFAULTS } from '../src/outreach/tuning.js';

describe('loadTuning', () => {
  it('returns the documented defaults', () => {
    expect(loadTuning({})).toEqual(TUNING_DEFAULTS);
    expect(TUNING_DEFAULTS.cadenceGapsDays).toEqual([3, 4, 5, 7, 10]);
    expect(TUNING_DEFAULTS.cooldownDays).toEqual({ ignored: 75, not_now: 75, explicit_stop: 120 });
  });

  it('reads overrides for every setting', () => {
    const t = loadTuning({
      COOLDOWN_IGNORED_DAYS: '30',
      COOLDOWN_NOT_NOW_DAYS: '45',
      COOLDOWN_EXPLICIT_STOP_DAYS: '200',
      CADENCE_GAPS_DAYS: '2,3,4,5,6',
    });
    expect(t).toEqual({
      cooldownDays: { ignored: 30, not_now: 45, explicit_stop: 200 },
      cadenceGapsDays: [2, 3, 4, 5, 6],
    });
  });

  it('falls back on invalid values', () => {
    const t = loadTuning({
      COOLDOWN_NOT_NOW_DAYS: 'abc',
      COOLDOWN_EXPLICIT_STOP_DAYS: '99999',
      COOLDOWN_IGNORED_DAYS: '-3',
      CADENCE_GAPS_DAYS: '1,2,3',
    });
    expect(t).toEqual(TUNING_DEFAULTS);
  });

  it('rejects zero or non-integer cadence gaps', () => {
    expect(loadTuning({ CADENCE_GAPS_DAYS: '0,1,2,3,4' }).cadenceGapsDays).toEqual([3, 4, 5, 7, 10]);
    expect(loadTuning({ CADENCE_GAPS_DAYS: '1.5,2,3,4,5' }).cadenceGapsDays).toEqual([3, 4, 5, 7, 10]);
  });
});

import { COOLDOWN_DAYS, GAPS_DAYS } from '../src/outreach/cadence.js';
describe('single source of truth with cadence', () => {
  it('tuning defaults equal the cadence constants', () => {
    expect(TUNING_DEFAULTS.cadenceGapsDays).toEqual([...GAPS_DAYS]);
    expect(TUNING_DEFAULTS.cooldownDays).toEqual(COOLDOWN_DAYS);
  });
});
