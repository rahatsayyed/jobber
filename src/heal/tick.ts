// src/heal/tick.ts
// The heal tick of the scheduler daemon (zero LLM calls itself; the fixer window is the only model step). Called about every 30 seconds
// from the daemon loop, it runs at most once a minute:
//   1. gates, like the lanes: HEAL_MODE off, the kill switch (which includes an `all` halt), the dry run: nothing at all
//   2. detection: scan the failure sources into the ledger (always, also during quiet hours and the usage backoff)
//   3. under the short `heal` lock: the watch pass (auto rollback), postponed or pending restarts, and in `auto` mode the landing of a
//      `ready` fix
//   4. a new heal when a signature is eligible (open, qualifying, outside its cooldown, under HEAL_MAX_PER_DAY, nothing else healing),
//      outside quiet hours and the usage backoff: one fixer at a time, run in the background so the tick (and a daemon stop) never wait
//      for it; a stale `healing` row is released after a few hours
// `suggest` mode stops before the merge: the fix waits as `ready` until the owner runs `npm run heal -- land <id>`.
import { acquireLock } from '../platform/lock.js';
import path from 'node:path';
import { getState } from '../scheduler/runLog.js';
import { healCooldownHours, healMaxPerDay, healMode } from './config.js';
import { ingestFailures } from './detect.js';
import { BACKOFF_KEY, runFixer, type FixerDispatcher } from './fixer.js';
import { landAttempt, pendingRestarts, runPendingRestart, watchPass, type HealDeps } from './land.js';
import { migrateHealTables, nextEligible, takeHealLock, type AttemptRow } from './ledger.js';

export interface HealTickDeps extends HealDeps {
  /** True for a dry run: nothing is detected, healed, landed or restarted. */
  dryRun: () => boolean;
  inQuiet: () => boolean;
  /** The window dispatcher (src/scheduler/windowDispatch.ts). Absent: no fixer is ever started (detection and landing still run). */
  windows?: FixerDispatcher;
  /** Minimum time between two full ticks (default 60 s). */
  everyMs?: number;
}

export interface HealTick {
  (): Promise<void>;
  /** Resolves when no fixer run is in flight (for tests and a clean exit). */
  idle(): Promise<void>;
}

const FIX_LOCK = 'heal-fix';

export function healTick(d: HealTickDeps): HealTick {
  let last = 0;
  let fixerJob: Promise<void> | null = null;
  try { migrateHealTables(d.db); } catch { /* the first tick tries again */ }

  const blockedByBackoff = (): boolean => {
    const now = d.now().getTime();
    for (const k of [BACKOFF_KEY, 'usage_backoff_until']) {
      try {
        const v = getState(d.db, k);
        if (v && Date.parse(v) > now) return true;
      } catch { /* ignore */ }
    }
    return false;
  };

  const step = async (): Promise<void> => {
    const mode = healMode(d.env);
    if (mode === 'off') return;
    if (d.killed() || d.dryRun()) return;
    migrateHealTables(d.db);
    ingestFailures(d.db, d.root, d.now());

    const lock = takeHealLock(d.root, 'heal-tick', 30 * 60_000);
    if (lock) {
      try {
        const deps: HealDeps = { ...d, beforeSelfRestart: () => { lock.release(); d.beforeSelfRestart?.(); } };
        await watchPass(deps);
        if (mode === 'auto') {
          const ready = d.db.prepare("SELECT * FROM heal_attempts WHERE outcome = 'ready' ORDER BY id ASC LIMIT 1").get() as AttemptRow | undefined;
          if (ready) await landAttempt(deps, ready.id);
        }
        const pend = pendingRestarts(d.db)[0];
        if (pend) await runPendingRestart(deps, pend.id);
      } finally {
        try { lock.release(); } catch { /* ignore */ }
      }
    }

    if (fixerJob || !d.windows || d.inQuiet() || blockedByBackoff()) return;
    const row = nextEligible(d.db, d.now(), { maxPerDay: healMaxPerDay(d.env), cooldownHours: healCooldownHours(d.env) });
    if (!row) return;
    const fixLock = acquireLock(path.join(d.root, '.jobber'), FIX_LOCK, 'heal-fixer', undefined, { ttlMs: 3 * 3600_000 });
    if (!fixLock) return;
    const windows = d.windows;
    fixerJob = (async () => {
      try {
        await runFixer({ ...d, mode }, windows, row);
      } catch { /* runFixer records its own failures */ } finally {
        try { fixLock.release(); } catch { /* ignore */ }
        fixerJob = null;
      }
    })();
  };

  const tick = (async () => {
    const now = d.now().getTime();
    if (now - last < (d.everyMs ?? 60_000)) return;
    last = now;
    try { await step(); } catch { /* the heal is a convenience: a failure must never stop the scheduler */ }
  }) as HealTick;
  tick.idle = async () => { while (fixerJob) await fixerJob; };
  return tick;
}
