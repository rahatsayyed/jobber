import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectLanguageRequirements, languageGate, loadLanguageConfig } from '../src/languageGate.js';

const englishOnly = [{ language: 'English', level: 'fluent' as const }];

describe('languageGate adversarial sentences (English fluent declared, confirmed)', () => {
  const v = (s: string) => languageGate(s, englishOnly, { confirmed: true }).verdict;
  it('PASS', () => {
    for (const s of [
      'German customers must be happy', 'We have offices in Spain and Japan.', 'You must speak English', 'The Polish UI must support RTL',
      'Bonjour!', 'We use Go and Swift.', 'Our office is in Turkey.', 'We love Chinese food.', 'An English-speaking environment',
      'We serve Hindi speaking customers.', 'German not required', 'No German needed', 'English and German speaking markets',
      'This job ad is written in German', 'Native or fluent English', 'Available in English and German', 'Without German',
      "German isn't required", 'No German or French needed',
    ]) expect([s, v(s)]).toEqual([s, 'PASS']);
  });
  it('FAIL', () => {
    for (const s of [
      'Fluent German required', 'Native-level Japanese required', 'fluency in Spanish or Portuguese required', '<li>French (fluent)</li>',
      '<b>Fluent</b> German', 'Business-level Japanese is a must', 'German language skills required', 'Strong command of Hindi and English',
      'Fluent in Español', 'Deutsch fluent required', 'English not required and German a must', 'No relocation and German required',
    ]) expect([s, v(s)]).toEqual([s, 'FAIL']);
  });
  it('FLAG', () => {
    for (const s of ['German is a plus', 'Hindi preferred', 'English required, French a plus', 'Fluent French and Dutch is a plus'])
      expect([s, v(s)]).toEqual([s, 'FLAG']);
    expect(languageGate('English required, French a plus', englishOnly).note).toBe('prefers French (fluent): "English required, French a plus"');
  });
  it('native or fluent counts as the lower level; aliases and diacritics map to the canonical language', () => {
    expect(detectLanguageRequirements('Native or fluent English')[0].level).toBe('fluent');
    expect(detectLanguageRequirements('Fluent in Français')[0].language).toBe('French');
    expect(languageGate('Fluent Mandarin required', [{ language: 'Chinese', level: 'fluent' }]).verdict).toBe('PASS');
    expect(languageGate('Fluent Cantonese required', [{ language: 'Chinese', level: 'fluent' }]).verdict).toBe('FAIL');
    expect(languageGate('Fluent Nederlands required', englishOnly).note).toBe('requires Dutch (fluent): "Fluent Nederlands required"');
  });
});

describe('loadLanguageConfig hardening', () => {
  const write = (obj: unknown) => {
    const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'lang-')), 'c.json');
    writeFileSync(f, JSON.stringify(obj));
    return f;
  };
  it('normalises level case and whitespace', () => {
    expect(loadLanguageConfig(write({ confirmed: true, declared: [{ language: ' Hindi ', level: 'Native' }, { language: 'English', level: ' FLUENT ' }] })))
      .toEqual({ declared: [{ language: 'Hindi', level: 'native' }, { language: 'English', level: 'fluent' }], confirmed: true });
  });
  it('rejects prototype-key levels and languages', () => {
    expect(loadLanguageConfig(write({ declared: [{ language: 'English', level: 'constructor' }] }))).toBeNull();
    expect(loadLanguageConfig(write({ declared: [{ language: 'constructor', level: 'fluent' }] }))).toBeNull();
  });
  it('returns null (fail closed) when any entry is invalid', () => {
    expect(loadLanguageConfig(write({ declared: [{ language: 'Hindi', level: 'native' }, { language: 'X', level: 'weird' }] }))).toBeNull();
    expect(loadLanguageConfig(write({ declared: [{ language: 'Hindi', level: 'native' }, { language: '', level: 'fluent' }] }))).toBeNull();
  });
});
