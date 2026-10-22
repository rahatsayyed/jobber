import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { loadTuning } from '../src/outreach/tuning.js';
import { inQuietHours, pacingFromConfig } from '../src/outreach/pacing.js';
import { acquireLock, peekLock } from '../src/platform/lock.js';
import { daemonLoop, wakeOnce, wakeIsDry, type DriverDeps, type WakeResult } from '../src/scheduler/driver.js';
import { fileNotifier, type Notice } from '../src/scheduler/notify.js';
import { tmuxLauncher, type FsOps, type LaunchHandle, type LaunchPlan, type Launcher, type PollResult } from '../src/scheduler/launch.js';
import type { Run } from '../src/platform/tmux.js';
import { recordRun } from '../src/sources/status.js';
import { getState, listRuns, setState, startRun } from '../src/scheduler/runLog.js';

const NOON_IST = new Date('2026-10-15T08:00:00.000Z'); // 13:30 IST, outside quiet hours
const QUIET = new Date('2026-10-14T21:00:00.000Z'); // 02:30 IST
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function mulberry(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Step { out?: string; exited?: boolean; code?: number }
class FakeLauncher implements Launcher {
  starts: LaunchPlan[] = [];
  kills = 0;
  constructor(public steps: Step[] = [{ exited: true, code: 0 }], private throwOnStart = false) {}
  async start(plan: LaunchPlan): Promise<LaunchHandle> {
    if (this.throwOnStart) throw new Error('boom launcher failure\n    at stack frame');
    this.starts.push(plan);
    return { runId: plan.runId, session: plan.session, window: `wake-${plan.runId}`, logPath: 'l', exitPath: 'e', promptPath: 'p' };
  }
  async poll(): Promise<PollResult> {
    const s = this.steps.length > 1 ? (this.steps.shift() as Step) : this.steps[0];
    return { exited: !!s.exited, exitCode: s.exited ? (s.code ?? 0) : null, newOutput: s.out ?? '' };
  }
  killed: string[] = [];
  killFails = false;
  async kill(h?: LaunchHandle): Promise<void> {
    this.kills++;
    if (h) this.killed.push(h.window);
    if (this.killFails) throw new Error('tmux gone');
  }
}

function setup(opts: { start?: Date; env?: NodeJS.ProcessEnv; launcher?: Launcher; stopExists?: () => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sched-drv-'));
  dirs.push(dir);
  let t = (opts.start ?? NOON_IST).getTime();
  const env = opts.env ?? {};
  const notices: Notice[] = [];
  const launcher = opts.launcher ?? new FakeLauncher();
  const db = openDb(':memory:');
  const d: DriverDeps = {
    db,
    now: () => new Date(t),
    rng: mulberry(7),
    sleep: async (ms) => {
      t += ms;
    },
    cfg: loadOutreachConfig(env),
    tuning: loadTuning(env),
    env,
    lockRoot: join(dir, 'locks'),
    stopFile: join(dir, 'STOP'),
    runDir: join(dir, 'runs'),
    projectRoot: dir,
    launcher,
    notifier: { notify: async (n) => void notices.push(n) },
    newRunId: (() => {
      let i = 0;
      return () => `run${String(++i).padStart(8, '0')}`;
    })(),
    control: opts.stopExists ? { exists: opts.stopExists, read: () => 'stop it' } : undefined,
    pollMs: 5000,
  };
  return { d, db, dir, notices, launcher: launcher as FakeLauncher, clock: () => new Date(t), advance: (ms: number) => void (t += ms) };
}

describe('wakeIsDry', () => {
  it('is dry only when JOBBER_DRY_RUN is 1 or true; unset is live', () => {
    expect(wakeIsDry({})).toBe(false);
    expect(wakeIsDry({ JOBBER_DRY_RUN: 'false' })).toBe(false);
    expect(wakeIsDry({ JOBBER_DRY_RUN: '1' })).toBe(true);
    expect(wakeIsDry({ JOBBER_DRY_RUN: 'true' })).toBe(true);
    expect(wakeIsDry({ JOBBER_DRY_RUN: ' TRUE ' })).toBe(true);
    expect(wakeIsDry({ SCHEDULER_DRY_RUN: 'true', LINKEDIN_DRY_RUN: 'true' })).toBe(false);
  });
});

describe('wakeOnce sources notice', () => {
  const sourceTitle = (n: Notice) => n.title.startsWith('sources:');

  it('is written after the model session, with agent rows and the numbers, not before', async () => {
    const s = setup();
    const order: string[] = [];
    s.d.notifier = { notify: async (n) => void (s.notices.push(n), order.push(n.title)) };
    // The fake session stores an agent-run source row while it runs.
    class Recording extends FakeLauncher {
      async poll(): Promise<PollResult> {
        order.push('session');
        recordRun(s.db, 'naukri-agent', { fetched: 7, kept: 3, new: 3 });
        return super.poll();
      }
    }
    s.d.launcher = new Recording();
    const r = await wakeOnce(s.d);
    expect(r.status).toBe('ok');
    const i = order.findIndex((t) => t.startsWith('sources:'));
    expect(i).toBeGreaterThan(order.lastIndexOf('session'));
    const n = s.notices.find(sourceTitle)!;
    expect(n.title).toBe('sources: 1 ran, fetched 7, new 3, errors 0, fallback 0');
    expect(n.runId).toBe(r.runId);
  });

  it('ignores rows from before the wake started', async () => {
    const s = setup();
    recordRun(s.db, 'old-src', { fetched: 9, kept: 9, new: 9 });
    s.db.prepare("UPDATE platform_status SET last_run_at = '2020-01-01T00:00:00.000Z'").run();
    await wakeOnce(s.d);
    expect(s.notices.find(sourceTitle)).toBeUndefined();
  });

  it('notes a code pass that threw', async () => {
    const s = setup();
    s.d.codePass = async () => {
      throw new Error('code pass exploded');
    };
    await wakeOnce(s.d);
    const failed = s.notices.some((n) => n.title === 'scheduler code pass failed');
    const n = s.notices.find(sourceTitle);
    expect(failed).toBe(true);
    expect(n?.detail).toContain('code pass exploded');
  });

  it('is not written when the wake is skipped', async () => {
    const s = setup({ stopExists: () => true });
    recordRun(s.db, 'fresh', { fetched: 1, kept: 1, new: 1 });
    const r = await wakeOnce(s.d);
    expect(r.status).toBe('skipped');
    expect(s.notices.find(sourceTitle)).toBeUndefined();
  });
});

describe('wakeOnce', () => {
  it('runs a dry wake when JOBBER_DRY_RUN=true and logs ok', async () => {
    const s = setup({ env: { JOBBER_DRY_RUN: 'true' } });
    const r = await wakeOnce(s.d);
    expect(r.status).toBe('ok');
    expect(s.launcher.starts).toHaveLength(1);
    expect(s.launcher.starts[0].dryRun).toBe(true);
    expect(s.launcher.starts[0].env?.JOBBER_DRY_RUN).toBeUndefined();
    expect(getState(s.db, 'next_wake_at')).toBe(r.nextWakeAt);
    expect(getState(s.db, 'inbox_last_checked_at')).not.toBeNull();
    expect(peekLock(s.d.lockRoot, 'run')).toBeNull();
  });

  it('an unset flag launches a live wake; false is live too', async () => {
    for (const env of [{}, { JOBBER_DRY_RUN: 'false' }]) {
      const s = setup({ env });
      await wakeOnce(s.d);
      expect(s.launcher.starts[0].dryRun).toBe(false);
    }
    const s = setup({ env: { JOBBER_DRY_RUN: 'false' } });
    await wakeOnce(s.d);
    expect(s.launcher.starts[0].dryRun).toBe(false);
    expect(s.launcher.starts[0].noClassifier).toBe(false);
  });

  it('child env holds only allowed keys and no reserved keys', async () => {
    const s = setup({
      env: {
        OPENAI_API_KEY: 'x', GMAIL_PASSWORD: 'y', TZ: 'Asia/Kolkata', PACING_FOO: '1',
        LINKEDIN_MAX_INVITES_PER_WEEK: '50', NAUKRI_MAX_APPLIES_PER_DAY: '5', CLASSIFIER_MODEL: 'm',
        COOLDOWN_X: '2', CADENCE_Y: '3', COMPANY_CONTACT_LIMIT: '4', JOBBER_KILL: '0',
        SCHEDULER_NO_CLASSIFIER: 'true',
      },
    });
    await wakeOnce(s.d);
    const env = s.launcher.starts[0].env ?? {};
    const ok = /^(TZ|QUIET_HOURS_START|QUIET_HOURS_END|COMPANY_CONTACT_LIMIT|SPECULATIVE_COMPANY_LIMIT|(PACING_|COOLDOWN_|CADENCE_|LINKEDIN_MAX_|NAUKRI_MAX_|CLASSIFIER_).*)$/;
    for (const k of Object.keys(env)) expect(k).toMatch(ok);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PACING_FOO).toBe('1');
    expect(Object.keys(env).some((k) => k.startsWith('JOBBER_') || k.startsWith('SCHEDULER_'))).toBe(false);
  });

  it('SCHEDULER_NO_CLASSIFIER only applies when dry', async () => {
    const dry = setup({ env: { SCHEDULER_NO_CLASSIFIER: 'true', JOBBER_DRY_RUN: 'true' } });
    await wakeOnce(dry.d);
    expect(dry.launcher.starts[0].noClassifier).toBe(true);
    const live = setup({
      env: { SCHEDULER_NO_CLASSIFIER: 'true', JOBBER_DRY_RUN: 'false' },
    });
    await wakeOnce(live.d);
    expect(live.launcher.starts[0].noClassifier).toBe(false);
  });

  it('killed at start: no launch, one skipped row, one notice', async () => {
    const s = setup({ stopExists: () => true });
    const r1 = await wakeOnce(s.d);
    const r2 = await wakeOnce(s.d);
    expect(r1.status).toBe('skipped');
    expect(s.launcher.starts).toHaveLength(0);
    expect(listRuns(s.db).filter((x) => x.status === 'skipped')).toHaveLength(2);
    expect(s.notices.filter((n) => n.level === 'halt')).toHaveLength(1);
    expect(r2.reason).toBe('killed');
  });

  it('fails closed when control cannot be read', async () => {
    const s = setup();
    s.db.exec('DROP TABLE halt_flags');
    const r = await wakeOnce(s.d);
    expect(r.status).toBe('skipped');
    expect(s.launcher.starts).toHaveLength(0);
  });

  it('STOP appearing mid-run kills the window', async () => {
    let polls = 0;
    const s = setup({
      launcher: new FakeLauncher([{ out: '' }]),
      stopExists: () => polls++ >= 2,
    });
    const r = await wakeOnce(s.d);
    expect(r.status).toBe('killed');
    expect(r.reason).toBe('kill_switch');
    expect(s.launcher.kills).toBe(1);
  });

  it('budget trip by tool calls kills and keeps last lines only', async () => {
    const tool = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } });
    const chunk = Array.from({ length: 12 }, () => tool).join('\n') + '\n';
    const s = setup({ env: { RUN_MAX_TOOL_CALLS: '3' }, launcher: new FakeLauncher([{ out: chunk }]) });
    const r = await wakeOnce(s.d);
    expect(r.status).toBe('budget_exceeded');
    expect(s.launcher.kills).toBe(1);
    const row = listRuns(s.db)[0];
    expect(row.summary?.split('\n').length).toBeLessThanOrEqual(5);
    expect((row.summary ?? '').length).toBeLessThanOrEqual(2000);
  });

  it('usage limit sets a backoff and the daemon does not launch before it', async () => {
    const s = setup({
      launcher: new FakeLauncher([{ out: '{"type":"result","is_error":true}\n' }]),
    });
    const r = await wakeOnce(s.d);
    expect(r.status).toBe('usage_limit');
    const until = Date.parse(getState(s.db, 'usage_backoff_until') as string);
    expect(until - NOON_IST.getTime()).toBe(300 * 60000);
    expect(s.notices.some((n) => n.level === 'warn')).toBe(true);
    const startsBefore = s.launcher.starts.length;
    const stop = { stopped: false };
    const baseSleep = s.d.sleep;
    s.d.sleep = async (ms) => {
      await baseSleep(ms);
      if (s.clock().getTime() >= NOON_IST.getTime() + 200 * 60000) stop.stopped = true;
    };
    await daemonLoop(s.d, stop);
    expect(s.launcher.starts.length).toBe(startsBefore);
  });

  it('lock held elsewhere gives skipped: locked', async () => {
    const s = setup();
    const held = acquireLock(s.d.lockRoot, 'run', 'other');
    expect(held).not.toBeNull();
    const r = await wakeOnce(s.d);
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('locked');
    expect(s.launcher.starts).toHaveLength(0);
    held?.release();
  });

  it('quiet hours at plan time skip and the next wake is outside quiet hours', async () => {
    const s = setup({ start: QUIET });
    const r = await wakeOnce(s.d);
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('quiet_hours');
    expect(s.launcher.starts).toHaveLength(0);
    expect(inQuietHours(new Date(r.nextWakeAt), pacingFromConfig(s.d.cfg, s.d.tuning))).toBe(false);
  });

  it('quiet hours beginning mid-run kill the window', async () => {
    const s = setup({
      start: new Date('2026-10-14T19:29:00.000Z'), // 00:59 IST
      launcher: new FakeLauncher([{ out: '' }]),
    });
    s.d.pollMs = 30000;
    const r = await wakeOnce(s.d);
    expect(r.status).toBe('killed');
    expect(r.reason).toBe('quiet_hours');
    expect(s.launcher.kills).toBe(1);
  });

  it('releases the lock and finishes the row after a launcher error, without a stack', async () => {
    const s = setup({ launcher: new FakeLauncher([], true) });
    const r = await wakeOnce(s.d);
    expect(r.status).toBe('failed');
    expect(r.reason).not.toMatch(/stack frame|\n/);
    expect(peekLock(s.d.lockRoot, 'run')).toBeNull();
    expect(acquireLock(s.d.lockRoot, 'run', 'again')).not.toBeNull();
    expect(getState(s.db, 'next_wake_at')).toBe(r.nextWakeAt);
    expect(listRuns(s.db)[0].status).toBe('failed');
  });

  it('non-zero exit is failed', async () => {
    const s = setup({ launcher: new FakeLauncher([{ exited: true, code: 3 }]) });
    expect((await wakeOnce(s.d)).status).toBe('failed');
  });

  it('kill failure warns, records the window and blocks the next wake until a retry succeeds', async () => {
    const s = setup({ launcher: new FakeLauncher([{ out: '' }]), stopExists: undefined });
    let polls = 0;
    s.launcher.killFails = true;
    const r = await wakeOnce(s.d, { abort: () => polls++ >= 1 });
    expect(r.status).toBe('killed');
    expect(r.reason).toBe('kill_failed');
    expect(s.notices.some((n) => /kill failed/.test(n.title))).toBe(true);
    expect(getState(s.db, 'unkilled_window')).toBeTruthy();
    const again = await wakeOnce(s.d);
    expect(again.status).toBe('skipped');
    expect(again.reason).toBe('unkilled_window');
    expect(s.launcher.starts).toHaveLength(1);
    s.launcher.killFails = false;
    s.launcher.steps = [{ exited: true, code: 0 }];
    const third = await wakeOnce(s.d);
    expect(third.status).toBe('ok');
    expect(s.launcher.starts).toHaveLength(2);
  });

  it('real tmuxLauncher whose window survives a kill gives kill_failed and blocks the next wake', async () => {
    const run: Run = async (_c, args) => ({
      stdout: args[0] === 'list-windows' ? '0|wake-run00000001|1|sh\n' : '',
      code: 0,
    });
    const fsOps: FsOps = {
      writeFile: () => {}, mkdir: () => {}, exists: () => false, readText: () => '',
      readFromOffset: (_p, off) => ({ data: Buffer.alloc(0), offset: off }),
    };
    const s = setup({ launcher: tmuxLauncher(run, fsOps) });
    let polls = 0;
    const r = await wakeOnce(s.d, { abort: () => polls++ >= 1 });
    expect(r.status).toBe('killed');
    expect(r.reason).toBe('kill_failed');
    expect(getState(s.db, 'unkilled_window')).toBeTruthy();
    expect((await wakeOnce(s.d)).reason).toBe('unkilled_window');
  });

  it('start failure attempts a kill by the deterministic window name', async () => {
    const s = setup({ launcher: new FakeLauncher([], true) });
    const r = await wakeOnce(s.d);
    expect(r.status).toBe('failed');
    expect(s.launcher.killed).toEqual([`wake-${r.runId}`]);
  });

  it('a killed skip keeps a stored future next_wake_at and skips afterWake', async () => {
    const s = setup({ stopExists: () => true });
    const future = new Date(NOON_IST.getTime() + 25 * 60000).toISOString();
    setState(s.db, 'next_wake_at', future, NOON_IST);
    let hooks = 0;
    s.d.afterWake = async () => void hooks++;
    const r = await wakeOnce(s.d);
    expect(r.reason).toBe('killed');
    expect(r.nextWakeAt).toBe(future);
    expect(getState(s.db, 'next_wake_at')).toBe(future);
    expect(hooks).toBe(0);
  });

  it('afterWake hook runs after the lock is released and its errors are swallowed', async () => {
    const s = setup();
    let lockedDuringHook: boolean | null = null;
    s.d.afterWake = async (_r: WakeResult) => {
      lockedDuringHook = peekLock(s.d.lockRoot, 'run') !== null;
      throw new Error('hook broke');
    };
    const r = await wakeOnce(s.d);
    expect(r.status).toBe('ok');
    expect(lockedDuringHook).toBe(false);
    expect(s.notices.some((n) => /hook failed/.test(n.title))).toBe(true);
  });
});

