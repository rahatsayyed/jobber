import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'scripts/check-portal.ts', ...args], { cwd: root, encoding: 'utf8', timeout: 60_000 });

describe('scripts/check-portal.ts (offline smoke)', () => {
  it('no args prints usage and exits 2', () => {
    const r = run();
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage: npx tsx scripts\/check-portal\.ts/);
  });
  it('an unknown ATS exits 2', () => {
    const r = run('taleo', 'acme');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage/);
  });
  it('an invalid slug exits 2 before any network call', () => {
    const r = run('greenhouse', '..');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/invalid slug/);
  });
}, 90_000);
