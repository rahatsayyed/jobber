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
import { manualRequestsPending } from '../manual/requests.js';
import { BudgetTracker, loadBudget, type StopReason } from './budget.js';
import { readControl, statExists, type ControlDeps, type ControlState } from './control.js';
import { countDue } from './due.js';
import type { LaunchHandle, Launcher } from './launch.js';
import { sourcesNotice } from '../status/sources.js';
import type { Notice, Notifier } from './notify.js';
import { loadPlanKnobs, planWake, stepOrder, type Assignment, type DiscoverSearches, type Step, type WakeDecision } from './plan.js';
import { targetRegionsLine, type CodePassResult } from './pipeline.js';
import { buildContinuationPrompt, buildWakePrompt } from './prompt.js';
import { describeStep, MAX_CONTINUATIONS, StreamInspector, unprovenSteps } from './stream.js';
import { dripLoop } from './mailDrip.js';
import { finishRun, getState, markOrphans, setRunLogPath, setRunSession, setState, startRun, type RunStatus } from './runLog.js';

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
  /** The zero-LLM code pass over the script providers (runCodePass); absent means the stage is planned but not run. Never throws. */
  codePass?: () => Promise<CodePassResult>;
  /** Run the mail drip lane (src/scheduler/mailDrip.ts) beside the wakes in the daemon loop. Absent or false: no drip. */
  mailDrip?: boolean;
  /** Stage `manual`, run in code before the model session when a manual request is pending: ingests the requests (src/manual/ingest.ts). Never throws into the wake. */
  manualIngest?: (runId: string) => Promise<unknown>;
  /** After every wake that launched a session: reports finished manual requests to the owner (src/manual/report.ts finalizeManualRequests). */
  manualReport?: (runStatus: string) => Promise<unknown>;
  heartbeat?: () => void; // called on every poll tick (the daemon lock heartbeat)
  /** Seam for 7D hooks. Called AFTER the run lock is released; errors are swallowed and noticed. */
  afterWake?: (r: WakeResult) => Promise<void>;
  /** Check the stream-json log of a session that exited 0 for proof that the wake finished (default true; false only in tests of other things). */
  verifyCompletion?: boolean;
  /** Most `claude --resume` continuations of a wake that ended incomplete; default and ceiling MAX_CONTINUATIONS. */
  maxContinuations?: number;
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
const PASS_PREFIXES = ['PACING_', 'COOLDOWN_', 'CADENCE_', 'LINKEDIN_MAX_', 'NAUKRI_MAX_', 'WELLFOUND_MAX_', 'CLASSIFIER_'];

/**
 * A wake is dry only when JOBBER_DRY_RUN is `1` or `true`; unset or anything else is live.
 */
export function wakeIsDry(env: NodeJS.ProcessEnv): boolean {
  return isDryRun(env);
}

/**
 * The explicit child env. JOBBER_* and SCHEDULER_* are reserved by the launcher (buildRunnerArgv
 * emits JOBBER_DRY_RUN from dryRun), so nothing dry-run related is put in this env.
 */
export function childEnv(env: NodeJS.ProcessEnv, dry: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string' || /[\r\n\0]/.test(v)) continue;
    if (PASS_KEYS.has(k) || PASS_PREFIXES.some((p) => k.startsWith(p))) out[k] = v;
  }
  void dry; // the master flag is emitted last by buildRunnerArgv from the plan's dryRun; it is a reserved key here
  return out;
}

