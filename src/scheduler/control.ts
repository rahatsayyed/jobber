// src/scheduler/control.ts
// Kill switch and halt-flag control state. Fails closed: any unreadable source means killed.
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { haltReason } from '../outreach/limits.js';

type Db = BetterSqlite3.Database;

export type Platform = 'linkedin' | 'naukri';
export const PLATFORMS: Platform[] = ['linkedin', 'naukri'];
export const DEFAULT_STOP_FILE = '.jobber/STOP';
const MAX_REASON = 200;

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

export function defaultDeps(env: NodeJS.ProcessEnv = process.env, stopFile = DEFAULT_STOP_FILE): ControlDeps {
  return {
    stopFile,
    env,
    exists: (p) => existsSync(p),
    read: (p) => readFileSync(p, 'utf8'),
  };
}

function trunc(s: string): string {
  return s.length > MAX_REASON ? s.slice(0, MAX_REASON) : s;
}

export function readControl(db: Db, deps: ControlDeps): ControlState {
  const halted: Record<Platform, string | null> = { linkedin: null, naukri: null };
  const reasons: string[] = [];
  let readError: string | null = null;

  try {
    if (deps.exists(deps.stopFile)) {
      let text = '';
      try {
        text = deps.read(deps.stopFile).trim();
      } catch {
        text = '';
      }
      reasons.push(`STOP file${text ? `: ${text}` : ''}`);
    }
  } catch (e) {
    readError = `stop file unreadable: ${(e as Error).message}`;
  }

  if (deps.env.JOBBER_KILL === '1') reasons.push('JOBBER_KILL=1');

  try {
    const all = haltReason(db, 'all');
    if (all !== null) reasons.push(`halt all: ${all}`);
    for (const p of PLATFORMS) halted[p] = haltReason(db, p);
  } catch (e) {
    readError = readError ?? `halt flags unreadable: ${(e as Error).message}`;
  }

  if (readError) reasons.push(readError);
  const killed = reasons.length > 0;
  return {
    killed,
    killReason: killed ? trunc(reasons.join('; ')) : null,
    halted,
    allowed: killed ? [] : PLATFORMS.filter((p) => halted[p] === null),
    readError: readError ? trunc(readError) : null,
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

export function clearStop(stopFile: string): boolean {
  if (!existsSync(stopFile)) return false;
  rmSync(stopFile, { force: true });
  return true;
}
