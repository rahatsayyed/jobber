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
import { inQuietHours, nextWake, quietFromConfig, retryWake, type Rng } from '../outreach/quiet.js';
import { claimPending, type OwnerInstruction } from '../owner/instructions.js';
import { manualRequestsPending } from '../manual/requests.js';
import { budgetEnvWarnings, loadBudget } from './budget.js';
import { readControl, statExists, type ControlDeps, type ControlState } from './control.js';
import { countDue } from './due.js';
import { linkedinActiveNow } from '../linkedin/activeHours.js';
import { buildSourceRows, sourcesNotice } from '../status/sources.js';
import type { Notice, Notifier } from './notify.js';
import { loadPlanKnobs, planWake, stepOrder, type Assignment, type DiscoverSearches, type Step, type WakeDecision } from './plan.js';
import { northStarPromptLine, targetRegionsLine, type CodePassResult } from './pipeline.js';
import { jdReportLine } from '../jdStore.js';
import type { WakeCounts } from './stream.js';
import { noticeUrgency } from '../telegram/silent.js';
import { notifyTg, wakeNotice, type TgPost, type WakeNotice } from './dripNotice.js';
import { dripLoop } from './mailDrip.js';
import type { WindowDispatcher } from './windowDispatch.js';
import type { ReplyFactsState } from '../outreach/replyFacts.js';
import type { FactCheckFn } from '../outreach/emailReplies.js';
import type { StyleConfig } from '../safety/styleGate.js';
import { linkedinDripEnabled, linkedinDripLoop } from './linkedinDrip.js';
import { groupWakeSteps, runWakeThroughWindows } from './wakeWindows.js';
import { recordWakeResult, takeWakeRequest, type WakeRequest } from './wakeRequest.js';
import { matchThresholdFromEnv } from '../matchRubric.js';
import {
  adaptiveIntervalMin, readEmptyStreak, wakeIdleMaxMin, wakeMadeProgress, workFingerprint, writeEmptyStreak, type WorkFingerprint,
} from './adaptiveWake.js';
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
  projectRoot: string;
  notifier: Notifier;
  /** Code-sent Telegram notices (topics wakes, alerts, mail, linkedin). Absent: none. Never throws and never blocks long (src/scheduler/dripNotice.ts). */
  tg?: TgPost;
  newRunId: () => string;
  lockDeps?: LockDeps;
  control?: Pick<ControlDeps, 'exists' | 'read'>;
  session?: string; // tmux session for wake windows, default 'Jobber'
  /** Named LinkedIn discovery searches (config/linkedin-discovery.json); absent plans no discover task. */
  discoverSearches?: DiscoverSearches | (() => DiscoverSearches);
  /** The zero-LLM code pass over the script providers (runCodePass); absent means the stage is planned but not run. Never throws. */
  codePass?: () => Promise<CodePassResult>;
  /** Run the mail drip lane (src/scheduler/mailDrip.ts) beside the wakes in the daemon loop. Absent or false: no drip. */
  mailDrip?: boolean;
  /** Test seams of the email auto reply path (src/outreach/emailReplies.ts): the reply facts, the fact gate and the owner name. Absent: the real files. */
  emailReply?: { facts?: () => ReplyFactsState; factCheck?: FactCheckFn; ownerName?: string | null; styleCfg?: StyleConfig };
  /** Hands one work item to a long-lived worker window (src/scheduler/windowDispatch.ts): the ONLY way work reaches a model (mail drip, LinkedIn drip, reply check and every wake step). Absent: nothing is dispatched. */
  windows?: WindowDispatcher;
  /** One-time cleanup at daemon start of the retired headless design: kills leftover tmux windows named wake-* / drip-*. Never throws. Absent: none. */
  cleanupLegacyWindows?: () => Promise<void>;
  /** Run the LinkedIn drip lane (src/scheduler/linkedinDrip.ts) beside the wakes in the daemon loop. Absent or false: no LinkedIn drip. */
  linkedinDrip?: boolean;
  /** One tick of the owner's escalation digest (src/scheduler/escalationDigest.ts), run every 30 seconds beside the wakes in the daemon loop. Never throws. Absent: no digest. */
  escalationDigest?: () => Promise<void>;
  /** One tick of the window upkeep (src/scheduler/windowTick.ts: handoff reminders and window recycle), run every 30 seconds in the daemon loop. Never throws. Absent: none. */
  windowTick?: () => Promise<void>;
  /** Stage `manual`, run in code before the model session when a manual request is pending: ingests the requests (src/manual/ingest.ts). Never throws into the wake. */
  manualIngest?: (runId: string) => Promise<unknown>;
  /** After every wake that launched a session: reports finished manual requests to the owner (src/manual/report.ts finalizeManualRequests). */
  manualReport?: (runStatus: string) => Promise<unknown>;
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

