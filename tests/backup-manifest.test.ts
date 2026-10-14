import { describe, it, expect } from 'vitest';
import { buildManifest, parseManifest, verifyFiles } from '../src/backup/manifest.js';

const H = 'a'.repeat(64);
const base = () =>
  buildManifest({
    created_at: '2026-10-15T00:00:00.000Z',
    commit: null,
    includes_secrets: false,
    files: [{ path: 'user-data/resume.json', sha256: H, bytes: 10 }],
    db: { path: 'data.sqlite', tables: { jobs: 3 } },
  });

describe('manifest', () => {
  it('round trips', () => {
    const m = base();
    expect(parseManifest(JSON.stringify(m))).toEqual(m);
  });
  it('ignores unknown top-level keys', () => {
    const m = { ...base(), extra: 1 };
    expect(parseManifest(JSON.stringify(m)).version).toBe(1);
  });
  it('rejects wrong version and malformed JSON', () => {
    expect(() => parseManifest(JSON.stringify({ ...base(), version: 2 }))).toThrow();
    expect(() => parseManifest('{')).toThrow();
  });
  it('rejects unsafe paths and bad fields', () => {
    const withFile = (f: object) => JSON.stringify({ ...base(), files: [f] });
    for (const p of ['../x', '/etc/x', 'a/../b', 'a\\b', 'a\0b']) {
      expect(() => parseManifest(withFile({ path: p, sha256: H, bytes: 1 }))).toThrow();
    }
    expect(() => parseManifest(withFile({ path: 'a', sha256: 'A'.repeat(64), bytes: 1 }))).toThrow();
    expect(() => parseManifest(withFile({ path: 'a', sha256: H, bytes: -1 }))).toThrow();
    expect(() => parseManifest(withFile({ path: 'a', sha256: H, bytes: 1.5 }))).toThrow();
    expect(() => parseManifest(JSON.stringify({ ...base(), created_at: 'nope' }))).toThrow();
  });
  it('verifyFiles reports missing, mismatched and extra', () => {
    const m = buildManifest({
      ...base(),
      files: [
        { path: 'a', sha256: H, bytes: 1 },
        { path: 'b', sha256: H, bytes: 1 },
        { path: 'c', sha256: H, bytes: 1 },
      ],
    });
    const hashes: Record<string, string> = { a: H, b: 'b'.repeat(64) };
    const r = verifyFiles(m, (p) => hashes[p] ?? null, ['a', 'b', 'z']);
    expect(r).toEqual({ ok: false, missing: ['c'], mismatched: ['b'], extra: ['z'] });
    const ok = verifyFiles(m, () => H, ['a', 'b', 'c']);
    expect(ok.ok).toBe(true);
  });
});
