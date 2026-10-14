import { describe, it, expect } from 'vitest';
import { applyReviewEdits, jobDescriptionSchema, type ReviewEdit } from '../src/reviewEdits.js';

const base: any = {
  name: 'Test User', jobTitle: null, email: 't@example.com', phone: '+91 90000 00000',
  summary: 'Software Engineer with 3+ years of experience in frontend architecture and AI-integrated systems.',
  experience: [{ title: 'Software Engineer', company: 'Acme Labs', location: null, start: 'Jul 2025', end: 'Present', description: [
    'Led the architecture of a policy-driven governance layer centralizing MCP access control, reducing policy misconfiguration issues by ~50%.',
    'Designed contract-driven TypeScript APIs, reducing integration-related regressions by 70% as AI interfaces evolved.',
    'Directed a system-wide refactor of React state management, reducing initial load time by 11 seconds.',
    'Developed D3-based risk analytics dashboards across 12+ policies.',
  ] }],
  projects: [], education: [{ degree: 'BE', school: 'XYZ Univ', location: 'Pune', year: '2021' }],
  skills: [{ category: 'Frontend', items: ['React', 'TypeScript'] }], certificates: [],
};
const clone = () => JSON.parse(JSON.stringify(base));
const O = { config: { allow_metrics: [], allow_facts: [], forbidden_phrases: [], warn_phrases: [] } };
const email = { subject: 'Frontend role at Acme', body: 'I cut load time by 11 seconds.' };
const run = (edits: ReviewEdit[]) => applyReviewEdits(base, clone(), email, edits, O);

