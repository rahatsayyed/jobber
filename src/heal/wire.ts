// src/heal/wire.ts
// Builds the real HealDeps (git and tmux through defaultRun, the alerts topic through the Telegram notifier, the session names).
// Shared by the scheduler daemon and the owner CLI so both act the same way.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { loadManagerConfig, sessionName } from '../platform/manager.js';
import { telegramNotifier } from '../platform/notify.js';
import { defaultRun, JOBBER_TMUX_SESSION } from '../platform/tmux.js';
import type { HealDeps } from './land.js';

export function windowSessionOf(root: string, env: NodeJS.ProcessEnv): string {
  try {
    return sessionName(loadManagerConfig(readFileSync(path.join(root, 'config', 'manager-windows.json'), 'utf8')), env);
  } catch {
    return JOBBER_TMUX_SESSION;
  }
}

export function makeHealDeps(o: { root: string; env: NodeJS.ProcessEnv; db: BetterSqlite3.Database; killed: () => boolean }): HealDeps {
  return {
    root: o.root,
    env: o.env,
    run: defaultRun,
    db: o.db,
    now: () => new Date(),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    killed: o.killed,
    windowSession: windowSessionOf(o.root, o.env),
    stackSession: (o.env.STACK_TMUX_SESSION ?? '').trim() || JOBBER_TMUX_SESSION,
    alert: (text, opts) => telegramNotifier(o.env).send(text, { topic: 'alerts', html: true, ...(opts?.silent !== undefined ? { silent: opts.silent } : {}) }),
  };
}
