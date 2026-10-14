import { describe, it, expect } from 'vitest';
import { classifyKeywords, coveragePct, termMatches } from '../src/atsKeywords.js';
import { normalizeForAts } from '../src/resume.js';

describe('classifyKeywords', () => {
  it('classifies covered / synonym_only / missing_have_it / gap', () => {
    const r = classifyKeywords([
      { term: 'React.js', priority: 'required' }, { term: 'JavaScript', priority: 'required' }, { term: 'Docker', priority: 'preferred' },
      { term: 'Kubernetes', priority: 'required' }, { term: 'REST APIs', priority: 'required' }, { term: 'Node.js', priority: 'preferred' },
    ], 'Built React apps with JS tooling and a REST API layer.', 'Optimized a Docker-based build.', 'Node.js, Express');
    expect(r).toEqual([
      { term: 'React.js', priority: 'required', status: 'covered' },
      { term: 'JavaScript', priority: 'required', status: 'synonym_only', via: 'js' },
      { term: 'Docker', priority: 'preferred', status: 'missing_have_it' },
      { term: 'Kubernetes', priority: 'required', status: 'gap' },
      { term: 'REST APIs', priority: 'required', status: 'covered' },
      { term: 'Node.js', priority: 'preferred', status: 'skills_only' },
    ]);
  });
  it('a skills-list-only term is never covered and never missing_have_it (P10)', () => {
    const r = classifyKeywords([{ term: 'Node.js', priority: 'required' }], 'Built React apps.', 'Built React apps.', 'React, Node.js');
    expect(r).toEqual([{ term: 'Node.js', priority: 'required', status: 'skills_only' }]);
    expect(coveragePct(r)).toBe(0);
    // with the skills text omitted the term is a plain gap
    expect(classifyKeywords([{ term: 'Node.js', priority: 'required' }], 'Built React apps.', 'Built React apps.')[0].status).toBe('gap');
  });
  it('matches NodeJS spellings and never matches inside a word', () => {
    expect(termMatches('Built with NodeJS', 'Node.js')).toBe(true);
    expect(termMatches('google cloud', 'go')).toBe(false);
  });
  it('ignores blank terms and computes coverage', () => {
    const r = classifyKeywords([{ term: 'React', priority: 'required' }, { term: 'Vue', priority: 'required' }, { term: ' ', priority: 'required' }], 'React', '');
    expect(r).toHaveLength(2);
    expect(coveragePct(r)).toBe(50);
    expect(coveragePct([])).toBeNull();
  });
});

describe('normalizeForAts', () => {
  it('folds typography in every string without mutating the input', () => {
    const input = { summary: 'Client–Server — “fast” it’s…', skills: [{ items: ['A B', 'x​y', 'a → b'] }], n: 3 };
    const out = normalizeForAts(input);
    expect(out).toEqual({ summary: 'Client-Server - "fast" it\'s...', skills: [{ items: ['A B', 'xy', 'a to b'] }], n: 3 });
    expect(input.summary).toContain('–');
  });
});
