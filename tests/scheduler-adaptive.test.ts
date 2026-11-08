import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { loadTuning } from '../src/outreach/tuning.js';
import { nextWake, quietFromConfig, WAKE_INTERVAL_MIN } from '../src/outreach/quiet.js';
import { daemonLoop, wakeOnce, type DriverDeps } from '../src/scheduler/driver.js';
import {
  adaptiveIntervalMin, readEmptyStreak, wakeIdleMaxMin, wakeMadeProgress, workFingerprint, writeEmptyStreak, type WorkFingerprint,
} from '../src/scheduler/adaptiveWake.js';
import { getState, setState } from '../src/scheduler/runLog.js';
import { launcherAsWindows, type LaunchHandle, type LaunchPlan, type Launcher, type PollResult } from './helpers/fakeWindows.js';

const NOON_IST = new Date('2026-10-15T08:00:00.000Z');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const INSERT_JOB = (n: number): string =>
  `INSERT INTO jobs (id, source, title, company, url) VALUES ('j${n}','t','x','c','https://x.example/${n}')`;

describe('wakeIdleMaxMin', () => {
  it('defaults to 60, clamps to 10..240 and treats blank like unset', () => {
    expect(wakeIdleMaxMin({})).toBe(60);
    expect(wakeIdleMaxMin({ WAKE_IDLE_MAX_MIN: '' })).toBe(60);
    expect(wakeIdleMaxMin({ WAKE_IDLE_MAX_MIN: 'abc' })).toBe(60);
    expect(wakeIdleMaxMin({ WAKE_IDLE_MAX_MIN: '10' })).toBe(10);
    expect(wakeIdleMaxMin({ WAKE_IDLE_MAX_MIN: '1' })).toBe(10);
    expect(wakeIdleMaxMin({ WAKE_IDLE_MAX_MIN: '9999' })).toBe(240);
  });
});

describe('adaptiveIntervalMin', () => {
  it('doubles per empty wake up to the max', () => {
    expect([0, 1, 2, 3, 4, 9].map((s) => adaptiveIntervalMin(s, 60))).toEqual([10, 20, 40, 60, 60, 60]);
  });
  it('a max of 10 is the old fixed behaviour', () => {
    expect([0, 1, 5].map((s) => adaptiveIntervalMin(s, 10))).toEqual([10, 10, 10]);
  });
  it('bad streak values fall back to the base', () => {
    expect(adaptiveIntervalMin(-3, 60)).toBe(10);
    expect(adaptiveIntervalMin(NaN, 60)).toBe(10);
  });
});

describe('nextWake with an interval', () => {
  const cfg = quietFromConfig(loadOutreachConfig({}));
  it('uses the base interval by default and the given one otherwise', () => {
    expect(nextWake(NOON_IST, cfg).getTime()).toBe(NOON_IST.getTime() + WAKE_INTERVAL_MIN * 60000);
    expect(nextWake(NOON_IST, cfg, 40).getTime()).toBe(NOON_IST.getTime() + 40 * 60000);
  });
  it('still moves a long wait out of quiet hours', () => {
    // 23:30 IST + 60 minutes lands at 00:30 IST (not quiet by default 1 to 7); use 00:30 IST + 60 = 01:30 IST (quiet).
    const start = new Date('2026-10-14T19:00:00.000Z'); // 00:30 IST
    const t = nextWake(start, cfg, 60);
    expect(new Date(t.getTime() + 330 * 60000).getUTCHours()).toBe(cfg.quietEndHour);
    expect(t.getTime()).toBeGreaterThan(start.getTime() + 60 * 60000);
  });
});

describe('wakeMadeProgress', () => {
  const fp: WorkFingerprint = { jobs: 10, scored: 8, excluded: 1, queue: 3, followups: 0 };
  const zero = { done: 0, skipped: 2, escalated: 0, stopped: 0 };
  it('is empty only when counts are zero and nothing moved', () => {
    expect(wakeMadeProgress(zero, fp, { ...fp })).toBe(false);
  });
  it('an operator task done or escalated is progress', () => {
    expect(wakeMadeProgress({ ...zero, done: 1 }, fp, { ...fp })).toBe(true);
    expect(wakeMadeProgress({ ...zero, escalated: 1 }, fp, { ...fp })).toBe(true);
  });
  it('new jobs, scoring, exclusions, queue rows or follow-ups are progress', () => {
    for (const k of Object.keys(fp) as Array<keyof WorkFingerprint>) {
      expect(wakeMadeProgress(zero, fp, { ...fp, [k]: (fp[k] as number) + 1 }), k).toBe(true);
    }
  });
  it('unknown is progress (no report, no fingerprint, failed query)', () => {
    expect(wakeMadeProgress(null, fp, { ...fp })).toBe(true);
    expect(wakeMadeProgress(zero, null, { ...fp })).toBe(true);
    expect(wakeMadeProgress(zero, fp, { ...fp, jobs: null })).toBe(true);
  });
});

class OkLauncher implements Launcher {
  starts: LaunchPlan[] = [];
  async start(plan: LaunchPlan): Promise<LaunchHandle> {
    this.starts.push(plan);
    return { runId: plan.runId, session: plan.session, window: `wake-${plan.runId}`, logPath: 'l', exitPath: 'e', promptPath: 'p' };
  }
  async poll(): Promise<PollResult> { return { exited: true, exitCode: 0, newOutput: '' }; }
  async kill(): Promise<void> { /* nothing */ }
}

type Disp = { dispatch: (x: unknown) => Promise<{ summary: string }> };

