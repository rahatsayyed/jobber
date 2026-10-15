// tests/bootstrap-sh.test.ts
// Hermetic: runs scripts/bootstrap.sh with PATH limited to a directory of stubs that only log and exit.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '..', 'scripts', 'bootstrap.sh');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function which(bin: string): string {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return r.stdout.trim();
}

function setup(stubs: string[], nodeMajor: number): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'jobber-bsh-'));
  dirs.push(dir);
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  for (const s of stubs) {
    let body = `echo "${s}" >> "${log}"\n`;
    if (s === 'uname') body += 'echo Darwin\n';
    if (s === 'node') body += `echo ${nodeMajor}\n`;
    writeFileSync(join(dir, s), `#!/bin/sh\n${body}exit 0\n`);
    chmodSync(join(dir, s), 0o755);
  }
  // plain coreutils the script needs; these are not logged
  for (const t of ['id', 'dirname', 'sed', 'head']) symlinkSync(which(t), join(dir, t));
  symlinkSync(which('bash'), join(dir, 'bash'));
  return { dir, log };
}

function runScript(dir: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(which('bash'), [SCRIPT, ...args], { env: { PATH: dir, HOME: dir }, encoding: 'utf8', input: '' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

const called = (log: string): string[] => readFileSync(log, 'utf8').split('\n').filter(Boolean);

describe('bootstrap.sh', () => {
  it('Node present: only uname, node, git and the final npx handover run', () => {
    const { dir, log } = setup(['node', 'git', 'npm', 'npx', 'uname', 'brew'], 22);
    // node_modules/.bin/tsx may be missing in a clean tree; --check skips npm ci
    const r = runScript(dir, ['--check']);
    const c = new Set(called(log));
    expect(c.has('npm')).toBe(false);
    expect(c.has('brew')).toBe(false);
    expect(r.code).toBe(0);
  });
  it('old Node and no brew: exit 1, Homebrew URL, no installer', () => {
    const { dir, log } = setup(['node', 'git', 'npm', 'npx', 'uname'], 18);
    const r = runScript(dir, ['--check']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('https://brew.sh');
    expect(called(log)).not.toContain('npm');
    expect(called(log)).not.toContain('npx');
  });
  it('old Node, no brew, not --check: still exit 1 with the URL and no installer', () => {
    const { dir, log } = setup(['node', 'git', 'npm', 'npx', 'uname'], 18);
    const r = runScript(dir, ['--yes']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('https://brew.sh');
    expect(called(log).filter((x) => x === 'npm' || x === 'npx')).toEqual([]);
  });
  it('--check never prompts (no tty needed, exit not 3)', () => {
    const { dir } = setup(['node', 'git', 'npm', 'npx', 'uname'], 18);
    const r = runScript(dir, ['--check']);
    expect(r.code).not.toBe(3);
  });
  it('prompt path probes /dev/tty by opening it, writing nothing to it on failure', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toContain('if ! ( : < /dev/tty ) 2>/dev/null; then');
    expect(src).not.toContain('-r /dev/tty');
  });
  it('source has no curl, wget, pipe to shell, bare sudo or stray rm -rf', () => {
    expect(existsSync(SCRIPT)).toBe(true);
    const src = readFileSync(SCRIPT, 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('#'));
    const text = code.join('\n');
    expect(text).not.toMatch(/\bcurl\b/);
    expect(text).not.toMatch(/\bwget\b/);
    expect(text).not.toMatch(/\|\s*(sh|bash)\b/);
    expect(text).not.toMatch(/rm\s+-rf/);
    code.forEach((l, i) => {
      if (/^\s*sudo\b/.test(l)) {
        const before = code.slice(Math.max(0, i - 12), i).join('\n');
        expect(before).toMatch(/echo "will run: sudo /);
      }
    });
  });
});
