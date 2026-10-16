import { describe, expect, it } from 'vitest';
import { loadWebConfig } from '../src/webcore/config.js';
import { isDryRun } from '../src/safety/dryRun.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { LIMITS, specFor } from '../src/setup/limitsCatalog.js';

const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;
const LIVE = { SCHEDULER_DRY_RUN: 'false', WEB_DRY_RUN: 'false', APPLY_DRY_RUN: 'false', SCOUT_DRY_RUN: 'false' };

describe('loadWebConfig', () => {
  it('defaults', () => {
    expect(loadWebConfig(env({}))).toEqual({
      dryRun: true, minGapSec: 20, maxCallsPerJob: 80, maxJobMin: 15, idleMs: 600000, settleMs: 1500,
    });
  });
  it('invalid and out-of-range values fall back or clamp and never throw', () => {
    const c = loadWebConfig(env({
      WEB_MIN_GAP_SEC: 'abc', WEB_MAX_CALLS_PER_JOB: '-1', WEB_MAX_JOB_MIN: '', WEB_IDLE_MS: '5', WEB_SETTLE_MS: '99999999',
    }));
    expect(c).toMatchObject({ minGapSec: 20, maxCallsPerJob: 80, maxJobMin: 15, idleMs: 60000, settleMs: 30000 });
  });
  it('reads valid values', () => {
    const c = loadWebConfig(env({ ...LIVE, WEB_MIN_GAP_SEC: '5', WEB_MAX_CALLS_PER_JOB: '10', WEB_MAX_JOB_MIN: '3', WEB_IDLE_MS: '120000', WEB_SETTLE_MS: '100' }));
    expect(c).toEqual({ dryRun: false, minGapSec: 5, maxCallsPerJob: 10, maxJobMin: 3, idleMs: 120000, settleMs: 100 });
  });
});

describe('isDryRun web flags', () => {
  it('web live needs all three flags exactly false', () => {
    expect(isDryRun(env(LIVE), { web: true })).toBe(false);
    for (const k of ['WEB_DRY_RUN', 'APPLY_DRY_RUN', 'SCOUT_DRY_RUN']) {
      expect(isDryRun(env({ ...LIVE, [k]: 'true' }), { web: true }), k).toBe(true);
      const { [k]: _omit, ...rest } = LIVE as Record<string, string>;
      expect(isDryRun(env(rest), { web: true }), `${k} unset`).toBe(true);
    }
  });
  it('JOBBER_DRY_RUN=1 and unset SCHEDULER_DRY_RUN still win', () => {
    expect(isDryRun(env({ ...LIVE, JOBBER_DRY_RUN: '1' }), { web: true })).toBe(true);
    const { SCHEDULER_DRY_RUN: _s, ...rest } = LIVE;
    expect(isDryRun(env(rest), { web: true })).toBe(true);
  });
  it('web flags do not affect calls without the web option', () => {
    expect(isDryRun(env({ SCHEDULER_DRY_RUN: 'false' }))).toBe(false);
    expect(isDryRun(env({ SCHEDULER_DRY_RUN: 'false', LINKEDIN_DRY_RUN: 'false' }), { linkedin: true })).toBe(false);
  });
});

describe('new ceilings and catalog drift', () => {
  it('config defaults match the catalog', () => {
    const cfg = loadOutreachConfig({});
    expect(cfg.applyMaxAttemptsPerDay).toBe(30);
    expect(cfg.siteMaxAccountsPerDay).toBe(2);
    expect(cfg.linkedinMaxDiscoverPerDay).toBe(12);
    expect(specFor('APPLY_MAX_ATTEMPTS_PER_DAY')!.default).toBe(30);
    expect(specFor('SITE_MAX_ACCOUNTS_PER_DAY')!.default).toBe(2);
    expect(specFor('LINKEDIN_MAX_DISCOVER_PER_DAY')!.default).toBe(12);
  });
  it('values are read', () => {
    const cfg = loadOutreachConfig(env({ APPLY_MAX_ATTEMPTS_PER_DAY: '7', SITE_MAX_ACCOUNTS_PER_DAY: '1', LINKEDIN_MAX_DISCOVER_PER_DAY: '3' }));
    expect([cfg.applyMaxAttemptsPerDay, cfg.siteMaxAccountsPerDay, cfg.linkedinMaxDiscoverPerDay]).toEqual([7, 1, 3]);
  });
  it('web keys are not duplicated in the catalog', () => {
    const keys = LIMITS.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
