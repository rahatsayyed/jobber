import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectLanguageRequirements, languageGate, loadLanguageConfig } from '../src/languageGate.js';

const declared = [{ language: 'English', level: 'fluent' as const }, { language: 'Hindi', level: 'native' as const }];
const englishOnly = [{ language: 'English', level: 'fluent' as const }];

describe('languageGate', () => {
  it('FAIL with the quote when a required language is not declared', () => {
    expect(languageGate('Great team. Fluent German is required. Remote.', declared)).toEqual({ verdict: 'FAIL', note: 'requires German (fluent): "Fluent German is required."' });
  });
  it('FLAG when the language is only a plus', () => {
    expect(languageGate('Knowledge of Spanish is a plus.', declared).verdict).toBe('FLAG');
    expect(languageGate('Arabic is a strong advantage.', declared).verdict).toBe('FLAG');
  });
  it('FLAG when the posting asks a higher level than declared', () => {
    expect(languageGate('Native English speaker required.', [{ language: 'English', level: 'professional' }])).toEqual({ verdict: 'FLAG', note: 'asks English (native), declared professional: "Native English speaker required."' });
  });
  it('PASS when declared at or above the level', () => {
    expect(languageGate('Excellent written and spoken English.', declared)).toEqual({ verdict: 'PASS', note: null });
  });
  it('a country or city name is not a language requirement', () => {
    expect(languageGate('We are a German company with an office in Tokyo. Japanese culture inspires our design.', declared).verdict).toBe('PASS');
  });
  it('requirement wording next to a nationality word is not enough (co-occurrence false positives)', () => {
    for (const s of [
      'Our German customers must receive support within one hour.',
      'The Japanese market is large and a strong sales process is required.',
      'The Polish UI must have full RTL support.',
      'You will support Hindi speaking customers; English required.',
      'We work in English and German markets and a shared calendar is mandatory.',
    ]) expect(languageGate(s, englishOnly)).toEqual({ verdict: 'PASS', note: null });
  });
  it('strips HTML first: tags and entities never reach the quote, list items are separate sentences', () => {
    expect(languageGate('<ul><li>German customers must be served</li><li>Fluent German is required.</li></ul>', englishOnly))
      .toEqual({ verdict: 'FAIL', note: 'requires German (fluent): "Fluent German is required."' });
    expect(languageGate('<ul><li>React and TypeScript</li><li>German customers must be served</li></ul><p>English required</p>', englishOnly))
      .toEqual({ verdict: 'PASS', note: null });
    expect(languageGate('<p>Bilingual &mdash; English and Spanish required</p>', englishOnly).note).toBe('requires Spanish (fluent): "Bilingual — English and Spanish required"');
    expect(languageGate('Fluent&nbsp;Polish&#160;is required', englishOnly).verdict).toBe('FAIL');
  });
  it('real-posting shapes: lists of languages and "fluent X and Y"', () => {
    expect(detectLanguageRequirements('Fluent English and Polish for daily collaboration').map((r) => r.language)).toEqual(['English', 'Polish']);
    expect(detectLanguageRequirements('Fluency in Portuguese & English').map((r) => r.language)).toEqual(['Portuguese', 'English']);
  });
  it('detects C1/B2 levels and several languages in one sentence', () => {
    expect(detectLanguageRequirements('You speak French (C1) and Dutch.').map((r) => [r.language, r.level])).toEqual([['French', 'fluent'], ['Dutch', 'fluent']]);
  });
  it('caps the quote at about 200 characters', () => {
    const q = detectLanguageRequirements(`${'word '.repeat(80)}Fluent German is required.`)[0].quote;
    expect(q.length).toBeLessThanOrEqual(200);
  });
  it('until the languages file is confirmed, an undeclared required language is FLAG, never FAIL', () => {
    expect(languageGate('Fluent German is required.', englishOnly, { confirmed: false }))
      .toEqual({ verdict: 'FLAG', note: 'unconfirmed languages.json: requires German (fluent): "Fluent German is required."' });
    expect(languageGate('Fluent German is required.', englishOnly, { confirmed: true }).verdict).toBe('FAIL');
  });
});

describe('loadLanguageConfig', () => {
  it('shipped config parses and declares at least English at a known level', () => {
    const cfg = loadLanguageConfig();
    expect(cfg).not.toBeNull();
    expect(typeof cfg!.confirmed).toBe('boolean');
    expect(cfg!.declared.find((d) => d.language === 'English')).toBeTruthy();
    for (const d of cfg!.declared) expect(['basic', 'professional', 'fluent', 'native']).toContain(d.level);
  });
  it('reads confirmed:true, and returns null for a missing, broken or empty file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lang-'));
    const ok = path.join(dir, 'ok.json');
    writeFileSync(ok, JSON.stringify({ confirmed: true, declared: [{ language: 'Hindi', level: 'native' }] }));
    expect(loadLanguageConfig(ok)).toEqual({ declared: [{ language: 'Hindi', level: 'native' }], confirmed: true });
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    expect(loadLanguageConfig(bad)).toBeNull();
    expect(loadLanguageConfig(path.join(dir, 'missing.json'))).toBeNull();
    const empty = path.join(dir, 'empty.json');
    writeFileSync(empty, JSON.stringify({ declared: [] }));
    expect(loadLanguageConfig(empty)).toBeNull();
  });
});
