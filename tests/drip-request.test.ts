// Owner "run one drip tick now" requests (src/scheduler/dripRequest.ts) consumed by both lanes. Fakes only.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { loadTuning } from '../src/outreach/tuning.js';
import { upsertPerson } from '../src/outreach/people.js';
import { haltPlatform } from '../src/outreach/limits.js';
import type { DriverDeps } from '../src/scheduler/driver.js';
import { launcherAsWindows, type LaunchHandle, type LaunchPlan, type Launcher, type PollResult } from './helpers/fakeWindows.js';
import { dripTick, STATE_NEXT_AT } from '../src/scheduler/mailDrip.js';
import { LI_STATE_INBOX_AT, LI_STATE_LAST_AT, LI_STATE_NEXT_AT, linkedinDripTick } from '../src/scheduler/linkedinDrip.js';
import { getState, setState } from '../src/scheduler/runLog.js';
import {
  readFreshRequest, readRefusal, reasonCode, refusalKey, requestKey, REQUEST_TTL_MS, writeDripRequest,
} from '../src/scheduler/dripRequest.js';

const NOON_IST = new Date('2026-10-15T08:00:00.000Z');
const QUIET = new Date('2026-10-14T21:00:00.000Z');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }); });
const sqlTime = (d: Date): string => d.toISOString().slice(0, 19).replace('T', ' ');

class FakeLauncher implements Launcher {
  starts: LaunchPlan[] = [];
  constructor(private onStart: (plan: LaunchPlan) => void) {}
  async start(plan: LaunchPlan): Promise<LaunchHandle> {
    this.starts.push(plan);
    this.onStart(plan);
    return { runId: plan.runId, session: plan.session, window: `w-${plan.runId}`, logPath: 'l', exitPath: 'e', promptPath: 'p' };
  }
  async poll(): Promise<PollResult> { return { exited: true, exitCode: 0, newOutput: '' }; }
  async kill(): Promise<void> {}
}

function setup(opts: { env?: NodeJS.ProcessEnv; start?: Date; stop?: () => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'drip-req-'));
  dirs.push(dir);
  let t = (opts.start ?? NOON_IST).getTime();
  const env = opts.env ?? {};
  const db = openDb(':memory:');
  const clock = (): Date => new Date(t);
  const launcher = new FakeLauncher((plan) => {
    const m = /outreach_queue row id (\d+)/.exec(plan.prompt);
    if (m) db.prepare("UPDATE outreach_queue SET email_status = 'sent', email_sent_at = ? WHERE id = ?").run(sqlTime(clock()), Number(m[1]));
  });
  const d: DriverDeps = {
    db, now: clock, rng: () => 0, sleep: async (ms) => { t += ms; },
    cfg: loadOutreachConfig(env), tuning: loadTuning(env), env,
    lockRoot: join(dir, 'locks'), stopFile: join(dir, 'STOP'), projectRoot: dir,
    windows: launcherAsWindows(launcher, () => d), notifier: { notify: async () => undefined },
    newRunId: (() => { let i = 0; return () => `q${String(++i).padStart(7, '0')}`; })(),
    control: opts.stop ? { exists: opts.stop, read: () => 'stop' } : undefined,
  };
  const queue = (n: number): void => {
    for (let i = 1; i <= n; i++) {
      db.prepare("INSERT INTO contacts (company, email, type, verified, source, confidence) VALUES ('C', ?, 'hr', 1, 't', 0.9)").run(`p${i}@co${i}.example`);
      db.prepare("INSERT INTO jobs (id, source, title, company, url) VALUES (?, 't', 'T', 'C', 'u')").run(`job${i}`);
      db.prepare("INSERT INTO outreach_queue (job_id, email_subject, email_body, email_to) VALUES (?, 's', 'b', ?)").run(`job${i}`, `p${i}@co${i}.example`);
    }
  };
  return { d, db, launcher, queue, now: clock, advance: (ms: number) => void (t += ms) };
}

const future = (s: { now: () => Date }, min: number): string => new Date(s.now().getTime() + min * 60_000).toISOString();

