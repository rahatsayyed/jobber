import { describe, expect, it } from 'vitest';
import { BudgetTracker, BUDGET_DEFAULTS, budgetEnvWarnings, loadStallSec } from '../src/scheduler/budget.js';

const T0 = new Date('2026-11-03T10:00:00Z');
const at = (sec: number): Date => new Date(T0.getTime() + sec * 1000);
const retry = (n: number, status: number | null = null): string =>
  JSON.stringify({ type: 'system', subtype: 'api_retry', attempt: n, max_retries: 10, retry_delay_ms: 1000, error_status: status, error: 'unknown' }) + '\n';

describe('stall watchdog', () => {
  it('loadStallSec defaults to 600 and accepts 60..3600 only', () => {
    expect(loadStallSec({})).toBe(600);
    expect(loadStallSec({ RUN_STALL_SEC: '60' })).toBe(60);
    expect(loadStallSec({ RUN_STALL_SEC: '3600' })).toBe(3600);
    expect(loadStallSec({ RUN_STALL_SEC: '59' })).toBe(600);
    expect(loadStallSec({ RUN_STALL_SEC: '3601' })).toBe(600);
    expect(loadStallSec({ RUN_STALL_SEC: 'x' })).toBe(600);
  });

  it('stalls when the log goes silent after api_retry, and reports the last event; never a usage limit', () => {
    const t = new BudgetTracker(BUDGET_DEFAULTS, T0, 600);
    for (let i = 1; i <= 8; i++) t.feed(retry(i), at(i * 10));
    expect(t.check(at(80 + 599))).toBeNull();
    expect(t.check(at(80 + 600))).toBe('stalled');
    expect(t.stallSummary(at(80 + 600))).toBe('no output for 600 s (last event: api_retry attempt 8 of 10)');
  });

  it('a stall with no bytes at all from the start also counts', () => {
    const t = new BudgetTracker(BUDGET_DEFAULTS, T0, 600);
    expect(t.check(at(599))).toBeNull();
    expect(t.check(at(600))).toBe('stalled');
  });

  it('a working run (tool calls and text keep writing) is never stalled', () => {
    const t = new BudgetTracker(BUDGET_DEFAULTS, T0, 600);
    for (let s = 100; s <= 3000; s += 100) {
      t.feed(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'x' }] } }) + '\n', at(s));
      expect(t.check(at(s + 1))).toBeNull();
    }
    expect(t.snapshot().toolCalls).toBe(30);
  });

  it('stallSec 0 turns the check off', () => {
    const t = new BudgetTracker(BUDGET_DEFAULTS, T0);
    expect(t.check(at(3000))).toBeNull();
  });

  it('wall clock still wins over a stall when both apply', () => {
    const t = new BudgetTracker({ ...BUDGET_DEFAULTS, maxWallSec: 100 }, T0, 60);
    expect(t.check(at(200))).toBe('wall_clock');
  });

  it('network retries do not make a usage limit', () => {
    const t = new BudgetTracker(BUDGET_DEFAULTS, T0, 600);
    t.feed(retry(1), at(1));
    expect(t.check(at(700))).toBe('stalled');
  });

  it('budgetEnvWarnings names an out-of-range value', () => {
    expect(budgetEnvWarnings({ RUN_MAX_WALL_SEC: '24000' })).toEqual(['RUN_MAX_WALL_SEC=24000 is outside 30..7200, using 3600']);
    expect(budgetEnvWarnings({ RUN_MAX_WALL_SEC: '3600', RUN_STALL_SEC: '' })).toEqual([]);
    expect(budgetEnvWarnings({ RUN_STALL_SEC: '5' })).toEqual(['RUN_STALL_SEC=5 is outside 60..3600, using 600']);
  });
});