describe('daemonLoop', () => {
  it('honours a future stored next_wake_at after restart', async () => {
    const s = setup();
    const future = new Date(NOON_IST.getTime() + 20 * 60000).toISOString();
    setState(s.db, 'next_wake_at', future, NOON_IST);
    const stop = { stopped: false };
    const base = s.d.sleep;
    s.d.sleep = async (ms) => {
      await base(ms);
      if (s.clock().getTime() >= NOON_IST.getTime() + 10 * 60000) stop.stopped = true;
    };
    await daemonLoop(s.d, stop);
    expect(s.launcher.starts).toHaveLength(0);
    expect(getState(s.db, 'next_wake_at')).toBe(future);
  });

  it('a missing next_wake_at draws one wait, never an immediate wake', async () => {
    const s = setup();
    const stop = { stopped: true };
    await daemonLoop(s.d, stop);
    const v = Date.parse(getState(s.db, 'next_wake_at') as string);
    expect(v).toBeGreaterThan(NOON_IST.getTime());
    expect(s.launcher.starts).toHaveLength(0);
  });

  it('marks orphan rows crashed at start', async () => {
    const s = setup();
    startRun(s.db, { id: 'orphan0001', at: NOON_IST, trigger: 'scheduled', dryRun: true, burst: 1, tasks: [], status: 'running' });
    await daemonLoop(s.d, { stopped: true });
    expect(listRuns(s.db).find((r) => r.id === 'orphan0001')?.status).toBe('crashed');
  });

  it('kills orphan windows before marking rows crashed', async () => {
    const s = setup();
    startRun(s.db, { id: 'orphan0002', at: NOON_IST, trigger: 'scheduled', dryRun: true, burst: 1, tasks: [], status: 'running' });
    await daemonLoop(s.d, { stopped: true });
    expect(s.launcher.killed).toContain('wake-orphan0002');
    expect(listRuns(s.db).find((r) => r.id === 'orphan0002')?.status).toBe('crashed');
  });

  it('leaves running rows untouched while another process holds the run lock', async () => {
    const s = setup();
    startRun(s.db, { id: 'live00001', at: NOON_IST, trigger: 'scheduled', dryRun: true, burst: 1, tasks: [], status: 'running' });
    const held = acquireLock(s.d.lockRoot, 'run', 'other');
    await daemonLoop(s.d, { stopped: true });
    expect(s.launcher.killed).toHaveLength(0);
    expect(listRuns(s.db).find((r) => r.id === 'live00001')?.status).toBe('running');
    held?.release();
  });

  it('a shutdown signal during a run kills the window and finishes the row', async () => {
    const s = setup({ launcher: new FakeLauncher([{ out: '' }]) });
    let polls = 0;
    const orig = s.launcher.poll.bind(s.launcher);
    s.launcher.poll = async () => {
      polls++;
      return orig();
    };
    const r = await wakeOnce(s.d, { abort: () => polls >= 2 });
    expect(r.status).toBe('killed');
    expect(r.reason).toBe('shutdown');
    expect(s.launcher.kills).toBe(1);
    expect(peekLock(s.d.lockRoot, 'run')).toBeNull();
    expect(listRuns(s.db)[0].status).toBe('killed');
  });

  it('a second daemon refuses and exits with a notice', async () => {
    const s = setup();
    const first = acquireLock(s.d.lockRoot, 'daemon', 'scheduler');
    expect(first).not.toBeNull();
    await daemonLoop(s.d, { stopped: false });
    expect(s.notices.some((n) => /another scheduler daemon/.test(n.title))).toBe(true);
    first?.release();
  });

  it('exits immediately when disabled', async () => {
    const s = setup({ env: { SCHEDULER_ENABLED: 'false' } });
    await daemonLoop(s.d, { stopped: false });
    expect(peekLock(s.d.lockRoot, 'daemon')).toBeNull();
    expect(listRuns(s.db)).toHaveLength(0);
  });
});

describe('fileNotifier', () => {
  it('appends redacted JSONL and passes only the title to the command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-notify-'));
    dirs.push(dir);
    const path = join(dir, 'n.jsonl');
    const calls: string[][] = [];
    const n = fileNotifier(path, () => NOON_IST, async (_c, a) => {
      calls.push(a);
      return { stdout: '', code: 0 };
    }, 'notify-cmd');
    await n.notify({ level: 'warn', title: 'hello', detail: 'password=hunter2\nsecond line', runId: 'abc' });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.title).toBe('hello');
    expect(rec.detail).not.toContain('hunter2');
    expect(rec.run_id).toBe('abc');
    expect(calls).toEqual([['hello']]);
  });

  it('never throws on a bad path or a throwing command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-notify-'));
    dirs.push(dir);
    const file = join(dir, 'plain');
    writeFileSync(file, 'x');
    const n = fileNotifier(join(file, 'sub', 'n.jsonl'), () => NOON_IST, async () => {
      throw new Error('cmd failed');
    }, 'c');
    await expect(n.notify({ level: 'info', title: 't', detail: 'd' })).resolves.toBeUndefined();
  });
});