const SLICE_MS = 30_000;

/**
 * A wake is dry only when JOBBER_DRY_RUN is `1` or `true`; unset or anything else is live.
 */
export function wakeIsDry(env: NodeJS.ProcessEnv): boolean {
  return isDryRun(env);
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

/** The steps of a wake planned without stages (legacy prompt): one Agent call per operator, proven by the final report or a completed call. */
function legacySteps(tasks: Assignment[]): Step[] {
  return tasks.map((a) => ({ operator: a.operator, platform: a.platform, kind: a.tasks[0]?.kind ?? 'inbox', quota: a.tasks[0]?.quota ?? 0 }));
}


async function inner(d: DriverDeps, opts: { force?: boolean; abort?: () => boolean }): Promise<WakeResult> {
  const quiet = quietFromConfig(d.cfg);
  const runId = d.newRunId();
  const dry = wakeIsDry(d.env);
  const trigger = opts.force ? 'forced' : 'scheduled';
  const drawNext = (): string => {
    const t = nextWake(d.now(), quiet, adaptiveIntervalMin(readEmptyStreak(d.db), wakeIdleMaxMin(d.env))).toISOString();
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
      id: runId, at, trigger, dryRun: dry, tasks: [], status: 'skipped', stopReason: sr,
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
      return { runId, status: 'skipped', reason, nextWakeAt: nextWake(d.now(), quiet).toISOString() };
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

  let status = 'running' as RunStatus;
  let stopReason = null as string | null;
  let started = false;
  let inboxPlanned = false;
  let nextWakeAt = '';
  let skippedResult: WakeResult | null = null;
  let wakeStartIso = '';
  let codePassNote: string | undefined;
  let reportCounts = null as WakeCounts | null;
  let windowsRan = false;
  let fpBefore = null as WorkFingerprint | null;

  try {
    // (4) plan
    let decision: WakeDecision;
    try {
      const now = d.now();
      decision = planWake({
        now, quiet, control,
        ceilings: ceilings(d.db, d.cfg, now),
        due: countDue(d.db, now, d.tuning, d.env),
        knobs: loadPlanKnobs(d.env),
        discoverSearches: typeof d.discoverSearches === 'function' ? d.discoverSearches() : d.discoverSearches,
        codePassEnabled: !!d.codePass,
        linkedinActive: linkedinActiveNow(d.env, now),
        linkedinDrip: linkedinDripEnabled(d.env),
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
      id: runId, at: startAt, trigger, dryRun: dry, tasks: decision.tasks, status: 'running',
    });
    started = true;
    fpBefore = workFingerprint(d.db);
    wakeStartIso = startAt.toISOString();
    // Stage 0 (manual requests) and stage 1 run in code, before the model session: failures are noticed but never stop the wake.
    // Ingest and the code pass can outlast the lock TTL (120 s): keep the lock fresh while they run.
    const lockBeat = setInterval(() => { try { lock.heartbeat(); } catch { /* ignore */ } }, 30_000);
    lockBeat.unref?.();
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
    clearInterval(lockBeat);
    const order = decision.stages?.length ? stepOrder(decision) : undefined;
    const steps: Step[] = order ?? legacySteps(decision.tasks);
    const pipelineInput = order ? {
      matchThreshold: matchThresholdFromEnv(d.env),
      sendLimit: boundedEnvInt(d.env.SEND_LIMIT_PER_RUN, 0, 100, 1),
      targetRegions: targetRegionsLine(d.projectRoot),
      northStar: northStarPromptLine(d.env, d.projectRoot),
      followupsAutonomous: d.env.FOLLOWUPS_AUTONOMOUS === 'true',
      codePass,
      jdLine: ((): string => { try { return jdReportLine(d.db, startAt); } catch { return ''; } })(),
    } : undefined;
    // The steps go to the long-lived windows (src/scheduler/wakeWindows.ts). There is no headless path: a forced wake (a /runhunt request read by
    // this daemon) takes exactly the same road, only the recorded trigger differs.
    const claimInstructions = (): OwnerInstruction[] => { try { return claimPending(d.db, startAt); } catch { return []; } };
    const r = await runWakeThroughWindows({
      d, runId, dry, budget, now: startAt, allowed: control.allowed,
      items: groupWakeSteps(steps),
      pipelineInput, claimInstructions,
      stopCheck: () => {
        if (opts.abort?.()) return 'shutdown';
        let ctl: ControlState | null = null;
        try { ctl = readControl(d.db, controlDeps(d)); } catch { ctl = null; }
        if (!ctl || ctl.killed) return 'kill_switch';
        if (inQuietHours(d.now(), quiet)) return 'quiet_hours';
        return null;
      },
      heartbeat: () => {
        lock.heartbeat();
        try { d.heartbeat?.(); } catch { /* ignore */ }
      },
    });
    status = r.status;
    stopReason = r.stopReason;
    reportCounts = r.counts;
    windowsRan = r.sessionRan;
    if (status === 'incomplete') await say(d, { level: 'warn', title: 'scheduler run incomplete', detail: stopReason ?? undefined, runId });
  } catch (e) {
    status = 'failed';
    stopReason = `error: ${safeMsg(e)}`;
  } finally {
    // (6) always: finish the row, release the lock, draw the next wake
    if (started) {
      try {
        if (status === 'running') status = 'failed';
        finishRun(d.db, runId, { at: d.now(), status, stopReason });
      } catch {
        // ignore
      }
      // Adaptive delay: an ok wake with no progress lengthens the next wait, any progress resets it; other endings leave the streak alone.
      if (status === 'ok') {
        const progress = wakeMadeProgress(reportCounts, fpBefore, workFingerprint(d.db));
        writeEmptyStreak(d.db, progress ? 0 : readEmptyStreak(d.db) + 1, d.now());
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
  if (started && windowsRan && d.manualReport) {
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
  if (started && d.tg) await wakeFinishedNotice(d, { runId, trigger, status, stopReason, startAt: wakeStartIso, counts: reportCounts, dry });
  return { runId, status, reason: stopReason ?? undefined, nextWakeAt };
}

function countSince(d: DriverDeps, sql: string, sinceIso: string): number | null {
  try {
    const row = d.db.prepare(sql).get(sinceIso) as { n: number } | undefined;
    return typeof row?.n === 'number' ? row.n : null;
  } catch {
    return null;
  }
}

/** The grouped numbers of one wake for its Telegram summary (each optional; a failing query just leaves the group out). */
function wakeGroups(d: DriverDeps, sinceIso: string): Partial<WakeNotice> {
  const out: Partial<WakeNotice> = {};
  const threshold = matchThresholdFromEnv(d.env);
  try {
    const rows = buildSourceRows(d.db, sinceIso).filter((r) => r.ran);
    if (rows.length) {
      out.sources = {
        ran: rows.length, fetched: rows.reduce((n, r) => n + r.fetched, 0), fresh: rows.reduce((n, r) => n + r.new, 0),
        errors: rows.reduce((n, r) => n + r.errors, 0), fallbacks: rows.filter((r) => r.fallback_used).length,
      };
    }
  } catch { /* leave the group out */ }
  const q = (sql: string, ...args: unknown[]): number | null => {
    try { const row = d.db.prepare(sql).get(...args) as { n: number } | undefined; return typeof row?.n === 'number' ? row.n : null; } catch { return null; }
  };
  out.scored = q("SELECT COUNT(*) AS n FROM jobs WHERE score IS NOT NULL AND datetime(created_at) >= datetime(?)", sinceIso);
  out.matched = q("SELECT COUNT(*) AS n FROM jobs WHERE score >= ? AND excluded_reason IS NULL AND datetime(created_at) >= datetime(?)", threshold, sinceIso);
  out.prepared = q("SELECT COUNT(DISTINCT job_id) AS n FROM outreach_queue WHERE datetime(created_at) >= datetime(?)", sinceIso);
  out.emailsQueued = q("SELECT COUNT(*) AS n FROM outreach_queue WHERE email_to IS NOT NULL AND datetime(created_at) >= datetime(?)", sinceIso);
  out.connectsQueued = q("SELECT COUNT(*) AS n FROM outreach_queue WHERE connect_profile_url IS NOT NULL AND datetime(created_at) >= datetime(?)", sinceIso);
  out.appliesQueued = q("SELECT COUNT(*) AS n FROM outreach_queue WHERE apply_platform IS NOT NULL AND apply_platform <> 'none' AND datetime(created_at) >= datetime(?)", sinceIso);
  out.followups = q("SELECT COUNT(*) AS n FROM followups WHERE datetime(created_at) >= datetime(?)", sinceIso);
  return out;
}

/** One Telegram message for a wake that ran (zero LLM). Never throws. */
async function wakeFinishedNotice(
  d: DriverDeps,
  w: { runId: string; trigger: string; status: string; stopReason: string | null; startAt: string; counts: WakeCounts | null; dry: boolean },
): Promise<void> {
  try {
    const sec = w.startAt ? Math.max(0, Math.round((d.now().getTime() - Date.parse(w.startAt)) / 1000)) : null;
    const n = wakeNotice({
      runId: w.runId, trigger: w.trigger, status: w.status, reason: w.stopReason, durationSec: sec, counts: w.counts, dry: w.dry,
      newJobs: w.startAt ? countSince(d, 'SELECT COUNT(*) AS n FROM jobs WHERE datetime(created_at) >= datetime(?)', w.startAt) : null,
      queued: w.startAt ? countSince(d, 'SELECT COUNT(*) AS n FROM outreach_queue WHERE datetime(created_at) >= datetime(?)', w.startAt) : null,
      ...(w.startAt ? wakeGroups(d, w.startAt) : {}),
    });
    try { setState(d.db, 'wake_skip_notified', '', d.now()); } catch { /* ignore */ }
    // Loud when the wake did not end ok or something needs the owner (escalations); else the topic default (silent) applies.
    const loud = noticeUrgency({ failed: w.status !== 'ok', needsOwner: (w.counts?.escalated ?? 0) > 0 });
    if (n) await notifyTg(d, n.topic, n.text, undefined, loud);
  } catch {
    // a notice never breaks a wake
  }
}

/** A skipped wake is told once per reason (killed, halted, ceilings_exhausted); quiet_hours and nothing_due stay silent. */
async function wakeSkippedNotice(d: DriverDeps, r: WakeResult, trigger: string): Promise<void> {
  try {
    const n = wakeNotice({ runId: r.runId, trigger, status: 'skipped', reason: r.reason, dry: wakeIsDry(d.env) });
    if (!n) return;
    const code = (r.reason ?? '').split(':')[0] ?? '';
    if (getState(d.db, 'wake_skip_notified') === code) return;
    setState(d.db, 'wake_skip_notified', code, d.now());
    await notifyTg(d, n.topic, n.text, undefined, noticeUrgency({ halted: true }));
  } catch {
    // a notice never breaks a wake
  }
}

export async function wakeOnce(
  d: DriverDeps,
  opts: { force?: boolean; abort?: () => boolean } = {},
): Promise<WakeResult> {
  const r = await inner(d, opts);
  if (r.status === 'skipped' && d.tg) await wakeSkippedNotice(d, r, opts.force ? 'forced' : 'scheduled');
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

async function digestLoop(d: DriverDeps, stop: { stopped: boolean }): Promise<void> {
  while (!stop.stopped) {
    try {
      await d.escalationDigest?.();
    } catch {
      // the digest never stops the scheduler
    }
    if (stop.stopped) break;
    await d.sleep(SLICE_MS);
  }
}

async function windowTickLoop(d: DriverDeps, stop: { stopped: boolean }): Promise<void> {
  while (!stop.stopped) {
    try {
      await d.windowTick?.();
    } catch {
      // the window upkeep never stops the scheduler
    }
    if (stop.stopped) break;
    await d.sleep(SLICE_MS);
  }
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
  for (const w of budgetEnvWarnings(d.env)) await say(d, { level: 'warn', title: `scheduler config: ${w}` });
  const quiet = quietFromConfig(d.cfg);
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
  let liDrip: Promise<void> | null = null;
  let digest: Promise<void> | null = null;
  let upkeep: Promise<void> | null = null;
  try {
    // Orphans from a previous daemon: kill their windows BEFORE marking them crashed, unless a live
    // run lock shows another process owns a run right now (then leave its rows untouched).
    if (peekLock(d.lockRoot, 'run', d.lockDeps) === null) {
      // One-time cleanup of the retired headless design: leftover wake-* / drip-* tmux windows and the old unkilled_window marker.
      try { await d.cleanupLegacyWindows?.(); } catch { /* best effort */ }
      try { if (getState(d.db, 'unkilled_window')) setState(d.db, 'unkilled_window', '', d.now()); } catch { /* ignore */ }
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
    // Daemon start is new work: the idle streak resets and a wake time that was only stretched by that streak is pulled in to the base interval.
    const streakAtStart = readEmptyStreak(d.db);
    writeEmptyStreak(d.db, 0, d.now());
    if (next && streakAtStart > 0) {
      const soonest = nextWake(d.now(), quiet);
      if (soonest.getTime() < next.getTime()) {
        next = soonest;
        try { setState(d.db, 'next_wake_at', soonest.toISOString(), d.now()); } catch { /* ignore */ }
      }
    }
    if (!next) {
      next = nextWake(d.now(), quiet);
      try {
        setState(d.db, 'next_wake_at', next.toISOString(), d.now());
      } catch {
        // ignore
      }
    }
    // New jobs saved by anything while the wake wait is stretched (a drip lane, an owner import) end the stretch: wake at the base interval.
    let jobsSeen = workFingerprint(d.db).jobs;
    const pullInOnNewJobs = (): void => {
      const j = workFingerprint(d.db).jobs;
      const prev = jobsSeen;
      if (j !== null) jobsSeen = j;
      if (j === null || prev === null || j <= prev || readEmptyStreak(d.db) === 0) return;
      writeEmptyStreak(d.db, 0, d.now());
      const soonest = nextWake(d.now(), quiet);
      if (next && soonest.getTime() < next.getTime()) {
        next = soonest;
        try { setState(d.db, 'next_wake_at', soonest.toISOString(), d.now()); } catch { /* ignore */ }
      }
    };
    let stopSeen = stopPresent();
    // The mail drip lane runs beside the wakes (its own `mail` lock), so a long wake never pauses the slow email trickle.
    drip = deps.mailDrip ? dripLoop(deps, stop) : null;
    // The LinkedIn drip lane (its own `linkedin` lock): one slow LinkedIn action at a time, so wakes never burst on LinkedIn.
    liDrip = deps.linkedinDrip ? linkedinDripLoop(deps, stop) : null;
    // New escalations reach the owner on Telegram even while a long wake runs, so the digest has its own loop too.
    digest = deps.escalationDigest ? digestLoop(deps, stop) : null;
    // Handoff reminders and window recycle (zero LLM), also in their own loop.
    upkeep = deps.windowTick ? windowTickLoop(deps, stop) : null;
    // A manual request must not wait for the next random wake: every slice (30 s) the daemon checks for a pending one and wakes early,
    // outside quiet hours, at most once per backoff. The regular wake schedule (`next`) is left alone.
    let manualBackoffUntil = 0;
    const manualWakeDue = (): boolean => {
      const t = d.now();
      if (t.getTime() < manualBackoffUntil || inQuietHours(t, quiet)) return false;
      try {
        return manualRequestsPending(d.db) > 0;
      } catch {
        return false;
      }
    };
    while (!stop.stopped) {
      let woke = false;
      let manualWake = false;
      let requested = null as WakeRequest | null;
      while (!stop.stopped) {
        // An owner `/runhunt` (or `./run-hunt.sh`) request: one forced wake through the windows, taken before the clock; every wake gate still applies.
        const wakeReq = takeWakeRequest(d.db, d.now());
        if (wakeReq) {
          requested = wakeReq;
          woke = true;
          manualWake = true;
          break;
        }
        if (manualWakeDue()) {
          woke = true;
          manualWake = true;
          break;
        }
        pullInOnNewJobs();
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
      // An owner request or a pending manual request is new work: reset the idle streak before the wake plans.
      const wasStretched = manualWake && readEmptyStreak(d.db) > 0;
      if (manualWake) writeEmptyStreak(d.db, 0, d.now());
      const r = await wakeOnce(deps, { abort: () => stop.stopped, ...(requested ? { force: true } : {}) });
      if (requested) {
        recordWakeResult(d.db, requested, { status: r.status, reason: r.reason, runId: r.runId }, d.now());
        requested = null;
      }
      if (manualWake) {
        // Keep the regular schedule: the wake drew a new next_wake_at, put the old one back.
        manualBackoffUntil = d.now().getTime() + (r.status === 'ok' ? 60_000 : 300_000);
        // When the old wait was only stretched by the idle streak, take the wake's own draw if it is sooner (the owner work reset the streak).
        const drawn = Date.parse(r.nextWakeAt);
        if (wasStretched && Number.isFinite(drawn) && drawn < next.getTime()) next = new Date(drawn);
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
    if (liDrip) await liDrip;
    if (digest) await digest;
    if (upkeep) await upkeep;
    try {
      dl.release();
    } catch {
      // ignore
    }
  }
}
