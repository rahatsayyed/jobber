import { describe, it, expect } from 'vitest';
import { buildRunnerArgv, tmuxLauncher, type FsOps } from '../src/scheduler/launch.js';
import { buildWakePrompt } from '../src/scheduler/prompt.js';
import type { Run } from '../src/platform/tmux.js';

function fakeRun(codes: Record<string, number> = {}, stdout: Record<string, string> = {}) {
  const calls: { cmd: string; args: string[] }[] = [];
  const run: Run = async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: stdout[args[0]] ?? '', code: codes[args[0]] ?? 0 };
  };
  return { run, calls };
}

function memFs() {
  const files = new Map<string, string>();
  const modes = new Map<string, number>();
  const fs: FsOps = {
    writeFile: (p, d, m) => {
      files.set(p, d);
      modes.set(p, m);
    },
    readFromOffset: (p, off) => {
      const b = Buffer.from(files.get(p) ?? '', 'utf8');
      return { text: b.subarray(off).toString('utf8'), offset: Math.max(off, b.length) };
    },
    exists: (p) => files.has(p),
    readText: (p) => files.get(p) ?? '',
  };
  return { fs, files, modes };
}

describe('buildRunnerArgv', () => {
  const base = { runId: 'abcd1234', promptPath: '/r/p', logPath: '/r/l', exitPath: '/r/e' };
  const head = ['/bin/sh', '-c', 'p=$1; l=$2; e=$3; shift 3; "$@" <"$p" >>"$l" 2>&1; echo $? >"$e"', 'sh', '/r/p', '/r/l', '/r/e', 'env'];
  it('golden without dry run', () => {
    expect(buildRunnerArgv({ ...base, dryRun: false })).toEqual([
      ...head, 'JOBBER_RUN_ID=abcd1234', 'JOBBER_DRY_RUN=0', 'npx', 'tsx', 'scripts/run-claude.ts', 'outreach_wake',
    ]);
  });
  it('golden with dry run, env and no-classifier', () => {
    expect(buildRunnerArgv({ ...base, dryRun: true, env: { FOO_BAR: 'x y' }, noClassifier: true })).toEqual([
      ...head, 'JOBBER_RUN_ID=abcd1234', 'JOBBER_DRY_RUN=1', 'FOO_BAR=x y', 'npx', 'tsx', 'scripts/run-claude.ts', 'outreach_wake', '--no-classifier',
    ]);
  });
  it('rejects bad env keys, values and run ids', () => {
    expect(() => buildRunnerArgv({ ...base, dryRun: false, env: { 'bad key': 'x' } })).toThrow();
    expect(() => buildRunnerArgv({ ...base, dryRun: false, env: { A: 'x\ny' } })).toThrow();
    expect(() => buildRunnerArgv({ ...base, dryRun: false, env: { A: 'x\0y' } })).toThrow();
    expect(() => buildRunnerArgv({ ...base, runId: 'BAD', dryRun: false })).toThrow();
  });
});

describe('tmuxLauncher', () => {
  const plan = { runId: 'abcd1234', dryRun: false, prompt: 'hello', session: 'jobber', runDir: '/r', projectRoot: '/proj' };

  it('writes the prompt 0600, ensures session, creates window in order', async () => {
    const { run, calls } = fakeRun({ 'has-session': 1 });
    const m = memFs();
    const h = await tmuxLauncher(run, m.fs).start(plan);
    expect(calls.map((c) => c.args[0])).toEqual(['has-session', 'new-session', 'new-window']);
    expect(calls[2].args.slice(0, 8)).toEqual(['new-window', '-d', '-t', '=jobber:', '-n', 'wake-abcd1234', '-c', '/proj']);
    expect(calls[2].args[8]).toBe('--');
    expect(h.window).toBe('wake-abcd1234');
    expect(m.files.get(h.promptPath)).toBe('hello');
    expect(m.modes.get(h.promptPath)).toBe(0o600);
  });

  it('skips new-session when present', async () => {
    const { run, calls } = fakeRun();
    await tmuxLauncher(run, memFs().fs).start(plan);
    expect(calls.map((c) => c.args[0])).toEqual(['has-session', 'new-window']);
  });

  it('poll returns only appended bytes and the exit code', async () => {
    const { run } = fakeRun();
    const m = memFs();
    const l = tmuxLauncher(run, m.fs);
    const h = await l.start(plan);
    m.files.set(h.logPath, 'one\n');
    expect(await l.poll(h)).toEqual({ exited: false, exitCode: null, newOutput: 'one\n' });
    m.files.set(h.logPath, 'one\ntwo\n');
    expect((await l.poll(h)).newOutput).toBe('two\n');
    m.files.set(h.exitPath, '3\n');
    expect(await l.poll(h)).toEqual({ exited: true, exitCode: 3, newOutput: '' });
    m.files.set(h.exitPath, 'garbage');
    expect(await l.poll(h)).toMatchObject({ exited: true, exitCode: -1 });
  });

  it('kill never throws on a missing window', async () => {
    const { run, calls } = fakeRun();
    const l = tmuxLauncher(run, memFs().fs);
    const h = await l.start(plan);
    await expect(l.kill(h)).resolves.toBeUndefined();
    expect(calls.some((c) => c.args[0] === 'kill-window')).toBe(false);
  });
});

describe('buildWakePrompt', () => {
  const i = {
    runId: 'abcd1234',
    dryRun: false,
    burst: 3,
    tasks: [
      { worker: 'due-followups' as const, quota: 2, platforms: ['linkedin' as const] },
      { worker: 'naukri-search' as const, quota: 1, platforms: ['naukri' as const] },
    ],
    budget: { maxToolCalls: 60, maxWallSec: 900, maxTokensApprox: 150000 },
    allowed: ['linkedin' as const, 'naukri' as const],
    now: new Date('2026-10-15T10:00:00Z'),
  };
  it('contains the expected lines and no dry-run sentence', () => {
    const p = buildWakePrompt(i);
    expect(p).toContain('abcd1234');
    expect(p).toContain('Allowed platforms: linkedin, naukri.');
    expect(p).toContain('Dispatch worker `due-followups` with quota 2, platforms linkedin.');
    expect(p).toContain('Dispatch worker `naukri-search` with quota 1, platforms naukri.');
    expect(p).toContain('{run_id, workers: [{worker, done, skipped, escalated}]}');
    expect(p).not.toMatch(/dry run/i);
    expect(p.indexOf('due-followups')).toBeLessThan(p.indexOf('naukri-search'));
  });
  it('mentions dry run only when set', () => {
    expect(buildWakePrompt({ ...i, dryRun: true })).toMatch(/dry run/i);
  });
});