describe('applyReviewEdits', () => {
  it('applies a truthful keyword edit', () => {
    const r = run([{ target: 'resume', path: 'summary', old_string: 'AI-integrated systems', new_string: 'AI-integrated TypeScript systems', reason: 'keyword' }]);
    expect(r.applied).toHaveLength(1);
    expect(r.resume.summary).toContain('AI-integrated TypeScript systems');
    expect(r.facts.verdict).toBe('pass');
  });
  it('rejects an edit that adds an unsupported claim', () => {
    const r = run([{ target: 'resume', path: 'summary', old_string: 'AI-integrated systems', new_string: 'AI-integrated systems I owned end to end', reason: 'reframing' }]);
    expect(r.applied).toEqual([]);
    expect(r.rejected[0].why).toMatch(/^would add unsupported claim\(s\): scope:ownership/);
    expect(r.resume.summary).toBe(base.summary);
  });
  it('rejects a missing or non-unique old_string', () => {
    expect(run([{ target: 'resume', path: 'experience[0].description[1]', old_string: 'nope', new_string: 'x', reason: 'style' }]).rejected[0].why).toBe('old_string not found at path');
    expect(run([{ target: 'resume', path: 'experience[0].description[1]', old_string: 'r', new_string: 'x', reason: 'style' }]).rejected[0].why).toMatch(/not unique/);
  });
  it('applies two cuts in index-safe order', () => {
    const r = run([
      { target: 'resume', path: 'experience[0].description[2]', old_string: base.experience[0].description[2], new_string: '', reason: 'cut' },
      { target: 'resume', path: 'experience[0].description[3]', old_string: base.experience[0].description[3], new_string: '', reason: 'cut' },
    ]);
    expect(r.rejected).toEqual([]);
    expect(r.resume.experience[0].description).toEqual(base.experience[0].description.slice(0, 2));
  });
  it('a non-cut edit keeps its original index when a cut is in the same batch (P3)', () => {
    // The reviewer wrote both paths against the ORIGINAL numbering. Cutting [0] first would slide the old [2] into [1]
    // and the style edit (which only checks that "reducing" is unique in whatever sits at [1]) would hit the wrong bullet.
    const r = run([
      { target: 'resume', path: 'experience[0].description[0]', old_string: base.experience[0].description[0], new_string: '', reason: 'cut' },
      { target: 'resume', path: 'experience[0].description[1]', old_string: 'reducing', new_string: 'cutting', reason: 'style' },
    ]);
    expect(r.rejected).toEqual([]);
    expect(r.resume.experience[0].description).toEqual([
      base.experience[0].description[1].replace('reducing', 'cutting'),
      base.experience[0].description[2],
      base.experience[0].description[3],
    ]);
  });
  it('a cut must quote the whole bullet', () => {
    const r = run([{ target: 'resume', path: 'experience[0].description[3]', old_string: 'Developed', new_string: '', reason: 'cut' }]);
    expect(r.rejected[0].why).toBe('cut must quote the whole bullet as old_string');
  });
  it('rejects an email edit that invents a metric and unsupported paths', () => {
    expect(run([{ target: 'email', path: 'body', old_string: '11 seconds', new_string: '11 seconds and grew signups 90%', reason: 'style' }]).rejected[0].why).toBe('would add unsupported claim(s): metric:90%');
    expect(run([{ target: 'resume', path: 'skills[0].items[0]', old_string: 'React', new_string: 'Vue', reason: 'keyword' }]).rejected[0].why).toBe('unsupported path "skills[0].items[0]"');
  });
  it('applies at most 20 edits and reports the rest as over the limit', () => {
    const many = Array.from({ length: 25 }, () => ({ target: 'resume' as const, path: 'jobTitle', old_string: 'zzz', new_string: 'y', reason: 'style' as const }));
    const r = run(many);
    // R2: edits beyond the limit are reported in rejected, not silently dropped (was: applied+rejected === 20).
    expect(r.applied.length + r.rejected.length).toBe(25);
    expect(r.rejected.filter((x) => x.why === 'over edit limit (20)')).toHaveLength(5);
  });
  it('refuses every edit when the starting resume is oversize', () => {
    const big = clone();
    big.experience[0].description[3] = 'Developed dashboards. ' + 'x'.repeat(200000);
    const r = applyReviewEdits(base, big, null, [
      { target: 'resume', path: 'experience[0].description[1]', old_string: 'TypeScript APIs', new_string: 'TypeScript APIs on Kubernetes', reason: 'keyword' },
      { target: 'resume', path: 'experience[0].description[2]', old_string: 'Directed', new_string: 'Led', reason: 'style' },
    ], O);
    expect(r.applied).toEqual([]);
    expect(r.rejected.map((x) => x.why)).toEqual(['oversize: not fact-checked; edits refused', 'oversize: not fact-checked; edits refused']);
  });
  it('rejects adding an already-flagged tool to another bullet, but allows cutting the flagged bullet', () => {
    const start = clone();
    start.experience[0].description[3] = 'Developed D3 dashboards on Kubernetes across 12+ policies.';
    const bad = applyReviewEdits(base, start, null, [
      { target: 'resume', path: 'experience[0].description[1]', old_string: 'TypeScript APIs', new_string: 'TypeScript APIs on Kubernetes', reason: 'keyword' },
    ], O);
    expect(bad.applied).toEqual([]);
    expect(bad.rejected[0].why).toMatch(/would add unsupported claim\(s\): tool:kubernetes @/);
    const cut = applyReviewEdits(base, start, null, [
      { target: 'resume', path: 'experience[0].description[3]', old_string: start.experience[0].description[3], new_string: '', reason: 'cut' },
    ], O);
    expect(cut.rejected).toEqual([]);
    expect(cut.facts.unsupported).toEqual([]);
  });
  it('enforces bullet minimums and never blanks fields', () => {
    const two = clone();
    two.experience.push({ title: 'Intern', company: 'Old Co', location: null, start: '2020', end: '2021', description: ['Built internal tools.'] });
    const bullets = (k: number) => ({ target: 'resume' as const, path: `experience[0].description[${k}]`, old_string: base.experience[0].description[k], new_string: '', reason: 'cut' as const });
    const r = applyReviewEdits(base, two, null, [bullets(0), bullets(1), bullets(2), bullets(3),
      { target: 'resume', path: 'experience[1].description[0]', old_string: 'Built internal tools.', new_string: '', reason: 'cut' }], O);
    expect(r.applied).toHaveLength(2);
    expect(r.rejected.length).toBe(3);
    expect(r.resume.experience[0].description).toHaveLength(2);
    expect(r.resume.experience[1].description).toHaveLength(1);
    const blank = run([{ target: 'resume', path: 'experience[0].description[1]', old_string: base.experience[0].description[1], new_string: '', reason: 'style' }]);
    expect(blank.rejected[0].why).toBe('would leave empty bullet');
    const sum = run([{ target: 'resume', path: 'summary', old_string: base.summary, new_string: '', reason: 'cut' }]);
    expect(sum.rejected[0].why).toBe('would leave empty summary');
  });
  it('rejects new headline / posting-echo warnings and setting jobTitle from blank', () => {
    const jt = run([{ target: 'resume', path: 'jobTitle', old_string: '', new_string: 'Principal Staff Engineer', reason: 'keyword' }]);
    expect(jt.rejected[0].why).toBe('jobTitle cannot be set from blank');
    const jd = 'We want someone deeply passionate about pixel-perfect UI quality and shipping delightful customer experiences every day.';
    const r = applyReviewEdits(base, clone(), null, [{ target: 'resume', path: 'summary', old_string: 'AI-integrated systems', new_string: 'AI-integrated systems and deeply passionate about pixel-perfect UI quality', reason: 'keyword' }], { ...O, jobDescription: jd });
    expect(r.applied).toEqual([]);
    expect(r.rejected[0].why).toMatch(/would add warning\(s\): posting-echo/);
  });
});

describe('apply_review_edits job_description schema', () => {
  it('accepts a full 6000-char posting unchanged and clamps longer postings to 20000 chars in code', () => {
    expect(jobDescriptionSchema.parse('x'.repeat(6000))).toBe('x'.repeat(6000));
    expect(jobDescriptionSchema.parse('x'.repeat(20000))).toBe('x'.repeat(20000));
    expect(jobDescriptionSchema.parse('y'.repeat(20001))).toBe('y'.repeat(20000));
    expect(jobDescriptionSchema.parse('z'.repeat(25000))).toHaveLength(20000);
    expect(jobDescriptionSchema.safeParse(undefined).success).toBe(true);
    expect(jobDescriptionSchema.safeParse(42).success).toBe(false);
  });
});
