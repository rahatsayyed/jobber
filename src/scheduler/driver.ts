// src/scheduler/driver.ts
// Wake driver: one planned wake (control, lock, plan, launch, poll, budget, finish) and the daemon loop.
import { readFileSync } from 'node:fs';
import type BetterSqlite3 from 'better-sqlite3';
import { acquireLock, peekLock, type LockDeps, type LockHandle } from '../platform/lock.js';
import { redactPane } from '../platform/redact.js';
import { isDryRun } from '../safety/dryRun.js';
import type { OutreachConfig } from '../outreach/config.js';
import type { Tuning } from '../outreach/tuning.js';
import { ceilings } from '../outreach/limits.js';
import { drawWaitMs, inQuietHours, nextWake, pacingFromConfig, type Rng } from '../outreach/pacing.js';
import { BudgetTracker, loadBudget, type StopReason } from './budget.js';
import { readControl, statExists, type ControlDeps, type ControlState } from './control.js';
import { countDue } from './due.js';
import type { LaunchHandle, Launcher } from './launch.js';
import type { Notice, Notifier } from './notify.js';
import { loadPlanKnobs, planWake, type DiscoverSearches, type WakeDecision } from './plan.js';
import { buildWakePrompt } from './prompt.js';
import { finishRun, getState, markOrphans, setState, startRun, type RunStatus } from './runLog.js';

type Db = BetterSqlite3.Database;

export interface DriverDeps {
  db: Db;
  now: () => Date;
  rng: Rng;
  sleep: (ms: number) => Promise<void>;
  cfg: OutreachConfig;
  tuning: Tuning;
  env: NodeJS.ProcessEnv;
  lockRoot: string;
  stopFile: string;
  runDir: string;
  projectRoot: string;
  launcher: Launcher;
  notifier: Notifier;
  newRunId: () => string;
  lockDeps?: LockDeps;
  control?: Pick<ControlDeps, 'exists' | 'read'>;
  pollMs?: number; // default 5000
  session?: string; // tmux session for wake windows, default 'jobber-wake'
  /** Named LinkedIn discovery searches (config/linkedin-discovery.json); absent plans no discover task. */
  discoverSearches?: DiscoverSearches;
  heartbeat?: () => void; // called on every poll tick (the daemon lock heartbeat)
  /** Seam for 7D hooks. Called AFTER the run lock is released; errors are swallowed and noticed. */
  afterWake?: (r: WakeResult) => Promise<void>;
}
export interface WakeResult {
  runId: string;
  status: RunStatus;
  reason?: string;
  nextWakeAt: string;
}

const DEFAULT_POLL_MS = 5000;
const SLICE_MS = 30_000;
const DEFAULT_SESSION = 'jobber-wake';
const PASS_KEYS = new Set([
  'TZ', 'QUIET_HOURS_START', 'QUIET_HOURS_END', 'COMPANY_CONTACT_LIMIT', 'SPECULATIVE_COMPANY_LIMIT',
]);
const PASS_PREFIXES = ['PACING_', 'COOLDOWN_', 'CADENCE_', 'LINKEDIN_MAX_', 'NAUKRI_MAX_', 'CLASSIFIER_'];

/**
 * A wake is dry unless every flag explicitly says live; any dry flag wins and unset means dry.
 */
export function wakeIsDry(env: NodeJS.ProcessEnv): boolean {
  return isDryRun(env, { linkedin: true });
}

/**
 * The explicit child env. JOBBER_* and SCHEDULER_* are reserved by the launcher (buildRunnerArgv
 * emits JOBBER_DRY_RUN and SCHEDULER_DRY_RUN from dryRun); LINKEDIN_DRY_RUN is passed here.
 */
export function childEnv(env: NodeJS.ProcessEnv, dry: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string' || /[\r\n\0]/.test(v)) continue;
    if (PASS_KEYS.has(k) || PASS_PREFIXES.some((p) => k.startsWith(p))) out[k] = v;
  }
  out.LINKEDIN_DRY_RUN = dry ? 'true' : 'false';
  return out;
}

