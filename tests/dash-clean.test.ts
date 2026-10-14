// tests/dash-clean.test.ts
import { describe, it, expect } from 'vitest';
import { cleanText, cleanRow } from '../src/dash/clean.js';

describe('cleanText', () => {
  it('strips bidi overrides, zero-width and control chars, keeps newline and tab', () => {
    const s = 'a‮b​c\u0007d\ne\tf\u0085g';
    expect(cleanText(s, 100)).toBe('abcd\ne\tfg');
  });
  it('collapses 3+ newlines', () => {
    expect(cleanText('a\n\n\n\n\nb', 100)).toBe('a\n\nb');
  });
  it('redacts secret shapes and web-token lines', () => {
    const out = cleanText('key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\nWEB_CLIENT_SECRET=abc\nok', 500);
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(out).not.toContain('WEB_CLIENT_SECRET');
    expect(out).toContain('ok');
  });
  it('truncates with ellipsis', () => {
    const out = cleanText('x'.repeat(50), 10);
    expect(out.length).toBe(10);
    expect(out.endsWith('...')).toBe(true);
  });
  it('returns empty string for null and non-strings', () => {
    expect(cleanText(null, 10)).toBe('');
    expect(cleanText(5, 10)).toBe('');
    expect(cleanText({}, 10)).toBe('');
  });
});

describe('cleanRow', () => {
  it('applies per-field limits and leaves non-strings', () => {
    const r = cleanRow({ a: 'x'.repeat(30), b: 'y'.repeat(30), n: 7, z: null }, { a: 10 }, 20);
    expect((r.a as string).length).toBe(10);
    expect((r.b as string).length).toBe(20);
    expect(r.n).toBe(7);
    expect(r.z).toBeNull();
  });
});
