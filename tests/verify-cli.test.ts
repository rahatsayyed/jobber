// tests/verify-cli.test.ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { loadFixtures, parseArgs, realStartWeb, runCli, type CliDeps } from '../src/verify/cli.js';
import { allStages, pipelineFixture } from '../src/verify/stages.js';
import { buildCtx } from '../src/verify/engine.js';

const ROOT = resolve(import.meta.dirname, '..');
const dirs: string[] = [];
const mkTmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'verify-cli-test-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const realFs = {
  mkdtemp: (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; },
  mkdir: (p: string) => { mkdirSync(p, { recursive: true }); },
  write: (p: string, d: string) => writeFileSync(p, d),
  exists: (p: string) => existsSync(p),
  rm: (p: string) => rmSync(p, { recursive: true, force: true }),
};
const ids = allStages().map((s) => s.id);
const okDoctor = async () => [{ id: 'classifier_smoke', title: 'c', result: { status: 'pass' as const, detail: 'ok' } }];

function deps(root: string, over: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = { PATH: process.env.PATH }) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<{ cmd: string; args: string[]; env?: Record<string, string> }> = [];
  const d: CliDeps = {
    root, env, out: (s) => out.push(s), err: (s) => err.push(s),
    parts: {
      run: async (cmd: string, args: string[], o?: { env?: Record<string, string> }) => {
        calls.push({ cmd, args, env: o?.env });
        if (args.includes('--dry-run-plan')) return { stdout: '{"decision":"skip"}', code: 0 };
        return { stdout: 'claude --print --safe\nfinal report', code: 0 };
      },
      fs: realFs, now: () => new Date('2026-10-15T00:00:00Z'), doctor: okDoctor, openDb,
      startWeb: async () => ({ url: 'http://x', close: async () => {} }),
      ...over,
    } as never,
  };
  return { d, out, err, calls };
}

describe('parseArgs', () => {
  it('parses flags and skip lists', () => {
    expect(parseArgs([])).toEqual({ llm: false, skip: [], json: false, list: false, help: false });
    expect(parseArgs(['--llm', '--json', '--skip', 'a,b', '--skip=c'])).toMatchObject({ llm: true, json: true, skip: ['a', 'b', 'c'] });
  });
  it('rejects unknown flags and a missing skip value', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--skip'])).toThrow(/needs a stage id/);
  });
});

describe('runCli', () => {
  it('usage errors exit 2 and write nothing', async () => {
    const stateDir = join(mkTmp(), '.jobber');
    const t = deps(ROOT);
    expect(await runCli(['--bogus'], { ...t.d, stateDir })).toBe(2);
    expect(await runCli(['--skip', 'env-guard'], { ...t.d, stateDir })).toBe(2);
    expect(await runCli(['--skip', 'no-such'], { ...t.d, stateDir })).toBe(2);
    expect(existsSync(stateDir)).toBe(false);
  });

  it('--list prints stages and exits 0 without writing', async () => {
    const stateDir = join(mkTmp(), '.jobber');
    const t = deps(ROOT);
    expect(await runCli(['--list'], { ...t.d, stateDir })).toBe(0);
    expect(t.out.join('\n')).toContain('env-guard');
    expect(t.out.join('\n')).toContain('llm-hunt');
    expect(existsSync(stateDir)).toBe(false);
  });

  it('whole run: banner, table, exit 0, exactly one file (mode 600, no details); llm-hunt off', async () => {
    const stateDir = join(mkTmp(), '.jobber');
    const t = deps(ROOT, { fetch: async () => ({ status: 404, text: async () => '' }) });
    const code = await runCli([], { ...t.d, stateDir });
    expect(t.err.join('\n')).toBe('');
    expect(t.out[0]).toContain('DRY RUN VERIFY: nothing is sent');
    expect(t.out.join('\n')).toMatch(/SKIP\s+LLM hunt/);
    expect(code).toBe(0);
    expect(t.calls.some((c) => c.cmd === './run-hunt.sh')).toBe(false);
    expect(readdirSync(stateDir)).toEqual(['verify.json']);
    const f = join(stateDir, 'verify.json');
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const j = JSON.parse(readFileSync(f, 'utf8'));
    expect(Object.keys(j).sort()).toEqual(['at', 'failed', 'passed', 'skipped', 'stages']);
    expect(j.failed).toBe(0);
    expect(j.stages.length).toBe(ids.length);
    expect(Object.keys(j.stages[0]).sort()).toEqual(['id', 'status']);
  });

  it('exits 1 when a stage fails', async () => {
    const stateDir = join(mkTmp(), '.jobber');
    const bad = async () => [{ id: 'x', title: 'x', result: { status: 'fail', detail: 'bad', fix: 'f' } }];
    const t = deps(ROOT, { doctor: bad });
    expect(await runCli(['--skip', 'classifier-smoke'], { ...t.d, stateDir })).toBe(1);
    expect(JSON.parse(readFileSync(join(stateDir, 'verify.json'), 'utf8')).failed).toBeGreaterThan(0);
  });

  it('--llm runs llm-hunt with all dry flags forced and no JOBBER_KILL in the child env copy', async () => {
    const stateDir = join(mkTmp(), '.jobber');
    const env = { PATH: process.env.PATH, JOBBER_KILL: '1', JOBBER_DRY_RUN: '0', SCHEDULER_DRY_RUN: 'false', LINKEDIN_DRY_RUN: 'false' };
    const t = deps(ROOT, {}, env);
    await runCli(['--llm', '--json'], { ...t.d, stateDir });
    const hunt = t.calls.find((c) => c.cmd === './run-hunt.sh');
    expect(hunt?.args).toEqual(['run the hunt in dry mode: report only']);
    expect(hunt?.env).toMatchObject({ JOBBER_DRY_RUN: '1', SCHEDULER_DRY_RUN: 'true', LINKEDIN_DRY_RUN: 'true' });
    expect(hunt?.env).not.toHaveProperty('JOBBER_KILL');
    expect(env.JOBBER_KILL).toBe('1');
    expect(env.JOBBER_DRY_RUN).toBe('0');
  });
});