function backoffMin(env: NodeJS.ProcessEnv): number {
  const n = Number(env.USAGE_LIMIT_BACKOFF_MIN);
  return Number.isInteger(n) && n >= 1 && n <= 10080 ? n : 300;
}

function safeMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return redactPane(m.split('\n')[0]).replace(/\s+/g, ' ').slice(0, 200);
}

async function say(d: DriverDeps, n: Notice): Promise<void> {
  try {
    await d.notifier.notify(n);
  } catch {
    // never fatal
  }
}

function controlDeps(d: DriverDeps): ControlDeps {
  return {
    stopFile: d.stopFile,
    env: d.env,
    exists: d.control?.exists ?? statExists,
    read: d.control?.read ?? ((p) => readFileSync(p, 'utf8')),
  };
}

function stopMap(r: StopReason): { status: RunStatus; reason: string } {
  if (r === 'usage_limit') return { status: 'usage_limit', reason: 'usage_limit' };
  return { status: 'budget_exceeded', reason: r };
}

function handleFor(runId: string, session: string, window?: string | null): LaunchHandle {
  return { runId, session, window: window || `wake-${runId}`, logPath: '', exitPath: '', promptPath: '' };
}

// Kill through the launcher; a throw is a failed kill: warn and record the window so the next wake refuses to launch.
async function killChecked(d: DriverDeps, h: LaunchHandle, runId: string): Promise<boolean> {
  try {
    await d.launcher.kill(h);
    return true;
  } catch (e) {
    try {
      setState(d.db, 'unkilled_window', JSON.stringify({ runId: h.runId, session: h.session }), d.now());
    } catch {
      // ignore
    }
    await say(d, { level: 'warn', title: 'kill failed, window may still be running', detail: safeMsg(e), runId });
    return false;
  }
}

