// src/scheduler/wakeWindows.ts
// The WAKE through the long-lived worker windows. This is THE wake: there is no headless `claude -p` session, no residual session, no
// `--resume` continuation. planWake, the code pass, the manual-request ingest, the run lock, quiet hours, halts, ceilings, the kill switch,
// the usage backoff and the dry-run flag all stay in the driver. Only the EXECUTION of the planned steps lives here:
//   - the steps (in stepOrder) are grouped by owning window: sources = discover_agent; linkedin = every LinkedIn step; boards = every Naukri
//     and Wellfound step; pipeline = the pipeline stage (sweep, reply check, match, vetoes, contacts, prepare, follow-up drafts); apply =
//     apply-operator. Code steps (manual, discover_scripts) already ran and are in no item.
//   - consecutive steps of one window are one work item; between two barrier steps (sources, pipeline, apply) the platform steps of
//     different platforms are independent, so one window's steps of that stretch are put together (fewer /clear round trips).
//   - each item goes to its window through WindowDispatcher.dispatch (one at a time, in order), then finish() types /clear. A window that is
//     missing or not a claude pane is started first (dispatcher ensureReady, bounded wait); when it still cannot be used the item is SKIPPED
//     (nothing runs anywhere else), a handoff entry is written and the owner gets one `alerts` notice per hour. The plan is DB-driven, so the
//     unfinished work is due again at the next wake.
//   - a busy window (for example the linkedin window working a drip item) is waited for up to WAKE_WINDOW_WAIT_MS, then the item is SKIPPED
//     the same way (handoff entry, stays due).
//   - an incomplete item is recorded `incomplete` and never continued. usage_limit sets the backoff and stops the rest of the wake; killed
//     and quiet hours stop the dispatching.
// Page, post and transcript text is untrusted: only the last assistant text (already redacted by the dispatcher) is parsed for the JSON line.
import type { OwnerInstruction } from '../owner/instructions.js';
import { noteSkippedItem } from '../platform/handoff.js';
import { redactPane } from '../platform/redact.js';
import type { Budget } from './budget.js';
import type { Platform } from './control.js';
import type { DriverDeps } from './driver.js';
import type { Step } from './plan.js';
import type { PipelinePromptInput } from './pipeline.js';
import { buildWakePrompt } from './prompt.js';
import { setState, type RunStatus } from './runLog.js';
import { describeStep, reportFromText, unprovenSteps, type WakeCounts } from './stream.js';
import type { DispatchResult } from './windowDispatch.js';
import { noteWindowUnavailable } from './windowReady.js';
import { windowStartedLive } from './wakeWindowStart.js';

/** The lane name of every item row, and the scheduler_runs trigger of every item row. */
export const WAKE_LANE = 'wake';
export const WAKE_TRIGGER = 'wake';
/** The windows of the wake; `linkedin` is also the LinkedIn drip window. */
export const WAKE_WINDOWS = ['sources', 'pipeline', 'boards', 'apply'] as const;
export const LINKEDIN_WINDOW = 'linkedin';
/** How long a busy window is waited for before its item is skipped for this wake, and how often it is retried. */
export const WAKE_WINDOW_WAIT_MS = 10 * 60_000;
export const WAKE_WAIT_POLL_MS = 15_000;
const HEARTBEAT_MS = 30_000;
const MAX_REASON = 500;

/** One unit of work: the steps of one window, in order. */
export interface WakeItem { window: string; steps: Step[] }

/** Barrier steps keep their place in stepOrder: they depend on the stretches around them. */
const isBarrier = (s: Step): boolean => s.operator === 'source-operator' || s.operator === 'pipeline' || s.operator === 'apply-operator' || s.operator === 'mail-operator';

/** The window a step belongs to; null for a step that no window owns (code steps are filtered out before; `mail-operator` runs only in the mail drip lane). */
export function ownerWindow(s: Step): string | null {
  if (s.operator === 'source-operator') return 'sources';
  if (s.operator === 'pipeline') return 'pipeline';
  if (s.operator === 'apply-operator') return 'apply';
  if (s.operator === 'linkedin-operator') return LINKEDIN_WINDOW;
  if (s.operator === 'naukri-operator' || s.operator === 'wellfound-operator') return 'boards';
  return null;
}

/** Groups the wake order into work items by owning window. A step that no window owns is dropped (a wake never sends mail). */
export function groupWakeSteps(order: Step[]): WakeItem[] {
  const items: WakeItem[] = [];
  let segment = new Map<string, Step[]>();
  const flush = (): void => {
    for (const [k, steps] of segment) items.push({ window: k, steps });
    segment = new Map();
  };
  for (const s of order) {
    if (s.operator === 'code') continue;
    const w = ownerWindow(s);
    if (w === null) continue;
    if (isBarrier(s)) {
      flush();
      items.push({ window: w, steps: [s] });
    } else {
      segment.set(w, [...(segment.get(w) ?? []), s]);
    }
  }
  flush();
  // Merge neighbours of the same window (a barrier next to a stretch group of the same window).
  const merged: WakeItem[] = [];
  for (const it of items) {
    const last = merged[merged.length - 1];
    if (last && last.window === it.window) last.steps = [...last.steps, ...it.steps];
    else merged.push({ window: it.window, steps: [...it.steps] });
  }
  return merged;
}

