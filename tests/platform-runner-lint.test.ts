// tests/platform-runner-lint.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = ['run-hunt.sh', 'scripts/run-claude.sh', 'scripts/run-claude.ts', 'src/platform/runner.ts'];

describe('runner never bypasses permissions', () => {
  it('has no bypass flag or mode in any launcher source (guards in runner.ts are allowed to name them)', () => {
    for (const f of ['run-hunt.sh', 'scripts/run-claude.sh', 'scripts/run-claude.ts']) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/bypassPermissions|dangerously-skip-permissions|allow-dangerously/i);
    }
  });

  it('run-hunt.sh does not source the whole env file', () => {
    expect(readFileSync('run-hunt.sh', 'utf8')).not.toMatch(/^\s*(source|\.)\s+\.env/m);
  });

  it('every launcher file exists', () => {
    for (const f of files) expect(() => readFileSync(f, 'utf8'), f).not.toThrow();
  });

  it('rejects an unknown profile with exit 2', { timeout: 60000 }, () => {
    const r = spawnSync('npx', ['tsx', 'scripts/run-claude.ts', 'nope', '--print-args'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});
