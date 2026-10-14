import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { buildPrompt, parseLoose, resumeAsText, rulesFromFrozenPrompt, safeId, seededShuffle, stripFrontmatter, summarizeVerdicts, type Verdict } from '../scripts/eval/lib.js';

const job = { id: 'x:1', title: 'Frontend Engineer', company: 'Acme', description: 'Build $1 things with React.', mustHaveKeywords: ['React'] };

describe('eval lib', () => {
  it('safeId replaces the first colon', () => { expect(safeId('remoteok:1137410')).toBe('remoteok_1137410'); });
  it('strips YAML frontmatter', () => { expect(stripFrontmatter('---\nname: x\n---\n# Body\n')).toBe('# Body'); });
  it('extracts rules after the wrapper separator of a frozen prompt', () => {
    expect(rulesFromFrozenPrompt('<!--\nheader\n-->\nWRAP\n---\n\n## Rules\nr1\n')).toBe('## Rules\nr1');
  });
  it('fills every placeholder and keeps $ literally', () => {
    const p = buildPrompt('B={{BASE_RESUME_JSON}} T={{JOB_TITLE}} C={{COMPANY}} D={{JOB_DESCRIPTION}}', 'RULES', '{"a":1}', job);
    expect(p).toContain('B={"a":1} T=Frontend Engineer C=Acme D=Build $1 things with React.');
    expect(p).toContain('---\n\nRULES');
    expect(p).not.toContain('{{');
  });
  it('parses fenced, wrapped and prose-surrounded JSON', () => {
    expect(parseLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseLoose('{"resume_json":{"summary":"s"},"pdf_path":"p"}')).toEqual({ summary: 's' });
    expect(parseLoose('Here you go: {"a":2} thanks')).toEqual({ a: 2 });
    expect(() => parseLoose('no json')).toThrow();
  });
  it('renders a resume as judge text with bullets', () => {
    const t = resumeAsText({ name: 'N', jobTitle: null, summary: 'S', experience: [{ title: 'T', company: 'C', start: 'a', end: 'b', description: ['x'] }], skills: [] });
    expect(t).toContain('Summary: S');
    expect(t).toContain('  - x');
  });
  it('shuffles deterministically', () => {
    expect(seededShuffle(['A', 'B', 'C'], 7)).toEqual(seededShuffle(['A', 'B', 'C'], 7));
    expect(seededShuffle(['A', 'B', 'C'], 7).sort()).toEqual(['A', 'B', 'C']);
  });
  it('summarizes verdicts per system through the key', () => {
    const s = (t: number, f: number, send: boolean, v: string[] = []) => ({ truthfulness: t, jobFit: f, bulletQuality: 4, voice: 4, skimmability: 4, violations: v, send, note: '' });
    const verdicts: Verdict[] = [
      { job: 'j1', scores: { 'Resume 1': s(5, 3, true), 'Resume 2': s(3, 5, false, ['x']) }, ranking: ['Resume 2', 'Resume 1'], why: '' },
      { job: 'j2', scores: { 'Resume 1': s(4, 4, true), 'Resume 2': s(3, 4, true) }, ranking: ['Resume 1', 'Resume 2'], why: '' },
    ];
    const key = { j1: { 'Resume 1': 'A', 'Resume 2': 'C' }, j2: { 'Resume 1': 'A', 'Resume 2': 'C' } };
    const out = summarizeVerdicts(verdicts, key);
    expect(out.A).toEqual({ n: 2, truthfulness: 4.5, jobFit: 3.5, bulletQuality: 4, voice: 4, skimmability: 4, sendCount: 2, avgRank: 1.5, violations: 0 });
    expect(out.C.sendCount).toBe(1);
    expect(out.C.violations).toBe(1);
  });
  // The baselines are local and git-ignored; skip cleanly when a user has not generated them.
  it.skipIf(!existsSync('scripts/eval/fixtures/baseline/judge/key.json'))('baseline fixtures reproduce the published headline numbers', () => {
    const dir = 'scripts/eval/fixtures/baseline/judge';
    const key = JSON.parse(readFileSync(`${dir}/key.json`, 'utf8'));
    const verdicts = Object.keys(key).map((id) => JSON.parse(readFileSync(`${dir}/verdict-${safeId(id)}.json`, 'utf8')));
    const out = summarizeVerdicts(verdicts, key);
    expect(out.A.truthfulness).toBeCloseTo(4.25, 2);
    expect(out.A.jobFit).toBeCloseTo(3.38, 1);
    expect(out.C.jobFit).toBeCloseTo(4.0, 2);
    expect([out.A.sendCount, out.B.sendCount, out.C.sendCount]).toEqual([7, 7, 3]);
    expect(out.A.avgRank).toBeCloseTo(1.63, 1);
  });
});
