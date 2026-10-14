// tests/safety-style-gate.test.ts
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkStyle, loadStyleConfig, loadStyleConfigSafe, DEFAULT_STYLE_CONFIG, type StyleConfig } from '../src/safety/styleGate.js';

const cfg: StyleConfig = loadStyleConfig('config/ai-tells.json');
const rules = (text: string, kind = 'followup'): string[] => checkStyle(text, kind, cfg).hits.map((h) => h.rule);

describe('shipped config', () => {
  it('loads and has sane values', () => {
    expect(cfg.banned_phrases.length).toBeGreaterThan(10);
    expect(cfg.max_words.connect).toBeGreaterThan(0);
  });
  it('rejects a malformed config file shape', () => {
    expect(() => loadStyleConfig('package.json')).toThrow();
  });
  it('safe loader falls back to defaults with a note on missing or invalid file', () => {
    const missing = loadStyleConfigSafe('config/does-not-exist.json');
    expect(missing.cfg).toEqual(DEFAULT_STYLE_CONFIG);
    expect(missing.note).toMatch(/style config invalid/);
    expect(loadStyleConfigSafe('package.json').note).toBeTruthy();
    expect(loadStyleConfigSafe('config/ai-tells.json').note).toBeNull();
  });
});

describe('checkStyle', () => {
  it('passes plain, natural text', () => {
    const r = checkStyle('Hi Jane, I saw the React role on your team. Could you tell me how the team works day to day?', 'rapport', cfg);
    expect(r).toEqual({ ok: true, hits: [] });
  });

  it('flags em dashes, en dashes and spaced double hyphens', () => {
    expect(rules('I build APIs — and UIs')).toContain('em_dash');
    expect(rules('2020–2024 at Acme')).toContain('en_dash');
    expect(rules('I build APIs -- and UIs')).toContain('double_hyphen_dash');
    expect(rules('A normal hyphen-ated word - fine')).toEqual([]);
  });

  it('flags banned phrases case-insensitively and names the phrase, not the text', () => {
    const r = checkStyle('I Hope This Finds You Well. I am keen to LEVERAGE my skills.', 'followup', cfg);
    const phrases = r.hits.filter((h) => h.rule === 'banned_phrase').map((h) => h.detail);
    expect(phrases).toEqual(expect.arrayContaining(['i hope this finds you well', 'leverage']));
    expect(JSON.stringify(r)).not.toContain('keen');
  });

  it('allows at most the configured exclamation marks', () => {
    expect(rules('Great team!')).toEqual([]);
    expect(rules('Great team! Really!')).toContain('exclamations');
  });

  it('flags markdown formatting', () => {
    expect(rules('Skills:\n- React\n- Node')).toContain('markdown');
    expect(rules('I use **React** daily')).toContain('markdown');
    expect(rules('# Heading\ntext')).toContain('markdown');
    expect(rules('1. First\n2. Second')).toContain('markdown');
  });

  it('enforces the word cap for the touch kind only', () => {
    const long = Array.from({ length: 80 }, () => 'word').join(' ');
    expect(rules(long, 'connect')).toContain('too_long');
    expect(rules(long, 'role_ask')).toEqual([]);
    expect(rules(long, 'unknown_kind')).toEqual([]);
  });

  it('respects a config that turns a rule off', () => {
    const lenient: StyleConfig = { ...cfg, forbid_em_dash: false, banned_phrases: [] };
    expect(checkStyle('a — b', 'followup', lenient).ok).toBe(true);
  });

  it('stays fast on pathological input and still flags over-long input', () => {
    const nasty = ' '.repeat(200000) + 'a'.repeat(100000) + '\n'.repeat(50000);
    const t = Date.now();
    const r = checkStyle(nasty, 'connect', cfg);
    expect(Date.now() - t).toBeLessThan(1500);
    expect(r.ok).toBe(false);
    expect(r.hits.map((h) => h.rule)).toContain('too_long');
  });
});

describe('phrase matching normalization', () => {
  it('catches curly apostrophes and newline-split phrases', () => {
    expect(rules('I’d love to chat')).toContain('banned_phrase');
    expect(rules('In today’s market')).toContain('banned_phrase');
    expect(rules('Iʼd love to chat')).toContain('banned_phrase');
    expect(rules('just following\n  up on this')).toContain('banned_phrase');
    const r = checkStyle('I’d love to chat', 'followup', cfg);
    expect(r.hits[0].detail).toBe("i'd love to");
  });
  it('still passes a normal message', () => {
    expect(rules("Hi Sam, I'm curious how the team ships.\nThanks.")).toEqual([]);
  });
});

describe('config sanitizing', () => {
  const write = (o: unknown): string => {
    const p = join(mkdtempSync(join(tmpdir(), 'style-')), 'c.json');
    writeFileSync(p, JSON.stringify(o));
    return p;
  };
  it('drops blank phrases so a space entry cannot match everything', () => {
    const c = loadStyleConfig(write({ ...cfg, banned_phrases: [' ', '', ' circling back '] }));
    expect(c.banned_phrases).toEqual(['circling back']);
    expect(checkStyle('hello there friend', 'followup', c).ok).toBe(true);
    expect(checkStyle('circling back soon', 'followup', c).ok).toBe(false);
  });
  it('rejects or defaults invalid numeric limits', () => {
    const bad = write({ ...cfg, max_exclamations: -1, max_words: { connect: 'x', role_ask: -5, followup: 10 } });
    expect(() => loadStyleConfig(bad)).toThrow();
    const s = loadStyleConfigSafe(bad);
    expect(s.note).toMatch(/max_exclamations/);
    expect(s.cfg.max_exclamations).toBe(DEFAULT_STYLE_CONFIG.max_exclamations);
    expect(s.cfg.max_words.connect).toBe(55);
    expect(s.cfg.max_words.role_ask).toBe(110);
    expect(s.cfg.max_words.followup).toBe(10);
  });
  it('checkStyle does not let a NaN cap disable the limit', () => {
    const c: StyleConfig = { ...cfg, max_words: { connect: NaN } };
    const long = Array.from({ length: 80 }, () => 'word').join(' ');
    expect(checkStyle(long, 'connect', c).hits.map((h) => h.rule)).toContain('too_long');
  });
});