export interface ItemOutcome {
  window: string | null;
  steps: string[];
  status: 'ok' | 'incomplete' | 'failed' | 'timeout' | 'skipped' | 'usage_limit' | 'killed';
  reason?: string;
  runId?: string;
}

export interface WakeWindowsCtx {
  d: DriverDeps;
  runId: string;
  dry: boolean;
  budget: Budget;
  now: Date;
  allowed: Platform[];
  items: WakeItem[];
  pipelineInput?: PipelinePromptInput;
  /** Claims the owner instructions; called only for the item that owns the pipeline. */
  claimInstructions: () => OwnerInstruction[];
  /** Between items: a reason to stop dispatching (`shutdown`, `kill_switch`, `quiet_hours`), or null. */
  stopCheck: () => string | null;
  heartbeat: () => void;
  waitMs?: number;
  waitPollMs?: number;
}

export interface WakeWindowsResult {
  status: RunStatus;
  stopReason: string | null;
  counts: WakeCounts | null;
  /** True when anything was typed into a window (the owner's manual-request report is due). */
  sessionRan: boolean;
  items: ItemOutcome[];
}

const addCounts = (a: WakeCounts | null, b: WakeCounts | null): WakeCounts | null =>
  !b ? a : !a ? { ...b } : { done: a.done + b.done, skipped: a.skipped + b.skipped, escalated: a.escalated + b.escalated, stopped: a.stopped + b.stopped };

const label = (steps: Step[]): string => steps.map((s, i) => describeStep(s, i).replace(/^\d+\. /, '')).join(', ');

function usageBackoff(d: DriverDeps, at: Date): string | null {
  const mins = Number(d.env.USAGE_LIMIT_BACKOFF_MIN);
  const until = new Date(at.getTime() + (Number.isInteger(mins) && mins >= 1 && mins <= 10080 ? mins : 300) * 60000).toISOString();
  try {
    setState(d.db, 'usage_backoff_until', until, at);
    return until;
  } catch {
    return null;
  }
}

