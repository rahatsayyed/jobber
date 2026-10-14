import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { upsertPerson } from '../src/outreach/people.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { TUNING_DEFAULTS } from '../src/outreach/tuning.js';
import { haltPlatform, haltReason, countSince } from '../src/outreach/limits.js';
import { getState, setState } from '../src/scheduler/runLog.js';
import { naukriSendMessage, naukriIdempotencyKey, type SendDeps, type PageDriver } from '../src/naukri/actions.js';

type Db = ReturnType<typeof openDb>;
const now = new Date('2026-10-14T10:00:00Z'); // 15:30 IST
const LIVE = { SCHEDULER_DRY_RUN: 'false' } as NodeJS.ProcessEnv;
const DRY = {} as NodeJS.ProcessEnv;

let db: Db;
let pid: number;
let calls: number;
let driverRes: { confirmed: boolean; observedRecipient: string | null };
let driverThrows: boolean;
let checkVerdict: 'pass' | 'warn' | 'block';
let styleOk: boolean;

const driver: PageDriver = {
  async sendInThread() {
    calls++;
    if (driverThrows) throw new Error('boom');
    return driverRes;
  },
};

const deps = (over: Partial<SendDeps> = {}): SendDeps => ({
  db, cfg: { ...loadOutreachConfig({}), quietStartHour: 0, quietEndHour: 0 }, now, env: LIVE, runId: 'run1',
  driver, tuning: TUNING_DEFAULTS,
  checkText: async (t) => ({ ok: checkVerdict !== 'block', normalized: t.trim(), verdict: checkVerdict }),
  style: () => ({ ok: styleOk, hits: styleOk ? [] : ['em_dash'] }),
  ...over,
});
const input = (text = 'Hi Pat, happy to share more about my React work.', over = {}) =>
  ({ personId: pid, threadRef: 'thread-1', text, kind: 'role_ask' as const, ...over });
const touches = () => db.prepare('SELECT * FROM touches').all() as any[];

beforeEach(() => {
  db = openDb(':memory:');
  pid = upsertPerson(db, { platform: 'naukri', profileKey: 'naukri:pat-recruiter', name: 'Pat Recruiter', company: 'Acme', category: 'recruiter' });
  setState(db, `naukri_thread_${pid}`, 'thread-1', now);
  calls = 0;
  driverRes = { confirmed: true, observedRecipient: 'Pat Recruiter' };
  driverThrows = false;
  checkVerdict = 'pass';
  styleOk = true;
});

