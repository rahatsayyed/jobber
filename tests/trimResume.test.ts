import { describe, it, expect } from 'vitest';
import { insertBullet, pickBulletToCut, removeBullet, scoreBullets } from '../src/trimResume.js';

const resume = {
  summary: 'Frontend engineer working on React state management.',
  experience: [
    { description: ['Built a governance layer for access control.', 'Shipped React features in TypeScript.', 'Refactored React state management.', 'Wrote internal docs.'] },
    { description: ['Audited smart contracts.'] }, // P1: not 'Built ...': "built" is a content token shared with bullet 0, which would drag its score below the filler bullet
  ],
};
const kws = [{ term: 'React', priority: 'required' as const }, { term: 'TypeScript', priority: 'required' as const }];

describe('trimResume', () => {
  it('scores relevance from keywords and uniqueness from overlap', () => {
    const s = scoreBullets(resume, kws);
    expect(s.find((b) => b.idx === 1 && b.exp === 0)!.relevance).toBe(4);
    expect(s.find((b) => b.idx === 0 && b.exp === 0)!.relevance).toBe(0);
    const dup = scoreBullets({ summary: '', experience: [{ description: ['Refactored React state management.', 'Refactored React state management.'] }] }, kws);
    expect(dup[0].uniqueness).toBe(0);
  });
  it('cuts the lowest-scoring bullet, never below role minimums', () => {
    // bullets 0 ("governance layer") and 3 ("internal docs") both score 1.00 (no keyword hit, no shared content token);
    // the tie goes to the same role's later bullet.
    expect(pickBulletToCut(resume, kws)).toEqual({ exp: 0, idx: 3 });
    const tight = { experience: [{ description: ['a React thing', 'b TypeScript thing'] }, { description: ['only bullet'] }] };
    expect(pickBulletToCut(tight, kws)).toBeNull();
  });
  it('cuts verbatim duplicates before unique bullets even when the duplicate has a keyword', () => {
    const r = { summary: '', experience: [{ description: ['Shipped React features in TypeScript.', 'Wrote internal docs.', 'Shipped React features in TypeScript.', 'Shipped React features in TypeScript.'] }] };
    expect(pickBulletToCut(r, kws)).toEqual({ exp: 0, idx: 3 });
    const after = removeBullet(removeBullet(r, 0, 3), 0, 2);
    expect(after.experience[0].description).toEqual(['Shipped React features in TypeScript.', 'Wrote internal docs.']);
  });
  it('counts only non-blank bullets for the per-role minimum', () => {
    const r = { experience: [{ description: ['a React thing', 'b TypeScript thing'] }, { description: ['', 'only real bullet'] }] };
    expect(pickBulletToCut(r, kws)).toBeNull();
  });
  it('removes and re-inserts a bullet without mutating the input', () => {
    const cut = removeBullet(resume, 0, 3);
    expect(cut.experience[0].description).toHaveLength(3);
    expect(resume.experience[0].description).toHaveLength(4);
    expect(insertBullet(cut, 0, 3, 'Wrote internal docs.').experience[0].description).toEqual(resume.experience[0].description);
  });
});
