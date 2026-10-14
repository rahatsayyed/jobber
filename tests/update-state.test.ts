import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  nodeStateFs, readState, readStateChecked, writeState, recordResult, STATE_PATH,
  type UpdateResultRecord, type UpdateState,
} from '../src/update/state.js';

const rec = (n: number, outcome: UpdateResultRecord['outcome'] = 'noop'): UpdateResultRecord => ({
  at: `2026-01-01T00:00:${String(n % 60).padStart(2, '0')}Z`, outcome, from: 'a'.repeat(40), to: null, reason: null, step: null,
});

describe('update state', () => {
  it('round trips', () => {
    const root = mkdtempSync(join(tmpdir(), 'st-'));
    const s: UpdateState = {
      version: 1, last_good_commit: 'abc', next_run_at: '2026-01-02T00:00:00Z',
      in_progress: { from: 'a', to: 'b', started_at: 'x' }, last_result: rec(1), history: [rec(1)],
    };
    writeState(nodeStateFs, root, s);
    expect(readState(nodeStateFs, root)).toEqual(s);
  });

  it('missing file gives the empty state', () => {
    const root = mkdtempSync(join(tmpdir(), 'st-'));
    const r = readStateChecked(nodeStateFs, root);
    expect(r.corrupt).toBe(false);
    expect(r.state.history).toEqual([]);
    expect(r.state.in_progress).toBeNull();
  });

  it('corrupt JSON gives the empty state and is flagged', () => {
    const root = mkdtempSync(join(tmpdir(), 'st-'));
    mkdirSync(join(root, '.update'));
    writeFileSync(join(root, STATE_PATH), '{not json');
    const r = readStateChecked(nodeStateFs, root);
    expect(r.corrupt).toBe(true);
    expect(r.state.version).toBe(1);
    expect(readState(nodeStateFs, root).history).toEqual([]);
  });

  it('caps history at 20, newest last', () => {
    let s = readState(nodeStateFs, mkdtempSync(join(tmpdir(), 'st-')));
    for (let i = 0; i < 25; i++) s = recordResult(s, rec(i));
    expect(s.history).toHaveLength(20);
    expect(s.history[19]).toEqual(rec(24));
    expect(s.history[0]).toEqual(rec(5));
    expect(s.last_result).toEqual(rec(24));
  });

  it('writes file mode 600 and dir mode 700', () => {
    const root = mkdtempSync(join(tmpdir(), 'st-'));
    writeState(nodeStateFs, root, readState(nodeStateFs, root));
    expect(statSync(join(root, STATE_PATH)).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, '.update')).mode & 0o777).toBe(0o700);
  });

  it('updates last_good_commit only on updated', () => {
    const s0 = readState(nodeStateFs, mkdtempSync(join(tmpdir(), 'st-')));
    expect(recordResult(s0, rec(1, 'noop'), 'good1').last_good_commit).toBeNull();
    expect(recordResult(s0, rec(1, 'skipped'), 'good1').last_good_commit).toBeNull();
    expect(recordResult(s0, rec(1, 'updated'), 'good1').last_good_commit).toBe('good1');
    expect(recordResult(s0, rec(1, 'updated')).last_good_commit).toBeNull();
  });
});
