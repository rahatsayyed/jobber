// tests/hygiene-hook.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  readFileSync, statSync, mkdirSync, writeFileSync, copyFileSync, rmSync, chmodSync, realpathSync, readdirSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

describe('pre-commit hook', () => {
  const hook = readFileSync('.githooks/pre-commit', 'utf8');

  it('fails closed on any error', () => {
    expect(hook).toMatch(/set -euo pipefail/);
  });

  it('refuses staged secret, database, local-settings and user-data files by name', () => {
    expect(hook).toMatch(/\\\.env/);
    expect(hook).toMatch(/secrets\//);
    expect(hook).toMatch(/\.sqlite/);
    expect(hook).toMatch(/user-data\//);
    expect(hook).toMatch(/settings\\\.local\\\.json/);
  });

  it('allows the committed templates and .env.example', () => {
    expect(hook).toMatch(/user-data\.example/);
    expect(hook).toMatch(/\.env\\\.example/);
  });

  it('is executable', () => {
    expect(statSync('.githooks/pre-commit').mode & 0o111).not.toBe(0);
  });
});

describe('pre-commit hook behavior', () => {
  const MARKER = 'DISTINCTIVE_MARKER_8f3a1c';
  const hookSrc = resolve('.githooks/pre-commit');
  const base = resolve(
    '.superpowers/sdd/2026-10-14-0-repo-hygiene-and-history-reset',
    `tmp-hook-repo-${randomBytes(4).toString('hex')}`,
  );
  const shim = join(base, '..', `tmp-hook-shim-${randomBytes(4).toString('hex')}`);

  const cleanEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith('GIT_')) env[k] = v;
    }
    return env;
  };

  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: base, encoding: 'utf8', env: cleanEnv() });

  const put = (rel: string, content = MARKER) => {
    const p = join(base, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };

  const run = (env: Record<string, string> = {}) =>
    spawnSync('bash', ['.githooks/pre-commit'], {
      cwd: base,
      encoding: 'utf8',
      env: { ...cleanEnv(), ...env },
    });

  const reset = () => {
    // Never touch an index unless we are provably inside the throwaway repo.
    const top = git('rev-parse', '--show-toplevel');
    if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(base)) {
      throw new Error('throwaway repo guard failed');
    }
    git('rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '.');
    for (const e of readdirSync(base)) {
      if (e !== '.git' && e !== '.githooks') rmSync(join(base, e), { recursive: true, force: true });
    }
  };

  const stage = (f: string, content = MARKER) => {
    reset();
    put(f, content);
    const r = git('add', '-f', '--', f);
    expect(r.status, `git add ${f}`).toBe(0);
  };

  beforeAll(() => {
    mkdirSync(join(base, '.githooks'), { recursive: true });
    copyFileSync(hookSrc, join(base, '.githooks/pre-commit'));
    chmodSync(join(base, '.githooks/pre-commit'), 0o755);
    const init = git('init', '--quiet');
    if (init.status !== 0) throw new Error('git init failed');
    const top = git('rev-parse', '--show-toplevel');
    if (realpathSync(top.stdout.trim()) !== realpathSync(base)) throw new Error('toplevel mismatch');
    git('config', 'user.email', 'hook-test');
    git('config', 'user.name', 'test');
    // A PATH shim whose git always fails, to prove the hook fails closed when git diff fails.
    mkdirSync(shim, { recursive: true });
    writeFileSync(join(shim, 'git'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(shim, 'git'), 0o755);
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
    rmSync(shim, { recursive: true, force: true });
  });

  it('refuses a staged .env', () => {
    stage('.env');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('.env');
  });

  it('refuses a force-added user-data file', () => {
    stage('user-data/resume.json');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('user-data/resume.json');
  });

  it('refuses secrets, sqlite, local settings, .ccgram and env lookalikes', () => {
    for (const f of [
      'secrets/token.txt', 'data.sqlite', 'data.sqlite-wal', 'data.sqlite-journal',
      '.claude/settings.local.json', '.ccgram/x.json', '.env.local', '.envrc', '.env/x',
    ]) {
      stage(f);
      expect(run().status, f).toBe(1);
    }
  });

  it('refuses blocked names at any depth', () => {
    for (const f of [
      'a/b/secrets/x', 'pkg/user-data/x.json', 'deep/dir/.env', 'x/.ccgram/y', 'sub/data.sqlite',
    ]) {
      stage(f);
      expect(run().status, f).toBe(1);
    }
  });

  it('refuses non-ASCII and spaced names that git would otherwise quote', () => {
    for (const f of [
      'user-data/é.json', 'secrets/ü', 'x é.sqlite', 'é/.env', 'user-data/a b.json',
    ]) {
      stage(f);
      expect(run().status, f).toBe(1);
    }
  });

  it('refuses names containing a newline or carriage return, and passes a normal file', () => {
    for (const f of ['x\nuser-data/y', 'a\nsecrets/k', 'x\n.env', 'ok\rname.txt']) {
      stage(f);
      expect(run().status, JSON.stringify(f)).toBe(1);
    }
    stage('normal.txt');
    expect(run().status).toBe(0);
  });

  it('matches case-insensitively', () => {
    for (const f of ['.ENV', 'Secrets/a', 'a.SQLITE', 'User-Data/x', 'Settings.Local.JSON']) {
      stage(f);
      expect(run().status, f).toBe(1);
    }
  });

  it('allows .env.example and user-data.example', () => {
    reset();
    put('.env.example');
    put('user-data.example/resume.json');
    put('User-Data.Example/x.json');
    put('user-data.examples/x');
    put('sub/.env.example');
    const r = git('add', '-f', '.env.example', 'user-data.example/resume.json', 'User-Data.Example/x.json', 'user-data.examples/x', 'sub/.env.example');
    expect(r.status).toBe(0);
    expect(run().status).toBe(0);
  });

  it('refuses .env.example inside a blocked directory', () => {
    for (const f of ['secrets/.env.example', 'user-data/.env.example', 'a.sqlite/.env.example', '.ccgram/.env.example']) {
      stage(f);
      expect(run().status, f).toBe(1);
    }
  });

  it('never prints file content in the refusal output', () => {
    stage('.env', MARKER);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).not.toContain(MARKER);
  });

  it('fails closed when git diff fails', () => {
    stage('normal.txt');
    const r = spawnSync('/bin/bash', ['.githooks/pre-commit'], {
      cwd: base,
      encoding: 'utf8',
      env: { ...cleanEnv(), PATH: shim },
    });
    expect(r.status).toBe(1);
  });
});
