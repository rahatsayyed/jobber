import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { loadTuning } from '../src/outreach/tuning.js';
import { pacingFromConfig } from '../src/outreach/pacing.js';
import { makeAfterWakeHooks, type HookRun, type HookRunOpts } from '../src/scheduler/hooks.js';
import type { WakeResult } from '../src/scheduler/driver.js';
import type { Notice } from '../src/scheduler/notify.js';
import { getState } from '../src/scheduler/runLog.js';

const DAY = new Date('2026-10-15T08:00:00.000Z'); // 13:30 IST
const QUIET = new Date('2026-10-14T21:00:00.000Z'); // 02:30 IST
const ok: WakeResult = { runId: 'r1', status: 'ok', nextWakeAt: '2026-10-15T09:00:00.000Z' };

function setup(o: { env?: NodeJS.ProcessEnv; files?: string[]; now?: Date; run?: HookRun } = {}) {
  const db = openDb(':memory:');
  const calls: Array<{ cmd: string; args: string[]; opts: HookRunOpts }> = [];
  const notices: Notice[] = [];
  let t = (o.now ?? DAY).getTime();
  const env = o.env ?? {};
  const files = new Set((o.files ?? []).map((f) => `/proj/${f}`));
  const run: HookRun = o.run ?? (async () => ({ code: 0 }));
  const hook = makeAfterWakeHooks({
    db, env, projectRoot: '/proj', now: () => new Date(t),
    pacing: pacingFromConfig(loadOutreachConfig(env), loadTuning(env)),
    notifier: { notify: async (n) => void notices.push(n) },
    exists: (p) => files.has(p),
    run: async (c, a, op) => {
      calls.push({ cmd: c, args: a, opts: op });
      return run(c, a, op);
    },
  });
  return { hook, db, calls, notices, advance: (ms: number) => void (t += ms) };
}

const BOTH = { AUTO_UPDATE: 'true', BACKUP_ENABLED: 'true' };
const FILES = ['scripts/auto-update.ts', 'scripts/backup.ts'];

describe('after-wake hooks', () => {
  it('is disabled by default even when the scripts exist', async () => {
    const s = setup({ files: FILES });
    await s.hook(ok);
    expect(s.calls).toHaveLength(0);
  });

  it('runs the exact argv when enabled and the script exists', async () => {
    const s = setup({ env: { ...BOTH, PATH: '/bin', HOME: '/h', TZ: 'UTC', SECRET_TOKEN: 'abcdefgh1234' }, files: FILES });
    await s.hook(ok);
    expect(s.calls.map((c) => [c.cmd, c.args])).toEqual([
      ['npm', ['run', 'auto-update', '--', '--tick']],
      ['npm', ['run', 'backup', '--', '--tick']],
    ]);
    expect(s.calls[0].opts.cwd).toBe('/proj');
    expect(s.calls[0].opts.timeoutMs).toBe(600_000);
    expect(Object.keys(s.calls[0].opts.env).sort()).toEqual(['AUTO_UPDATE', 'BACKUP_ENABLED', 'HOME', 'PATH', 'TZ']);
  });

  it('enable flag must be exactly true', async () => {
    const s = setup({ env: { AUTO_UPDATE: '1', BACKUP_ENABLED: 'TRUE' }, files: FILES });
    await s.hook(ok);
    expect(s.calls).toHaveLength(0);
  });

  it('a missing script is a no-op', async () => {
    const s = setup({ env: BOTH, files: ['scripts/backup.ts'] });
    await s.hook(ok);
    expect(s.calls.map((c) => c.args[1])).toEqual(['backup']);
    const none = setup({ env: BOTH, files: [] });
    await none.hook(ok);
    expect(none.calls).toHaveLength(0);
  });

  it('does nothing in quiet hours', async () => {
    const s = setup({ env: BOTH, files: FILES, now: QUIET });
    await s.hook(ok);
    expect(s.calls).toHaveLength(0);
  });

  it('does nothing after a killed wake', async () => {
    const s = setup({ env: BOTH, files: FILES });
    await s.hook({ ...ok, status: 'killed' });
    await s.hook({ runId: 'r2', status: 'skipped', reason: 'killed', nextWakeAt: ok.nextWakeAt });
    expect(s.calls).toHaveLength(0);
  });

  it('swallows a failing run and notices with a title only', async () => {
    const s = setup({ env: { AUTO_UPDATE: 'true' }, files: FILES, run: async () => { throw new Error('secret detail /home/x'); } });
    await expect(s.hook(ok)).resolves.toBeUndefined();
    expect(s.notices).toEqual([{ level: 'warn', title: 'scheduler auto-update tick failed' }]);
    const nonZero = setup({ env: { AUTO_UPDATE: 'true' }, files: FILES, run: async () => ({ code: 1 }) });
    await nonZero.hook(ok);
    expect(nonZero.notices).toHaveLength(1);
    const timeout = setup({ env: { AUTO_UPDATE: 'true' }, files: FILES, run: async () => ({ code: null, timedOut: true }) });
    await timeout.hook(ok);
    expect(timeout.notices[0].detail).toBeUndefined();
  });

  it('respects the minimum interval and persists the last run', async () => {
    const s = setup({ env: { AUTO_UPDATE: 'true' }, files: FILES });
    await s.hook(ok);
    expect(s.calls).toHaveLength(1);
    expect(getState(s.db, 'hook_auto_update_last_at')).toBe(DAY.toISOString());
    s.advance(30 * 60_000);
    await s.hook(ok);
    expect(s.calls).toHaveLength(1);
    s.advance(31 * 60_000);
    await s.hook(ok);
    expect(s.calls).toHaveLength(2);
  });

  it('bounds the timeout env', async () => {
    const lo = setup({ env: { AUTO_UPDATE: 'true', SCHEDULER_HOOK_TIMEOUT_SEC: '5' }, files: FILES });
    await lo.hook(ok);
    expect(lo.calls[0].opts.timeoutMs).toBe(600_000);
    const set = setup({ env: { AUTO_UPDATE: 'true', SCHEDULER_HOOK_TIMEOUT_SEC: '120' }, files: FILES });
    await set.hook(ok);
    expect(set.calls[0].opts.timeoutMs).toBe(120_000);
  });
});
