import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'scripts/check-portal.ts', ...args], { cwd: root, encoding: 'utf8', timeout: 60_000 });

// Offline only: every case below must exit 2 BEFORE any network call.
describe('scripts/check-portal.ts vendors (offline validation)', () => {
  it('usage lists every vendor and aggregator', () => {
    const r = run();
    expect(r.status).toBe(2);
    for (const v of ['workable', 'recruitee', 'personio', 'smartrecruiters', 'workday', 'hackernews', 'himalayas', 'weworkremotely']) expect(r.stderr).toContain(v);
  });
  it('a company vendor needs a slug', () => { expect(run('workable').status).toBe(2); });
  it.each([
    [['recruitee', 'Acme'], /invalid slug/],
    [['personio', 'a.b'], /invalid slug/],
    [['workable', 'a.b'], /invalid slug/],
    [['workday', 'acme'], /workday needs wd/],
    [['workday', 'acme', '--wd', 'wd5'], /workday needs site/],
    [['workday', 'acme', '--wd', 'wd5.evil.io', '--site', 'x'], /workday needs wd/],
    [['workday', 'acme', '--wd', 'wd5', '--site', '../x'], /workday needs site/],
    [['personio', 'acme', '--domain', 'fr'], /domain must be/],
    [['smartrecruiters', 'acme', '--max-detail', '0'], /max_detail/],
    [['greenhouse', '..'], /invalid slug/],
  ])('%j exits 2 with a clear message', (args, msg) => {
    const r = run(...(args as string[]));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(msg as RegExp);
  });
}, 120_000);
