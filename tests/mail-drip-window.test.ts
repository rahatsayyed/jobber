// Phase 3a: the mail drip lane through the long-lived `mail` window (WINDOW_LANES contains `mail`). Fakes only: fake clock,
// fake dispatcher or fake tmux, in-memory db. Nothing is sent, no tmux, no claude.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { loadTuning } from '../src/outreach/tuning.js';
import { listHandoff } from '../src/platform/handoff.js';
import { takeWindowLock } from '../src/platform/windowLock.js';
import type { Run } from '../src/platform/tmux.js';
import type { DriverDeps } from '../src/scheduler/driver.js';
import type { LaunchHandle, LaunchPlan, Launcher, PollResult } from '../src/scheduler/launch.js';
import type { Notice } from '../src/scheduler/notify.js';
import { dripTick, listDripQuarantine } from '../src/scheduler/mailDrip.js';
import { getState, listRuns } from '../src/scheduler/runLog.js';
import { WindowDispatcher, type DispatchInput, type DispatchResult } from '../src/scheduler/windowDispatch.js';

const NOON_IST = new Date('2026-10-15T08:00:00.000Z');
const AFTER_WINDOW = new Date('2026-10-15T14:00:00.000Z');
const QUIET = new Date('2026-10-14T21:00:00.000Z');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const sqlTime = (d: Date): string => d.toISOString().slice(0, 19).replace('T', ' ');

class FakeLauncher implements Launcher {
  starts: LaunchPlan[] = [];
  async start(plan: LaunchPlan): Promise<LaunchHandle> {
    this.starts.push(plan);
    return { runId: plan.runId, session: plan.session, window: `wake-${plan.runId}`, logPath: 'l', exitPath: 'e', promptPath: 'p' };
  }
  async poll(): Promise<PollResult> {
    return { exited: true, exitCode: 0, newOutput: '' };
  }
  async kill(): Promise<void> {}
}

/** A stand-in for WindowDispatcher: records every call; `reply` decides the result and may mark the row sent. */
class FakeDispatcher {
  inputs: DispatchInput[] = [];
  finished: string[] = [];
  reply: (i: DispatchInput, n: number) => DispatchResult = () => ({ status: 'ok', stopReason: 'end_turn', summary: '', toolCalls: 1, runId: 'w-run' });
  async dispatch(i: DispatchInput): Promise<DispatchResult> {
    this.inputs.push(i);
    return this.reply(i, this.inputs.length);
  }
  async finish(id: string): Promise<{ cleared: boolean }> {
    this.finished.push(id);
    return { cleared: true };
  }
}

