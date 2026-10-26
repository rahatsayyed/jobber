// The mail drip lane (src/scheduler/mailDrip.ts): fake clock, fake launcher, in-memory db. Nothing is sent, no tmux, no claude.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { loadTuning } from '../src/outreach/tuning.js';
import { acquireLock } from '../src/platform/lock.js';
import type { DriverDeps } from '../src/scheduler/driver.js';
import type { LaunchHandle, LaunchPlan, Launcher, PollResult } from '../src/scheduler/launch.js';
import type { Notice } from '../src/scheduler/notify.js';
import { buildDripPrompt, dripTick, listDripQuarantine, releaseDripQuarantine, pickDripItem, inSendWindow, loadDripConfig, NO_CAP_LIMIT, STATE_NEXT_AT } from '../src/scheduler/mailDrip.js';
import { getState, listRuns } from '../src/scheduler/runLog.js';
import { planWake, stepOrder, type PlanKnobs } from '../src/scheduler/plan.js';
import { pipelineLines } from '../src/scheduler/pipeline.js';
import { quietFromConfig } from '../src/outreach/quiet.js';
import { readControl } from '../src/scheduler/control.js';
import { ceilings } from '../src/outreach/limits.js';
import type { DueCounts } from '../src/scheduler/due.js';

const NOON_IST = new Date('2026-10-15T08:00:00.000Z'); // 13:30 IST, inside the window
const BEFORE_WINDOW = new Date('2026-10-15T03:00:00.000Z'); // 08:30 IST
const AFTER_WINDOW = new Date('2026-10-15T14:00:00.000Z'); // 19:30 IST
const QUIET = new Date('2026-10-14T21:00:00.000Z'); // 02:30 IST
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const sqlTime = (d: Date): string => d.toISOString().slice(0, 19).replace('T', ' ');

class FakeLauncher implements Launcher {
  starts: LaunchPlan[] = [];
  startedAt: number[] = [];
  live = 0;
  maxLive = 0;
  exitCode = 0;
  constructor(private onStart: (plan: LaunchPlan) => void = () => undefined, private now: () => Date = () => new Date()) {}
  async start(plan: LaunchPlan): Promise<LaunchHandle> {
    this.starts.push(plan);
    this.startedAt.push(this.now().getTime());
    this.live++;
    this.maxLive = Math.max(this.maxLive, this.live);
    this.onStart(plan);
    return { runId: plan.runId, session: plan.session, window: `wake-${plan.runId}`, logPath: 'l', exitPath: 'e', promptPath: 'p' };
  }
  async poll(): Promise<PollResult> {
    this.live = Math.max(0, this.live - 1);
    return { exited: true, exitCode: this.exitCode, newOutput: '' };
  }
  async kill(): Promise<void> {}
}

