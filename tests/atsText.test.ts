import { describe, it, expect } from 'vitest';
import { normalizeText, normalizeForAts } from '../src/atsText.js';
import { checkOutreachText, checkResume, checkTextWithNormalized } from '../src/resumeFacts.js';
import { applyReviewEdits } from '../src/reviewEdits.js';
import { getBaseResume, renderResumeChecked } from '../src/resume.js';

const ZW = '​';
const SHY = '­';
const probe = (sep: string) => `O${sep}wned the Kuber${sep}netes platform rollout.`;
const blocks = (r: { invented: string[]; unsupported: string[]; forbidden: string[] }) => [...r.invented, ...r.unsupported, ...r.forbidden];

describe('normalizeText', () => {
  it('strips every Unicode format character (\\p{Cf})', () => {
    const cf = ['­', '​', '‌', '‍', '‎', '‏', '‪', '‫', '‬', '‭', '‮', '⁠', '⁡', '⁢', '⁣', '⁤', '﻿'];
    for (const c of cf) expect(normalizeText(`Kuber${c}netes`)).toBe('Kubernetes');
  });
  it('leaves a plain ASCII email with ordinary punctuation unchanged', () => {
    const email = 'Hi Priya,\n\nI saw the Senior Frontend Engineer role (React, TypeScript) - and I\'d like to apply: "fast" UIs; 11 seconds faster load! Thanks.\n\nJane';
    expect(normalizeText(email)).toBe(email);
  });
  it('turns curly quotes into ASCII and keeps the existing mappings', () => {
    expect(normalizeText('I’d say “fast” – a b… x → y')).toBe('I\'d say "fast" - a b... x to y');
  });
  it('normalizeForAts walks objects and also strips soft hyphens', () => {
    expect(normalizeForAts({ a: [`x${SHY}y`], n: 1 })).toEqual({ a: ['xy'], n: 1 });
  });
});

describe('invisible-character gate bypass', () => {
  for (const [label, sep] of [['zero-width space', ZW], ['soft hyphen', SHY], ['word joiner', '⁠']] as const) {
    it(`blocks a ${label}-laced claim at the resume gate`, () => {
      const t = getBaseResume();
      t.summary = `${t.summary} ${probe(sep)}`;
      const b = blocks(checkResume(getBaseResume(), t));
      expect(b.some((x) => x.startsWith('scope:ownership'))).toBe(true);
      expect(b.some((x) => x.startsWith('tool:kubernetes'))).toBe(true);
    });
    it(`blocks a ${label}-laced claim in checkOutreachText`, () => {
      const r = checkOutreachText(`Hi,\n\nI ${probe(sep).toLowerCase()}\n\nThanks`, getBaseResume());
      expect(r.verdict).toBe('block');
      expect(blocks(r).some((x) => /kubernetes/.test(x))).toBe(true);
    });
  }
  it('check_text returns the normalized text that was gated', () => {
    const r = checkTextWithNormalized(`I’d like to talk${ZW}.`, getBaseResume());
    expect(r.normalized_text).toBe("I'd like to talk.");
    expect(r.verdict).not.toBe('block');
  });
  it('apply_review_edits gates and returns normalized email and resume text', () => {
    const base = getBaseResume();
    const email = { subject: 'Hello', body: 'I’m keen on this role.' };
    const edit = { target: 'email' as const, path: 'body', old_string: 'keen on this role.', new_string: probe(ZW), reason: 'style' as const };
    const r = applyReviewEdits(base, base, email, [edit]);
    expect(r.applied).toEqual([]);
    expect(r.rejected[0].why).toMatch(/unsupported claim/);
    expect(r.email).toEqual({ subject: 'Hello', body: "I'm keen on this role." });
  });
  it('renderResumeChecked refuses a zero-width-laced resume before rendering', async () => {
    const t = getBaseResume();
    t.experience[0].description[0] = `${probe(ZW)} ${t.experience[0].description[0]}`;
    await expect(renderResumeChecked(t)).rejects.toThrow(/fact check failed/);
  });
});