async function inner(d: DriverDeps, opts: { force?: boolean; abort?: () => boolean }): Promise<WakeResult> {
  const pacing = pacingFromConfig(d.cfg, d.tuning);
  const runId = d.newRunId();
  const dry = wakeIsDry(d.env);
  const trigger = opts.force ? 'forced' : 'scheduled';
  const drawNext = (): string => {
    const t = nextWake(d.now(), d.rng, pacing).toISOString();
    try {
      setState(d.db, 'next_wake_at', t, d.now());
    } catch {
      // state unwritable: the daemon still holds the value in memory
    }
    return t;
  };
  const logSkipped = (reason: string, detail?: string): void => {
    const at = d.now();
    const sr = detail ? `${reason}: ${detail}`.slice(0, 200) : reason;
    startRun(d.db, {
      id: runId, at, trigger, dryRun: dry, burst: null, tasks: [], status: 'skipped', stopReason: sr,
    });
    finishRun(d.db, runId, { at, status: 'skipped', stopReason: sr });
  };
  const skip = async (reason: string, detail?: string): Promise<WakeResult> => {
    try {
      logSkipped(reason, detail);
    } catch (e) {
      await say(d, { level: 'warn', title: 'scheduler skipped row not written', detail: safeMsg(e), runId });
    }
    if (reason === 'killed') {
      // a kill skip never redraws or overwrites a stored future next_wake_at
      try {
        const v = getState(d.db, 'next_wake_at');
        if (v && Date.parse(v) > d.now().getTime()) return { runId, status: 'skipped', reason, nextWakeAt: v };
      } catch {
        // fall through to an in-memory draw
      }
      return { runId, status: 'skipped', reason, nextWakeAt: nextWake(d.now(), d.rng, pacing).toISOString() };
    }
    return { runId, status: 'skipped', reason, nextWakeAt: drawNext() };
  };

  // (2) control, fails closed
  let control: ControlState;
  try {
    control = readControl(d.db, controlDeps(d));
    if (control.killed) {
      let notified: string | null = null;
      try {
        notified = getState(d.db, 'kill_notified');
      } catch {
        // treat as not notified
      }
      if (notified !== '1') {
        await say(d, { level: 'halt', title: 'scheduler killed', detail: control.killReason ?? undefined, runId });
        try {
          setState(d.db, 'kill_notified', '1', d.now());
        } catch {
          // ignore
        }
      }
      return await skip('killed', control.killReason ?? undefined);
    }
    if (getState(d.db, 'kill_notified') === '1') setState(d.db, 'kill_notified', '0', d.now());
  } catch (e) {
    await say(d, { level: 'warn', title: 'scheduler control read failed, not launching', detail: safeMsg(e), runId });
    return await skip('control_error', safeMsg(e));
  }

  // a window we failed to kill earlier blocks launching until a retried kill succeeds
  try {
    const raw = getState(d.db, 'unkilled_window');
    if (raw) {
      const u = JSON.parse(raw) as { runId?: unknown; session?: unknown };
      if (typeof u.runId !== 'string' || typeof u.session !== 'string') throw new Error('bad unkilled_window state');
      await d.launcher.kill(handleFor(u.runId, u.session));
      setState(d.db, 'unkilled_window', '', d.now());
    }
  } catch (e) {
    await say(d, { level: 'warn', title: 'kill failed, window may still be running', detail: safeMsg(e), runId });
    return await skip('unkilled_window');
  }

  // usage backoff
  try {
    const until = getState(d.db, 'usage_backoff_until');
    if (until && Date.parse(until) > d.now().getTime()) return await skip('usage_backoff', until);
  } catch (e) {
    await say(d, { level: 'warn', title: 'scheduler state read failed, not launching', detail: safeMsg(e), runId });
    return await skip('state_error', safeMsg(e));
  }

  // (3) lock
  let lock: LockHandle | null;
  try {
    lock = acquireLock(d.lockRoot, 'run', 'wake', d.lockDeps);
  } catch (e) {
    await say(d, { level: 'warn', title: 'scheduler lock error, not launching', detail: safeMsg(e), runId });
    return await skip('lock_error', safeMsg(e));
  }
  if (!lock) return await skip('locked');

  let status: RunStatus = 'running';
  let stopReason: string | null = null;
  let exitCode: number | null = null;
  let started = false;
  let launchTried = false;
  let inboxPlanned = false;
  let handle: LaunchHandle | null = null;
  let tracker: BudgetTracker | null = null;
  let nextWakeAt = '';
  let skippedResult: WakeResult | null = null;

  try {
    // (4) plan
    let decision: WakeDecision;
    try {
      const now = d.now();
      decision = planWake({
        now, rng: d.rng, pacing, control,
        ceilings: ceilings(d.db, d.cfg, now),
        due: countDue(d.db, now, d.tuning),
        knobs: loadPlanKnobs(d.env),
        discoverSearches: d.discoverSearches,
      });
    } catch (e) {
      await say(d, { level: 'warn', title: 'scheduler plan failed, not launching', detail: safeMsg(e), runId });
      skippedResult = await skip('plan_error', safeMsg(e));
      return skippedResult;
    }
    if (decision.kind === 'skip') {
      skippedResult = await skip(decision.reason, decision.detail);
      return skippedResult;
    }

    // (5) run
    const startAt = d.now();
    const budget = loadBudget(d.env);
    inboxPlanned = decision.tasks.some((a) => a.tasks.some((k) => k.kind === 'inbox'));
    startRun(d.db, {
      id: runId, at: startAt, trigger, dryRun: dry, burst: decision.burst, tasks: decision.tasks, status: 'running',
    });
    started = true;
    tracker = new BudgetTracker(budget, startAt);
    const prompt = buildWakePrompt({
      runId, dryRun: dry, burst: decision.burst, tasks: decision.tasks, budget, allowed: control.allowed, now: startAt,
    });
    launchTried = true;
    handle = await d.launcher.start({
      runId, dryRun: dry, prompt,
      session: d.session ?? DEFAULT_SESSION,
      runDir: d.runDir,
      projectRoot: d.projectRoot,
      noClassifier: d.env.SCHEDULER_NO_CLASSIFIER === 'true' && dry,
      env: childEnv(d.env, dry),
    });
    const h = handle;
    const pollMs = d.pollMs ?? DEFAULT_POLL_MS;
    let killFailed = false;
    const kill = async (): Promise<void> => {
      if (!(await killChecked(d, h, runId))) killFailed = true;
    };
    for (;;) {
      const r = await d.launcher.poll(h);
      const now = d.now();
      tracker.feed(r.newOutput, now);
      lock.heartbeat();
      try {
        d.heartbeat?.();
      } catch {
        // ignore
      }
      const stop = tracker.check(now);
      if (stop) {
        if (!r.exited) await kill();
        const m = stopMap(stop);
        status = m.status;
        stopReason = m.reason;
        exitCode = r.exitCode;
        if (stop === 'usage_limit') {
          const until = new Date(now.getTime() + backoffMin(d.env) * 60000).toISOString();
          try {
            setState(d.db, 'usage_backoff_until', until, now);
          } catch {
            // ignore
          }
          await say(d, { level: 'warn', title: 'scheduler usage limit reached, backing off', detail: `until ${until}`, runId });
        }
        break;
      }
      if (r.exited) {
        exitCode = r.exitCode;
        status = r.exitCode === 0 ? 'ok' : 'failed';
        if (status === 'failed') stopReason = `exit ${r.exitCode}`;
        break;
      }
      if (opts.abort?.()) {
        await kill();
        status = 'killed';
        stopReason = 'shutdown';
        break;
      }
      let ctl: ControlState | null = null;
      try {
        ctl = readControl(d.db, controlDeps(d));
      } catch {
        ctl = null; // unreadable means kill
      }
      if (!ctl || ctl.killed) {
        await kill();
        status = 'killed';
        stopReason = 'kill_switch';
        break;
      }
      if (inQuietHours(now, pacing)) {
        await kill();
        status = 'killed';
        stopReason = 'quiet_hours';
        break;
      }
      await d.sleep(pollMs);
    }
    if (killFailed) stopReason = 'kill_failed';
  } catch (e) {
    status = 'failed';
    stopReason = `error: ${safeMsg(e)}`;
    if (launchTried) {
      // the window may exist even when start() threw: kill it by its deterministic name
      const ok = await killChecked(d, handle ?? handleFor(runId, d.session ?? DEFAULT_SESSION), runId);
      if (!ok) stopReason = 'kill_failed';
    }
  } finally {
    // (6) always: finish the row, release the lock, draw the next wake
    if (started) {
      try {
        const snap = tracker?.snapshot();
        if (status === 'running') status = 'failed';
        finishRun(d.db, runId, {
          at: d.now(), status, stopReason, exitCode,
          toolCalls: snap?.toolCalls, tokensApprox: snap?.tokensApprox,
          summary: snap ? redactPane(snap.lastLines.join('\n')).slice(0, 2000) : null,
        });
      } catch {
        // ignore
      }
      if (inboxPlanned && status === 'ok') {
        try {
          setState(d.db, 'inbox_last_checked_at', d.now().toISOString(), d.now());
        } catch {
          // ignore
        }
      }
    }
    try {
      if (!lock.release()) await say(d, { level: 'warn', title: 'scheduler run lock was lost', runId });
    } catch {
      // ignore
    }
    if (!skippedResult) nextWakeAt = drawNext();
  }
  if (skippedResult) return skippedResult;
  if (status === 'failed' || status === 'killed' || status === 'budget_exceeded' || status === 'usage_limit') {
    await say(d, {
      level: status === 'failed' ? 'warn' : 'info', title: `scheduler run ${status}`,
      detail: stopReason ?? undefined, runId,
    });
  }
  return { runId, status, reason: stopReason ?? undefined, nextWakeAt };
}