function setup(opts: { start?: Date; env?: NodeJS.ProcessEnv; rng?: () => number; sends?: boolean; stopExists?: () => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mail-drip-'));
  dirs.push(dir);
  let t = (opts.start ?? NOON_IST).getTime();
  const env = opts.env ?? {};
  const notices: Notice[] = [];
  const db = openDb(':memory:');
  const clock = (): Date => new Date(t);
  const launcher = new FakeLauncher((plan) => {
    if (opts.sends === false) return;
    const m = /outreach_queue row id (\d+)/.exec(plan.prompt);
    if (m) db.prepare("UPDATE outreach_queue SET email_status = 'sent', email_sent_at = ? WHERE id = ?").run(sqlTime(clock()), Number(m[1]));
  }, clock);
  const d: DriverDeps = {
    db,
    now: clock,
    rng: opts.rng ?? (() => 0),
    sleep: async (ms) => {
      t += ms;
    },
    cfg: loadOutreachConfig(env),
    tuning: loadTuning(env),
    env,
    lockRoot: join(dir, 'locks'),
    stopFile: join(dir, 'STOP'),
    runDir: join(dir, 'runs'),
    projectRoot: dir,
    launcher,
    notifier: { notify: async (n) => void notices.push(n) },
    newRunId: (() => {
      let i = 0;
      return () => `drip${String(++i).padStart(8, '0')}`;
    })(),
    control: opts.stopExists ? { exists: opts.stopExists, read: () => 'stop it' } : undefined,
    pollMs: 5000,
  };
  const verify = (addr: string): void => void db.prepare("INSERT INTO contacts (company, email, type, verified, source, confidence) VALUES ('C', ?, 'hr', 1, 't', 0.9)").run(addr);
  const queue = (n: number, to: (i: number) => string = (i) => `person${i}@co${i}.example`, verified = true): number[] => {
    const ids: number[] = [];
    for (let i = 1; i <= n; i++) {
      if (verified) verify(to(i));
      db.prepare("INSERT INTO jobs (id, source, title, company, url) VALUES (?, 't', 'T', 'C', 'u')").run(`job${i}`);
      ids.push(Number(db.prepare("INSERT INTO outreach_queue (job_id, email_subject, email_body, email_to) VALUES (?, 's', 'b', ?)").run(`job${i}`, to(i)).lastInsertRowid));
    }
    return ids;
  };
  const sent = (): number => (db.prepare("SELECT COUNT(*) AS n FROM outreach_queue WHERE email_status = 'sent'").get() as { n: number }).n;
  return { d, db, launcher, notices, queue, verify, sent, advance: (ms: number) => void (t += ms), clock, setNow: (x: Date) => void (t = x.getTime()) };
}

describe('config and window', () => {
  it('defaults: 09:30-19:00 IST, batch 2-3, gap 5-8 min, pause 10-40 s, no cap, sane', () => {
    const c = loadDripConfig({});
    expect(c).toMatchObject({ windowStartMin: 570, windowEndMin: 1140, minBatch: 2, maxBatch: 3, minGapMin: 5, maxGapMin: 8, pauseMinSec: 10, pauseMaxSec: 40, maxPerDay: 0, problems: [] });
  });
  it('blank is the default; an inverted or malformed setting is a problem', () => {
    expect(loadDripConfig({ EMAIL_MAX_PER_DAY: '' }).problems).toEqual([]);
    expect(loadDripConfig({ EMAIL_SEND_WINDOW_START: '20:00' }).problems.join()).toMatch(/before/);
    expect(loadDripConfig({ EMAIL_DRIP_MIN_GAP_MIN: '9' }).problems.join()).toMatch(/MIN_GAP/);
    expect(loadDripConfig({ EMAIL_DRIP_MIN_BATCH: '5' }).problems.join()).toMatch(/BATCH/);
    expect(loadDripConfig({ EMAIL_DRIP_INTRA_PAUSE_MIN_SEC: '50' }).problems.join()).toMatch(/PAUSE/);
    expect(loadDripConfig({ EMAIL_SEND_WINDOW_END: '25:00' }).problems.join()).toMatch(/HH:MM/);
  });
  it('the window is read as IST', () => {
    const c = loadDripConfig({});
    expect(inSendWindow(NOON_IST, c)).toBe(true);
    expect(inSendWindow(BEFORE_WINDOW, c)).toBe(false);
    expect(inSendWindow(AFTER_WINDOW, c)).toBe(false);
  });
});

describe('dripTick', () => {
  it('sends nothing outside the window or in quiet hours, then sends inside it', async () => {
    const s = setup({ start: BEFORE_WINDOW });
    s.queue(3);
    expect(await dripTick(s.d)).toMatchObject({ status: 'skipped', reason: 'outside_window' });
    s.setNow(AFTER_WINDOW);
    expect(await dripTick(s.d)).toMatchObject({ reason: 'outside_window' });
    s.setNow(QUIET);
    expect(await dripTick(s.d)).toMatchObject({ reason: 'quiet_hours' });
    expect(s.launcher.starts).toHaveLength(0);
    s.setNow(NOON_IST);
    expect((await dripTick(s.d)).status).toBe('ran');
    expect(s.launcher.starts.length).toBeGreaterThan(0);
  });

  it('sends a batch of 2 (rng 0) or 3 (rng 0.99), one run per email, sequential, with a 10 to 40 s pause between', async () => {
    const lo = setup({ rng: () => 0 });
    lo.queue(5);
    const r1 = await dripTick(lo.d);
    expect(r1.runs).toHaveLength(2);
    expect(lo.sent()).toBe(2);
    expect(lo.launcher.maxLive).toBe(1);
    expect(lo.launcher.startedAt[1] - lo.launcher.startedAt[0]).toBeGreaterThanOrEqual(10_000);
    const hi = setup({ rng: () => 0.99 });
    hi.queue(5);
    const r2 = await dripTick(hi.d);
    expect(r2.runs).toHaveLength(3);
    expect(hi.launcher.maxLive).toBe(1);
    const gaps = [1, 2].map((i) => hi.launcher.startedAt[i] - hi.launcher.startedAt[i - 1]);
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(10_000);
      expect(g).toBeLessThanOrEqual(45_000 + 10_000); // pause plus the fake poll step
    }
    for (const p of hi.launcher.starts) expect(p.profile).toBe('mail_drip');
  });

  it('spacing: the next tick waits 5 to 8 minutes after the batch, and the wait survives a restart', async () => {
    const s = setup({ rng: () => 0 });
    s.queue(8);
    await dripTick(s.d);
    const next = Date.parse(getState(s.db, STATE_NEXT_AT) as string);
    const waited = next - s.clock().getTime();
    expect(waited).toBeGreaterThanOrEqual(5 * 60_000 - 1000);
    expect(waited).toBeLessThanOrEqual(8 * 60_000);
    // restart: a fresh deps object over the same database
    let n = 50;
    const again: DriverDeps = { ...s.d, newRunId: () => `drip${String(++n).padStart(8, '0')}` };
    expect(await dripTick(again)).toMatchObject({ status: 'skipped', reason: 'spacing' });
    s.advance(4 * 60_000);
    expect(await dripTick(again)).toMatchObject({ reason: 'spacing' });
    s.advance(5 * 60_000);
    expect((await dripTick(again)).status).toBe('ran');
    expect(s.sent()).toBe(4);
  });

  it('spacing also counts the newest real send made outside the lane', async () => {
    const s = setup();
    s.queue(2);
    s.db.prepare("UPDATE outreach_queue SET email_status = 'sent', email_sent_at = ? WHERE id = 1").run(sqlTime(new Date(NOON_IST.getTime() - 2 * 60_000)));
    expect(await dripTick(s.d)).toMatchObject({ reason: 'spacing' });
  });

  it('dedupe is per address: two people at one company are both emailed', async () => {
    const s = setup({ rng: () => 0 });
    s.queue(2, (i) => `p${i}@same.example`);
    const r = await dripTick(s.d);
    expect(r.runs).toHaveLength(2);
    expect(s.sent()).toBe(2);
  });

  it('one address is never emailed twice by the cold path: the second row with the same address is skipped', async () => {
    const s = setup({ rng: () => 0.99 });
    s.queue(3, (i) => (i <= 2 ? 'Same.Person@co.example' : 'other@co.example'));
    const r = await dripTick(s.d);
    const sentTo = (s.db.prepare("SELECT job_id, email_to FROM outreach_queue WHERE email_status = 'sent' ORDER BY id").all() as { job_id: string; email_to: string }[]);
    expect(sentTo.map((x) => x.job_id)).toEqual(['job1', 'job3']);
    expect(r.runs).toHaveLength(2); // the duplicate was skipped, only two distinct addresses existed
    // a later tick never sends the duplicate either
    s.advance(60 * 60_000);
    expect(await dripTick(s.d)).toMatchObject({ reason: 'nothing_queued' });
    expect(s.launcher.starts).toHaveLength(2);
  });

  it('a dripped row the operator skipped is not retried inside the same tick', async () => {
    const s = setup({ rng: () => 0.99, sends: false });
    s.queue(5);
    const r = await dripTick(s.d);
    expect(r.runs).toHaveLength(3);
    const ids = s.launcher.starts.map((p) => /row id (\d+)/.exec(p.prompt)?.[1]);
    expect(new Set(ids).size).toBe(3);
  });

  it('daily cap when set trims the batch and stops; no cap when unset', async () => {
    const capped = setup({ env: { EMAIL_MAX_PER_DAY: '3' }, rng: () => 0.99 });
    capped.queue(10);
    expect((await dripTick(capped.d)).runs).toHaveLength(3);
    expect(capped.launcher.starts[0].prompt).toContain('DAILY_SEND_LIMIT=3');
    expect(capped.launcher.starts[0].env?.SEND_LIMIT_PER_RUN).toBe('3');
    capped.db.prepare("INSERT OR REPLACE INTO daily_counters (day, key, count) VALUES (date('now'), 'send_email', 3)").run();
    capped.advance(60 * 60_000);
    expect(await dripTick(capped.d)).toMatchObject({ reason: 'daily_cap' });

    const free = setup({ rng: () => 0.99 });
    free.queue(10);
    free.db.prepare("INSERT OR REPLACE INTO daily_counters (day, key, count) VALUES (date('now'), 'send_email', 40)").run();
    expect((await dripTick(free.d)).status).toBe('ran');
    expect(free.launcher.starts[0].prompt).toContain(`DAILY_SEND_LIMIT=${NO_CAP_LIMIT}`);
  });

  it('dry run: the run is recorded as dry and told "dry run", nothing is marked sent by the lane', async () => {
    const s = setup({ env: { JOBBER_DRY_RUN: 'true' }, sends: false, rng: () => 0 });
    s.queue(2);
    await dripTick(s.d);
    expect(s.launcher.starts.every((p) => p.dryRun && /^dry run$/m.test(p.prompt))).toBe(true);
    const rows = listRuns(s.db, 10);
    expect(rows.every((r) => r.dry_run === 1 && r.trigger === 'mail_drip')).toBe(true);
    expect(s.sent()).toBe(0);
  });

  it('live run is not told "dry run"; runs are logged with trigger mail_drip', async () => {
    const s = setup({ rng: () => 0 });
    s.queue(2);
    await dripTick(s.d);
    expect(s.launcher.starts.every((p) => !p.dryRun && !/^dry run$/m.test(p.prompt))).toBe(true);
    expect(listRuns(s.db, 10).map((r) => `${r.trigger}:${r.status}`)).toEqual(['mail_drip:ok', 'mail_drip:ok']);
  });

  it('kill switch and an invalid config send nothing', async () => {
    const s = setup({ stopExists: () => true });
    s.queue(2);
    expect(await dripTick(s.d)).toMatchObject({ reason: 'killed' });
    const bad = setup({ env: { EMAIL_DRIP_MIN_GAP_MIN: '30' } });
    bad.queue(2);
    expect(await dripTick(bad.d)).toMatchObject({ reason: 'bad_config' });
    expect(s.launcher.starts.length + bad.launcher.starts.length).toBe(0);
  });

  it('an all-platform halt stops the lane', async () => {
    const s = setup();
    s.queue(2);
    s.db.prepare("INSERT INTO halt_flags (platform, reason, set_at, cleared_at) VALUES ('all', 'x', 'now', NULL)").run();
    expect(readControl(s.db, { stopFile: s.d.stopFile, env: {}, exists: () => false, read: () => '' }).killed).toBe(true);
    expect(await dripTick(s.d)).toMatchObject({ reason: 'killed' });
  });

  it('never two mail-operators at once: concurrent ticks and a held lock produce one set of runs', async () => {
    const s = setup({ rng: () => 0 });
    s.queue(6);
    const [a, b] = await Promise.all([dripTick(s.d), dripTick(s.d)]);
    expect([a.status, b.status].sort()).toEqual(['ran', 'skipped']);
    expect(s.launcher.maxLive).toBe(1);
    expect(s.sent()).toBe(2);
    const held = setup();
    held.queue(2);
    const lock = acquireLock(held.d.lockRoot, 'mail', 'other');
    expect(lock).not.toBeNull();
    expect(await dripTick(held.d)).toMatchObject({ reason: 'locked' });
    expect(held.launcher.starts).toHaveLength(0);
    lock?.release();
  });

  it('a run that fails without a recorded send holds that row: it is never picked again automatically', async () => {
    const s = setup({ rng: () => 0, sends: false });
    s.launcher.exitCode = 1;
    s.queue(1);
    const r = await dripTick(s.d);
    expect(r.runs).toHaveLength(1);
    expect(s.notices.some((n) => /held for the owner/.test(n.title))).toBe(true);
    s.advance(60 * 60_000);
    expect(await dripTick(s.d)).toMatchObject({ reason: 'nothing_queued' });
  });

  it('never sends a row whose job was excluded or an address a contacts row marks unverified', async () => {
    const s = setup({ rng: () => 0 });
    s.queue(2, undefined, false);
    s.verify('person1@co1.example');
    s.db.prepare("UPDATE jobs SET excluded_reason = 'x' WHERE id = 'job1'").run();
    s.db.prepare("INSERT INTO contacts (company, email, type, verified, source, confidence) VALUES ('C', 'person2@co2.example', 'hr', 0, 't', 0.1)").run();
    expect(await dripTick(s.d)).toMatchObject({ reason: 'nothing_queued' });
  });
});

