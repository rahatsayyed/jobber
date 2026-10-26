// src/scheduler/hooks.ts
// Optional 7D tick hooks run after a wake (auto-update, backup). Feature-detected, off by default.
// The driver calls afterWake AFTER the run lock is released; a hook that does work must take the
// `run` lock itself (the updater does), so nothing here holds it. Errors are swallowed and
// reported as a warn notice with a fixed title only.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { inQuietHours, type QuietConfig } from '../outreach/quiet.js';
import type { WakeResult } from './driver.js';
import type { Notifier } from './notify.js';
import { getState, setState } from './runLog.js';

type Db = BetterSqlite3.Database;

export interface HookRunOpts { cwd: string; env: Record<string, string>; timeoutMs: number }
export type HookRun = (cmd: string, args: string[], opts: HookRunOpts) => Promise<{ code: number | null; timedOut?: boolean }>;

export interface HookDeps {
  db: Db;
  env: NodeJS.ProcessEnv;
  projectRoot: string;
  now: () => Date;
  quiet: QuietConfig;
  notifier: Notifier;
  exists?: (path: string) => boolean;
  run?: HookRun;
  // package.json scripts map, or null when unreadable. Default reads <projectRoot>/package.json.
  readScripts?: () => Record<string, string> | null;
}

interface HookSpec { id: string; script: string; enableEnv: string; npmScript: string; stateKey: string }

const HOOKS: HookSpec[] = [
  { id: 'auto-update', script: 'scripts/auto-update.ts', enableEnv: 'AUTO_UPDATE', npmScript: 'auto-update', stateKey: 'hook_auto_update_last_at' },
  { id: 'backup', script: 'scripts/backup.ts', enableEnv: 'BACKUP_ENABLED', npmScript: 'backup', stateKey: 'hook_backup_last_at' },
];

const DEFAULT_TIMEOUT_SEC = 120;
const DEFAULT_MIN_INTERVAL_MIN = 60;

function boundedInt(v: string | undefined, lo: number, hi: number, fallback: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
}

export const defaultHookRun: HookRun = (cmd, args, opts) =>
  new Promise((resolve) => {
    // No shell. A rejected or timed-out child resolves; it never throws.
    execFile(cmd, args, { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, shell: false }, (err) => {
      if (!err) return resolve({ code: 0 });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      resolve({ code: typeof e.code === 'number' ? e.code : null, timedOut: e.killed === true });
    });
  });

function hookEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'TZ', 'AUTO_UPDATE', 'BACKUP_ENABLED']) {
    const v = env[k];
    if (typeof v === 'string' && !/[\r\n\0]/.test(v)) out[k] = v;
  }
  return out;
}

export function makeAfterWakeHooks(deps: HookDeps): (r: WakeResult) => Promise<void> {
  const exists = deps.exists ?? existsSync;
  const run = deps.run ?? defaultHookRun;
  const readScripts =
    deps.readScripts ??
    ((): Record<string, string> | null => {
      try {
        const pkg = JSON.parse(readFileSync(join(deps.projectRoot, 'package.json'), 'utf8')) as {
          scripts?: Record<string, string>;
        };
        return pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : null;
      } catch {
        return null;
      }
    });
  return async (r: WakeResult): Promise<void> => {
    if (r.status === 'killed' || (r.status === 'skipped' && r.reason === 'killed')) return;
    const now = deps.now();
    if (inQuietHours(now, deps.quiet)) return;
    const timeoutMs = boundedInt(deps.env.SCHEDULER_HOOK_TIMEOUT_SEC, 30, 3600, DEFAULT_TIMEOUT_SEC) * 1000;
    const minMs = boundedInt(deps.env.HOOK_MIN_INTERVAL_MIN, 1, 1440, DEFAULT_MIN_INTERVAL_MIN) * 60_000;
    for (const h of HOOKS) {
      try {
        if (deps.env[h.enableEnv] !== 'true') continue;
        if (!exists(join(deps.projectRoot, h.script))) continue;
        const scripts = readScripts();
        if (!scripts || typeof scripts[h.npmScript] !== 'string') continue;
        const last = getState(deps.db, h.stateKey);
        const lastMs = last ? Date.parse(last) : NaN;
        if (Number.isFinite(lastMs) && now.getTime() - lastMs < minMs) continue;
        // Recorded before the run so a failing or hanging tick is still throttled.
        setState(deps.db, h.stateKey, now.toISOString(), now);
        const res = await run('npm', ['run', h.npmScript, '--', '--tick'], {
          cwd: deps.projectRoot, env: hookEnv(deps.env), timeoutMs,
        });
        if (res.code !== 0 || res.timedOut) {
          await deps.notifier.notify({ level: 'warn', title: `scheduler ${h.id} tick failed` });
        }
      } catch {
        try {
          await deps.notifier.notify({ level: 'warn', title: `scheduler ${h.id} tick failed` });
        } catch {
          // never fatal
        }
      }
    }
  };
}
