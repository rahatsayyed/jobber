import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(ROOT, '.claude', 'hooks', 'block-outside-project.cjs');

function run(hook: string, event: unknown): { denied: boolean; reason: string } {
  const r = spawnSync('node', [hook], { input: JSON.stringify(event), encoding: 'utf8' });
  expect(r.status).toBe(0);
  if (!r.stdout.trim()) return { denied: false, reason: '' };
  const out = JSON.parse(r.stdout);
  const d = out.hookSpecificOutput;
  return { denied: d.permissionDecision === 'deny', reason: d.permissionDecisionReason };
}

const read = (file_path: string) => ({ tool_name: 'Read', tool_input: { file_path } });
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });

describe('block-outside-project hook', () => {
  it('allows a Read inside the project', () => {
    expect(run(HOOK, read(join(ROOT, 'package.json'))).denied).toBe(false);
  });

  it('denies a Read of /etc/hosts', () => {
    expect(run(HOOK, read('/etc/hosts')).denied).toBe(true);
  });

  it('allows a Read under ~/.claude', () => {
    expect(run(HOOK, read(join(homedir(), '.claude', 'CLAUDE.md'))).denied).toBe(false);
  });

  it('denies a Bash command referencing a path outside the project', () => {
    expect(run(HOOK, bash('ls /usr')).denied).toBe(true);
  });

  it('allows a Bash command with only project-relative paths', () => {
    expect(run(HOOK, bash('ls src tests ./config')).denied).toBe(false);
  });

  describe('portability', () => {
    const base = join(ROOT, '.superpowers', 'sdd', '2026-10-14-0-repo-hygiene-and-history-reset');
    mkdirSync(base, { recursive: true });
    const T = mkdtempSync(join(base, 'tmp-hook-test-'));
    afterAll(() => rmSync(T, { recursive: true, force: true }));

    it('derives the root from the hook location, not a hardcoded path', () => {
      mkdirSync(join(T, '.claude', 'hooks'), { recursive: true });
      const copy = join(T, '.claude', 'hooks', 'block-outside-project.cjs');
      copyFileSync(HOOK, copy);
      writeFileSync(join(T, 'inside.txt'), 'x');
      expect(run(copy, read(join(T, 'inside.txt'))).denied).toBe(false);
      expect(run(copy, read(join(ROOT, 'package.json'))).denied).toBe(true);
    });
  });
});
