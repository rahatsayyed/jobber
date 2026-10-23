// src/scheduler/control.ts
// Kill switch and halt-flag control state. Fails closed: any unreadable source means killed.
import { writeFileSync, mkdirSync, rmSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { haltPlatform, clearHalt } from '../outreach/limits.js';

type Db = BetterSqlite3.Database;

export type Platform = 'linkedin' | 'naukri' | 'wellfound';
export const PLATFORMS: Platform[] = ['linkedin', 'naukri', 'wellfound'];
export const DEFAULT_STOP_FILE = '.jobber/STOP';
const MAX_REASON = 200;
const NO_REASON = 'halt flag set (no reason)';

export interface ControlState {
  killed: boolean;
  killReason: string | null;
  halted: Record<Platform, string | null>;
  allowed: Platform[];
  readError: string | null;
}

export interface ControlDeps {
  stopFile: string;
  env: NodeJS.ProcessEnv;
  exists: (p: string) => boolean;
  read: (p: string) => string;
}

/** true if the path exists, false only on ENOENT, any other stat error is rethrown. */
export function statExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

export function defaultDeps(env: NodeJS.ProcessEnv = process.env, stopFile = DEFAULT_STOP_FILE): ControlDeps {
  return {
    stopFile,
    env,
    exists: (p) => statExists(p),
    read: (p) => readFileSync(p, 'utf8'),
  };
}

function trunc(s: string, max = MAX_REASON): string {
  return s.length > max ? s.slice(0, max) : s;
}

// Read-only: any active row (cleared_at IS NULL) is a halt, even with an empty reason.
function activeHalt(db: Db, platform: string): string | null {
  const row = db
    .prepare('SELECT reason FROM halt_flags WHERE platform = ? AND cleared_at IS NULL')
    .get(platform) as { reason: string | null } | undefined;
  if (!row) return null;
  return row.reason && row.reason.trim() ? row.reason : NO_REASON;
}

export function readControl(db: Db, deps: ControlDeps): ControlState {
  const halted: Record<Platform, string | null> = { linkedin: null, naukri: null, wellfound: null };
  const reasons: string[] = [];
  const errors: string[] = [];

  try {
    if (deps.exists(deps.stopFile)) {
      let text = '';
      try {
        text = deps.read(deps.stopFile).split('\n')[0].trim();
      } catch (e) {
        errors.push(`STOP file unreadable: ${(e as Error).message}`);
      }
      reasons.push(`STOP file${text ? `: ${trunc(text, 80)}` : ''}`);
    }
  } catch (e) {
    errors.push(`STOP file unreadable: ${(e as Error).message}`);
  }

  if (deps.env.JOBBER_KILL === '1') reasons.push('JOBBER_KILL=1');

  try {
    const all = activeHalt(db, 'all');
    if (all !== null) reasons.push(`halt all: ${trunc(all, 80)}`);
    for (const p of PLATFORMS) halted[p] = activeHalt(db, p);
  } catch (e) {
    errors.push(`halt flags unreadable: ${(e as Error).message}`);
  }

  const readError = errors.length ? trunc(errors.join('; ')) : null;
  const parts = [...reasons, ...errors.map((m) => trunc(m, 60))];
  const killed = parts.length > 0;
  return {
    killed,
    killReason: killed ? trunc(parts.join('; ')) : null,
    halted,
    allowed: killed ? [] : PLATFORMS.filter((p) => halted[p] === null),
    readError,
  };
}

export function setStop(
  stopFile: string,
  reason: string,
  now: Date,
  write: typeof writeFileSync = writeFileSync,
): void {
  mkdirSync(dirname(stopFile), { recursive: true });
  write(stopFile, `${trunc(reason.replace(/\s+/g, ' ').trim())}\n${now.toISOString()}\n`);
}

/** Fixed prefix on every halt reason and STOP reason the CLI writes; resume clears only these. */
export const STOP_PREFIX = 'jobber-control stop: ';
export const HALT_TARGETS = ['all', 'linkedin', 'naukri', 'wellfound'] as const;

/** The STOP file path for a project root (the scheduler daemon uses the same one). */
export function stopFileForRoot(projectRoot: string): string {
  return join(projectRoot, '.jobber', 'STOP');
}

/** Project root derived from the directory of a script that lives in <root>/scripts. */
export function projectRootFromScriptDir(scriptDir: string): string {
  return resolve(scriptDir, '..');
}

export interface StopResult {
  reason: string;
  /** Halts that were already active and kept untouched, by target. */
  kept: Record<string, string>;
  /** Halts this call wrote. */
  written: string[];
}

export function applyStop(db: Db, stopFile: string, reason: string, now: Date): StopResult {
  const full = `${STOP_PREFIX}${reason}`;
  setStop(stopFile, full, now);
  const kept: Record<string, string> = {};
  const written: string[] = [];
  for (const p of HALT_TARGETS) {
    const existing = activeHalt(db, p);
    if (existing !== null) kept[p] = existing;
    else {
      haltPlatform(db, p, trunc(full), now);
      written.push(p);
    }
  }
  return { reason: full, kept, written };
}

export interface ResumeResult {
  stopFileRemoved: boolean;
  cleared: string[];
  /** Active halts left in place (not written by the CLI), by target. */
  remaining: Record<string, string>;
}

export function applyResume(db: Db, stopFile: string, now: Date): ResumeResult {
  const stopFileRemoved = clearStop(stopFile);
  const cleared: string[] = [];
  const remaining: Record<string, string> = {};
  for (const p of HALT_TARGETS) {
    const reason = activeHalt(db, p);
    if (reason === null) continue;
    if (reason.startsWith(STOP_PREFIX)) {
      clearHalt(db, p, now);
      cleared.push(p);
    } else remaining[p] = reason;
  }
  return { stopFileRemoved, cleared, remaining };
}

/** The active `apply` halt reason, or null. */
export function activeApplyHalt(db: Db): string | null {
  return activeHalt(db, 'apply');
}

export interface ClearApplyResult {
  /** The apply halt reason that was cleared, or null when none was active. */
  cleared: string | null;
  /** A global `all` halt is not cleared here; its reason is reported when active. */
  globalHalt: string | null;
}

/**
 * Owner-only: clears the `apply` halt (set by the bot_wall streak in the browser applier, or by anything
 * else). No tool calls this. It never touches `all`, `linkedin` or `naukri`, and it also forgets the
 * persisted bot_wall events so the next block cannot re-halt at once.
 */
export function clearApplyHalt(db: Db, now: Date): ClearApplyResult {
  const own = activeHalt(db, 'apply');
  const globalHalt = activeHalt(db, 'all');
  if (own === null) return { cleared: null, globalHalt };
  clearHalt(db, 'apply', now);
  try { db.prepare("DELETE FROM apply_host_blocks WHERE kind = 'bot_wall'").run(); } catch { /* table absent in an old db */ }
  return { cleared: own, globalHalt };
}

/** true if a file was removed, false if it was absent (ENOENT); other errors are rethrown. */
export function clearStop(stopFile: string): boolean {
  if (!statExists(stopFile)) return false;
  rmSync(stopFile, { force: true });
  return true;
}
