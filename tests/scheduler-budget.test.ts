import { describe, it, expect } from 'vitest';
import { BudgetTracker, loadBudget, BUDGET_DEFAULTS } from '../src/scheduler/budget.js';

const t0 = new Date(Date.UTC(2026, 9, 14, 6, 0, 0));
const tool = (n = 1) =>
  JSON.stringify({ type: 'assistant', message: { content: Array.from({ length: n }, () => ({ type: 'tool_use', name: 'x', input: {} })) } }) + '\n';
const big = { maxToolCalls: 99, maxWallSec: 900, maxTokensApprox: 1e6 };

describe('BudgetTracker', () => {
  it('counts tool calls and trips only past the limit', () => {
    const b = new BudgetTracker({ maxToolCalls: 2, maxWallSec: 900, maxTokensApprox: 1e6 }, t0);
    b.feed(tool(2), t0);
    expect(b.check(t0)).toBeNull();
    b.feed(tool(1), t0);
    expect(b.check(t0)).toBe('tool_calls');
  });

  it('handles a line split across two chunks', () => {
    const b = new BudgetTracker({ maxToolCalls: 1, maxWallSec: 900, maxTokensApprox: 1e6 }, t0);
    const line = tool(2);
    b.feed(line.slice(0, 20), t0);
    expect(b.snapshot().toolCalls).toBe(0);
    b.feed(line.slice(20), t0);
    expect(b.check(t0)).toBe('tool_calls');
  });

  it('trips wall clock using the injected clock', () => {
    const b = new BudgetTracker({ maxToolCalls: 99, maxWallSec: 60, maxTokensApprox: 1e6 }, t0);
    expect(b.check(new Date(t0.getTime() + 59000))).toBeNull();
    expect(b.check(new Date(t0.getTime() + 61000))).toBe('wall_clock');
  });

  it('trips approximate tokens and reports usage_limit with priority', () => {
    const b = new BudgetTracker({ maxToolCalls: 99, maxWallSec: 900, maxTokensApprox: 10 }, t0);
    b.feed('x'.repeat(100) + '\n', t0);
    expect(b.check(t0)).toBe('tokens');
    b.feed(JSON.stringify({ type: 'result', is_error: true, result: 'Claude usage limit reached' }) + '\n', t0);
    expect(b.check(t0)).toBe('usage_limit');
  });

  it('does not buffer an unbounded unterminated line', () => {
    const b = new BudgetTracker(BUDGET_DEFAULTS, t0);
    b.feed('y'.repeat(2_000_000), t0);
    expect(b.snapshot().tokensApprox).toBeGreaterThan(400000);
  });

  it('a tool call exactly at the limit is fine', () => {
    const b = new BudgetTracker({ ...big, maxToolCalls: 3 }, t0);
    b.feed(tool(3), t0);
    expect(b.check(t0)).toBeNull();
    expect(b.snapshot().toolCalls).toBe(3);
  });

  it('unparseable JSON counts chars but no tool calls', () => {
    const b = new BudgetTracker(big, t0);
    b.feed('{not json tool_use\n', t0);
    const s = b.snapshot();
    expect(s.toolCalls).toBe(0);
    expect(s.tokensApprox).toBe(Math.ceil(19 / 4));
    expect(b.check(t0)).toBeNull();
  });

  it('plain-text limit line sets usage_limit', () => {
    const b = new BudgetTracker(big, t0);
    b.feed('Error: rate limit exceeded\n', t0);
    expect(b.check(t0)).toBe('usage_limit');
  });

  it('error_max_turns result is not usage_limit', () => {
    const b = new BudgetTracker(big, t0);
    b.feed(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: false }) + '\n', t0);
    expect(b.check(t0)).toBeNull();
  });

  it('non-error result is fine', () => {
    const b = new BudgetTracker(big, t0);
    b.feed(JSON.stringify({ type: 'result', is_error: false, result: 'done' }) + '\n', t0);
    expect(b.check(t0)).toBeNull();
  });

  it('lastLines keeps last 5 lines, each at most 300 chars', () => {
    const b = new BudgetTracker(big, t0);
    for (let i = 0; i < 8; i++) b.feed(`line${i}` + 'z'.repeat(400) + '\n', t0);
    const l = b.snapshot().lastLines;
    expect(l).toHaveLength(5);
    expect(l[0].startsWith('line3')).toBe(true);
    expect(l[4].startsWith('line7')).toBe(true);
    expect(l.every((x) => x.length <= 300)).toBe(true);
  });

  it('snapshot wallSec uses last fed time', () => {
    const b = new BudgetTracker(big, t0);
    b.feed('a\n', new Date(t0.getTime() + 12000));
    expect(b.snapshot().wallSec).toBe(12);
  });

  it('first exceeded wins: tool_calls before wall_clock before tokens', () => {
    const b = new BudgetTracker({ maxToolCalls: 1, maxWallSec: 30, maxTokensApprox: 1000 }, t0);
    b.feed(tool(2), t0);
    expect(b.check(new Date(t0.getTime() + 40000))).toBe('tool_calls');
  });
});

