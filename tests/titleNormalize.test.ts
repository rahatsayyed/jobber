import { describe, it, expect } from 'vitest';
import { checkOutreachText } from '../src/resumeFacts.js';
import { getBaseResume } from '../src/resume.js';

const SHY = '­';
const all = (r: { invented: string[]; unsupported: string[]; forbidden: string[] }) => [...r.invented, ...r.unsupported, ...r.forbidden];

describe('job_title and company are normalized before blanking', () => {
  it('a title containing a soft hyphen still blanks the posting reference', () => {
    const text = 'Hi,\n\nI saw the Kubernetes Platform Engineer role and would like to talk.\n\nThanks';
    const plain = checkOutreachText(text, getBaseResume(), { jobTitle: 'Kubernetes Platform Engineer' });
    const shy = checkOutreachText(text, getBaseResume(), { jobTitle: `Kuber${SHY}netes Platform Engineer` });
    expect(all(plain)).toEqual([]);
    expect(all(shy)).toEqual(all(plain));
  });
  it('a curly-apostrophe company name blanks like the straight one', () => {
    const text = 'Hi,\n\nI saw the opening at Kubernetes\'s Lab and would like to talk.\n\nThanks';
    const curly = checkOutreachText(text, getBaseResume(), { company: 'Kubernetes’s Lab' });
    const straight = checkOutreachText(text, getBaseResume(), { company: "Kubernetes's Lab" });
    expect(all(curly)).toEqual(all(straight));
  });
  it('a company with a zero-width space and curly quote still blanks', () => {
    const text = 'Hi,\n\nI applied for the role at "Kubernetes Works" and would like to talk.\n\nThanks';
    const r = checkOutreachText(text, getBaseResume(), { company: 'Kuber​netes Works' });
    expect(all(r)).toEqual([]);
  });
});