describe('fail closed on unverified addresses (Safety rule 1)', () => {
  it('a row with NO contacts row is never picked or sent', async () => {
    const s = setup({ rng: () => 0 });
    s.queue(2, undefined, false);
    expect(pickDripItem(s.db, NOON_IST, {})).toMatchObject({ item: null, reason: 'nothing_queued' });
    expect(await dripTick(s.d)).toMatchObject({ reason: 'nothing_queued' });
    expect(s.launcher.starts).toHaveLength(0);
  });
  it('an unverified contacts row is refused, a verified one is sent, case does not matter', async () => {
    const s = setup({ rng: () => 0 });
    s.queue(3, (i) => (i === 3 ? 'Person3@Co3.Example' : `person${i}@co${i}.example`), false);
    s.db.prepare("INSERT INTO contacts (company, email, type, verified, source, confidence) VALUES ('C', 'person1@co1.example', 'hr', 0, 't', 0.1)").run();
    s.verify('PERSON3@co3.example');
    const r = await dripTick(s.d);
    expect(r.runs).toHaveLength(1);
    expect(s.launcher.starts[0].prompt).toContain('row id 3');
  });
  it('a verified post email is sent, a free-mail post email (never verified, so no contacts row) is not', () => {
    const s = setup();
    s.queue(2, (i) => (i === 1 ? 'hiring@startup.example' : 'someone@gmail.com'), false);
    s.db.prepare("INSERT INTO contacts (company, email, type, verified, source, confidence) VALUES ('C', 'hiring@startup.example', 'generic', 1, 'post', 0.5)").run();
    const p = pickDripItem(s.db, NOON_IST, {});
    expect(p).toMatchObject({ item: { kind: 'cold', address: 'hiring@startup.example' } });
    s.db.prepare("UPDATE outreach_queue SET email_status = 'sent' WHERE job_id = 'job1'").run();
    expect(pickDripItem(s.db, NOON_IST, {})).toMatchObject({ item: null });
  });
});