describe('naukriSendMessage', () => {
  it('dry run records, consumes no ceiling, no driver, no touch', async () => {
    const r = await naukriSendMessage(deps({ env: DRY }), input());
    expect(r.status).toBe('dry_run');
    expect(calls).toBe(0);
    expect(touches()).toHaveLength(0);
    expect(countSince(db, 'naukri_message', new Date(0))).toBe(0);
    const row = db.prepare('SELECT * FROM dry_run_actions').get() as any;
    expect(row).toMatchObject({ platform: 'naukri', action: 'message', person_id: pid });
    expect(JSON.parse(row.payload)).toMatchObject({ kind: 'role_ask', thread_ref: 'thread-1' });
  });
  it('halted by naukri or all', async () => {
    haltPlatform(db, 'naukri', 'x', now);
    expect((await naukriSendMessage(deps(), input())).status).toBe('halted');
    db.prepare('UPDATE halt_flags SET cleared_at = ?').run(now.toISOString());
    haltPlatform(db, 'all', 'y', now);
    expect((await naukriSendMessage(deps(), input())).status).toBe('halted');
    expect(calls).toBe(0);
  });
  it('quiet hours blocks', async () => {
    const cfg = { ...loadOutreachConfig({}), quietStartHour: 10, quietEndHour: 20 };
    const r = await naukriSendMessage(deps({ cfg }), input());
    expect(r).toMatchObject({ status: 'blocked', reasons: ['quiet_hours'] });
  });
  it('cadence not due blocks a wrong kind', async () => {
    const r = await naukriSendMessage(deps(), input(undefined, { kind: 'followup' }));
    expect(r).toMatchObject({ status: 'blocked', reasons: ['cadence_not_due'] });
  });
  const inbound = (klass: string, escalated: number, at = '2026-10-14T09:00:00.000Z') =>
    db.prepare(
      `INSERT INTO inbound_messages (platform, thread_ref, person_id, text_hash, klass, escalated, created_at)
       VALUES ('naukri', 'thread-1', ?, ?, ?, ?, ?)`,
    ).run(pid, `h${klass}${escalated}${at}`, klass, escalated, at);
  it('derived reply-to-inbound skips cadence', async () => {
    inbound('recruiter_inquiry', 0);
    const r = await naukriSendMessage(deps(), input(undefined, { kind: 'followup' }));
    expect(r.status).toBe('sent');
  });
  it('escalated inbound does not skip cadence', async () => {
    inbound('recruiter_inquiry', 1);
    const r = await naukriSendMessage(deps(), input(undefined, { kind: 'followup' }));
    expect(r.reasons).toEqual(['cadence_not_due']);
  });
  it('unverified thread is blocked', async () => {
    const r = await naukriSendMessage(deps(), input(undefined, { threadRef: 'other-thread' }));
    expect(r).toMatchObject({ status: 'blocked', reasons: ['unverified_thread'] });
    expect(calls).toBe(0);
  });
  it('inbound thread is accepted without confirmed state', async () => {
    db.prepare("DELETE FROM scheduler_state WHERE key LIKE 'naukri_thread_%'").run();
    expect((await naukriSendMessage(deps(), input())).reasons).toEqual(['unverified_thread']);
    inbound('noise', 0);
    expect((await naukriSendMessage(deps(), input())).reasons).toEqual(['unverified_thread']);
    inbound('injection_suspect', 1);
    expect((await naukriSendMessage(deps(), input())).reasons).toEqual(['unverified_thread']);
    inbound('reply', 1);
    expect((await naukriSendMessage(deps(), input())).status).toBe('sent');
  });
  it('verifyThread mismatch blocks before typing; company mismatch too', async () => {
    const bad = { ...driver, verifyThread: async () => ({ recipient: 'Someone Else' }) };
    expect((await naukriSendMessage(deps({ driver: bad }), input())).reasons).toEqual(['recipient_mismatch']);
    const badCo = { ...driver, verifyThread: async () => ({ recipient: 'Pat Recruiter', company: 'Other Corp' }) };
    expect((await naukriSendMessage(deps({ driver: badCo }), input())).reasons).toEqual(['recipient_mismatch']);
    const good = { ...driver, verifyThread: async () => ({ recipient: 'Pat Recruiter', company: 'Acme Pvt Ltd' }) };
    expect((await naukriSendMessage(deps({ driver: good }), input())).status).toBe('sent');
    expect(calls).toBe(1);
  });
  it('bookkeeping failure still returns sent', async () => {
    db.exec("CREATE TRIGGER nobook BEFORE UPDATE ON contact_state BEGIN SELECT RAISE(ABORT, 'x'); END");
    const r = await naukriSendMessage(deps(), input());
    expect(r.status).toBe('sent');
    expect(touches()[0].status).toBe('sent');
  });
  it('paused contact blocks', async () => {
    db.prepare('UPDATE contact_state SET paused_reason = ? WHERE person_id = ?').run('manual', pid);
    expect((await naukriSendMessage(deps(), input())).reasons).toEqual(['contact_paused']);
  });
  it('style block', async () => {
    styleOk = false;
    const r = await naukriSendMessage(deps(), input());
    expect(r.status).toBe('blocked');
    expect(r.reasons[0]).toBe('style_gate');
  });
  it('style gate also runs on normalized text', async () => {
    const r = await naukriSendMessage(deps({
      style: (t) => ({ ok: !t.includes('NORM'), hits: ['x'] }),
      checkText: async (t) => ({ ok: true, normalized: t + ' NORM', verdict: 'pass' }),
    }), input());
    expect(r.status).toBe('blocked');
    expect(r.reasons[0]).toBe('style_gate');
  });
  it('fact block', async () => {
    checkVerdict = 'block';
    expect((await naukriSendMessage(deps(), input())).reasons).toEqual(['fact_gate_block']);
  });
  it('output gate blocks a url', async () => {
    const r = await naukriSendMessage(deps(), input('See https://example.org/x for details'));
    expect(r.status).toBe('blocked');
    expect(r.reasons).toContain('url_not_allowed');
  });
  it('ceiling exhausted leaves no touch', async () => {
    const cfg = { ...loadOutreachConfig({}), quietStartHour: 0, quietEndHour: 0, naukriMaxMessagesPerDay: 0 };
    const r = await naukriSendMessage(deps({ cfg }), input());
    expect(r.status).toBe('rate_limited');
    expect(touches()).toHaveLength(1);
    expect(touches()[0].status).toBe('refused');
    expect(calls).toBe(0);
    const ok = await naukriSendMessage(deps(), input());
    expect(ok.status).toBe('sent');
    expect(touches()).toHaveLength(1);
  });
  it('duplicate (in-flight same key) is blocked without consuming a ceiling unit', async () => {
    const text = 'Hi Pat, happy to share more about my React work.';
    const key = naukriIdempotencyKey(pid, 'role_ask', text);
    db.prepare(
      "INSERT INTO touches (person_id, kind, body, idempotency_key, status, created_at) VALUES (?, 'role_ask', ?, ?, 'unconfirmed', ?)",
    ).run(pid, text, key, now.toISOString());
    const before = countSince(db, 'naukri_message', new Date(0));
    const second = await naukriSendMessage(deps(), input(text));
    expect(countSince(db, 'naukri_message', new Date(0))).toBe(before);
    expect(second.status).toBe('blocked');
    expect(second.reasons).toContain('duplicate');
    expect(calls).toBe(0);
  });
  it('success records touch and contact_state', async () => {
    const r = await naukriSendMessage(deps(), input());
    expect(r.status).toBe('sent');
    expect(touches()[0]).toMatchObject({ status: 'sent', kind: 'role_ask' });
    expect(touches()[0].idempotency_key).toMatch(/^naukri:\d+:role_ask:[0-9a-f]{16}$/);
    const cs = db.prepare('SELECT * FROM contact_state WHERE person_id = ?').get(pid) as any;
    expect(cs.stage).toBe('active');
    expect(cs.last_touch_at).toBe(now.toISOString());
    expect(cs.next_due_at).toBeTruthy();
    expect(new Date(cs.next_due_at).getTime()).toBeGreaterThan(now.getTime());
  });
  it('recipient mismatch marks touch failed', async () => {
    driverRes = { confirmed: true, observedRecipient: 'Someone Else' };
    const r = await naukriSendMessage(deps(), input());
    expect(r.status).toBe('failed');
    expect(touches()[0].status).toBe('failed');
  });
  it('unconfirmed is recorded unconfirmed and result failed', async () => {
    driverRes = { confirmed: false, observedRecipient: 'Pat Recruiter' };
    const r = await naukriSendMessage(deps(), input());
    expect(r).toMatchObject({ status: 'failed', reasons: ['unconfirmed'] });
    expect(touches()[0].status).toBe('unconfirmed');
  });
  it('three consecutive failures halt naukri; success resets the counter', async () => {
    driverRes = { confirmed: true, observedRecipient: 'Nobody' };
    for (let n = 0; n < 2; n++) {
      await naukriSendMessage(deps(), input(`attempt ${n}`));
    }
    expect(haltReason(db, 'naukri')).toBeNull();
    driverRes = { confirmed: true, observedRecipient: 'Pat Recruiter' };
    expect((await naukriSendMessage(deps(), input('good one'))).status).toBe('sent');
    expect(getState(db, 'naukri_send_failures_run1')).toBe('0');
    driverRes = { confirmed: true, observedRecipient: 'Nobody' };
    const later = new Date(now.getTime() + 4 * 24 * 3600 * 1000);
    for (let n = 0; n < 3; n++) {
      await naukriSendMessage(deps({ now: later }), input(`bad ${n}`, { kind: 'followup' }));
    }
    expect(haltReason(db, 'naukri')).not.toBeNull();
    expect((await naukriSendMessage(deps({ now: later }), input('after', { kind: 'followup' }))).status).toBe('halted');
  });
  it('driver throw is failed and unconfirmed', async () => {
    driverThrows = true;
    const r = await naukriSendMessage(deps(), input());
    expect(r.status).toBe('failed');
    expect(touches()[0].status).toBe('unconfirmed');
  });
  it('unreadable db fails closed', async () => {
    const broken = { prepare() { throw new Error('db gone'); }, transaction() { throw new Error('db gone'); } } as unknown as Db;
    const r = await naukriSendMessage(deps({ db: broken }), input());
    expect(r.status).toBe('failed');
    expect(calls).toBe(0);
  });
});