describe('request storage', () => {
  it('write, read fresh, expire after the ttl, and refuse a request dated in the future', () => {
    const s = setup();
    const req = writeDripRequest(s.db, 'mail', s.now());
    expect(req.id).toMatch(/^[0-9a-f]{8}$/);
    expect(readFreshRequest(s.db, 'mail', s.now())?.id).toBe(req.id);
    expect(readFreshRequest(s.db, 'linkedin', s.now())).toBeNull();
    expect(readFreshRequest(s.db, 'mail', new Date(s.now().getTime() + REQUEST_TTL_MS + 1))).toBeNull();
    setState(s.db, requestKey('mail'), JSON.stringify({ id: 'x', at: future(s, 30) }), s.now());
    expect(readFreshRequest(s.db, 'mail', s.now())).toBeNull();
    setState(s.db, requestKey('mail'), 'not json', s.now());
    expect(readFreshRequest(s.db, 'mail', s.now())).toBeNull();
  });
  it('reason codes are short and clean', () => {
    expect(reasonCode('state_error: boom <b>')).toBe('state_error');
    expect(reasonCode('')).toBe('unknown');
  });
});

describe('mail lane', () => {
  it('without a request the stored next-tick time holds; a fresh request skips it once and is cleared', async () => {
    const s = setup();
    s.queue(5);
    setState(s.db, STATE_NEXT_AT, future(s, 30), s.now());
    expect(await dripTick(s.d)).toMatchObject({ status: 'skipped', reason: 'spacing' });
    expect(s.launcher.starts).toHaveLength(0);
    writeDripRequest(s.db, 'mail', s.now());
    const r = await dripTick(s.d);
    expect(r.status).toBe('ran');
    expect(s.launcher.starts.length).toBeGreaterThan(0);
    expect(getState(s.db, requestKey('mail'))).toBe('');
    expect(readRefusal(s.db, 'mail')).toBeNull();
    // the next tick is spaced again: the request does not repeat
    expect(await dripTick(s.d)).toMatchObject({ status: 'skipped', reason: 'spacing' });
  });

  it('a stale request is ignored (the spacing holds), cleared and leaves no refusal', async () => {
    const s = setup();
    s.queue(3);
    setState(s.db, STATE_NEXT_AT, future(s, 30), s.now());
    setState(s.db, requestKey('mail'), JSON.stringify({ id: 'old', at: new Date(s.now().getTime() - 11 * 60_000).toISOString() }), s.now());
    expect(await dripTick(s.d)).toMatchObject({ reason: 'spacing' });
    expect(getState(s.db, requestKey('mail'))).toBe('');
    expect(readRefusal(s.db, 'mail')).toBeNull();
    expect(s.launcher.starts).toHaveLength(0);
  });

  it('every other gate still refuses, the reason is stored and the request is cleared', async () => {
    const killed = setup({ stop: () => true });
    killed.queue(2);
    writeDripRequest(killed.db, 'mail', killed.now());
    expect(await dripTick(killed.d)).toMatchObject({ reason: 'killed' });
    expect(readRefusal(killed.db, 'mail')).toMatchObject({ reason: 'killed' });
    expect(getState(killed.db, requestKey('mail'))).toBe('');

    const quiet = setup({ start: QUIET });
    quiet.queue(2);
    writeDripRequest(quiet.db, 'mail', quiet.now());
    expect(await dripTick(quiet.d)).toMatchObject({ reason: 'quiet_hours' });

    const cap = setup({ env: { EMAIL_MAX_PER_DAY: '1' } });
    cap.queue(3);
    cap.db.prepare("INSERT INTO daily_counters (day, key, count) VALUES (date('now'), 'send_email', 1)").run();
    writeDripRequest(cap.db, 'mail', cap.now());
    expect(await dripTick(cap.d)).toMatchObject({ reason: 'daily_cap' });

    const bad = setup({ env: { EMAIL_DRIP_MIN_BATCH: 'x' } });
    bad.queue(1);
    writeDripRequest(bad.db, 'mail', bad.now());
    expect(await dripTick(bad.d)).toMatchObject({ reason: 'bad_config' });

    const brake = setup({ env: { SEND_LIMIT_PER_RUN: '0' } });
    brake.queue(1);
    writeDripRequest(brake.db, 'mail', brake.now());
    expect(await dripTick(brake.d)).toMatchObject({ reason: 'send_limit_zero' });

    const empty = setup();
    writeDripRequest(empty.db, 'mail', empty.now());
    expect(await dripTick(empty.d)).toMatchObject({ reason: 'nothing_queued' });
    expect(readRefusal(empty.db, 'mail')).toMatchObject({ reason: 'nothing_queued' });
    for (const x of [killed, quiet, cap, bad, brake, empty]) expect(x.launcher.starts).toHaveLength(0);
  });

  it('the minimum gap since the last real send is kept', async () => {
    const s = setup();
    s.queue(3);
    s.db.prepare("INSERT INTO jobs (id, source, title, company, url) VALUES ('old', 't', 'T', 'C', 'u')").run();
    s.db.prepare("INSERT INTO outreach_queue (job_id, email_to, email_status, email_sent_at) VALUES ('old', 'z@z.example', 'sent', ?)").run(sqlTime(new Date(s.now().getTime() - 2 * 60_000)));
    setState(s.db, STATE_NEXT_AT, future(s, 30), s.now());
    writeDripRequest(s.db, 'mail', s.now());
    expect(await dripTick(s.d)).toMatchObject({ reason: 'spacing' });
    expect(readRefusal(s.db, 'mail')).toMatchObject({ reason: 'spacing' });
    expect(s.launcher.starts).toHaveLength(0);
  });
});