describe('caps: EMAIL_MAX_PER_DAY is the drip cap, SEND_LIMIT_PER_RUN=0 is the emergency brake', () => {
  it('unset or 0 EMAIL_MAX_PER_DAY means no cap, whatever SEND_LIMIT_PER_RUN says', async () => {
    const s = setup({ rng: () => 0, env: { SEND_LIMIT_PER_RUN: '1' } });
    s.queue(4);
    await dripTick(s.d);
    expect(s.launcher.starts.every((p) => p.prompt.includes(`DAILY_SEND_LIMIT=${NO_CAP_LIMIT}`))).toBe(true);
  });
  it('EMAIL_MAX_PER_DAY caps the drip and is the daily limit handed to the operator', async () => {
    const s = setup({ rng: () => 0.99, env: { EMAIL_MAX_PER_DAY: '2', SEND_LIMIT_PER_RUN: '1' } });
    s.queue(5);
    const r = await dripTick(s.d);
    expect(r.runs).toHaveLength(2);
    expect(s.launcher.starts[0].prompt).toContain('DAILY_SEND_LIMIT=2');
  });
  it('SEND_LIMIT_PER_RUN=0 stops all email even with EMAIL_MAX_PER_DAY set or unset', async () => {
    for (const env of [{ SEND_LIMIT_PER_RUN: '0' }, { SEND_LIMIT_PER_RUN: ' 0 ', EMAIL_MAX_PER_DAY: '50' }]) {
      const s = setup({ rng: () => 0, env });
      s.queue(3);
      expect(await dripTick(s.d)).toMatchObject({ status: 'skipped', reason: 'send_limit_zero' });
      expect(s.launcher.starts).toHaveLength(0);
    }
  });
});

