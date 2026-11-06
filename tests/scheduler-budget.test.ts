import { describe, it, expect } from 'vitest';
import { BUDGET_DEFAULTS, budgetEnvWarnings, LIMIT_RE, loadBudget, loadStallSec, stallMsFromEnv } from '../src/scheduler/budget.js';

describe('loadBudget', () => {
  it('has the shipped default and no token budget any more', () => {
    expect(BUDGET_DEFAULTS).toEqual({ maxWallSec: 3600 });
    expect(loadBudget({})).toEqual({ maxWallSec: 3600 });
  });
  it('RUN_MAX_WALL_SEC is read inside 30..7200; anything else keeps the default; RUN_MAX_TOKENS_APPROX is ignored', () => {
    expect(loadBudget({ RUN_MAX_WALL_SEC: '600' }).maxWallSec).toBe(600);
    expect(loadBudget({ RUN_MAX_WALL_SEC: '29' }).maxWallSec).toBe(3600);
    expect(loadBudget({ RUN_MAX_WALL_SEC: '7201' }).maxWallSec).toBe(3600);
    expect(loadBudget({ RUN_MAX_WALL_SEC: 'abc' }).maxWallSec).toBe(3600);
    expect(loadBudget({ RUN_MAX_TOKENS_APPROX: '80000000' })).toEqual({ maxWallSec: 3600 });
  });
});

describe('RUN_STALL_SEC', () => {
  it('60..3600, default 600; the dispatcher override is only set when the variable is set', () => {
    expect(loadStallSec({})).toBe(600);
    expect(loadStallSec({ RUN_STALL_SEC: '120' })).toBe(120);
    expect(loadStallSec({ RUN_STALL_SEC: '59' })).toBe(600);
    expect(stallMsFromEnv({})).toBeUndefined();
    expect(stallMsFromEnv({ RUN_STALL_SEC: '' })).toBeUndefined();
    expect(stallMsFromEnv({ RUN_STALL_SEC: '120' })).toBe(120_000);
  });
});

describe('budgetEnvWarnings', () => {
  it('warns about an out-of-range wall or stall value only; a retired token key is not mentioned', () => {
    expect(budgetEnvWarnings({})).toEqual([]);
    expect(budgetEnvWarnings({ RUN_MAX_WALL_SEC: '5' })[0]).toMatch(/RUN_MAX_WALL_SEC=5 is outside 30..7200/);
    expect(budgetEnvWarnings({ RUN_STALL_SEC: '5' })[0]).toMatch(/RUN_STALL_SEC/);
    expect(budgetEnvWarnings({ RUN_MAX_TOKENS_APPROX: '1' })).toEqual([]);
  });
});

describe('LIMIT_RE', () => {
  it('matches the usage-limit texts of the claude window and not ordinary words', () => {
    for (const t of ['Claude usage limit reached', 'rate limit exceeded', 'You have hit your limit', 'session limit reached']) expect(LIMIT_RE.test(t)).toBe(true);
    expect(LIMIT_RE.test('the invite limit is fine')).toBe(false);
  });
});
