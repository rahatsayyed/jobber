// src/scheduler/dripRequest.ts
// "Run one drip tick now" requests from the owner (Telegram /drip). The bridge is another process than the scheduler daemon, so a request is
// one scheduler_state row per lane. The daemon's 30 s drip tick reads it, clears it FIRST (a crash never replays a request) and treats the
// stored next-tick time as passed for that one tick. Every other gate still applies. A refusal is stored so the bridge can show the reason.
import { randomBytes } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { getState, setState } from './runLog.js';

type Db = BetterSqlite3.Database;

export type DripLane = 'mail' | 'linkedin';
export const DRIP_LANES: readonly DripLane[] = ['mail', 'linkedin'];
/** A request older than this is ignored (the daemon was down, or the owner forgot). */
export const REQUEST_TTL_MS = 10 * 60_000;

export const requestKey = (lane: DripLane): string => `drip_request_${lane}`;
export const refusalKey = (lane: DripLane): string => `drip_last_refusal_${lane}`;

export interface DripRequest { id: string; at: string }
export interface DripRefusal { at: string; reason: string; request_id?: string }

/** Short code for a refusal reason: no free text, nothing from a model or a page. */
export function reasonCode(reason: string): string {
  const base = reason.split(':')[0] ?? '';
  return base.replace(/[^a-z0-9_]/gi, '_').slice(0, 40) || 'unknown';
}

/** Owner side (bridge): store one request for a lane. Returns its id. */
export function writeDripRequest(db: Db, lane: DripLane, now: Date): DripRequest {
  const req: DripRequest = { id: randomBytes(4).toString('hex'), at: now.toISOString() };
  setState(db, requestKey(lane), JSON.stringify(req), now);
  return req;
}

/** A stored request that is still fresh, or null. Never throws. */
export function readFreshRequest(db: Db, lane: DripLane, now: Date): DripRequest | null {
  try {
    const raw = getState(db, requestKey(lane));
    if (!raw) return null;
    const v = JSON.parse(raw) as { id?: unknown; at?: unknown };
    if (typeof v.id !== 'string' || typeof v.at !== 'string') return null;
    const t = Date.parse(v.at);
    if (!Number.isFinite(t) || now.getTime() - t > REQUEST_TTL_MS || t - now.getTime() > 60_000) return null;
    return { id: v.id, at: v.at };
  } catch {
    return null;
  }
}

/** Daemon side: take the request (fresh or not) and clear it. Returns it only when fresh. Never throws. */
export function takeRequest(db: Db, lane: DripLane, now: Date): DripRequest | null {
  const req = readFreshRequest(db, lane, now);
  try {
    if (getState(db, requestKey(lane))) setState(db, requestKey(lane), '', now);
  } catch {
    // the request stays; it expires by itself
  }
  return req;
}

export function recordRefusal(db: Db, lane: DripLane, reason: string, now: Date, requestId?: string): void {
  try {
    const v: DripRefusal = { at: now.toISOString(), reason: reasonCode(reason), ...(requestId ? { request_id: requestId } : {}) };
    setState(db, refusalKey(lane), JSON.stringify(v), now);
  } catch {
    // diagnostics only
  }
}

export function clearRefusal(db: Db, lane: DripLane, now: Date): void {
  try {
    if (getState(db, refusalKey(lane))) setState(db, refusalKey(lane), '', now);
  } catch {
    // diagnostics only
  }
}

export function readRefusal(db: Db, lane: DripLane): DripRefusal | null {
  try {
    const raw = getState(db, refusalKey(lane));
    if (!raw) return null;
    const v = JSON.parse(raw) as { at?: unknown; reason?: unknown; request_id?: unknown };
    if (typeof v.at !== 'string' || typeof v.reason !== 'string') return null;
    return { at: v.at, reason: reasonCode(v.reason), ...(typeof v.request_id === 'string' ? { request_id: v.request_id } : {}) };
  } catch {
    return null;
  }
}

/** Wrap one lane tick: consume the request, run the tick with `bypassSpacing`, record the refusal or clear it. */
export async function withDripRequest<R extends { status: 'skipped' | 'ran'; reason?: string }>(
  db: Db, lane: DripLane, now: () => Date, tick: (bypassSpacing: boolean) => Promise<R>,
): Promise<R> {
  const req = takeRequest(db, lane, now());
  const r = await tick(req !== null);
  if (req) {
    if (r.status === 'skipped') recordRefusal(db, lane, r.reason ?? 'unknown', now(), req.id);
    else clearRefusal(db, lane, now());
  }
  return r;
}