describe('quarantined drip rows can be listed and released by the owner', () => {
  it('lists the held row and releases it by id without sending anything', async () => {
    const s = setup({ rng: () => 0, sends: false });
    s.launcher.exitCode = 1;
    const [id] = s.queue(1);
    await dripTick(s.d);
    expect(listDripQuarantine(s.db)).toEqual([expect.objectContaining({ id, job_id: 'job1' })]);
    s.advance(60 * 60_000);
    expect(pickDripItem(s.db, s.clock(), {})).toMatchObject({ item: null });
    expect(releaseDripQuarantine(s.db, id, s.clock())).toMatchObject({ released: true });
    expect(listDripQuarantine(s.db)).toEqual([]);
    expect(pickDripItem(s.db, s.clock(), {})).toMatchObject({ item: { id } });
    expect(s.sent()).toBe(0);
  });
  it('refuses an unknown id, a row that is not quarantined and a row that was in fact sent', async () => {
    const s = setup({ rng: () => 0, sends: false });
    s.launcher.exitCode = 1;
    const [id] = s.queue(1);
    expect(releaseDripQuarantine(s.db, id, s.clock())).toMatchObject({ released: false, reason: 'not_quarantined' });
    await dripTick(s.d);
    expect(releaseDripQuarantine(s.db, 9999, s.clock())).toMatchObject({ released: false, reason: 'not_quarantined' });
    s.db.prepare("UPDATE outreach_queue SET email_status = 'sent' WHERE id = ?").run(id);
    expect(releaseDripQuarantine(s.db, id, s.clock())).toMatchObject({ released: false, reason: 'already_sent' });
    expect(listDripQuarantine(s.db)).toHaveLength(1);
  });
});

