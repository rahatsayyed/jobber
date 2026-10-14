import { describe, it, expect } from 'vitest';
import { mkdtempSync, appendFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunnerArgv, defaultFsOps, tmuxLauncher, type FsOps } from '../src/scheduler/launch.js';
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
    mkdir: () => {},
    readFromOffset: (p, off) => {
      const b = Buffer.from(files.get(p) ?? '', 'utf8');
      return { data: b.subarray(off), offset: Math.max(off, b.length) };
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
      ...head, 'FOO_BAR=x y', 'JOBBER_RUN_ID=abcd1234', 'JOBBER_DRY_RUN=1', 'npx', 'tsx', 'scripts/run-claude.ts', 'outreach_wake', '--no-classifier',
    ]);
  });
  it('rejects reserved env keys and always emits the dry-run flag last', () => {
    expect(() => buildRunnerArgv({ ...base, dryRun: true, env: { JOBBER_DRY_RUN: '0' } })).toThrow();
    expect(() => buildRunnerArgv({ ...base, dryRun: true, env: { SCHEDULER_X: '1' } })).toThrow();
    for (const k of ['PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'HOME']) {
      expect(() => buildRunnerArgv({ ...base, dryRun: false, env: { [k]: 'x' } })).toThrow();
    }
    const a = buildRunnerArgv({ ...base, dryRun: true, env: { OK_KEY: '1' } });
    expect(a.filter((x) => x.startsWith('JOBBER_DRY_RUN='))).toEqual(['JOBBER_DRY_RUN=1']);
    expect(a.indexOf('JOBBER_DRY_RUN=1')).toBeGreaterThan(a.indexOf('OK_KEY=1'));
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
    expect(h.session).toBe('jobber');
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

  it('poll drains the log after the exit file check (race)', async () => {
    const { run } = fakeRun();
    const m = memFs();
    const h = await tmuxLauncher(run, m.fs).start(plan);
    m.files.set(h.logPath, 'a');
    const racy: FsOps = {
      ...m.fs,
      exists: (p) => {
        if (p === h.exitPath) {
          m.files.set(h.exitPath, '0');
          m.files.set(h.logPath, 'a-tail'); // final output lands right as the exit file appears
          return true;
        }
        return m.fs.exists(p);
      },
    };
    const res = await tmuxLauncher(run, racy).poll(h);
    expect(res.exited).toBe(true);
    expect(res.newOutput).toBe('a-tail');
  });

  it('poll does not corrupt a split UTF-8 character', async () => {
    const { run } = fakeRun();
    const m = memFs();
    const h = await tmuxLauncher(run, m.fs).start(plan);
    const bytes = Buffer.from('x€', 'utf8');
    let cur = bytes.subarray(0, 3);
    const fs2: FsOps = { ...m.fs, readFromOffset: (_p, off) => ({ data: cur.subarray(off), offset: cur.length }) };
    const l2 = tmuxLauncher(run, fs2);
    expect((await l2.poll(h)).newOutput).toBe('x');
    cur = bytes;
    expect((await l2.poll(h)).newOutput).toBe('€');
  });

  it('kill uses the handle session (restart-safe) and kills an existing window', async () => {
    const { run, calls } = fakeRun({}, { 'list-windows': '0|wake-abcd1234|1|sh\n' });
    await tmuxLauncher(run, memFs().fs).kill({
      runId: 'abcd1234', session: 'jobber', window: 'wake-abcd1234', logPath: '', exitPath: '', promptPath: '',
    });
    expect(calls[1].args).toEqual(['kill-window', '-t', '=jobber:=wake-abcd1234']);
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
  it('contains the expected lines, ends with the JSON instruction, no dry-run sentence', () => {
    const p = buildWakePrompt(i);
    expect(p).toContain('abcd1234');
    expect(p).toContain('Dry run: no.');
    expect(p).toContain('Allowed platforms: linkedin, naukri.');
    expect(p).toContain('Dispatch worker `due-followups` with quota 2, platforms linkedin.');
    expect(p).toContain('Dispatch worker `naukri-search` with quota 1, platforms naukri.');
    expect(p).not.toContain('must not send');
    expect(p.indexOf('due-followups')).toBeLessThan(p.indexOf('naukri-search'));
    const nonEmpty = p.split('\n').filter(Boolean);
    expect(nonEmpty[nonEmpty.length - 1]).toBe('End with one JSON line {run_id, workers: [{worker, done, skipped, escalated}]}.');
    expect(p.match(/halted/g)).toHaveLength(2);
  });
  it('states the dry-run sentence only when set', () => {
    const p = buildWakePrompt({ ...i, dryRun: true });
    expect(p).toContain('Dry run: yes.');
    expect(p).toContain('must not send');
  });
});

describe('defaultFsOps', () => {
  it('writes 0600, reads appended bytes from an offset, creates dirs', () => {
    const d = mkdtempSync(join(tmpdir(), 'sched-launch-'));
    try {
      const f = join(d, 'a.txt');
      defaultFsOps.writeFile(f, 'hello', 0o600);
      expect(statSync(f).mode & 0o777).toBe(0o600);
      const r1 = defaultFsOps.readFromOffset(f, 0);
      expect(r1.data.toString()).toBe('hello');
      appendFileSync(f, ' world');
      expect(defaultFsOps.readFromOffset(f, r1.offset).data.toString()).toBe(' world');
      expect(defaultFsOps.readFromOffset(join(d, 'none'), 0).data.length).toBe(0);
      expect(defaultFsOps.exists(f)).toBe(true);
      expect(defaultFsOps.readText(f)).toBe('hello world');
      defaultFsOps.mkdir(join(d, 'x', 'y'));
      expect(defaultFsOps.exists(join(d, 'x', 'y'))).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
