import { describe, it, expect } from 'vitest';
import { mixedScriptWords } from '../src/atsText.js';
import { checkOutreachText, checkResume } from '../src/resumeFacts.js';
import { getBaseResume } from '../src/resume.js';

const all = (r: { invented: string[]; unsupported: string[]; forbidden: string[] }) => [...r.invented, ...r.unsupported, ...r.forbidden];
const CYR_O = 'о'; // Cyrillic small o

describe('mixedScriptWords', () => {
  it('flags a Latin word with one Cyrillic letter', () => {
    expect(mixedScriptWords(`I wr${CYR_O}te code`)).toEqual([{ word: `wr${CYR_O}te`, scripts: ['Cyrillic'] }]);
  });
  it('flags each listed script mixed with Latin', () => {
    const probes: Array<[string, string]> = [['Greek', 'α'], ['Armenian', 'ա'], ['Georgian', 'ა'], ['Hangul', '한'], ['Hiragana', 'あ'], ['Katakana', 'カ'], ['Han', '日'], ['Arabic', 'ع'], ['Hebrew', 'ש'], ['Cyrillic', 'я']];
    for (const [name, ch] of probes) expect(mixedScriptWords(`ab${ch}cd`).map((x) => x.scripts)).toEqual([[name]]);
  });
  it('passes single-script words and Latin with diacritics', () => {
    for (const w of ['Москва', '日本語', 'שלום', 'Zürich', 'Müller', 'Résumé', 'naïve', 'node.js', "don't", 'full-stack', 'ES2022', 'école']) expect(mixedScriptWords(w), w).toEqual([]);
  });
  it('a sentence mixing a fully Cyrillic word and Latin words passes', () => {
    expect(mixedScriptWords('I moved from Москва to Berlin for React work.')).toEqual([]);
  });
});

describe('mixed-script gate', () => {
  it('resume: a homoglyph word blocks', () => {
    const t = getBaseResume();
    t.summary = `${t.summary} I wr${CYR_O}te the checkout flow.`;
    const r = checkResume(getBaseResume(), t);
    expect(r.verdict).toBe('block');
    expect(all(r).some((x) => x.startsWith(`mixed-script:wr${CYR_O}te`))).toBe(true);
  });
  it('resume: a homoglyph in a skill item (non-prose field) blocks', () => {
    const t = getBaseResume();
    t.skills[0].items = [...t.skills[0].items, `Rea${CYR_O}ct`];
    expect(all(checkResume(getBaseResume(), t)).some((x) => x.startsWith('mixed-script:'))).toBe(true);
  });
  it('resume: the base against itself passes', () => {
    const r = checkResume(getBaseResume(), getBaseResume());
    expect(all(r).some((x) => x.startsWith('mixed-script:'))).toBe(false);
    expect(r.verdict).not.toBe('block');
  });
  it('resume: a fully Cyrillic word does not block', () => {
    const t = getBaseResume();
    t.summary = `${t.summary} Москва.`;
    expect(all(checkResume(getBaseResume(), t)).some((x) => x.startsWith('mixed-script:'))).toBe(false);
  });
  it('outreach: a homoglyph word blocks, with a reason', () => {
    const r = checkOutreachText(`Hi,\n\nI wr${CYR_O}te the checkout flow.\n\nThanks`, getBaseResume());
    expect(r.verdict).toBe('block');
    expect(all(r).find((x) => x.startsWith('mixed-script:'))).toMatch(/Latin.*Cyrillic/);
  });
  it('outreach: Latin diacritics and a Cyrillic word pass', () => {
    const r = checkOutreachText('Hi Müller,\n\nI visited Zürich and Москва.\n\nThanks', getBaseResume());
    expect(all(r).some((x) => x.startsWith('mixed-script:'))).toBe(false);
  });
});
