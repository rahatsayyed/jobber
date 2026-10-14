import { describe, it, expect } from 'vitest';
import { applyVetoes, vetoResults } from '../src/vetoes.js';

const job = { title: 'Full Stack Dev', description: 'React and Node. Onsite in Berlin. Unpaid trial week.' };

describe('applyVetoes', () => {
  it('excludes on location FAIL even with a high score', () => {
    const r = applyVetoes({ job_id: 'a', score: 95, location_verdict: 'FAIL' }, job, []);
    expect(r).toEqual({ excluded: true, reason: 'location FAIL', flags: [] });
  });
  it('excludes on language FAIL', () => {
    expect(applyVetoes({ job_id: 'a', score: 90, language_gate: 'FAIL' }, job, []).excluded).toBe(true);
  });
  it('keeps FLAGs with a marker', () => {
    expect(applyVetoes({ job_id: 'a', score: 70, language_gate: 'FLAG' }, job, [])).toEqual({ excluded: false, flags: ['language FLAG'] });
  });
  it('excludes on a deal-breaker keyword, case-insensitive', () => {
    const r = applyVetoes({ job_id: 'a', score: 80 }, job, ['unpaid']);
    expect(r.excluded).toBe(true);
    expect(r.reason).toBe('deal-breaker: unpaid');
  });
  it('ignores whitespace-only and empty keywords (they must not match everything)', () => {
    expect(applyVetoes({ job_id: 'a', score: 80 }, job, ['   ', '', '\t'])).toEqual({ excluded: false, flags: [] });
  });
  it('trims keywords before matching and in the reason', () => {
    expect(applyVetoes({ job_id: 'a', score: 80 }, job, ['  unpaid  '])).toEqual({
      excluded: true, reason: 'deal-breaker: unpaid', flags: [],
    });
  });
  it('FAIL verdicts take precedence over a deal-breaker match', () => {
    expect(applyVetoes({ job_id: 'a', score: 80, location_verdict: 'FAIL' }, job, ['unpaid']).reason).toBe('location FAIL');
    expect(applyVetoes({ job_id: 'a', score: 80, language_gate: 'FAIL' }, job, ['unpaid']).reason).toBe('language FAIL');
  });
  it('keeps a location FLAG with a marker', () => {
    expect(applyVetoes({ job_id: 'a', score: 70, location_verdict: 'FLAG' }, job, [])).toEqual({
      excluded: false, flags: ['location FLAG'],
    });
  });
  it('language FAIL reason string', () => {
    expect(applyVetoes({ job_id: 'a', score: 90, language_gate: 'FAIL' }, job, [])).toEqual({
      excluded: true, reason: 'language FAIL', flags: [],
    });
  });
  it('passes when no verdict fields are present (old matcher output)', () => {
    expect(applyVetoes({ job_id: 'a', score: 80 }, job, [])).toEqual({ excluded: false, flags: [] });
  });
});

describe('vetoResults null/undefined description mapping', () => {
  it('treats a null or missing description as empty and does not throw', () => {
    const r = vetoResults(
      [{ job_id: 'a', score: 80 }, { job_id: 'b', score: 80 }],
      [{ id: 'a', title: 'Dev', description: null }, { id: 'b', title: 'Dev' }],
      ['unpaid'],
    );
    expect(r).toEqual([
      { job_id: 'a', excluded: false, flags: [] },
      { job_id: 'b', excluded: false, flags: [] },
    ]);
  });
  it('still matches deal-breakers in the title when description is null', () => {
    const r = vetoResults([{ job_id: 'a', score: 80 }], [{ id: 'a', title: 'Unpaid Dev', description: null }], ['unpaid']);
    expect(r[0].excluded).toBe(true);
  });
});