describe('linkedin lane', () => {
  const dmDue = (s: ReturnType<typeof setup>): void => {
    const id = upsertPerson(s.db, { platform: 'linkedin', profileKey: 'linkedin.com/in/jane', name: 'Jane', headline: 'Recruiter at Acme', company: 'Acme', category: 'recruiter' });
    s.db.prepare('UPDATE contact_state SET stage = ?, cycle_started_at = ? WHERE person_id = ?').run('active', new Date(s.now().getTime() - 30 * 86400_000).toISOString(), id);
    s.db.prepare("INSERT INTO touches (person_id, kind, idempotency_key, status, sent_at) VALUES (?, 'connect', 'c-jane', 'sent', ?)").run(id, new Date(s.now().getTime() - 10 * 86400_000).toISOString());
    s.db.prepare("INSERT INTO connections (profile_url, status) VALUES (?, 'connected')").run('https://www.linkedin.com/in/jane');
    setState(s.db, LI_STATE_INBOX_AT, s.now().toISOString(), s.now());
  };

  it('a fresh request skips the stored next-tick time once and is cleared', async () => {
    const s = setup();
    dmDue(s);
    setState(s.db, LI_STATE_NEXT_AT, future(s, 30), s.now());
    expect(await linkedinDripTick(s.d)).toMatchObject({ status: 'skipped', reason: 'spacing' });
    writeDripRequest(s.db, 'linkedin', s.now());
    expect((await linkedinDripTick(s.d)).status).toBe('ran');
    expect(getState(s.db, requestKey('linkedin'))).toBe('');
    expect(s.launcher.starts).toHaveLength(1);
  });

  it('a stale request changes nothing', async () => {
    const s = setup();
    dmDue(s);
    setState(s.db, LI_STATE_NEXT_AT, future(s, 30), s.now());
    setState(s.db, requestKey('linkedin'), JSON.stringify({ id: 'old', at: new Date(s.now().getTime() - 20 * 60_000).toISOString() }), s.now());
    expect(await linkedinDripTick(s.d)).toMatchObject({ reason: 'spacing' });
    expect(getState(s.db, requestKey('linkedin'))).toBe('');
    expect(getState(s.db, refusalKey('linkedin'))).toBeNull();
  });

  it('kill switch, halt, quiet hours, disabled lane and the minimum gap still refuse', async () => {
    const killed = setup({ stop: () => true });
    dmDue(killed);
    writeDripRequest(killed.db, 'linkedin', killed.now());
    expect(await linkedinDripTick(killed.d)).toMatchObject({ reason: 'killed' });
    expect(readRefusal(killed.db, 'linkedin')).toMatchObject({ reason: 'killed' });

    const halted = setup();
    dmDue(halted);
    haltPlatform(halted.db, 'linkedin', 'checkpoint', halted.now());
    writeDripRequest(halted.db, 'linkedin', halted.now());
    expect(await linkedinDripTick(halted.d)).toMatchObject({ reason: 'halted' });

    const quiet = setup({ start: QUIET });
    dmDue(quiet);
    writeDripRequest(quiet.db, 'linkedin', quiet.now());
    expect(await linkedinDripTick(quiet.d)).toMatchObject({ reason: 'quiet_hours' });

    const off = setup({ env: { LINKEDIN_DRIP: 'false' } });
    dmDue(off);
    writeDripRequest(off.db, 'linkedin', off.now());
    expect(await linkedinDripTick(off.d)).toMatchObject({ reason: 'disabled' });

    const gap = setup();
    dmDue(gap);
    setState(gap.db, LI_STATE_LAST_AT, new Date(gap.now().getTime() - 2 * 60_000).toISOString(), gap.now());
    setState(gap.db, LI_STATE_NEXT_AT, future(gap, 30), gap.now());
    writeDripRequest(gap.db, 'linkedin', gap.now());
    expect(await linkedinDripTick(gap.d)).toMatchObject({ reason: 'spacing' });
    for (const x of [killed, halted, quiet, off, gap]) expect(x.launcher.starts).toHaveLength(0);
  });
});
