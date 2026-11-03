// tests/tmux-single-session.test.ts
// Piece 1: everything lives in ONE tmux session named Jobber (defaults, env override, run window names, keep-open option).
import { describe, expect, it } from 'vitest';
import { JOBBER_TMUX_SESSION, type Run } from '../src/platform/tmux.js';
import { ENV_CATALOG } from '../src/settings/envCatalog.js';
import { DEFAULT_STACK_SESSION } from '../src/stack/plan.js';
import { stackSession } from '../src/stack/up.js';
import { validateRunnerConfig } from '../src/web/env.js';
import { buildRunnerArgv, runWindowKeepMin, tmuxLauncher, type FsOps } from '../src/scheduler/launch.js';

const spec = (k: string) => ENV_CATALOG.find((s) => s.key === k);

describe('the single Jobber session', () => {
  it('the shared constant is Jobber', () => {
    expect(JOBBER_TMUX_SESSION).toBe('Jobber');
    expect(DEFAULT_STACK_SESSION).toBe('Jobber');
  });
  it('the three session env keys all default to it', () => {
    for (const k of ['STACK_TMUX_SESSION', 'SCHEDULER_TMUX_SESSION', 'WEB_TMUX_SESSION']) expect(spec(k)?.default, k).toBe('Jobber');
  });
  it('the stack session defaults to Jobber and an env value overrides it', () => {
    expect(stackSession({})).toBe('Jobber');
    expect(stackSession({ STACK_TMUX_SESSION: '  ' })).toBe('Jobber');
    expect(stackSession({ STACK_TMUX_SESSION: 'other' })).toBe('other');
    expect(() => stackSession({ STACK_TMUX_SESSION: 'bad name' })).toThrow();
  });
  it('the dashboard chat session defaults to Jobber and WEB_TMUX_SESSION overrides it', () => {
    const sess = (e: Record<string, string>): string | undefined => {
      const r = validateRunnerConfig(e, { accountStored: true });
      return r.ok ? r.config.session : undefined;
    };
    expect([sess({}), sess({ WEB_TMUX_SESSION: 'mine' })]).toEqual(['Jobber', 'mine']);
  });
});

const fsOps = (files: Set<string>): FsOps => ({
  writeFile: () => {},
  mkdir: () => {},
  readFromOffset: (_p, o) => ({ data: Buffer.alloc(0), offset: o }),
  exists: (p) => files.has(p),
  readText: () => '0',
});

function fake() {
  const calls: string[][] = [];
  const run: Run = async (_c, args) => {
    calls.push(args);
    return { stdout: '', code: args[0] === 'list-windows' ? 1 : 0 };
  };
  return { run, calls };
}
const plan = { runId: 'abcd1234ef', dryRun: false, prompt: 'p', session: 'Jobber', runDir: '/r', projectRoot: '/proj' };

describe('run window names', () => {
  it('default stays wake-<runId>, a lane can name its window, a bad name is refused', async () => {
    const a = fake();
    expect((await tmuxLauncher(a.run, fsOps(new Set())).start(plan)).window).toBe('wake-abcd1234ef');
    const b = fake();
    const h = await tmuxLauncher(b.run, fsOps(new Set())).start({ ...plan, windowName: 'drip-mail-abcd1234ef' });
    expect(h.window).toBe('drip-mail-abcd1234ef');
    expect(b.calls.find((c) => c[0] === 'new-window')).toContain('drip-mail-abcd1234ef');
    await expect(tmuxLauncher(fake().run, fsOps(new Set())).start({ ...plan, windowName: 'a;b' })).rejects.toThrow();
    expect(buildRunnerArgv).toBeTypeOf('function');
  });
});

describe('RUN_WINDOW_KEEP_MIN', () => {
  it('parses to 0 by default and clamps', () => {
    expect(runWindowKeepMin({})).toBe(0);
    expect(runWindowKeepMin({ RUN_WINDOW_KEEP_MIN: 'abc' })).toBe(0);
    expect(runWindowKeepMin({ RUN_WINDOW_KEEP_MIN: '5' })).toBe(5);
    expect(runWindowKeepMin({ RUN_WINDOW_KEEP_MIN: '9999' })).toBe(120);
  });
  it('0 closes the window at once (kill-window), as before', async () => {
    const f = fake();
    const l = tmuxLauncher(f.run, fsOps(new Set()), 0);
    const h = await l.start(plan);
    await l.kill(h).catch(() => {});
    expect(f.calls.some((c) => c[0] === 'run-shell')).toBe(false);
    expect(f.calls.some((c) => c[0] === 'set-option')).toBe(false);
  });
  it('N>0 keeps a finished window open and closes it later inside tmux; a running one is killed at once', async () => {
    const f = fake();
    const done = new Set<string>();
    const l = tmuxLauncher(f.run, fsOps(done), 5);
    const h = await l.start(plan);
    expect(f.calls.some((c) => c[0] === 'set-option' && c.includes('remain-on-exit'))).toBe(true);
    done.add(h.exitPath);
    await l.kill(h);
    const rs = f.calls.find((c) => c[0] === 'run-shell');
    const cmd = rs?.[2] ?? '';
    expect(cmd).toContain('sleep 300');
    expect(cmd).toContain('=Jobber:=wake-abcd1234ef');
    expect(f.calls.some((c) => c[0] === 'kill-window')).toBe(false);
    // not finished: killed through the normal path
    const g = fake();
    const l2 = tmuxLauncher(g.run, fsOps(new Set()), 5);
    const h2 = await l2.start(plan);
    await l2.kill(h2).catch(() => {});
    expect(g.calls.some((c) => c[0] === 'run-shell')).toBe(false);
  });
});
