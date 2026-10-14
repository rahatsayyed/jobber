import { describe, expect, it, vi } from 'vitest';
import { runUpdate, type RunDeps } from '../src/update/run.js';
import { emptyState, type UpdateState } from '../src/update/state.js';
import type { RepoFacts } from '../src/update/plan.js';
import type { UpdateConfig } from '../src/update/config.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
// 12:00 UTC = 17:30 IST, outside quiet hours 1..7
const NOW = new Date('2026-10-15T12:00:00Z');
const QUIET = { startHour: 1, endHour: 7, tzOffsetMinutes: 330 };

function cfg(over: Partial<UpdateConfig> = {}): UpdateConfig {
  return {
    enabled: true, remote: 'origin', branch: 'main', tagPattern: null, requireSigned: false,
    signersFile: null, reviewPaths: [], problems: [], ...over,
  };
}
function facts(over: Partial<RepoFacts> = {}): RepoFacts {
  return {
    head: SHA_A, currentBranch: 'main', dirty: false, upstreamSha: SHA_B, upstreamLabel: 'origin/main',
    ahead: 0, behind: 1, commits: [{ sha: SHA_B, subject: 's', signature: 'G' }], changedPaths: ['a.ts'],
    tagSignature: null, ...over,
  };
}

function make(over: Partial<RunDeps> = {}, st: UpdateState = emptyState()) {
  const release = vi.fn(async () => {});
  const saved: UpdateState[] = [];
  let cur = st;
  const deps = {
    cfg: cfg(),
    exec: vi.fn(),
    root: '/r',
    now: () => NOW,
    rng: () => 0.5,
    lock: { acquire: vi.fn(async () => ({ release })) },
    notify: { send: vi.fn(async () => ({ ok: true, detail: 'x' })) },
    apply: vi.fn(async () => ({ outcome: 'updated' as const, step: null, reason: null, from: SHA_A, to: SHA_B })),
    gather: vi.fn(async () => facts()),
    state: { load: () => cur, save: (s: UpdateState) => { cur = s; saved.push(s); } },
    quiet: QUIET,
    ...over,
  } as unknown as RunDeps;
  return { deps, release, saved, get state() { return cur; } };
}

describe('runUpdate', () => {
  it('tick with AUTO_UPDATE off does nothing', async () => {
    const m = make({ cfg: cfg({ enabled: false }) });
    const r = await runUpdate(m.deps, { mode: 'tick', dryRun: false });
    expect(r.outcome).toBe('noop');
    expect(m.deps.lock.acquire).not.toHaveBeenCalled();
    expect(m.deps.gather).not.toHaveBeenCalled();
    expect(m.deps.notify.send).not.toHaveBeenCalled();
  });

  it('tick before next_run_at does nothing', async () => {
    const st = { ...emptyState(), next_run_at: '2026-10-16T12:00:00Z' };
    const m = make({}, st);
    const r = await runUpdate(m.deps, { mode: 'tick', dryRun: false });
    expect(r.outcome).toBe('noop');
    expect(m.deps.lock.acquire).not.toHaveBeenCalled();
  });

  it('tick inside quiet hours does nothing', async () => {
    const m = make({ now: () => new Date('2026-10-15T00:00:00Z') }); // 05:30 IST
    const r = await runUpdate(m.deps, { mode: 'tick', dryRun: false });
    expect(r.outcome).toBe('noop');
    expect(m.deps.gather).not.toHaveBeenCalled();
  });

  it('due tick with a skip notifies once and releases the lock', async () => {
    const m = make({ gather: vi.fn(async () => facts({ dirty: true })) });
    const r = await runUpdate(m.deps, { mode: 'tick', dryRun: false });
    expect(r.outcome).toBe('skipped');
    expect(m.deps.notify.send).toHaveBeenCalledTimes(1);
    expect(m.deps.apply).not.toHaveBeenCalled();
    expect(m.release).toHaveBeenCalledTimes(1);
    expect(m.state.last_result?.outcome).toBe('skipped');
  });

  it('lock held yields skipped lock-held without gathering', async () => {
    const m = make({ lock: { acquire: vi.fn(async () => null) } });
    const r = await runUpdate(m.deps, { mode: 'tick', dryRun: false });
    expect(r.outcome).toBe('skipped');
    expect(r.detail).toContain('lock-held');
    expect(m.deps.gather).not.toHaveBeenCalled();
    expect(m.deps.notify.send).toHaveBeenCalledTimes(1);
  });

  it('noop sends no notification and still sets the next run', async () => {
    const m = make({ gather: vi.fn(async () => facts({ behind: 0 })) });
    const r = await runUpdate(m.deps, { mode: 'tick', dryRun: false });
    expect(r.outcome).toBe('noop');
    expect(m.deps.notify.send).not.toHaveBeenCalled();
    expect(m.state.next_run_at).not.toBeNull();
    expect(m.release).toHaveBeenCalled();
  });

  it('apply result is returned and next_run_at is future and outside quiet hours', async () => {
    const m = make();
    const r = await runUpdate(m.deps, { mode: 'tick', dryRun: false });
    expect(r.outcome).toBe('updated');
    expect(m.deps.apply).toHaveBeenCalledTimes(1);
    expect(m.deps.notify.send).not.toHaveBeenCalled();
    const t = new Date(m.state.next_run_at!);
    expect(t.getTime()).toBeGreaterThan(NOW.getTime());
    const ist = new Date(t.getTime() + 330 * 60000).getUTCHours();
    expect(ist < 1 || ist >= 7).toBe(true);
  });

  it('tick detaches instead of applying when detach is given', async () => {
    const detach = vi.fn();
    const m = make({ detach });
    const r = await runUpdate(m.deps, { mode: 'tick', dryRun: false });
    expect(detach).toHaveBeenCalledTimes(1);
    expect(m.deps.apply).not.toHaveBeenCalled();
    expect(r.outcome).toBe('noop');
    expect(m.release).toHaveBeenCalledTimes(1);
  });

  it('now mode runs although disabled and does not change next_run_at', async () => {
    const st = { ...emptyState(), next_run_at: '2026-10-20T12:00:00Z' };
    const m = make({ cfg: cfg({ enabled: false }) }, st);
    const r = await runUpdate(m.deps, { mode: 'now', dryRun: false });
    expect(r.outcome).toBe('updated');
    expect(m.state.next_run_at).toBe('2026-10-20T12:00:00Z');
  });

  it('throwing gather records error, notifies once, releases', async () => {
    const m = make({ gather: vi.fn(async () => { throw new Error('boom token=secret'); }) });
    const r = await runUpdate(m.deps, { mode: 'tick', dryRun: false });
    expect(r.outcome).toBe('error');
    expect(m.deps.notify.send).toHaveBeenCalledTimes(1);
    expect(m.release).toHaveBeenCalledTimes(1);
    expect(m.state.last_result?.outcome).toBe('error');
  });

  it('passes dryRun through to apply', async () => {
    const m = make();
    await runUpdate(m.deps, { mode: 'now', dryRun: true });
    expect(m.deps.apply).toHaveBeenCalledWith(expect.objectContaining({ action: 'apply' }), { dryRun: true });
  });

  it('releases the lock when apply throws', async () => {
    const m = make({ apply: vi.fn(async () => { throw new Error('x'); }) });
    const r = await runUpdate(m.deps, { mode: 'now', dryRun: false });
    expect(r.outcome).toBe('error');
    expect(m.release).toHaveBeenCalledTimes(1);
  });
});