function setup(opts: { start?: Date; env?: NodeJS.ProcessEnv; stopExists?: () => boolean; withWindows?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mail-win-'));
  dirs.push(dir);
  let t = (opts.start ?? NOON_IST).getTime();
  const env = opts.env ?? { WINDOW_LANES: 'mail' };
  const notices: Notice[] = [];
  const db = openDb(':memory:');
  const clock = (): Date => new Date(t);
  const launcher = new FakeLauncher();
  const fake = new FakeDispatcher();
  const markSent = (prompt: string): void => {
    const m = /outreach_queue row id (\d+)/.exec(prompt);
    if (m) db.prepare("UPDATE outreach_queue SET email_status = 'sent', email_sent_at = ? WHERE id = ?").run(sqlTime(clock()), Number(m[1]));
  };
  const d: DriverDeps = {
    db, now: clock, rng: () => 0,
    sleep: async (ms) => { t += ms; },
    cfg: loadOutreachConfig(env), tuning: loadTuning(env), env,
    lockRoot: join(dir, 'locks'), stopFile: join(dir, 'STOP'), runDir: join(dir, 'runs'), projectRoot: dir,
    launcher, notifier: { notify: async (n) => void notices.push(n) },
    newRunId: (() => { let i = 0; return () => `drip${String(++i).padStart(8, '0')}`; })(),
    control: opts.stopExists ? { exists: opts.stopExists, read: () => 'stop it' } : undefined,
    pollMs: 5000,
    windows: opts.withWindows === false ? undefined : (fake as unknown as WindowDispatcher),
  };
  const queue = (n: number): number[] => {
    const ids: number[] = [];
    for (let i = 1; i <= n; i++) {
      const to = `person${i}@co${i}.example`;
      db.prepare("INSERT INTO contacts (company, email, type, verified, source, confidence) VALUES ('C', ?, 'hr', 1, 't', 0.9)").run(to);
      db.prepare("INSERT INTO jobs (id, source, title, company, url) VALUES (?, 't', 'T', 'C', 'u')").run(`job${i}`);
      ids.push(Number(db.prepare("INSERT INTO outreach_queue (job_id, email_subject, email_body, email_to) VALUES (?, 's', 'b', ?)").run(`job${i}`, to).lastInsertRowid));
    }
    return ids;
  };
  const status = (id: number): string | null => (db.prepare('SELECT email_status AS s FROM outreach_queue WHERE id = ?').get(id) as { s: string | null }).s;
  return { d, db, dir, launcher, fake, notices, queue, status, markSent, setNow: (x: Date) => void (t = x.getTime()) };
}

describe('mail lane through the window', () => {
  it('lane off: the old headless path runs and the dispatcher is never used', async () => {
    const s = setup({ env: {} });
    s.queue(1);
    await dripTick(s.d);
    expect(s.launcher.starts).toHaveLength(1);
    expect(s.fake.inputs).toHaveLength(0);
  });

  it('lane on but no dispatcher object: headless', async () => {
    const s = setup({ withWindows: false });
    s.queue(1);
    await dripTick(s.d);
    expect(s.launcher.starts).toHaveLength(1);
  });

  it('lane on: the item goes to window mail, the headless launcher is not used, same prompt as headless, trigger mail_drip', async () => {
    const headless = setup({ env: {} });
    headless.queue(1);
    await dripTick(headless.d);
    const win = setup();
    win.queue(1);
    win.fake.reply = (i) => { win.markSent(i.promptText); return { status: 'ok', stopReason: 'end_turn', summary: 'x', toolCalls: 3, runId: 'w-run-1' }; };
    const r = await dripTick(win.d);
    expect(r.status).toBe('ran');
    expect(win.launcher.starts).toHaveLength(0);
    const i = win.fake.inputs[0];
    expect(i).toMatchObject({ window: 'mail', lane: 'mail', trigger: 'mail_drip', dryRun: false });
    expect(i.promptText).toBe(headless.launcher.starts[0].prompt);
    expect(i.deadlineMs).toBe(3600 * 1000);
    expect(win.status(1)).toBe('sent');
    expect(win.fake.finished).toContain('w-run-1');
  });

  it('claims the cold row before typing (row is sending while the window works)', async () => {
    const s = setup();
    const [id] = s.queue(1);
    let during: string | null = null;
    s.fake.reply = (i) => { during = s.status(id); s.markSent(i.promptText); return { status: 'ok', stopReason: 'end_turn', summary: '', toolCalls: 1, runId: 'w1' }; };
    await dripTick(s.d);
    expect(during).toBe('sending');
  });

  it('failed, stalled, timeout and a dispatch error with a typed run: a cold row left sending is quarantined and the owner is told', async () => {
    for (const status of ['failed', 'stalled', 'timeout'] as const) {
      const s = setup();
      const [id] = s.queue(1);
      s.fake.reply = () => ({ status, stopReason: status === 'timeout' ? 'wall_clock' : status, summary: '', toolCalls: 1, runId: 'w1' });
      const r = await dripTick(s.d);
      expect(r.runs?.[0]).toMatchObject({ quarantined: true });
      expect(listDripQuarantine(s.db).length).toBeGreaterThan(0);
      expect(s.status(id)).toBe('sending'); // never reset: it may have gone out
      expect(s.notices.some((n) => /without a recorded send/.test(n.title))).toBe(true);
      expect(r.runs).toHaveLength(1); // a failed item stops the batch
      expect(s.fake.finished).toEqual(['w1']); // /clear is still asked for
    }
  });

  it('ok but nothing recorded is quarantined too, like the headless path', async () => {
    const s = setup();
    s.queue(1);
    const r = await dripTick(s.d);
    expect(r.runs?.[0].quarantined).toBe(true);
  });

  it('usage_limit: sets usage_backoff_until, adds a handoff entry, quarantines the unrecorded row, and the next tick is held by the gate', async () => {
    const s = setup({ env: { WINDOW_LANES: 'mail', USAGE_LIMIT_BACKOFF_MIN: '60' } });
    s.queue(2);
    s.fake.reply = () => ({ status: 'usage_limit', stopReason: 'usage_limit', summary: '', toolCalls: 0, runId: 'w1' });
    const r = await dripTick(s.d);
    expect(r.runs?.[0]).toMatchObject({ status: 'usage_limit', quarantined: true });
    expect(Date.parse(getState(s.db, 'usage_backoff_until') as string)).toBe(NOON_IST.getTime() + 60 * 60000);
    const h = listHandoff(s.dir);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ window: 'mail' });
    expect(h[0].what).toMatch(/^skipped: mail cold:1/);
    expect(h[0].why).toMatch(/usage limit/);
    expect(s.fake.finished).toEqual(['w1']);
    s.setNow(new Date(NOON_IST.getTime() + 10 * 60000));
    expect(await dripTick(s.d)).toMatchObject({ status: 'skipped' });
    expect(s.fake.inputs).toHaveLength(1);
  });

  it('killed result: stops the batch, no further item, the row is held when unrecorded', async () => {
    const s = setup();
    s.queue(3);
    s.fake.reply = () => ({ status: 'killed', stopReason: 'killed', summary: '', toolCalls: 0, runId: 'w1' });
    const r = await dripTick(s.d);
    expect(r.runs).toHaveLength(1);
    expect(r.runs?.[0]).toMatchObject({ status: 'killed', quarantined: true });
    expect(s.fake.inputs).toHaveLength(1);
  });

  it('window_busy: nothing sent, the row is put back to queued, item not marked tried, no failure alert, tick stops', async () => {
    const s = setup();
    const [id] = s.queue(2);
    s.fake.reply = () => ({ status: 'unavailable', stopReason: 'window_busy', summary: '', toolCalls: 0 });
    const r = await dripTick(s.d);
    expect(r.runs).toHaveLength(1);
    expect(r.runs?.[0]).toMatchObject({ skipped: true });
    expect(s.status(id)).toBe('queued');
    expect(s.launcher.starts).toHaveLength(0);
    expect(listDripQuarantine(s.db)).toHaveLength(0);
    expect(s.fake.inputs).toHaveLength(1);
    expect(s.fake.finished).toEqual([]);
  });

  it('window missing or not claude: row put back and the headless path runs for that item, one warning only', async () => {
    const s = setup();
    const [id] = s.queue(2);
    s.fake.reply = () => ({ status: 'unavailable', stopReason: 'window_missing', summary: '', toolCalls: 0 });
    await dripTick(s.d);
    expect(s.launcher.starts.length).toBeGreaterThan(0);
    expect(s.launcher.starts[0].prompt).toMatch(new RegExp(`row id ${id} `));
    expect(s.notices.filter((n) => /mail window unavailable/.test(n.title)).length).toBeLessThanOrEqual(1);
    expect(listRuns(s.db, 10).some((x) => x.trigger === 'mail_drip')).toBe(true);
  });

  it('a usage_backoff or killed refusal from the dispatcher sends nothing and does not fall back to headless', async () => {
    for (const why of ['usage_backoff', 'killed', 'send_failed', 'invalid:prompt']) {
      const s = setup();
      const [id] = s.queue(1);
      s.fake.reply = () => ({ status: 'unavailable', stopReason: why, summary: '', toolCalls: 0 });
      await dripTick(s.d);
      expect(s.launcher.starts).toHaveLength(0);
      expect(s.status(id)).toBe('queued');
    }
  });

  it('dry run: the dispatcher gets dryRun true, the row is not claimed, nothing is quarantined', async () => {
    const s = setup({ env: { WINDOW_LANES: 'mail', JOBBER_DRY_RUN: 'true' } });
    const [id] = s.queue(1);
    let during: string | null = 'x';
    s.fake.reply = () => { during = s.status(id); return { status: 'ok', stopReason: 'end_turn', summary: '', toolCalls: 1, runId: 'w1' }; };
    const r = await dripTick(s.d);
    expect(s.fake.inputs[0].dryRun).toBe(true);
    expect(s.fake.inputs[0].promptText).toMatch(/Dry run: yes/);
    expect(during).toBeNull();
    expect(r.runs?.[0].quarantined).toBe(false);
    expect(listDripQuarantine(s.db)).toHaveLength(0);
  });

  it('every item of a batch is followed by finish() (the /clear)', async () => {
    const s = setup();
    s.queue(3);
    let n = 0;
    s.fake.reply = (i) => { s.markSent(i.promptText); return { status: 'ok', stopReason: 'end_turn', summary: '', toolCalls: 1, runId: `w${++n}` }; };
    const r = await dripTick(s.d);
    expect(r.runs?.length).toBeGreaterThanOrEqual(2);
    expect(s.fake.finished).toEqual(s.fake.inputs.map((_, k) => `w${k + 1}`));
  });
});