/** Runs every item in order. Never throws (a failure of one item is recorded and the next item still runs). */
export async function runWakeThroughWindows(c: WakeWindowsCtx): Promise<WakeWindowsResult> {
  const { d } = c;
  const disp = d.windows;
  const outcomes: ItemOutcome[] = [];
  let counts: WakeCounts | null = null;
  let sessionRan = false;
  let stopStatus: RunStatus | null = null;
  let stopWhy: string | null = null;
  const sleep = d.sleep;
  const beat = setInterval(() => { try { c.heartbeat(); } catch { /* ignore */ } }, HEARTBEAT_MS);
  beat.unref?.();

  try {
    for (const item of c.items) {
      const names = item.steps.map((s, i) => describeStep(s, i));
      const stop = c.stopCheck();
      if (stop) {
        stopStatus = 'killed';
        stopWhy = stop;
        outcomes.push({ window: item.window, steps: names, status: 'skipped', reason: stop });
        break;
      }
      const w = item.window;
      if (!disp) {
        outcomes.push({ window: w, steps: names, status: 'skipped', reason: 'no_dispatcher' });
        continue;
      }
      if (windowStartedLive(d.projectRoot, w, c.dry)) {
        outcomes.push({ window: w, steps: names, status: 'skipped', reason: 'window_started_live_but_dry_run_now' });
        continue;
      }
      const ownsPipeline = item.steps.some((s) => s.operator === 'pipeline');
      const promptText = buildWakePrompt({
        runId: c.runId, dryRun: c.dry, tasks: [], budget: c.budget, allowed: c.allowed, now: c.now, order: item.steps,
        pipeline: c.pipelineInput, item: { window: w, selfRepair: ownsPipeline },
        instructions: ownsPipeline ? c.claimInstructions() : undefined,
      });
      const input = {
        window: w, lane: WAKE_LANE, trigger: WAKE_TRIGGER, dryRun: c.dry,
        item: { wake_run_id: c.runId, window: w, steps: names },
        promptText, deadlineMs: Math.min(c.budget.maxWallSec * 1000, 6 * 3600_000),
      };
      // A busy window is retried until the wait is over: dispatch refuses before it types anything.
      const waitMs = c.waitMs ?? WAKE_WINDOW_WAIT_MS;
      const pollMs = c.waitPollMs ?? WAKE_WAIT_POLL_MS;
      const t0 = d.now().getTime();
      let res: DispatchResult;
      for (;;) {
        res = await disp.dispatch(input);
        if (res.status !== 'unavailable' || res.stopReason !== 'window_busy') break;
        if (d.now().getTime() - t0 >= waitMs) break;
        const s = c.stopCheck();
        if (s) { res = { status: 'unavailable', stopReason: s, summary: '', toolCalls: 0 }; break; }
        try { c.heartbeat(); } catch { /* ignore */ }
        await sleep(pollMs);
      }

      if (res.status === 'unavailable' || !res.runId) {
        const why = res.stopReason;
        if (why === 'killed' || why === 'shutdown' || why === 'kill_switch' || why === 'quiet_hours') {
          outcomes.push({ window: w, steps: names, status: 'skipped', reason: why });
          stopStatus = 'killed';
          stopWhy = why;
          break;
        }
        outcomes.push({ window: w, steps: names, status: 'skipped', reason: why });
        if (why === 'usage_backoff') { stopStatus = 'incomplete'; stopWhy = 'usage_backoff'; break; }
        if (why.startsWith('window_unavailable')) {
          await noteWindowUnavailable(d, w, `wake steps ${label(item.steps)}`, why);
        } else {
          noteSkippedItem(d.projectRoot, { window: w, item: `wake steps ${label(item.steps)}`, reason: `${why}; due again at the next wake` });
        }
        continue;
      }

      // Typed: the work may have started. Reconcile from the dispatcher result; the DB-driven plan makes unfinished work due again.
      sessionRan = true;
      let outcome: ItemOutcome;
      if (res.status === 'ok') {
        const rep = reportFromText(res.summary, [c.runId]);
        if (rep) counts = addCounts(counts, rep.counts);
        const proof = unprovenSteps(item.steps, rep);
        if (!rep || proof.unproven.length > 0) {
          const list = proof.unproven.map((i) => describeStep(item.steps[i], i));
          outcome = {
            window: w, steps: names, status: 'incomplete', runId: res.runId,
            reason: `incomplete: ${rep ? '' : 'no final report line; '}unproven steps: ${list.length > 0 ? list.join(', ') : 'none listed'} (not continued)`,
          };
        } else outcome = { window: w, steps: names, status: 'ok', runId: res.runId };
      } else if (res.status === 'usage_limit') {
        const until = usageBackoff(d, d.now());
        try { await d.notifier.notify({ level: 'warn', title: 'scheduler usage limit reached, backing off', detail: until ? `until ${until}` : undefined, runId: c.runId }); } catch { /* never fatal */ }
        noteSkippedItem(d.projectRoot, { window: w, item: `wake steps ${label(item.steps)}`, reason: `usage limit${until ? `, backoff until ${until}` : ''}` });
        outcome = { window: w, steps: names, status: 'usage_limit', runId: res.runId, reason: `usage_limit${until ? ` until ${until}` : ''}` };
        stopStatus = 'usage_limit';
        stopWhy = outcome.reason ?? 'usage_limit';
      } else if (res.status === 'killed') {
        outcome = { window: w, steps: names, status: 'killed', runId: res.runId, reason: 'killed' };
        stopStatus = 'killed';
        stopWhy = 'kill_switch';
      } else if (res.status === 'timeout') {
        outcome = { window: w, steps: names, status: 'timeout', runId: res.runId, reason: `timeout: ${res.stopReason}` };
      } else if (res.status === 'stalled') {
        outcome = { window: w, steps: names, status: 'incomplete', runId: res.runId, reason: `stalled: ${res.stopReason} (not continued)` };
      } else {
        outcome = { window: w, steps: names, status: 'failed', runId: res.runId, reason: `failed: ${res.stopReason}` };
      }
      outcomes.push(outcome);
      try {
        await disp.finish(res.runId); // work file, /clear, window lock; best effort, never throws
      } catch { /* ignore */ }
      if (stopStatus) break;
    }
  } catch (e) {
    outcomes.push({ window: null, steps: [], status: 'failed', reason: `error: ${redactPane(e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 120)}` });
  } finally {
    clearInterval(beat);
  }

  // Aggregate. An item that did not end clean makes the wake `incomplete` (or `failed` when nothing ended clean).
  const notes = outcomes
    .filter((o) => o.status !== 'ok')
    .map((o) => `${o.window ?? 'wake'}: ${o.status}${o.reason ? ` (${o.reason})` : ''}`);
  let status: RunStatus;
  if (stopStatus) status = stopStatus;
  else if (outcomes.every((o) => o.status === 'ok')) status = 'ok';
  else if (outcomes.some((o) => o.status === 'ok')) status = 'incomplete';
  else status = outcomes.every((o) => o.status === 'failed') ? 'failed' : 'incomplete';
  const why = notes.length > 0 ? notes.join('; ') : (stopWhy ?? '');
  const reason = status === 'ok' ? null : why.slice(0, MAX_REASON);
  return { status, stopReason: reason, counts, sessionRan, items: outcomes };
}
