// src/scheduler/windowReady.ts
// Windows are the ONLY execution path (no headless `claude -p`). When a worker window is missing or is not a claude pane at dispatch
// time, the scheduler starts it through the manager startWindow path (startup line included), waits a bounded time for a claude pane,
// and only then types the item. If it still cannot, the caller SKIPS the item (nothing runs anywhere else), writes a handoff entry and
// the owner gets at most one loud `alerts` notice per hour per window (noteWindowUnavailable). Never double-runs: nothing is typed
// unless a claude pane is confirmed.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { noteSkippedItem } from '../platform/handoff.js';
import { loadManagerConfig, sessionName, startWindowWithMemory } from '../platform/manager.js';
import { assertClaudePane, killWindow, listWindows, type Run } from '../platform/tmux.js';
import { E, clean, code, headline, html, i as ital, line, lines } from '../platform/tgHtml.js';
import { notifyTg, type HasTg } from './dripNotice.js';
import { getState, setState } from './runLog.js';

/** How many 1 second tries the start waits for a claude pane (claude can take a while to start). */
export const READY_TRIES = 60;
export const ALERT_EVERY_MS = 60 * 60_000;

export interface EnsureReadyOpts {
  root: string;
  env: NodeJS.ProcessEnv;
  run: Run;
  tries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Returns the `ensureReady` function of the WindowDispatcher: 'ready', or a short reason (`not_a_worker`, `config_unreadable`,
 * `start_failed`, `not_ready`). One start per window at a time (a second caller waits for the first).
 */
export function makeEnsureReady(o: EnsureReadyOpts): (window: string) => Promise<string> {
  const inflight = new Map<string, Promise<string>>();
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tries = o.tries ?? READY_TRIES;
  const once = async (window: string): Promise<string> => {
    let cfg;
    try {
      cfg = loadManagerConfig(readFileSync(path.join(o.root, 'config', 'manager-windows.json'), 'utf8'));
    } catch {
      return 'config_unreadable';
    }
    if (!Object.hasOwn(cfg.windows, window) || cfg.windows[window].kind !== 'worker') return 'not_a_worker';
    const session = sessionName(cfg, o.env);
    try {
      await startWindowWithMemory(o.run, cfg, o.env, window, o.root, { tries, intervalMs: 1000, sleep });
    } catch {
      return 'start_failed';
    }
    // startWindowWithMemory types the startup line only when it started the window; either way the pane must now be claude.
    for (let n = 0; n < tries; n++) {
      try {
        await assertClaudePane(o.run, session, window);
        return 'ready';
      } catch {
        await sleep(1000);
      }
    }
    return 'not_ready';
  };
  return (window) => {
    const cur = inflight.get(window);
    if (cur) return cur;
    const p = once(window).finally(() => inflight.delete(window));
    inflight.set(window, p);
    return p;
  };
}

/**
 * One-time cleanup at scheduler start: the retired headless design left tmux windows named `wake-<id>` and `drip-*`. They are killed here
 * (only those names; never a worker window). Returns the names killed. Never throws.
 */
export async function killLegacyWindows(run: Run, session: string): Promise<string[]> {
  const killed: string[] = [];
  try {
    for (const w of await listWindows(run, session)) {
      if (!/^(wake|drip)-/.test(w.name)) continue;
      try { await killWindow(run, session, w.name); killed.push(w.name); } catch { /* best effort */ }
    }
  } catch { /* no session: nothing to clean */ }
  return killed;
}

export interface UnavailableDeps extends HasTg {
  db: BetterSqlite3.Database;
  projectRoot: string;
  now: () => Date;
}

/**
 * An item that could not be typed because its window is not usable: one handoff entry (same text while pending: no second entry) and one loud
 * `alerts` notice per hour per window. Never throws.
 */
export async function noteWindowUnavailable(d: UnavailableDeps, window: string, item: string, reason: string): Promise<void> {
  try {
    noteSkippedItem(d.projectRoot, { window, item, reason: `window unavailable (${reason}); stays due` });
  } catch { /* advisory */ }
  try {
    const key = `window_unavailable_alert_${window}`;
    const now = d.now();
    const last = Date.parse(getState(d.db, key) ?? '');
    if (Number.isFinite(last) && now.getTime() - last < ALERT_EVERY_MS) return;
    setState(d.db, key, now.toISOString(), now);
    await notifyTg(d, 'alerts', html(lines([
      headline(E.warn, `Window ${window} is not available`),
      line('Item skipped', clean(item, 120)),
      line('Why', clean(reason, 80)),
      ital('Nothing was run anywhere else. The item stays due and is tried again. Look at the window with: tmux attach -t Jobber'),
      line('Start it by hand', code(`npx tsx scripts/manager.ts start ${window}`)),
      ital('At most one notice like this per hour per window.'),
    ])), undefined, false);
  } catch { /* a notice never breaks the lane */ }
}
