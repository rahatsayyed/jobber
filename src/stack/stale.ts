// src/stack/stale.ts
// `npm run up` recycles an IDLE worker window that was started before the role became part of its system prompt, or whose role
// file changed since (the role hash in .jobber/window-start/<window>.json differs, see src/platform/windowRole.ts). A busy window
// (dispatcher lock held, or any pane or transcript activity in the last IDLE_MS) is never touched: it keeps running with the old role and
// is picked up by a later `npm run up` or by the normal recycle tick. Nothing happens while the kill switch is on.
import { statSync } from 'node:fs';
import { IDLE_MS, restartWindow, sessionName, typeStartup, type ManagerConfig, type StartupOpts, type StartupState } from '../platform/manager.js';
import { listWindows, type Run } from '../platform/tmux.js';
import { windowActivityMs } from '../platform/windowAge.js';
import { takeWindowLock, windowLockHeld } from '../platform/windowLock.js';
import { roleIsStale } from '../platform/windowRole.js';
import { windowTranscript } from '../platform/windowSession.js';

export interface StaleRoleDeps {
  root: string;
  killed: () => boolean;
  now?: () => number;
  claudeHome?: string;
  startup?: StartupOpts;
}

export type StaleRoleResult =
  | { status: 'restarted'; startup: StartupState }
  | { status: 'skipped'; reason: string };

/** One worker window: restart it when its recorded role is old and it is idle. Never throws for a skip reason. */
export async function recycleStaleRoleWindow(
  run: Run, cfg: ManagerConfig, env: NodeJS.ProcessEnv, name: string, d: StaleRoleDeps,
): Promise<StaleRoleResult> {
  const skip = (reason: string): StaleRoleResult => ({ status: 'skipped', reason });
  const w = Object.hasOwn(cfg.windows, name) ? cfg.windows[name] : undefined;
  if (w?.kind !== 'worker') return skip('not_worker');
  const session = sessionName(cfg, env);
  if (!(await listWindows(run, session)).some((x) => x.name === name)) return skip('absent');
  if (!roleIsStale(d.root, name)) return skip('role_current');
  if (d.killed()) return skip('killed');
  if (windowLockHeld(d.root, name)) return skip('busy');
  const lock = takeWindowLock(d.root, name, `stale-role:${name}`);
  if (!lock) return skip('busy');
  try {
    const now = (d.now ?? Date.now)();
    const seen: number[] = [];
    const pane = await windowActivityMs(run, session, name);
    if (pane !== null) seen.push(pane);
    const tr = windowTranscript(d.root, name, d.claudeHome);
    if (tr) {
      try { seen.push(statSync(tr).mtimeMs); } catch { /* no transcript yet */ }
    }
    if (seen.length === 0) return skip('activity_unknown');
    if (now - Math.max(...seen) < IDLE_MS) return skip('active');
    if (d.killed()) return skip('killed');
    await restartWindow(run, cfg, env, name, d.root);
    return { status: 'restarted', startup: await typeStartup(run, cfg, env, name, d.root, d.startup) };
  } finally {
    lock.release();
  }
}
