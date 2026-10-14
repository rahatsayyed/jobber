// src/scheduler/control.ts
// Kill switch and halt-flag control state. Fails closed: any unreadable source means killed.
import { writeFileSync, mkdirSync, rmSync, statSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';

type Db = BetterSqlite3.Database;

export type Platform = 'linkedin' | 'naukri';
export const PLATFORMS: Platform[] = ['linkedin', 'naukri'];
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
  const halted: Record<Platform, string | null> = { linkedin: null, naukri: null };
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

/** true if a file was removed, false if it was absent (ENOENT); other errors are rethrown. */
export function clearStop(stopFile: string): boolean {
  if (!statExists(stopFile)) return false;
  rmSync(stopFile, { force: true });
  return true;
}
