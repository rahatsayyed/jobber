// tests/settings-pending-restart.test.ts (plan 8H Task 13)
import { describe, expect, it } from 'vitest';
import { PENDING_COMMANDS, PENDING_MAX_BYTES, clearForScopes, commandFor, createPendingSeam, markPending, pendingFilePath, readPending } from '../src/settings/pendingRestart.js';
import { MemFs } from './helpers/memFs.js';

const ROOT = '/proj';
const mk = (files: Record<string, string> = {}) => {
  const fs = new MemFs(files);
  let n = 0;
  return { fs, d: { root: ROOT, fs, now: () => new Date(Date.UTC(2026, 9, 16, 0, 0, n++)) } };
};

describe('pending restart store', () => {
  it('marks, skips none and next_run, dedupes by key (newest scope wins)', () => {
    const { d } = mk();
    markPending(d, [{ key: 'A', scope: 'dashboard' }, { key: 'B', scope: 'none' }, { key: 'C', scope: 'next_run' }]);
    expect(readPending(d).map((e) => e.key)).toEqual(['A']);
    markPending(d, [{ key: 'A', scope: 'mcp' }, { key: 'D', scope: 'scheduler' }]);
    expect(readPending(d).map((x) => `${x.key}:${x.scope}`)).toEqual(['A:mcp', 'D:scheduler']);
  });

  it('clears by scope and writes only when something was removed', () => {
    const { fs, d } = mk();
    markPending(d, [{ key: 'A', scope: 'dashboard' }, { key: 'B', scope: 'mcp' }, { key: 'C', scope: 'stack' }]);
    fs.log.length = 0;
    expect(clearForScopes(d, ['scheduler'])).toEqual([]);
    expect(fs.log.some((l) => l.startsWith('write:'))).toBe(false);
    expect(clearForScopes(d, ['dashboard', 'stack'])).toEqual(['A', 'C']);
    expect(readPending(d).map((e) => e.key)).toEqual(['B']);
  });

  it('treats a corrupt file as empty and rewrites it on the next mark', () => {
    const p = pendingFilePath(ROOT);
    const { fs, d } = mk({ [p]: '{not json' });
    expect(readPending(d)).toEqual([]);
    expect(clearForScopes(d, ['mcp'])).toEqual([]);
    markPending(d, [{ key: 'A', scope: 'mcp' }]);
    expect(JSON.parse(fs.text(p) ?? '').entries).toHaveLength(1);
  });

  it('ignores malformed entries and bad keys', () => {
    const p = pendingFilePath(ROOT);
    const bad = { entries: [{ key: 'ok', scope: 'mcp', at: 'x' }, { key: 'bad key!', scope: 'mcp', at: 'x' }, { key: 'k', scope: 'zzz', at: 'x' }] };
    const { d } = mk({ [p]: JSON.stringify(bad) });
    expect(readPending(d).map((e) => e.key)).toEqual(['ok']);
    markPending(d, [{ key: 'has space', scope: 'mcp' }]);
    expect(readPending(d).map((e) => e.key)).toEqual(['ok']);
  });

  it('caps the file size, dropping the oldest', () => {
    const { fs, d } = mk();
    for (let i = 0; i < 6; i++) {
      markPending(d, Array.from({ length: 100 }, (_, j) => ({ key: `KEY_${'X'.repeat(60)}_${i}_${j}`, scope: 'mcp' as const })));
    }
    const t = fs.text(pendingFilePath(ROOT)) ?? '';
    expect(t.length).toBeLessThanOrEqual(PENDING_MAX_BYTES + 2);
    const keys = readPending(d).map((e) => e.key);
    expect(keys.length).toBeLessThanOrEqual(400);
    expect(keys[keys.length - 1]).toContain('_5_99');
  });

  it('stores key names, scopes and times only, mode 0600, no temp file left', () => {
    const { fs, d } = mk();
    markPending(d, [{ key: 'SOME_SECRET_KEY', scope: 'mcp' }]);
    const p = pendingFilePath(ROOT);
    expect(fs.modeOf(p)).toBe(0o600);
    const j = JSON.parse(fs.text(p) ?? '');
    expect(Object.keys(j)).toEqual(['entries']);
    expect(Object.keys(j.entries[0]).sort()).toEqual(['at', 'key', 'scope']);
    expect(fs.paths().filter((x) => x.includes('.tmp-'))).toEqual([]);
  });

  it('has the exact command table and the route seam adds commands', () => {
    expect(commandFor('scheduler')).toBe('`npm run down && npm run up`');
    expect(commandFor('stack')).toContain('fully restart Claude Code sessions');
    expect(Object.keys(PENDING_COMMANDS).sort()).toEqual(['dashboard', 'mcp', 'next_run', 'none', 'scheduler', 'stack']);
    const { d } = mk();
    const seam = createPendingSeam(d);
    seam.mark([{ key: 'A', scope: 'mcp' }]);
    expect(seam.list()).toEqual([{ key: 'A', scope: 'mcp', command: commandFor('mcp') }]);
  });
});
