import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';

vi.mock('../src/sources/boards/index.js', () => ({ fetchBoards: vi.fn().mockRejectedValue(new Error('boards exploded app_key=SECRET')) }));

describe('runScriptSources when fetchBoards itself throws', () => {
  it('is a failed provider: fallback_used, redacted error, one source_tasks row per day', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runScriptSources } = await import('../src/sources/runner.js');
    const reg = path.join(mkdtempSync(path.join(tmpdir(), 'runner-throw-')), 'platforms.json');
    writeFileSync(reg, JSON.stringify({ platforms: [] }));
    const db = openDb(':memory:');
    const opts = { role: 'r', registryPath: reg, now: () => new Date('2026-10-16T10:00:00Z') };
    const r = await runScriptSources(db, opts);
    const row = r.rows.find((x) => x.source === 'boards')!;
    expect(row.fallback_used).toBe(true);
    expect(row.error).toContain('boards exploded');
    expect(row.error).not.toContain('SECRET');
    await runScriptSources(db, opts);
    expect(db.prepare('SELECT platform, company, reason FROM source_tasks').all()).toEqual([{ platform: 'boards', company: null, reason: 'error' }]);
  });
});
