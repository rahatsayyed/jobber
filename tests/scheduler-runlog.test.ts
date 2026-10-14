import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import {
  migrateSchedulerTables, startRun, finishRun, listRuns, markOrphans, getState, setState,
} from '../src/scheduler/runLog.js';

const T0 = new Date('2026-10-15T10:00:00.000Z');

function mk() { return openDb(':memory:'); }
function base(id: string, at = T0, status: 'planned' | 'running' = 'running') {
  return { id, at, trigger: 'timer', dryRun: false, burst: null, tasks: [{ worker: 'a', quota: 1 }], status };
}

describe('scheduler run log', () => {
  it('creates tables on openDb and migrate is idempotent', () => {
    const db = mk();
    for (const t of ['scheduler_runs', 'scheduler_state', 'escalations', 'dry_run_actions', 'inbound_messages']) {
      const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
      expect(r, t).toBeTruthy();
    }
    expect(() => { migrateSchedulerTables(db); migrateSchedulerTables(db); }).not.toThrow();
  });

  it('startRun then finishRun computes wall_sec', () => {
    const db = mk();
    startRun(db, base('r1'));
    finishRun(db, 'r1', { at: new Date(T0.getTime() + 95_000), status: 'ok', exitCode: 0, toolCalls: 3, tokensApprox: 10 });
    const [r] = listRuns(db);
    expect(r.status).toBe('ok');
    expect(r.wall_sec).toBe(95);
    expect(r.started_at).toBe(T0.toISOString());
    expect(r.ended_at).toBe(new Date(T0.getTime() + 95_000).toISOString());
    expect(r.tool_calls).toBe(3);
    expect(r.dry_run).toBe(0);
    expect(JSON.parse(r.tasks)).toEqual([{ worker: 'a', quota: 1 }]);
  });

  it('listRuns is newest first and respects limit', () => {
    const db = mk();
    startRun(db, base('a', new Date(T0.getTime())));
    startRun(db, base('b', new Date(T0.getTime() + 1000)));
    startRun(db, base('c', new Date(T0.getTime() + 2000)));
    expect(listRuns(db).map((r) => r.id)).toEqual(['c', 'b', 'a']);
    expect(listRuns(db, 2).map((r) => r.id)).toEqual(['c', 'b']);
  });

  it('markOrphans flips running and planned only', () => {
    const db = mk();
    startRun(db, base('run', T0, 'running'));
    startRun(db, base('plan', T0, 'planned'));
    startRun(db, base('done', T0, 'running'));
    finishRun(db, 'done', { at: T0, status: 'ok' });
    expect(markOrphans(db, new Date(T0.getTime() + 5000))).toBe(2);
    const by = Object.fromEntries(listRuns(db).map((r) => [r.id, r.status]));
    expect(by).toEqual({ run: 'crashed', plan: 'crashed', done: 'ok' });
    expect(markOrphans(db, T0)).toBe(0);
  });

  it('setState/getState upserts', () => {
    const db = mk();
    expect(getState(db, 'k')).toBeNull();
    setState(db, 'k', 'v1', T0);
    setState(db, 'k', 'v2', T0);
    expect(getState(db, 'k')).toBe('v2');
  });

  it('clamps summary to 2000 chars', () => {
    const db = mk();
    startRun(db, base('s'));
    finishRun(db, 's', { at: T0, status: 'ok', summary: 'x'.repeat(5000) });
    expect(listRuns(db)[0].summary!.length).toBe(2000);
  });
});
