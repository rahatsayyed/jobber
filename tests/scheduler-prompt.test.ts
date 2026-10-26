import { describe, it, expect } from 'vitest';
import { buildWakePrompt } from '../src/scheduler/prompt.js';
import type { Assignment, Step } from '../src/scheduler/plan.js';

describe('buildWakePrompt', () => {
  const tasks: Assignment[] = [
    {
      operator: 'linkedin-operator', platform: 'linkedin',
      tasks: [{ kind: 'followups', quota: 2 }, { kind: 'new_outreach', quota: 1 }],
    },
    {
      operator: 'naukri-operator', platform: 'naukri',
      tasks: [{ kind: 'inbox', quota: 5 }, { kind: 'discover', quota: 5, searches: { jobs: ['react-india'], posts: [] } }],
    },
  ];
  const i = {
    runId: 'abcd1234',
    dryRun: false,
   
    tasks,
    budget: { maxWallSec: 900, maxTokensApprox: 150000 },
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
      'Dispatch operator `naukri-operator` for platform naukri with tasks: inbox quota 5, discover quota 5 (searches: react-india; quota is the job pages you may open for descriptions).',
    );
    expect(p.indexOf('linkedin-operator')).toBeLessThan(p.indexOf('naukri-operator'));
    for (const old of ['due-followups', 'new-outreach', 'inbox-recruiter-replies', 'naukri-search', 'Dispatch worker']) {
      expect(p).not.toContain(old);
    }
    expect(p).toMatch(/sequentially/);
    expect(p).toMatch(/one Agent call each/);
  });
  it('lists the separate sequential calls of a chunked sending step and keeps one call for a small quota', () => {
    const order: Step[] = [
      { operator: 'linkedin-operator', platform: 'linkedin', kind: 'new_outreach', quota: 12, chunks: [5, 5, 2] },
      { operator: 'linkedin-operator', platform: 'linkedin', kind: 'followups', quota: 3, chunks: [3] },
      { operator: 'apply-operator', kind: 'apply', quota: 7, chunks: [5, 2] },
    ];
    const p = buildWakePrompt({ ...i, order });
    expect(p).toContain('new_outreach quota 12 -> calls of 5, 5, 2');
    expect(p).toContain('SEPARATE sequential Agent calls');
    expect(p).toMatch(/done 0, stopped, halted or limit reached/);
    expect(p).toContain('apply quota 7 -> calls of 5, 2');
    expect(p).toContain('task: followups quota 3 (first');
    expect(p).not.toContain('followups quota 3 ->');
    expect(p.match(/first read your own queue/g)?.length).toBeGreaterThanOrEqual(2);
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

describe('buildWakePrompt discover task', () => {
  it('names the searches the operator may run', () => {
    const p = buildWakePrompt({
      runId: 'r1', dryRun: false, budget: { maxWallSec: 60, maxTokensApprox: 1000 } as any,
      allowed: ['linkedin'], now: new Date('2026-10-16T10:00:00Z'),
      tasks: [{ operator: 'linkedin-operator', platform: 'linkedin', tasks: [{ kind: 'discover', quota: 2, searches: { jobs: ['react-india'], posts: ['default'] } }] }],
    });
    expect(p).toContain('discover quota 2 (job searches: react-india; post searches: default)');
  });
});
