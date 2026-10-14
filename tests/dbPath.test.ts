import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { dbPath } from '../src/dbPath.js';

const root = path.resolve(__dirname, '..');
const stat = (f: string) => (existsSync(f) ? (({ size, mtimeMs }) => `${size}:${mtimeMs}`)(statSync(f)) : 'absent');

describe('dbPath (final review I4)', () => {
  const saved = process.env.JOBAPPLIER_DB;
  afterEach(() => { if (saved === undefined) delete process.env.JOBAPPLIER_DB; else process.env.JOBAPPLIER_DB = saved; });

  it('under vitest it is NOT the real data.sqlite', () => {
    expect(dbPath()).not.toBe('data.sqlite');
    expect(dbPath()).toBe(process.env.JOBAPPLIER_DB);
  });
  it('honours JOBAPPLIER_DB and defaults to data.sqlite when unset or empty', () => {
    process.env.JOBAPPLIER_DB = 'x.sqlite';
    expect(dbPath()).toBe('x.sqlite');
    process.env.JOBAPPLIER_DB = '';
    expect(dbPath()).toBe('data.sqlite');
    delete process.env.JOBAPPLIER_DB;
    expect(dbPath()).toBe('data.sqlite');
  });
  it('importing the db-opening modules does not touch the real data.sqlite', async () => {
    const real = path.join(root, 'data.sqlite');
    const before = stat(real);
    await import('../src/apply/linkedin.js');
    await import('../src/apply/external.js');
    expect(stat(real)).toBe(before);
  });
  it('no source module hardcodes the data.sqlite default except dbPath itself', () => {
    const files = ['src/mcp/db.ts', 'src/mcp/gates.ts', 'src/mcp/job-fetch.ts', 'src/mcp/contacts.ts', 'src/mcp/connect.ts',
      'src/apply/external.ts', 'src/apply/linkedin.ts', 'src/discover/linkedin-jobs.ts', 'src/discover/linkedin-posts.ts'];
    for (const f of files) {
      const src = readFileSync(path.join(root, f), 'utf8');
      expect(src, f).not.toMatch(/openDb\('data\.sqlite'\)/);
      expect(src, f).toMatch(/dbPath\(\)/);
    }
  });
});