function setup(opts: { env?: NodeJS.ProcessEnv; doneZero?: boolean; beforeDispatch?: () => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sched-adapt-'));
  dirs.push(dir);
  let t = NOON_IST.getTime();
  const env = opts.env ?? {};
  const db = openDb(':memory:');
  const launcher = new OkLauncher();
  const d: DriverDeps = {
    db, now: () => new Date(t), rng: () => 0.5,
    sleep: async (ms) => { t += ms; },
    cfg: loadOutreachConfig(env), tuning: loadTuning(env), env,
    lockRoot: join(dir, 'locks'), stopFile: join(dir, 'STOP'), projectRoot: dir,
    windows: launcherAsWindows(launcher, () => d),
    notifier: { notify: async () => undefined },
    newRunId: (() => { let i = 0; return () => `run${String(++i).padStart(8, '0')}`; })(),
  };
  if (opts.doneZero || opts.beforeDispatch) {
    // The fake window reports done 1 per step; rewrite it to done 0 so the wake is an empty one.
    const w = d.windows as unknown as Disp;
    const orig = w.dispatch.bind(w);
    w.dispatch = async (i: unknown) => {
      opts.beforeDispatch?.();
      const r = await orig(i);
      return opts.doneZero ? { ...r, summary: r.summary.replace(/"done":1/g, '"done":0') } : r;
    };
  }
  return { d, db, advance: (ms: number) => void (t += ms), clock: () => new Date(t) };
}

describe('wakeOnce adaptive delay', () => {
  it('an ok wake with progress keeps the base interval and a streak of 0', async () => {
    const s = setup();
    const r = await wakeOnce(s.d);
    expect(r.status).toBe('ok');
    expect(readEmptyStreak(s.db)).toBe(0);
    expect(Date.parse(r.nextWakeAt) - s.clock().getTime()).toBe(10 * 60000);
  });

  it('empty wakes double the wait up to the max', async () => {
    // Each wake is a fresh setup (the code pass is due only on the first wake of a db); the streak is seeded.
    const waits: number[] = [];
    for (const seed of [0, 1, 2, 3, 4]) {
      const s = setup({ doneZero: true });
      writeEmptyStreak(s.db, seed, s.clock());
      const r = await wakeOnce(s.d);
      expect(r.status).toBe('ok');
      expect(readEmptyStreak(s.db)).toBe(seed + 1);
      waits.push((Date.parse(r.nextWakeAt) - s.clock().getTime()) / 60000);
    }
    expect(waits).toEqual([20, 40, 60, 60, 60]);
  });

  it('new job rows during an otherwise empty wake reset the streak', async () => {
    let n = 0;
    let dbRef: ReturnType<typeof openDb> | null = null;
    const s = setup({ doneZero: true, beforeDispatch: () => { dbRef?.prepare(INSERT_JOB(++n)).run(); } });
    dbRef = s.db;
    writeEmptyStreak(s.db, 3, s.clock());
    const r = await wakeOnce(s.d);
    expect(readEmptyStreak(s.db)).toBe(0);
    expect(Date.parse(r.nextWakeAt) - s.clock().getTime()).toBe(10 * 60000);
  });

  it('WAKE_IDLE_MAX_MIN=10 keeps the fixed 10 minutes', async () => {
    const s = setup({ doneZero: true, env: { WAKE_IDLE_MAX_MIN: '10' } });
    writeEmptyStreak(s.db, 3, s.clock());
    const r = await wakeOnce(s.d);
    expect(Date.parse(r.nextWakeAt) - s.clock().getTime()).toBe(10 * 60000);
  });

  it('a skipped wake leaves the streak unchanged', async () => {
    const s = setup({ doneZero: true });
    writeEmptyStreak(s.db, 2, s.clock());
    setState(s.db, 'usage_backoff_until', new Date(s.clock().getTime() + 3600000).toISOString(), s.clock());
    await wakeOnce(s.d);
    expect(readEmptyStreak(s.db)).toBe(2);
  });
});

describe('daemonLoop adaptive delay', () => {
  it('daemon start resets the streak and pulls a stretched wake back to the base interval', async () => {
    const s = setup();
    writeEmptyStreak(s.db, 3, s.clock());
    setState(s.db, 'next_wake_at', new Date(s.clock().getTime() + 60 * 60000).toISOString(), s.clock());
    const stop = { stopped: false };
    const base = s.d.sleep;
    s.d.sleep = async (ms) => { await base(ms); stop.stopped = true; };
    await daemonLoop(s.d, stop);
    expect(readEmptyStreak(s.db)).toBe(0);
    expect(Date.parse(getState(s.db, 'next_wake_at') as string)).toBe(NOON_IST.getTime() + 10 * 60000);
  });

  it('new jobs saved while the wait is stretched pull the next wake back to the base interval', async () => {
    const s = setup();
    const stretched = new Date(NOON_IST.getTime() + 60 * 60000).toISOString();
    setState(s.db, 'next_wake_at', stretched, NOON_IST);
    const stop = { stopped: false };
    const base = s.d.sleep;
    let n = 0;
    s.d.sleep = async (ms) => {
      await base(ms);
      n++;
      if (n === 1) {
        writeEmptyStreak(s.db, 2, s.clock());
        s.db.prepare(INSERT_JOB(9)).run();
      }
      if (n >= 3) stop.stopped = true;
    };
    await daemonLoop(s.d, stop);
    expect(readEmptyStreak(s.db)).toBe(0);
    expect(Date.parse(getState(s.db, 'next_wake_at') as string)).toBeLessThan(Date.parse(stretched));
  });
});

describe('workFingerprint', () => {
  it('counts the tables and moves when a job is added', () => {
    const db = openDb(':memory:');
    const a = workFingerprint(db);
    db.prepare(INSERT_JOB(1)).run();
    expect(workFingerprint(db).jobs).toBe((a.jobs as number) + 1);
  });
});
