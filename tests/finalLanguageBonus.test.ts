import { describe, it, expect } from 'vitest';
import { detectLanguageRequirements, languageGate } from '../src/languageGate.js';

const declared = [{ language: 'English', level: 'fluent' as const }];
const html = '<ul><li>Organised - You can multitask</li></ul><strong>Added bonus <br><br></strong><ul><li>Bi-lingual - Fluency in Portuguese &amp; English</li>' +
  '<li>Beauty &amp; Wellness - Experience within the industry</li></ul><strong>Why join us?</strong><ul><li>Fluent French is required for this role</li></ul>';

describe('language gate: bonus headings (final review M3)', () => {
  it("remoteok:1134417's bonus line gives FLAG (confirmed config), not FAIL", () => {
    const r = languageGate(html, declared, { confirmed: true });
    // French after the next heading is a real requirement and still FAILs; isolate the bonus part first
    const bonusOnly = html.split('<strong>Why join us?</strong>')[0];
    const b = languageGate(bonusOnly, declared, { confirmed: true });
    expect(b.verdict).toBe('FLAG');
    expect(b.note).toContain('prefers Portuguese');
    expect(r.verdict).toBe('FAIL');
    expect(r.note).toContain('French');
  });
  it('the heading marks list items as preferred in plain text too, until a blank line', () => {
    const t = 'Requirements\nReact experience\n\nAdded bonus\nFluency in Portuguese\nFluent German\n\nFluent French is required';
    const reqs = detectLanguageRequirements(t);
    expect(reqs.map((r) => [r.language, r.preferred])).toEqual([['Portuguese', true], ['German', true], ['French', false]]);
  });
  it.each(['Bonus', 'Nice to have', 'Nice to have:', 'Preferred', 'Plus', 'Added bonus'])('heading "%s" works', (h) => {
    expect(detectLanguageRequirements(`${h}\nFluent German`)).toMatchObject([{ language: 'German', preferred: true }]);
  });
  it('a heading ends at the next heading-like line (colon or known section name)', () => {
    const t = 'Bonus\nFluent German\nResponsibilities\nFluent French\nNice to have:\nFluent Italian\nRequirements:\nFluent Spanish';
    expect(detectLanguageRequirements(t).map((r) => [r.language, r.preferred])).toEqual([
      ['German', true], ['French', false], ['Italian', true], ['Spanish', false]]);
  });
  it('a line that merely contains the word bonus is not a heading', () => {
    expect(detectLanguageRequirements('Bonus structure is competitive\nFluent German required')).toMatchObject([{ language: 'German', preferred: false }]);
  });
});