describe('loadBudget', () => {
  it('falls back to defaults on invalid env', () => {
    expect(loadBudget({ RUN_MAX_TOOL_CALLS: '-3', RUN_MAX_WALL_SEC: 'abc' })).toEqual(BUDGET_DEFAULTS);
  });
  it('has the documented defaults', () => {
    expect(BUDGET_DEFAULTS).toEqual({ maxToolCalls: 60, maxWallSec: 900, maxTokensApprox: 150000 });
    expect(loadBudget({})).toEqual(BUDGET_DEFAULTS);
  });
  it('enforces inclusive ranges', () => {
    expect(loadBudget({ RUN_MAX_TOOL_CALLS: '1000' }).maxToolCalls).toBe(1000);
    expect(loadBudget({ RUN_MAX_TOOL_CALLS: '1001' }).maxToolCalls).toBe(60);
    expect(loadBudget({ RUN_MAX_TOOL_CALLS: '1' }).maxToolCalls).toBe(1);
    expect(loadBudget({ RUN_MAX_TOOL_CALLS: '0' }).maxToolCalls).toBe(60);
    expect(loadBudget({ RUN_MAX_WALL_SEC: '30' }).maxWallSec).toBe(30);
    expect(loadBudget({ RUN_MAX_WALL_SEC: '29' }).maxWallSec).toBe(900);
    expect(loadBudget({ RUN_MAX_WALL_SEC: '7200' }).maxWallSec).toBe(7200);
    expect(loadBudget({ RUN_MAX_WALL_SEC: '7201' }).maxWallSec).toBe(900);
    expect(loadBudget({ RUN_MAX_TOKENS_APPROX: '1000' }).maxTokensApprox).toBe(1000);
    expect(loadBudget({ RUN_MAX_TOKENS_APPROX: '999' }).maxTokensApprox).toBe(150000);
    expect(loadBudget({ RUN_MAX_TOKENS_APPROX: '2000000' }).maxTokensApprox).toBe(2000000);
    expect(loadBudget({ RUN_MAX_TOKENS_APPROX: '2000001' }).maxTokensApprox).toBe(150000);
  });
  it('falls back per field, not all-or-nothing', () => {
    expect(loadBudget({ RUN_MAX_TOOL_CALLS: '10', RUN_MAX_WALL_SEC: 'x', RUN_MAX_TOKENS_APPROX: '5000' })).toEqual({
      maxToolCalls: 10,
      maxWallSec: 900,
      maxTokensApprox: 5000,
    });
  });
  it('rejects non-integer strings', () => {
    expect(loadBudget({ RUN_MAX_TOOL_CALLS: '12.5' }).maxToolCalls).toBe(60);
    expect(loadBudget({ RUN_MAX_TOOL_CALLS: '10abc' }).maxToolCalls).toBe(60);
  });
});

describe('usage limit detection scope', () => {
  const fresh = () => new BudgetTracker(big, t0);
  it('ignores limit text inside tool_result (user) lines', () => {
    const b = fresh();
    b.feed(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'daily limit reached' }] } }) + '\n', t0);
    expect(b.check(t0)).toBeNull();
  });
  it('ignores limit text quoted by the assistant', () => {
    const b = fresh();
    b.feed(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'usage limit reached' }] } }) + '\n', t0);
    expect(b.check(t0)).toBeNull();
  });
  it('detects a raw non-JSON line', () => {
    const b = fresh();
    b.feed('Claude usage limit reached\n', t0);
    expect(b.check(t0)).toBe('usage_limit');
  });
  it('detects an is_error result and a result string', () => {
    const a = fresh();
    a.feed(JSON.stringify({ type: 'result', is_error: true }) + '\n', t0);
    expect(a.check(t0)).toBe('usage_limit');
    const b = fresh();
    b.feed(JSON.stringify({ type: 'result', is_error: false, result: 'rate limit exceeded' }) + '\n', t0);
    expect(b.check(t0)).toBe('usage_limit');
  });
  it('counting is unchanged', () => {
    const b = fresh();
    b.feed('x'.repeat(39) + '\n', t0);
    expect(b.snapshot().tokensApprox).toBe(10);
  });
  it('evaluates an unterminated trailing line once', () => {
    const b = fresh();
    b.feed('Claude usage limit reached', t0);
    expect(b.check(t0)).toBe('usage_limit');
    const c = fresh();
    c.feed(tool(1).trim(), t0);
    c.check(t0);
    c.check(t0);
    expect(c.snapshot().toolCalls).toBe(1);
    c.feed('\n', t0);
    expect(c.snapshot().toolCalls).toBe(1);
  });
});
