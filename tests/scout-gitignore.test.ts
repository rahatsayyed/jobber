import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

// scout_capture_fixture writes under generated/, which must never be committed.
describe('generated/ is git-ignored', () => {
  it('git check-ignore accepts generated/x and generated/fixtures/lever/a.html', () => {
    for (const p of ['generated/x', 'generated/fixtures/lever/a.html', 'generated/providers/acme.json']) {
      expect(execFileSync('git', ['check-ignore', p], { cwd: process.cwd(), encoding: 'utf8' }).trim()).toBe(p);
    }
  });
  it('the source directory src/sources/generated is NOT ignored (only the root generated directory is)', () => {
    expect(() => execFileSync('git', ['check-ignore', 'src/sources/generated/spec.ts'], { cwd: process.cwd(), encoding: 'utf8' })).toThrow();
  });
});