export async function wakeOnce(
  d: DriverDeps,
  opts: { force?: boolean; abort?: () => boolean } = {},
): Promise<WakeResult> {
  const r = await inner(d, opts);
  const killedResult = r.status === 'killed' || (r.status === 'skipped' && r.reason === 'killed');
  if (d.afterWake && !killedResult) {
    try {
      // The run lock is already released here: a hook that does work must take the `run` lock itself.
      await d.afterWake(r);
    } catch (e) {
      await say(d, { level: 'warn', title: 'scheduler after-wake hook failed', detail: safeMsg(e), runId: r.runId });
    }
  }
  return r;
}

export async function daemonLoop(d: DriverDeps, stop: { stopped: boolean }): Promise<void> {
  if (d.env.SCHEDULER_ENABLED === 'false') {
    await say(d, { level: 'info', title: 'scheduler disabled (SCHEDULER_ENABLED=false), exiting' });
    return;
  }
  const dl = acquireLock(d.lockRoot, 'daemon', 'scheduler', d.lockDeps);
  if (!dl) {
    await say(d, { level: 'warn', title: 'another scheduler daemon is running, exiting' });
    return;
  }
  const pacing = pacingFromConfig(d.cfg, d.tuning);
  const exists = d.control?.exists ?? statExists;
  const hb = (): void => dl.heartbeat();
  const deps: DriverDeps = {
    ...d,
    heartbeat: () => {
      hb();
      d.heartbeat?.();
    },
  };
  const stopPresent = (): boolean => {
    try {
      return exists(d.stopFile);
    } catch {
      return false;
    }
  };
  try {
    // Orphans from a previous daemon: kill their windows BEFORE marking them crashed, unless a live
    // run lock shows another process owns a run right now (then leave its rows untouched).
    if (peekLock(d.lockRoot, 'run', d.lockDeps) === null) {
      let rows: { id: string; window: string | null }[] = [];
      try {
        rows = d.db
          .prepare("SELECT id, window FROM scheduler_runs WHERE status IN ('running', 'planned')")
          .all() as { id: string; window: string | null }[];
      } catch {
        rows = [];
      }
      for (const r of rows) {
        await killChecked(d, handleFor(r.id, d.session ?? DEFAULT_SESSION, r.window), r.id);
      }
      markOrphans(d.db, d.now());
    } else {
      await say(d, { level: 'warn', title: 'run lock is live at daemon start, leaving running rows untouched' });
    }
    let next: Date | null = null;
    try {
      const v = getState(d.db, 'next_wake_at');
      const t = v ? Date.parse(v) : NaN;
      if (Number.isFinite(t) && t > d.now().getTime()) next = new Date(t);
    } catch {
      next = null;
    }
    if (!next) {
      next = new Date(d.now().getTime() + drawWaitMs(d.rng, pacing));
      try {
        setState(d.db, 'next_wake_at', next.toISOString(), d.now());
      } catch {
        // ignore
      }
    }
    let stopSeen = stopPresent();
    while (!stop.stopped) {
      let woke = false;
      while (!stop.stopped) {
        const remaining = next.getTime() - d.now().getTime();
        if (remaining <= 0) {
          woke = true;
          break;
        }
        await d.sleep(Math.min(SLICE_MS, remaining));
        hb();
        const present = stopPresent();
        if (present && !stopSeen) {
          stopSeen = true;
          woke = true; // let the kill transition be logged and noticed promptly
          break;
        }
        if (!present) stopSeen = false;
      }
      if (!woke || stop.stopped) break;
      const r = await wakeOnce(deps, { abort: () => stop.stopped });
      next = new Date(r.nextWakeAt);
    }
  } finally {
    try {
      dl.release();
    } catch {
      // ignore
    }
  }
}