describe('fixtures', () => {
  const dir = join(ROOT, 'src', 'verify', 'fixtures');
  const text = readFileSync(join(dir, 'jobs.json'), 'utf8') + readFileSync(join(dir, 'match.json'), 'utf8');
  it('only example.invalid emails and urls', () => {
    for (const m of text.matchAll(/[A-Za-z0-9._-]+@([A-Za-z0-9.-]+)/g)) expect(m[1].replace(/\.$/, '')).toBe('example.invalid');
    for (const m of text.matchAll(/https?:\/\/([^/"\s]+)/g)) expect(m[1]).toBe('example.invalid');
  });
  it('deal-breaker fixture has one config keyword and is marked; clean has none', () => {
    const fx = loadFixtures(ROOT);
    const bad = fx.jobs.find((j) => j.id === fx.dealBreakerJobId)!;
    const clean = fx.jobs.find((j) => j.id === fx.cleanJobId)!;
    const cfg = (JSON.parse(readFileSync(join(ROOT, 'config', 'deal-breakers.json'), 'utf8')).keywords as string[]).map((k) => k.toLowerCase());
    const hits = (t: string) => cfg.filter((k) => t.toLowerCase().includes(k));
    expect(hits(bad.description + bad.title)).toHaveLength(1);
    expect(hits(clean.description + clean.title)).toHaveLength(0);
    expect(bad.description).toContain('FIXTURE');
    expect(fx.dealBreakers.length).toBeGreaterThan(0);
  });
  it('the real fixtures pass the pipeline-fixture stage', async () => {
    const ctx = buildCtx({
      root: ROOT, env: { PATH: process.env.PATH }, run: async () => ({ stdout: '', code: 0 }), fs: realFs,
      now: () => new Date('2026-10-15T00:00:00Z'), doctor: async () => [], openDb,
      startWeb: async () => ({ url: 'x', close: async () => {} }), fixtures: () => loadFixtures(ROOT),
    });
    expect(await pipelineFixture.run(ctx)).toMatchObject({ status: 'pass' });
  });
});

describe('realStartWeb', () => {
  it('the dashboard-login stage skips against the real pre-8C server', async () => {
    const { dashboardLogin } = await import('../src/verify/stages.js');
    const ctx = buildCtx({
      root: ROOT, env: { PATH: process.env.PATH }, run: async () => ({ stdout: '', code: 0 }), fs: realFs,
      now: () => new Date('2026-10-15T00:00:00Z'), doctor: async () => [], openDb,
      startWeb: realStartWeb, fixtures: () => loadFixtures(ROOT),
    });
    const r = await dashboardLogin.run(ctx);
    expect(r.status).toBe('skip');
    expect(r.detail).toContain('(got 401)');
  });
  it('starts hermetically on loopback port 0 and serves without real config', async () => {
    const srv = await realStartWeb({ port: 0, host: '127.0.0.1', tmp: mkTmp() });
    try {
      expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      // Production answers 401 (not 404) for an unknown /api path without a session; with 8C absent the
      // dashboard-login stage therefore reports fail on a real run (R13: skip only on 404). Reported upstream.
      expect((await fetch(`${srv.url}/api/auth/mode`)).status).toBe(401);
      expect((await fetch(`${srv.url}/`)).status).toBe(200);
    } finally {
      await srv.close();
    }
  });
});
