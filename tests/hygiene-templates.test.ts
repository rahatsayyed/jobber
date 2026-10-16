// tests/hygiene-templates.test.ts
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { USER_FILES } from '../src/lib/userData.js';

// Key paths up to and including `custom`; the contents of a `custom` map are the owner's own
// screening questions, and the keys under `salary` are currency codes (user-specific), so neither is compared.
const keysOf = (v: unknown, prefix = ''): string[] =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [
        prefix + k,
        ...(k === 'custom' || k === 'salary' ? [] : keysOf(x, `${prefix}${k}.`)),
      ])
    : [];

describe('user-data templates', () => {
  it('has a template and a README for the folder', () => {
    expect(existsSync('user-data.example/README.md')).toBe(true);
    for (const f of USER_FILES) expect(existsSync(`user-data.example/${f}`), f).toBe(true);
  });

  for (const f of USER_FILES) {
    it(`user-data.example/${f} is valid JSON`, () => {
      const text = readFileSync(`user-data.example/${f}`, 'utf8');
      expect(() => JSON.parse(text)).not.toThrow();
    });

    it(`user-data.example/${f} has the same keys as the real file when the real file is present`, () => {
      const real = `user-data/${f}`;
      if (!existsSync(real)) return;
      const a = keysOf(JSON.parse(readFileSync(real, 'utf8'))).sort();
      const b = keysOf(JSON.parse(readFileSync(`user-data.example/${f}`, 'utf8'))).sort();
      expect(b).toEqual(a);
    });
  }

  it('.gitignore keeps every personal path out of git', () => {
    const lines = readFileSync('.gitignore', 'utf8').split('\n').map((l) => l.trim());
    for (const rule of [
      'user-data/',
      'renderer/input/resume.json',
      'scripts/eval/fixtures/base-resume.json',
      'scripts/eval/fixtures/baseline/',
    ]) {
      expect(lines).toContain(rule);
    }
  });
});
