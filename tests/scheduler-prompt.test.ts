import { describe, it, expect } from 'vitest';
import { buildWakePrompt } from '../src/scheduler/prompt.js';
import type { Assignment } from '../src/scheduler/plan.js';

describe('buildWakePrompt', () => {
  const tasks: Assignment[] = [
    {
      operator: 'linkedin-operator', platform: 'linkedin',
      tasks: [{ kind: 'followups', quota: 2 }, { kind: 'new_outreach', quota: 1 }],
    },
    {
      operator: 'naukri-operator', platform: 'naukri',
      tasks: [{ kind: 'inbox', quota: 5 }, { kind: 'search', quota: 1 }],
    },
  ];
  const i = {
    runId: 'abcd1234',
    dryRun: false,
    burst: 3,
    tasks,
    budget: { maxToolCalls: 60, maxWallSec: 900, maxTokensApprox: 150000 },
    allowed: ['linkedin' as const, 'naukri' as const],
    now: new Date('2026-10-15T10:00:00Z'),
  };
  it('lists each operator with its tasks, linkedin before naukri, no old worker names', () => {
    const p = buildWakePrompt(i);
    expect(p).toContain('abcd1234');
    expect(p).toContain('Dry run: no.');
    expect(p).toContain('Allowed platforms: linkedin, naukri.');
    expect(p).toContain(
      'Dispatch operator `linkedin-operator` for platform linkedin with tasks: followups quota 2, new_outreach quota 1.',
    );
    expect(p).toContain(
      'Dispatch operator `naukri-operator` for platform naukri with tasks: inbox quota 5, search quota 1.',
    );
    expect(p.indexOf('linkedin-operator')).toBeLessThan(p.indexOf('naukri-operator'));
    for (const old of ['due-followups', 'new-outreach', 'inbox-recruiter-replies', 'naukri-search', 'Dispatch worker']) {
      expect(p).not.toContain(old);
    }
    expect(p).toMatch(/sequentially/);
    expect(p).toMatch(/one Agent call each/);
  });
  it('ends with the operator JSON instruction, no dry-run sentence when live', () => {
    const p = buildWakePrompt(i);
    expect(p).not.toContain('must not send');
    const nonEmpty = p.split('\n').filter(Boolean);
    expect(nonEmpty[nonEmpty.length - 1]).toBe(
      'End with one JSON line {run_id, operators: [{operator, platform, tasks: [{kind, done, skipped, escalated, stopped}]}]}.',
    );
    expect(p.match(/halted/g)).toHaveLength(2);
  });
  it('states the dry-run sentence only when set', () => {
    const p = buildWakePrompt({ ...i, dryRun: true });
    expect(p).toContain('Dry run: yes.');
    expect(p).toContain('must not send');
  });
});