function boundedEnvInt(v: string | undefined, lo: number, hi: number, fallback: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
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

/** The steps of a wake planned without stages (legacy prompt): one Agent call per operator, proven by the final report or a completed call. */
function legacySteps(tasks: Assignment[]): Step[] {
  return tasks.map((a) => ({ operator: a.operator, platform: a.platform, kind: a.tasks[0]?.kind ?? 'inbox', quota: a.tasks[0]?.quota ?? 0 }));
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

  // `as` casts: runSession (a closure) assigns these, and TS must not narrow them to their initial values.
  let status = 'running' as RunStatus;
  let stopReason = null as string | null;
  let exitCode = null as number | null;
  let activeRunId = runId; // the run row being worked on: the wake itself, then each continuation
  let started = false;
  let launchTried = false;
  let inboxPlanned = false;
  let handle = null as LaunchHandle | null;
  let tracker = null as BudgetTracker | null;
  let nextWakeAt = '';
  let skippedResult: WakeResult | null = null;
  let wakeStartIso = '';
  let codePassNote: string | undefined;

  try {
    // (4) plan
    let decision: WakeDecision;
    try {
      const now = d.now();
      decision = planWake({
        now, rng: d.rng, pacing, control,
        ceilings: ceilings(d.db, d.cfg, now),
        due: countDue(d.db, now, d.tuning, d.env),
        knobs: loadPlanKnobs(d.env),
        discoverSearches: d.discoverSearches,
        codePassEnabled: !!d.codePass,
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
    wakeStartIso = startAt.toISOString();
    // Stage 0 (manual requests) and stage 1 run in code, before the model session: failures are noticed but never stop the wake.
    if (decision.stages?.some((s) => s.kind === 'manual') && d.manualIngest) {
      try {
        await d.manualIngest(runId);
      } catch (e) {
        await say(d, { level: 'warn', title: 'scheduler manual request ingest failed', detail: safeMsg(e), runId });
      }
    }
    let codePass: CodePassResult | null = null;
    if (decision.stages?.some((s) => s.kind === 'discover_scripts') && d.codePass) {
      try {
        codePass = await d.codePass();
        if (!codePass.ok) {
          codePassNote = codePass.error;
          await say(d, { level: 'warn', title: 'scheduler code pass failed', detail: codePass.error, runId });
        }
      } catch (e) {
        codePassNote = safeMsg(e);
        await say(d, { level: 'warn', title: 'scheduler code pass failed', detail: codePassNote, runId });
      }
    }
    const order = decision.stages?.length ? stepOrder(decision) : undefined;
    const steps: Step[] = order ?? legacySteps(decision.tasks);
    const pipelineInput = order ? {
      matchThreshold: boundedEnvInt(d.env.MATCH_THRESHOLD, 0, 100, 60),
      sendLimit: boundedEnvInt(d.env.SEND_LIMIT_PER_RUN, 0, 100, 1),
      targetRegions: targetRegionsLine(d.projectRoot),
      followupsAutonomous: d.env.FOLLOWUPS_AUTONOMOUS === 'true',
      codePass,
    } : undefined;
    const prompt = buildWakePrompt({
      runId, dryRun: dry, burst: decision.burst, tasks: decision.tasks, budget, allowed: control.allowed, now: startAt,
      order,
      pipeline: pipelineInput,
    });
    const pollMs = d.pollMs ?? DEFAULT_POLL_MS;

    // One claude session (the original wake, or a `--resume` continuation of it) from launch to exit, stop or kill.
    // It sets status, stopReason and exitCode, and returns what the stream-json log showed.
    const runSession = async (id: string, promptText: string, resume?: string): Promise<StreamInspector> => {
      status = 'running';
      stopReason = null;
      exitCode = null;
      // The wall budget starts after the code pass: that time is not the model session's.
      const t = new BudgetTracker(budget, d.now());
      tracker = t;
      const insp = new StreamInspector();
      launchTried = true;
      handle = await d.launcher.start({
        runId: id, dryRun: dry, prompt: promptText,
        session: d.session ?? DEFAULT_SESSION,
        runDir: d.runDir,
        projectRoot: d.projectRoot,
        noClassifier: d.env.SCHEDULER_NO_CLASSIFIER === 'true' && dry,
        env: childEnv(d.env, dry),
        ...(resume !== undefined ? { resumeSessionId: resume } : {}),
      });
      const h = handle;
      if (h.logPath) {
        try {
          setRunLogPath(d.db, id, h.logPath);
        } catch {
          // the log path is only a convenience for later measurement
        }
      }
      let killFailed = false;
      const kill = async (): Promise<void> => {
        if (!(await killChecked(d, h, id))) killFailed = true;
      };
      for (;;) {
        const r = await d.launcher.poll(h);
        const now = d.now();
        t.feed(r.newOutput, now);
        insp.feed(r.newOutput);
        lock.heartbeat();
        try {
          d.heartbeat?.();
        } catch {
          // ignore
        }
        const stop = t.check(now);
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
            await say(d, { level: 'warn', title: 'scheduler usage limit reached, backing off', detail: `until ${until}`, runId: id });
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
      insp.finish();
      if (insp.sessionId) {
        try {
          setRunSession(d.db, id, insp.sessionId);
        } catch {
          // the session id is a convenience for the chain; the continuation reads it from the inspector
        }
      }
      return insp;
    };

    // A wake that exits 0 without proof that it finished (no final report line, a subagent still pending, a step with no
    // completed operator call) is `incomplete`, not `ok`, and is continued (at most maxCont times) with `claude --resume`.
    const verify = d.verifyCompletion !== false;
    const maxCont = Math.max(0, Math.min(d.maxContinuations ?? MAX_CONTINUATIONS, MAX_CONTINUATIONS));
    const settled = new Set<number>(); // proven done, or dropped because the platform is halted now
    const dropped = new Set<number>();
    const chainIds = [runId];
    let chain = 0;
    let curPrompt = prompt;
    let resumeId: string | undefined;
    for (;;) {
      const insp = await runSession(activeRunId, curPrompt, resumeId);
      if (status === 'ok' && verify) {
        const proof = unprovenSteps(steps, insp, chainIds, settled);
        for (const i of proof.proven) settled.add(i);
        const hasReport = insp.report(chainIds) !== null;
        const stuck = insp.pending();
        if (!insp.resultSeen || !hasReport || stuck.length > 0 || proof.unproven.length > 0) {
          status = 'incomplete';
          const why: string[] = [];
          if (!insp.resultSeen) why.push('no result event in the log');
          else if (!hasReport) why.push('no final report line');
          if (stuck.length > 0) why.push(`${stuck.length} subagent(s) did not return (${stuck.slice(0, 4).map((x) => x.subagent || 'agent').join(', ')})`);
          const list = proof.unproven.map((i) => describeStep(steps[i], i));
          stopReason = `incomplete: ${why.join('; ') || 'steps unproven'}; unproven steps: ${list.length > 0 ? list.join(', ') : 'none listed'}`.slice(0, 500);
        }
      }
      if (status !== 'incomplete') break;
      await say(d, { level: 'warn', title: 'scheduler run incomplete', detail: stopReason ?? undefined, runId: activeRunId });
      const noGo = async (why: string): Promise<void> => {
        stopReason = `${stopReason ?? 'incomplete'}; not continued: ${why}`.slice(0, 600);
      };
      if (chain >= maxCont) {
        await noGo(maxCont === 0 ? 'continuation off' : 'continuation limit reached');
        break;
      }
      const sid = insp.sessionId;
      if (!sid) {
        await noGo('no session id in the log');
        break;
      }
      // Same gates as a new wake: shutdown, kill switch, halts, quiet hours, usage backoff. Dry-run handling is the wake's own flag.
      let ctl: ControlState | null = null;
      try {
        ctl = readControl(d.db, controlDeps(d));
      } catch {
        ctl = null;
      }
      let block: string | null = null;
      if (opts.abort?.()) block = 'shutdown';
      else if (!ctl) block = 'control unreadable';
      else if (ctl.killed) block = 'kill switch';
      else if (ctl.allowed.length === 0) block = 'all platforms halted';
      else if (inQuietHours(d.now(), pacing)) block = 'quiet hours';
      else {
        try {
          const until = getState(d.db, 'usage_backoff_until');
          if (until && Date.parse(until) > d.now().getTime()) block = 'usage backoff';
        } catch {
          block = 'state unreadable';
        }
      }
      if (block || !ctl) {
        await noGo(block ?? 'control unreadable');
        break;
      }
      // A step of a platform halted since the wake began is not worked on in the continuation.
      steps.forEach((s, i) => {
        if (!settled.has(i) && s.platform && !ctl.allowed.includes(s.platform)) {
          settled.add(i);
          dropped.add(i);
        }
      });
      const nextId = d.newRunId();
      const snap = tracker?.snapshot();
      try {
        finishRun(d.db, activeRunId, {
          at: d.now(), status: 'incomplete', stopReason: `${stopReason ?? 'incomplete'}; continued by ${nextId}`.slice(0, 600), exitCode,
          toolCalls: snap?.toolCalls, tokensApprox: snap?.tokensApprox,
          summary: snap ? redactPane(snap.lastLines.join('\n')).slice(0, 2000) : null,
        });
        startRun(d.db, {
          id: nextId, at: d.now(), trigger: 'continuation', dryRun: dry, burst: decision.burst, tasks: decision.tasks,
          status: 'running', parentRunId: activeRunId,
        });
      } catch (e) {
        await say(d, { level: 'warn', title: 'scheduler continuation row not written, not continuing', detail: safeMsg(e), runId: activeRunId });
        stopReason = `${stopReason ?? 'incomplete'}; not continued: run log unwritable`.slice(0, 600);
        break;
      }
      chain++;
      await say(d, { level: 'info', title: `scheduler continuing wake ${runId} (${chain} of ${maxCont})`, detail: `run ${nextId} resumes session ${sid}`, runId: nextId });
      chainIds.push(nextId);
      activeRunId = nextId;
      resumeId = sid;
      curPrompt = buildContinuationPrompt({
        rootRunId: runId, runId: nextId, n: chain, max: maxCont, dryRun: dry, budget, allowed: ctl.allowed, now: d.now(),
        order: steps, proven: settled, dropped,
        pending: insp.pending().map((p) => ({ subagent: p.subagent, description: p.description })),
        pipeline: pipelineInput,
      });
      status = 'running';
      stopReason = null;
    }
  } catch (e) {
    status = 'failed';
    stopReason = `error: ${safeMsg(e)}`;
    if (launchTried) {
      // the window may exist even when start() threw: kill it by its deterministic name
      const ok = await killChecked(d, handle ?? handleFor(activeRunId, d.session ?? DEFAULT_SESSION), activeRunId);
      if (!ok) stopReason = 'kill_failed';
    }
  } finally {
    // (6) always: finish the row, release the lock, draw the next wake
    if (started) {
      try {
        const snap = tracker?.snapshot();
        if (status === 'running') status = 'failed';
        finishRun(d.db, activeRunId, {
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
  // Owner-submitted requests whose jobs are all settled get their report now (code composes and sends it; never fatal).
  if (started && launchTried && d.manualReport) {
    try {
      await d.manualReport(status);
    } catch (e) {
      await say(d, { level: 'warn', title: 'scheduler manual report failed', detail: safeMsg(e), runId });
    }
  }
  // Source summary after the whole wake (code pass and model session), so agent rows are in it too.
  if (started && wakeStartIso) {
    const sn = sourcesNotice(d.db, { runId, sinceIso: wakeStartIso, note: codePassNote });
    if (sn) await say(d, sn);
  }
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
  let drip: Promise<void> | null = null;
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
    // The mail drip lane runs beside the wakes (its own `mail` lock), so a long wake never pauses the slow email trickle.
    drip = deps.mailDrip ? dripLoop(deps, stop) : null;
    // A manual request must not wait for the next random wake: every slice (30 s) the daemon checks for a pending one and wakes early,
    // outside quiet hours, at most once per backoff. The regular pacing (`next`) is left alone.
    let manualBackoffUntil = 0;
    const manualWakeDue = (): boolean => {
      const t = d.now();
      if (t.getTime() < manualBackoffUntil || inQuietHours(t, pacing)) return false;
      try {
        return manualRequestsPending(d.db) > 0;
      } catch {
        return false;
      }
    };
    while (!stop.stopped) {
      let woke = false;
      let manualWake = false;
      while (!stop.stopped) {
        if (manualWakeDue()) {
          woke = true;
          manualWake = true;
          break;
        }
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
      if (manualWake) {
        // Keep the regular schedule: the wake drew a new next_wake_at, put the old one back.
        manualBackoffUntil = d.now().getTime() + (r.status === 'ok' ? 60_000 : 300_000);
        try {
          setState(d.db, 'next_wake_at', next.toISOString(), d.now());
        } catch {
          // ignore
        }
      } else next = new Date(r.nextWakeAt);
    }
  } finally {
    stop.stopped = true; // the drip loop (if any) exits on the same flag
    if (drip) await drip;
    try {
      dl.release();
    } catch {
      // ignore
    }
  }
}
