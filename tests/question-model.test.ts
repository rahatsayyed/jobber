import { describe, expect, it } from 'vitest';
import {
  draftProblem, errorsFrom, limitOf, openCount, planSave, skippableIds, type Draft, type NeedJob, type NeedQuestion,
} from '../apps/dashboard/src/lib/question-model.js';

const q = (o: Partial<NeedQuestion> & { id: number }): NeedQuestion => ({
  label: 'L', kind: 'text', options: [], maxlength: null, status: 'open', answer: null, owner_comment: null, suggested: null, agent_allowed: false, job_count: 1, ...o,
});
const job = (questions: NeedQuestion[]): NeedJob => ({ job_id: 'j', title: 'T', company: 'C', apply_url: null, host: 'h', resume_pdf: null, ats_note: null, apply_status: 'needs_answer', questions });
const D = (d: Partial<Draft>): Draft => ({ mode: '', text: '', always: false, ...d });

describe('question model (dashboard Needs your answer)', () => {
  it('checks the typed answer like the server: empty, maxlength, options', () => {
    expect(draftProblem(q({ id: 1 }), D({ mode: 'answer' }))).toMatch(/Type an answer/);
    expect(draftProblem(q({ id: 1, maxlength: 5 }), D({ mode: 'answer', text: 'abcdef' }))).toMatch(/Too long/);
    expect(draftProblem(q({ id: 1, kind: 'select', options: ['Remote', 'Hybrid'] }), D({ mode: 'answer', text: 'onsite' }))).toMatch(/Pick one/);
    expect(draftProblem(q({ id: 1, kind: 'select', options: ['Remote'] }), D({ mode: 'answer', text: 'remote' }))).toBeNull();
    expect(draftProblem(q({ id: 1 }), D({ mode: 'agent' }))).toBeNull();
    expect(limitOf(q({ id: 1, maxlength: 99999 }))).toBe(2000);
  });

  it('plans one submit per job: answers with scope, agent ids, blocked rows; agent only where allowed', () => {
    const j = job([q({ id: 1 }), q({ id: 2, agent_allowed: true }), q({ id: 3 }), q({ id: 4, maxlength: 3 }), q({ id: 5, agent_allowed: true, status: 'agent_handle' })]);
    const p = planSave(j, {
      1: D({ mode: 'answer', text: ' 12 LPA ', always: true }), 2: D({ mode: 'agent' }), 3: D({ mode: 'agent' }), 4: D({ mode: 'answer', text: 'toolong' }), 5: D({ mode: 'agent' }),
    });
    expect(p.answers).toEqual([{ id: 1, answer: '12 LPA', scope: 'always' }]);
    expect(p.agentIds).toEqual([2]); // 5 is already agent_handle: nothing to resend
    expect(p.blocked.map((b) => b.id)).toEqual([3, 4]);
    expect(p.idle).toBe(false);
    expect(planSave(j, {}).idle).toBe(true);
  });

  it('skip applies to every unanswered question and counts open ones', () => {
    const j = job([q({ id: 1 }), q({ id: 2, status: 'agent_handle' }), q({ id: 3, status: 'answered' })]);
    expect(skippableIds(j)).toEqual([1, 2]);
    expect(openCount(j)).toBe(1);
  });

  it('reads per-question errors from a save response', () => {
    expect(errorsFrom([{ id: 1, ok: true }, { id: 2, ok: false, error: 'nope' }, { id: 3, ok: false }])).toEqual({ 2: 'nope', 3: 'Not saved.' });
    expect(errorsFrom(undefined)).toEqual({});
  });
});
