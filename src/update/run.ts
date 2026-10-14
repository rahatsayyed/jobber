import type { Exec } from '../lib/exec.js';
import type { Notifier } from '../platform/notify.js';
import type { ApplyOptions, ApplyOutcome } from './apply.js';
import type { UpdateConfig } from './config.js';
import type { LockPort } from './lockAdapter.js';
import { formatNotification, sanitizeLine } from './notes.js';
import { planUpdate, type RepoFacts, type UpdatePlan } from './plan.js';
import { isDue, pickRunTime, type QuietWindow, type Rng } from './schedule.js';
import { recordResult, type Outcome, type UpdateState } from './state.js';

export interface RunDeps {
  cfg: UpdateConfig;
  exec: Exec;
  root: string;
  now: () => Date;
  rng: Rng;
  lock: LockPort;
  notify: Notifier;
  apply: (plan: Extract<UpdatePlan, { action: 'apply' }>, o: ApplyOptions) => Promise<ApplyOutcome>;
  gather: () => Promise<RepoFacts>;
  state: { load(): UpdateState; save(s: UpdateState): void };
  quiet: QuietWindow;
  // Tick mode only: hand a due update to a detached child instead of applying inline.
  detach?: () => void;
}
export interface RunOptions { mode: 'tick' | 'now'; dryRun: boolean }

export async function runUpdate(deps: RunDeps, o: RunOptions): Promise<{ outcome: Outcome; detail: string }> {
  const tick = o.mode === 'tick';
  if (tick) {
    if (!deps.cfg.enabled) return { outcome: 'noop', detail: 'disabled' };
    if (!isDue(deps.now(), deps.state.load().next_run_at, deps.quiet)) return { outcome: 'noop', detail: 'not due' };
  }

  const reschedule = (s: UpdateState): UpdateState =>
    tick ? { ...s, next_run_at: pickRunTime(deps.now(), deps.rng, deps.quiet).toISOString() } : s;

  const record = (outcome: Outcome, from: string, to: string | null, reason: string | null, step: string | null): void => {
    const rec = { at: deps.now().toISOString(), outcome, from, to, reason, step };
    try {
      deps.state.save(reschedule(recordResult(deps.state.load(), rec)));
    } catch {
      // state not writable: the notification still goes out
    }
  };

  const notifyOnce = async (text: string): Promise<void> => {
    try { await deps.notify.send(text); } catch { /* never fatal */ }
  };

  const handle = await deps.lock.acquire();
  if (handle === null) {
    const reason = 'lock-held: another run holds the lock';
    record('skipped', 'unknown', null, reason, null);
    await notifyOnce(formatNotification({
      outcome: 'skipped', from: 'unknown', to: null, reason, step: null, commits: [], flags: [],
      dryRun: o.dryRun, restartNeeded: false,
    }));
    return { outcome: 'skipped', detail: reason };
  }

  try {
    let facts: RepoFacts;
    try {
      facts = await deps.gather();
    } catch (e) {
      const reason = sanitizeLine(e instanceof Error ? e.message : 'unknown error', 160);
      record('error', 'unknown', null, reason, 'gather');
      await notifyOnce(formatNotification({
        outcome: 'error', from: 'unknown', to: null, reason, step: 'gather', commits: [], flags: [],
        dryRun: o.dryRun, restartNeeded: false,
      }));
      return { outcome: 'error', detail: reason };
    }

    const plan = planUpdate(facts, deps.cfg, { ignoreEnabled: !tick });

    if (plan.action === 'noop') {
      record('noop', plan.head, null, null, null);
      return { outcome: 'noop', detail: 'up to date' };
    }
    if (plan.action === 'skip') {
      const reason = `${plan.reason}: ${plan.detail}`;
      record('skipped', plan.head, null, reason, null);
      await notifyOnce(formatNotification({
        outcome: 'skipped', from: plan.head, to: null, reason, step: null, commits: [], flags: [],
        dryRun: o.dryRun, restartNeeded: false,
      }));
      return { outcome: 'skipped', detail: reason };
    }

    if (tick && !o.dryRun && deps.detach) {
      deps.detach();
      return { outcome: 'noop', detail: 'update handed to a detached run' };
    }

    try {
      const r = await deps.apply(plan, { dryRun: o.dryRun });
      if (tick) {
        try { deps.state.save(reschedule(deps.state.load())); } catch { /* ignore */ }
      }
      return { outcome: r.outcome, detail: r.reason ?? r.step ?? '' };
    } catch (e) {
      const reason = sanitizeLine(e instanceof Error ? e.message : 'unknown error', 160);
      record('error', plan.from, plan.to, reason, 'apply');
      await notifyOnce(formatNotification({
        outcome: 'error', from: plan.from, to: plan.to, reason, step: 'apply', commits: plan.commits, flags: [],
        dryRun: o.dryRun, restartNeeded: false,
      }));
      return { outcome: 'error', detail: reason };
    }
  } finally {
    try { await handle.release(); } catch { /* lock lost or already gone */ }
  }
}
