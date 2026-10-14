import { describe, it, expect } from 'vitest';
import { normalizeText } from '../src/atsText.js';
import { checkOutreachText, checkResume } from '../src/resumeFacts.js';
import { getBaseResume } from '../src/resume.js';

const blocks = (r: { invented: string[]; unsupported: string[]; forbidden: string[] }) => [...r.invented, ...r.unsupported, ...r.forbidden];
const probe = (c: string) => `O${c}wned the Kuber${c}netes platform rollout.`;

const SINGLES = ['͏', 'ᅟ', 'ᅠ', 'ㅤ', 'ﾠ', '⠀', '᠎', '឴', '឵'];
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCodePoint(a + i));
const ALL = [...SINGLES, ...range(0xfe00, 0xfe0f), ...range(0xe0100, 0xe01ef)];

describe('exotic invisible characters', () => {
  it('normalizeText strips every one of them', () => {
    for (const c of ALL) expect(normalizeText(`Kuber${c}netes`), `U+${c.codePointAt(0)!.toString(16)}`).toBe('Kubernetes');
  });
  it('ordinary text is unchanged', () => {
    const s = 'Built React apps at Zürich, node.js and a b-c d.';
    expect(normalizeText(s)).toBe(s);
  });
  for (const c of ALL) {
    const label = `U+${c.codePointAt(0)!.toString(16).toUpperCase()}`;
    it(`${label}: resume bullet blocks (ownership + kubernetes)`, () => {
      const t = getBaseResume();
      t.summary = `${t.summary} ${probe(c)}`;
      const b = blocks(checkResume(getBaseResume(), t));
      expect(b.some((x) => x.startsWith('scope:ownership'))).toBe(true);
      expect(b.some((x) => x.startsWith('tool:kubernetes'))).toBe(true);
    });
    it(`${label}: outreach text blocks`, () => {
      const r = checkOutreachText(`Hi,\n\nI ${probe(c).toLowerCase()}\n\nThanks`, getBaseResume());
      expect(r.verdict).toBe('block');
    });
  }
});