describe('gates come before any text is typed', () => {
  it('outside the window, quiet hours, kill switch, SEND_LIMIT_PER_RUN=0, spacing: dispatcher untouched', async () => {
    const s = setup({ start: AFTER_WINDOW });
    s.queue(2);
    expect(await dripTick(s.d)).toMatchObject({ reason: 'outside_window' });
    s.setNow(QUIET);
    expect(await dripTick(s.d)).toMatchObject({ reason: 'quiet_hours' });
    const k = setup({ stopExists: () => true });
    k.queue(1);
    expect(await dripTick(k.d)).toMatchObject({ reason: 'killed' });
    const z = setup({ env: { WINDOW_LANES: 'mail', SEND_LIMIT_PER_RUN: '0' } });
    z.queue(1);
    expect(await dripTick(z.d)).toMatchObject({ reason: 'send_limit_zero' });
    for (const x of [s, k, z]) expect(x.fake.inputs).toHaveLength(0);
  });

  it('with the real dispatcher and a fake tmux: a failed gate types nothing', async () => {
    const calls: string[][] = [];
    const run: Run = async (_c, args) => { calls.push(args); return { stdout: '0|mail|0|claude', code: 0 }; };
    const s = setup({ start: AFTER_WINDOW });
    s.d.windows = new WindowDispatcher({ root: s.dir, session: 'Jobber', run, db: s.db, killed: () => false });
    s.queue(1);
    await dripTick(s.d);
    expect(calls.filter((c) => c[0] === 'send-keys')).toHaveLength(0);
  });

  it('with the real dispatcher: missing window falls back to headless, busy window skips with nothing typed', async () => {
    const calls: string[][] = [];
    const run: Run = async (_c, args) => { calls.push(args); return { stdout: '', code: 0 }; }; // no windows listed
    const s = setup();
    s.d.windows = new WindowDispatcher({ root: s.dir, session: 'Jobber', run, db: s.db, killed: () => false });
    const [id] = s.queue(1);
    await dripTick(s.d);
    expect(s.launcher.starts[0].prompt).toMatch(new RegExp(`row id ${id} `));
    expect(calls.filter((c) => c[0] === 'send-keys')).toHaveLength(0);

    const calls2: string[][] = [];
    const run2: Run = async (_c, args) => { calls2.push(args); return { stdout: args[0] === 'list-windows' ? '0|mail|0|claude' : '', code: 0 }; };
    const b = setup();
    b.d.windows = new WindowDispatcher({ root: b.dir, session: 'Jobber', run: run2, db: b.db, killed: () => false });
    const [bid] = b.queue(1);
    const lock = takeWindowLock(b.dir, 'mail', 'other');
    expect(lock).not.toBeNull();
    const r = await dripTick(b.d);
    expect(r.runs?.[0]).toMatchObject({ skipped: true });
    expect(b.launcher.starts).toHaveLength(0);
    expect(calls2.filter((c) => c[0] === 'send-keys')).toHaveLength(0);
    expect(b.status(bid)).toBe('queued');
    lock?.release();
  });
});
