// /runhunt, ./run-hunt.sh and `npm run scheduler -- --once --now` only ask the running scheduler daemon for one wake (scheduler_state request row).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { acquireLock } from '../src/platform/lock.js';
import { daemonRunning, NOT_RUNNING_MESSAGE, readFreshWakeRequest, readWakeResult, recordWakeResult, requestWake, takeWakeRequest, WAKE_REQUEST_TTL_MS } from '../src/scheduler/wakeRequest.js';
import { parseSchedulerArgs } from '../src/scheduler/args.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }); });
const lockRoot = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'wake-req-')); dirs.push(d); return d; };
const NOW = new Date('2026-11-06T10:00:00Z');

describe('wake request', () => {
  it('is refused with the clear message when no scheduler daemon is running, and nothing is stored', () => {
    const db = openDb(':memory:');
    const root = lockRoot();
    expect(daemonRunning(root)).toBe(false);
    const r = requestWake(db, root, NOW);
    expect(r).toEqual({ ok: false, message: NOT_RUNNING_MESSAGE });
    expect(NOT_RUNNING_MESSAGE).toMatch(/npm run up/);
    expect(readFreshWakeRequest(db, NOW)).toBeNull();
  });

  it('with a live daemon lock it stores one request that the daemon takes once (cleared first), and records the result', () => {
    const db = openDb(':memory:');
    const root = lockRoot();
    const lock = acquireLock(root, 'daemon', 'scheduler');
    expect(lock).toBeTruthy();
    expect(daemonRunning(root)).toBe(true);
    const r = requestWake(db, root, NOW);
    expect(r.ok).toBe(true);
    const id = r.ok ? r.request.id : '';
    expect(readFreshWakeRequest(db, NOW)?.id).toBe(id);
    const taken = takeWakeRequest(db, NOW);
    expect(taken?.id).toBe(id);
    expect(takeWakeRequest(db, NOW)).toBeNull(); // never replayed
    recordWakeResult(db, taken!, { status: 'skipped', reason: 'quiet_hours', runId: 'r1' }, NOW);
    expect(readWakeResult(db)).toMatchObject({ id, status: 'skipped', reason: 'quiet_hours', run_id: 'r1' });
    lock?.release();
  });

  it('an old request is ignored', () => {
    const db = openDb(':memory:');
    const root = lockRoot();
    const lock = acquireLock(root, 'daemon', 'scheduler');
    requestWake(db, root, NOW);
    expect(readFreshWakeRequest(db, new Date(NOW.getTime() + WAKE_REQUEST_TTL_MS + 1000))).toBeNull();
    lock?.release();
  });

  it('--once and --now are both the request mode (no headless run), the shim run-hunt.sh passes them on', () => {
    expect(parseSchedulerArgs(['--once', '--now']).mode).toBe('once');
    expect(parseSchedulerArgs(['--now']).mode).toBe('once');
  });
});