describe('prompt', () => {
  const base = { runId: 'drip00000001', dryRun: false, now: NOON_IST, budget: { maxWallSec: 600, maxTokensApprox: 100000 }, item: { kind: 'cold', id: 7, job_id: 'j', address: 'a@b.c' } as const, dailyLimit: 5 };
  it('names exactly one item, quota 1, and the reply-check line only when the code says the check is clean', () => {
    const p = buildDripPrompt({ ...base, replyCheckClean: false });
    expect(p).toContain('outreach_queue row id 7');
    expect(p).toContain('mail quota 1');
    expect(p).not.toContain('pre-send reply check completed with no errors');
    expect(buildDripPrompt({ ...base, replyCheckClean: true })).toContain('pre-send reply check completed with no errors');
  });
});

describe('wakes no longer burst-send', () => {
  const knobs: PlanKnobs = { inboxEveryMin: 60, naukriDiscoverEveryHours: 6 };
  const due = (o: Partial<DueCounts> = {}): DueCounts => ({
    followupsDue: 0, newOutreachReady: 0,
    followupsDueByPlatform: { linkedin: 0, naukri: 0 }, newOutreachReadyByPlatform: { linkedin: 0, naukri: 0 },
    inboxLastCheckedMinAgo: 1, naukriSearchLastHoursAgo: 1, ...o,
  });
  const plan = (o: Partial<DueCounts>) => {
    const s = setup();
    const cfg = loadOutreachConfig({});
    return planWake({
      now: NOON_IST, quiet: quietFromConfig(cfg),
      control: readControl(s.db, { stopFile: s.d.stopFile, env: {}, exists: () => false, read: () => '' }),
      ceilings: ceilings(s.db, cfg, NOON_IST), due: due(o), knobs,
    });
  };
  it('queued cold email alone is nothing_due for a wake', () => {
    expect(plan({ emailQueued: 12 })).toMatchObject({ kind: 'skip', reason: 'nothing_due' });
  });
  it('ready email follow-ups still pull in the pipeline (its reply check) but never a mail stage', () => {
    const d = plan({ emailFollowupsReady: 3, emailQueued: 12 });
    expect(d.kind).toBe('run');
    if (d.kind !== 'run') return;
    expect(d.stages?.map((x) => x.kind)).toEqual(['pipeline']);
  });
  it('a wake with pipeline work has no mail stage and its prompt tells the session not to send', () => {
    const d = plan({ unmatchedJobs: 4, emailQueued: 12 });
    expect(d.kind).toBe('run');
    if (d.kind !== 'run') return;
    expect(d.stages?.some((x) => x.kind === 'mail' || x.operator === 'mail-operator')).toBe(false);
    expect(stepOrder(d).some((x) => x.operator === 'mail-operator')).toBe(false);
    const text = pipelineLines({ matchThreshold: 60, sendLimit: 1, targetRegions: 'Target regions: x', followupsAutonomous: false, codePass: null }).join('\n');
    expect(text).toMatch(/Do NOT dispatch `mail-operator`/);
    expect(text).not.toMatch(/Mail stage: dispatch/);
  });
});
