// src/scheduler/wakeRequest.ts
// "Run one wake now" requests (`/runhunt`, `./run-hunt.sh`, `npm run scheduler -- --once --now`). There is no headless forced wake any more: a request is
// one scheduler_state row that the running scheduler daemon takes (its 30 s slice) and answers with a wake through the worker windows. The caller process
// (the Telegram bridge or the CLI) never runs a wake itself. If no daemon is running the request is refused with a clear message (nothing is queued).
// Same pattern as src/scheduler/dripRequest.ts: the daemon clears the row FIRST (a crash never replays a request); every gate of a normal wake still
// applies (kill switch, halts, quiet hours, ceilings, nothing_due, dry run).
import { randomBytes } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { peekLock } from '../platform/lock.js';
import { getState, setState } from './runLog.js';

type Db = BetterSqlite3.Database;

export const WAKE_REQUEST_KEY = 'wake_request';
export const WAKE_RESULT_KEY = 'wake_request_result';
/** A request older than this is ignored (the daemon was down, or the owner forgot). */
export const WAKE_REQUEST_TTL_MS = 10 * 60_000;
export const NOT_RUNNING_MESSAGE = 'The scheduler daemon is not running, so no wake was requested. Start the stack with: npm run up';

export interface WakeRequest { id: string; at: string }
export interface WakeRequestResult { id: string; at: string; status: string; reason?: string; run_id?: string }

/** True when a live scheduler daemon holds the `daemon` lock in `lockRoot` (the project's .jobber directory). */
export function daemonRunning(lockRoot: string): boolean {
  try {
    return peekLock(lockRoot, 'daemon') !== null;
  } catch {
    return false;
  }
}

/** Owner side: store one request. Refused (nothing stored) when no daemon is running. */
export function requestWake(db: Db, lockRoot: string, now: Date): { ok: true; request: WakeRequest } | { ok: false; message: string } {
  if (!daemonRunning(lockRoot)) return { ok: false, message: NOT_RUNNING_MESSAGE };
  const request: WakeRequest = { id: randomBytes(4).toString('hex'), at: now.toISOString() };
  setState(db, WAKE_REQUEST_KEY, JSON.stringify(request), now);
  return { ok: true, request };
}

/** A stored request that is still fresh, or null. Never throws. */
export function readFreshWakeRequest(db: Db, now: Date): WakeRequest | null {
  try {
    const raw = getState(db, WAKE_REQUEST_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { id?: unknown; at?: unknown };
    if (typeof v.id !== 'string' || typeof v.at !== 'string') return null;
    const t = Date.parse(v.at);
    if (!Number.isFinite(t) || now.getTime() - t > WAKE_REQUEST_TTL_MS || t - now.getTime() > 60_000) return null;
    return { id: v.id, at: v.at };
  } catch {
    return null;
  }
}

/** Daemon side: take the request (fresh or not) and clear it. Returns it only when fresh. Never throws. */
export function takeWakeRequest(db: Db, now: Date): WakeRequest | null {
  const req = readFreshWakeRequest(db, now);
  try {
    if (getState(db, WAKE_REQUEST_KEY)) setState(db, WAKE_REQUEST_KEY, '', now);
  } catch {
    // the request stays; it expires by itself
  }
  return req;
}

export function recordWakeResult(db: Db, req: WakeRequest, r: { status: string; reason?: string; runId?: string }, now: Date): void {
  try {
    const v: WakeRequestResult = {
      id: req.id, at: now.toISOString(), status: r.status,
      ...(r.reason ? { reason: r.reason.replace(/[^\x20-\x7e]/g, ' ').slice(0, 160) } : {}),
      ...(r.runId ? { run_id: r.runId } : {}),
    };
    setState(db, WAKE_RESULT_KEY, JSON.stringify(v), now);
  } catch {
    // diagnostics only
  }
}

export function readWakeResult(db: Db): WakeRequestResult | null {
  try {
    const raw = getState(db, WAKE_RESULT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<WakeRequestResult>;
    return typeof v.id === 'string' && typeof v.at === 'string' && typeof v.status === 'string' ? (v as WakeRequestResult) : null;
  } catch {
    return null;
  }
}
