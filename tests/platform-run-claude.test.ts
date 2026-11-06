// tests/platform-run-claude.test.ts
// Spawn-path tests for scripts/run-claude.ts using a FAKE `claude` on PATH (never the real binary).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '..');
const T = 60000;
let dir: string;

const FAKE = `#!/bin/sh
d=$(dirname "$0")
echo run >> "$d/invoked"
printf '%s\\n' "$@" > "$d/argv"
cat > "$d/stdin"
env | cut -d= -f1 | sort > "$d/envkeys"
code=0
[ -f "$d/exit" ] && code=$(cat "$d/exit")
exit "$code"
`;

beforeEach(() => {
  mkdirSync(join(root, 'debug'), { recursive: true });
  dir = mkdtempSync(join(root, 'debug', 'fake-claude-'));
  writeFileSync(join(dir, 'claude'), FAKE);
  chmodSync(join(dir, 'claude'), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[], extra: Record<string, string> = {}, dropDryRun = true) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    ...extra,
  };
  if (dropDryRun && !('JOBBER_DRY_RUN' in extra)) delete env.JOBBER_DRY_RUN;
  return spawnSync('npx', ['tsx', 'scripts/run-claude.ts', ...args], { cwd: root, encoding: 'utf8', env: env as NodeJS.ProcessEnv });
}
const read = (f: string): string => readFileSync(join(dir, f), 'utf8');
const invoked = (): boolean => existsSync(join(dir, 'invoked'));
const DRY = { JOBBER_DRY_RUN: '1' };

describe('run-claude spawn path (fake claude)', () => {
  it('the retired headless profiles are unknown: they exit 2 and claude is not invoked', { timeout: T }, () => {
    for (const p of ['outreach_wake', 'mail_drip', 'mail_reply_check', 'linkedin_drip']) {
      const r = run([p, '--print-args']);
      expect(r.status, p).toBe(2);
      expect(r.stderr).toMatch(/unknown profile/);
    }
    expect(invoked()).toBe(false);
  });

  it('a profile that is not interactive is refused: there is no headless runner', { timeout: T }, () => {
    const r = run(['setup_guide', 'hello']);
    expect(r.status).toBe(2);
    expect(invoked()).toBe(false);
  });

  it('setup_guide --interactive --print-args prints an interactive argv: no -p, no --output-format, no bypass flag', { timeout: T }, () => {
    const r = run(['setup_guide', '--interactive', '--print-args']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/(^|\s)(-p|--print|--output-format)(\s|$)/);
    expect(r.stdout).not.toMatch(/bypass|skip-permissions|dangerously/i);
    expect(invoked()).toBe(false);
  });
});
