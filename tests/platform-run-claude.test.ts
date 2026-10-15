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
  it('(a) argv is restricted, never has the prompt; stdin is the prompt exactly', { timeout: T }, () => {
    const r = run(['hunt', '--no-classifier', 'the prompt'], DRY);
    expect(r.status, r.stderr).toBe(0);
    const argv = read('argv').split('\n').filter(Boolean);
    expect(argv).toContain('dontAsk');
    expect(argv).toContain('--strict-mcp-config');
    expect(argv.join(' ')).not.toContain('the prompt');
    expect(read('stdin')).toBe('the prompt');
  });

  it('(b) propagates the child exit code', { timeout: T }, () => {
    writeFileSync(join(dir, 'exit'), '7');
    const r = run(['hunt', '--no-classifier', 'the prompt'], DRY);
    expect(r.status, r.stderr).toBe(7);
  });

  it('(c) empty prompt exits 2 without invoking claude', { timeout: T }, () => {
    const r = run(['hunt', '   ']);
    expect(r.status).toBe(2);
    expect(invoked()).toBe(false);
  });

  it('(c2) kill switch active: hunt exits 4 and claude is not invoked', { timeout: T }, () => {
    const r = run(['hunt', '--no-classifier', 'the prompt'], { ...DRY, JOBBER_KILL: '1' });
    expect(r.status, r.stderr).toBe(4);
    expect(r.stderr).toContain('kill switch active');
    expect(invoked()).toBe(false);
  });

  it('(d) --no-classifier without JOBBER_DRY_RUN=1 exits 2', { timeout: T }, () => {
    const r = run(['outreach_wake', '--no-classifier', 'hello']);
    expect(r.status).toBe(2);
    expect(invoked()).toBe(false);
  });

  it('(e) outreach_wake with an unknown classifier profile exits 3, claude not invoked', { timeout: T }, () => {
    const r = run(['outreach_wake', 'hello'], { CLASSIFIER_MODEL: 'no-such-profile' });
    expect(r.status, r.stderr).toBe(3);
    expect(invoked()).toBe(false);
  });

  it('(f) rendered files are private and contain both hooks and no set reference', { timeout: T }, () => {
    const r = run(['hunt', '--no-classifier', 'the prompt'], DRY);
    expect(r.status, r.stderr).toBe(0);
    const out = join(root, 'debug', 'runner');
    expect(statSync(out).mode & 0o777).toBe(0o700);
    for (const f of ['hunt.settings.json', 'hunt.policy.json']) {
      expect(statSync(join(out, f)).mode & 0o777, f).toBe(0o600);
    }
    const policy = readFileSync(join(out, 'hunt.policy.json'), 'utf8');
    expect(policy).not.toContain('allow_from_permission_set');
    const settings = readFileSync(join(out, 'hunt.settings.json'), 'utf8');
    expect(settings).toContain('tool-allowlist.cjs');
    expect(settings).toContain('block-outside-project.cjs');
  });

  it('(g) child env for outreach_wake is scrubbed and has JOBBER_RUN_PROFILE', { timeout: T }, () => {
    const r = run(['outreach_wake', '--no-classifier', 'hello'], {
      JOBBER_DRY_RUN: '1',
      GMAIL_APP_PASSWORD: 'synthetic-secret-value-123',
    });
    expect(r.status, r.stderr).toBe(0);
    const keys = read('envkeys').split('\n');
    expect(keys).not.toContain('GMAIL_APP_PASSWORD');
    expect(keys).toContain('JOBBER_RUN_PROFILE');
  });

  it('--interactive on a non-interactive profile exits 2, claude not invoked', { timeout: T }, () => {
    const r = run(['hunt', '--interactive', '--no-classifier', 'p'], DRY);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain('--interactive');
    expect(invoked()).toBe(false);
  });

  it('kill switch exits 4 before the --interactive check', { timeout: T }, () => {
    const r = run(['hunt', '--interactive', '--no-classifier', 'p'], { ...DRY, JOBBER_KILL: '1' });
    expect(r.status, r.stderr).toBe(4);
    expect(invoked()).toBe(false);
  });

  it('hunt --print-args prints the golden argv and env key names only', { timeout: T }, () => {
    const r = run(['hunt', '--print-args'], { GMAIL_APP_PASSWORD: 'synthetic-secret-value-123' });
    expect(r.status, r.stderr).toBe(0);
    const golden = JSON.parse(readFileSync(join(root, 'tests/fixtures/runner-golden.json'), 'utf8')) as any;
    const printed = JSON.parse(r.stdout.split('\n')[0]) as string[];
    expect(printed).toEqual(['claude', ...golden.hunt.args.map((a: string) => (a.startsWith('debug/runner/') ? join(root, a) : a))]);
    expect(r.stdout).toContain('env keys: ');
    expect(r.stdout).not.toContain('synthetic-secret-value-123');
  });

  it('flags after "--" are prompt text', { timeout: T }, () => {
    const r = run(['hunt', '--no-classifier', '--', '--print-args'], DRY);
    expect(r.status, r.stderr).toBe(0);
    expect(read('stdin')).toBe('--print-args');
  });
});
