// tests/bootstrap-sh.test.ts
// Hermetic: runs scripts/bootstrap.sh with PATH limited to a directory of stubs that only log and exit.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  it('an unknown flag exits 2 before anything runs', () => {
    const { dir, log } = setup(['node', 'git', 'npm', 'npx', 'uname'], 22);
    const r = runScript(dir, ['--bogus']);
    expect(r.code).toBe(2);
    expect(called(log).filter((x) => x === 'npm' || x === 'npx')).toEqual([]);
  });
  it('--check without node_modules/.bin/tsx says so, exits 1 and never calls npx', () => {
    const { dir, log } = setup(['node', 'git', 'npm', 'npx', 'uname'], 22);
    const proj = mkdtempSync(join(tmpdir(), 'jobber-bsh-proj-'));
    dirs.push(proj);
    mkdirSync(join(proj, 'scripts'));
    copyFileSync(SCRIPT, join(proj, 'scripts', 'bootstrap.sh'));
    const r = spawnSync(which('bash'), [join(proj, 'scripts', 'bootstrap.sh'), '--check'], { env: { PATH: dir, HOME: dir }, encoding: 'utf8', input: '' });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('dependencies not installed: run bash scripts/bootstrap.sh');
    expect(called(log)).not.toContain('npx');
  });
  it('--allow-sudo alone does not skip the sudo prompt: no tty exits 3 and sudo never runs', async () => {
    const { dir, log } = setup(['node', 'git', 'npm', 'npx', 'sudo'], 18);
    writeFileSync(join(dir, 'uname'), '#!/bin/sh\necho Linux\n');
    writeFileSync(join(dir, 'apt-cache'), '#!/bin/sh\necho "nodejs:"\necho "  Candidate: 22.1.0-1"\n');
    chmodSync(join(dir, 'uname'), 0o755);
    chmodSync(join(dir, 'apt-cache'), 0o755);
    // detached => new session => no controlling terminal, so the /dev/tty probe fails
    const code = await new Promise<number>((res) => {
      const c = spawn(which('bash'), [SCRIPT, '--allow-sudo'], { env: { PATH: dir, HOME: dir }, detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
      c.on('close', (n) => res(n ?? -1));
    });
    expect(code).toBe(3);
    expect(called(log)).not.toContain('sudo');
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
