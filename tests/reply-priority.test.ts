// Reply priority (owner decision 2026-11-06): mail reply_check item, thread check before follow-ups, owner notices, LinkedIn inbox bypass.
// Fakes only: fake clock, fake launcher, in-memory db, fake Telegram. Nothing is sent, no tmux, no claude.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { loadTuning } from '../src/outreach/tuning.js';
import { acquireLock } from '../src/platform/lock.js';
import type { DriverDeps } from '../src/scheduler/driver.js';
import type { LaunchHandle, LaunchPlan, Launcher, PollResult } from '../src/scheduler/launch.js';
import { dripTick } from '../src/scheduler/mailDrip.js';
import {
  formatReplyNotice, markReplyCheckDueAtStart, notifyNewReplies, pickReplyCheck, replyCheckEveryMin, STATE_RC_AT, STATE_RC_NOTICE_AT,
} from '../src/scheduler/replyCheck.js';
import { claimFollowupForSend, claimFollowupGuarded, hasFreshCleanReplyCheck, recordReplyCheck, recordThreadCheck } from '../src/followups.js';
import { ownerOnlyCodes, unquotedText } from '../src/outreach/ownerOnly.js';
import { getState, setState } from '../src/scheduler/runLog.js';
import { linkedinDripTick, LI_STATE_INBOX_AT, LI_STATE_LAST_AT, LI_STATE_NEXT_AT, loadLinkedinDripConfig, markInboxDueAtStart } from '../src/scheduler/linkedinDrip.js';
import { notifyLinkedinInbox, announcedEscalations } from '../src/scheduler/linkedinNotice.js';
import { runEscalationDigest } from '../src/scheduler/escalationDigest.js';
import { upsertPerson } from '../src/outreach/people.js';
import { addEscalation, hashInboundText, recordInbound } from '../src/outreach/service.js';

const NOON_IST = new Date('2026-10-15T08:00:00.000Z'); // 13:30 IST
const BEFORE_WINDOW = new Date('2026-10-15T03:00:00.000Z'); // 08:30 IST: outside the send window, not quiet
const QUIET = new Date('2026-10-14T21:00:00.000Z'); // 02:30 IST
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }); });
const sqlTime = (d: Date): string => d.toISOString().slice(0, 19).replace('T', ' ');

class FakeLauncher implements Launcher {
  starts: LaunchPlan[] = [];
  constructor(private onStart: (p: LaunchPlan) => void) {}
  async start(plan: LaunchPlan): Promise<LaunchHandle> {
    this.starts.push(plan);
    this.onStart(plan);
    return { runId: plan.runId, session: plan.session, window: `w-${plan.runId}`, logPath: 'l', exitPath: 'e', promptPath: 'p' };
  }
  async poll(): Promise<PollResult> { return { exited: true, exitCode: 0, newOutput: '' }; }
  async kill(): Promise<void> {}
}

interface Opts { start?: Date; env?: NodeJS.ProcessEnv; stopExists?: () => boolean; recordClean?: boolean }
function setup(opts: Opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reply-prio-'));
  dirs.push(dir);
  let t = (opts.start ?? NOON_IST).getTime();
  const env = opts.env ?? {};
  const db = openDb(':memory:');
  const posts: Array<{ topic: string; text: string }> = [];
  const clock = (): Date => new Date(t);
  const launcher = new FakeLauncher((plan) => {
    if (plan.profile === 'mail_reply_check' && opts.recordClean !== false) {
      const m = /thread_id: (\S+)\./.exec(plan.prompt);
      if (m) recordThreadCheck(db, { thread_id: m[1], messages: 0, errors: 0 }, clock());
      else recordReplyCheck(db, { messages: 0, errors: 0 }, clock());
    }
    const m = /outreach_queue row id (\d+)/.exec(plan.prompt);
    if (m) db.prepare("UPDATE outreach_queue SET email_status = 'sent', email_sent_at = ? WHERE id = ?").run(sqlTime(clock()), Number(m[1]));
  });
  const d: DriverDeps = {
    db, now: clock, rng: () => 0, sleep: async (ms) => { t += ms; },
    cfg: loadOutreachConfig(env), tuning: loadTuning(env), env,
    lockRoot: join(dir, 'locks'), stopFile: join(dir, 'STOP'), runDir: join(dir, 'runs'), projectRoot: dir,
    launcher, notifier: { notify: async () => undefined },
    tg: async (topic, text) => void posts.push({ topic, text }),
    newRunId: (() => { let i = 0; return () => `rp${String(++i).padStart(8, '0')}`; })(),
    control: opts.stopExists ? { exists: opts.stopExists, read: () => 'stop' } : undefined,
    pollMs: 5000,
  };
  const queueCold = (n: number): void => {
    for (let i = 1; i <= n; i++) {
      db.prepare("INSERT INTO contacts (company, email, type, verified, source, confidence) VALUES ('C', ?, 'hr', 1, 't', 0.9)").run(`p${i}@co${i}.example`);
      db.prepare("INSERT INTO jobs (id, source, title, company, url) VALUES (?, 't', 'T', 'C', 'u')").run(`job${i}`);
      db.prepare("INSERT INTO outreach_queue (job_id, email_subject, email_body, email_to) VALUES (?, 's', 'b', ?)").run(`job${i}`, `p${i}@co${i}.example`);
    }
  };
  /** A sent cold email 5 days ago plus an approved follow-up on Gmail thread `thr`. Returns the follow-up id. */
  const approvedFollowup = (thr: string | null = 'thr1'): number => {
    db.prepare("INSERT INTO contacts (company, email, type, verified, source, confidence) VALUES ('F', 'hr@fu.example', 'hr', 1, 't', 0.9)").run();
    db.prepare("INSERT INTO jobs (id, source, title, company, url) VALUES ('jf', 't', 'T', 'F', 'u')").run();
    db.prepare("INSERT INTO outreach_queue (job_id, email_subject, email_body, email_to, email_status, email_sent_at, email_thread_id) VALUES ('jf', 's', 'b', 'hr@fu.example', 'sent', ?, ?)")
      .run(sqlTime(new Date(t - 5 * 86400_000)), thr);
    return Number(db.prepare("INSERT INTO followups (job_id, n, subject, body, status) VALUES ('jf', 1, 'Re: s', 'body', 'approved')").run().lastInsertRowid);
  };
  return { d, db, launcher, posts, queueCold, approvedFollowup, advance: (ms: number) => void (t += ms), now: clock };
}
type S = ReturnType<typeof setup>;
const profiles = (s: S): string[] => s.launcher.starts.map((p) => p.profile ?? '');

describe('REPLY_CHECK_EVERY_MIN', () => {
  it('defaults to 60 and clamps to 10..1440', () => {
    expect(replyCheckEveryMin({})).toBe(60);
    expect(replyCheckEveryMin({ REPLY_CHECK_EVERY_MIN: '' })).toBe(60);
    expect(replyCheckEveryMin({ REPLY_CHECK_EVERY_MIN: 'x' })).toBe(60);
    expect(replyCheckEveryMin({ REPLY_CHECK_EVERY_MIN: '1' })).toBe(10);
    expect(replyCheckEveryMin({ REPLY_CHECK_EVERY_MIN: '99999' })).toBe(1440);
    expect(replyCheckEveryMin({ REPLY_CHECK_EVERY_MIN: '30' })).toBe(30);
  });
  it('the LinkedIn inbox gap follows it only while LINKEDIN_INBOX_MIN_GAP_MIN is unset', () => {
    expect(loadLinkedinDripConfig({ REPLY_CHECK_EVERY_MIN: '30' }).inboxGapMin).toBe(30);
    expect(loadLinkedinDripConfig({ REPLY_CHECK_EVERY_MIN: '30', LINKEDIN_INBOX_MIN_GAP_MIN: '90' }).inboxGapMin).toBe(90);
    expect(loadLinkedinDripConfig({}).inboxGapMin).toBe(60);
  });
});

describe('mail reply_check: due logic and pick order', () => {
  it('not due without a daemon-start stamp, due at start, then only after the interval', () => {
    const s = setup();
    expect(pickReplyCheck(s.db, s.now(), {})).toBeNull();
    markReplyCheckDueAtStart(s.db, s.now());
    expect(pickReplyCheck(s.db, s.now(), {})).toMatchObject({ scope: 'mailbox', reason: 'start' });
    setState(s.db, STATE_RC_AT, s.now().toISOString(), s.now());
    expect(pickReplyCheck(s.db, s.now(), {})).toBeNull();
    s.advance(59 * 60_000);
    expect(pickReplyCheck(s.db, s.now(), {})).toBeNull();
    s.advance(2 * 60_000);
    expect(pickReplyCheck(s.db, s.now(), {})).toMatchObject({ reason: 'interval' });
    expect(pickReplyCheck(s.db, s.now(), { REPLY_CHECK_EVERY_MIN: '120' })).toBeNull();
  });
  it('runs FIRST (before queued cold email) under the read-only profile, then the next tick sends', async () => {
    const s = setup();
    s.queueCold(2);
    markReplyCheckDueAtStart(s.db, s.now());
    const r1 = await dripTick(s.d);
    expect(r1).toMatchObject({ status: 'ran', reason: 'reply_check' });
    expect(profiles(s)).toEqual(['mail_reply_check']);
    expect((s.db.prepare("SELECT COUNT(*) AS n FROM outreach_queue WHERE email_status = 'sent'").get() as { n: number }).n).toBe(0);
    expect(s.launcher.starts[0].prompt).toMatch(/reply-watcher/);
    expect(s.launcher.starts[0].prompt).not.toMatch(/mail-operator/);
    const r2 = await dripTick(s.d);
    expect(r2.status).toBe('ran');
    expect(profiles(s).slice(1)).toContain('mail_drip');
  });
  it('is not subject to the send window or the send brake (EMAIL_MAX_PER_DAY, SEND_LIMIT_PER_RUN=0), but quiet hours stop it', async () => {
    const s = setup({ start: BEFORE_WINDOW, env: { SEND_LIMIT_PER_RUN: '0', EMAIL_MAX_PER_DAY: '1' } });
    markReplyCheckDueAtStart(s.db, s.now());
    expect((await dripTick(s.d)).reason).toBe('reply_check');
    const q = setup({ start: QUIET });
    markReplyCheckDueAtStart(q.db, q.now());
    expect(await dripTick(q.d)).toMatchObject({ status: 'skipped', reason: 'quiet_hours' });
    expect(q.launcher.starts).toHaveLength(0);
  });
});

describe('mail reply_check: gates', () => {
  it('kill switch, usage backoff, unkilled window, lock and dry run all stop it', async () => {
    const k = setup({ stopExists: () => true });
    markReplyCheckDueAtStart(k.db, k.now());
    expect((await dripTick(k.d)).status).toBe('skipped');
    expect(k.launcher.starts).toHaveLength(0);

    const b = setup();
    markReplyCheckDueAtStart(b.db, b.now());
    setState(b.db, 'usage_backoff_until', new Date(b.now().getTime() + 3600_000).toISOString(), b.now());
    await dripTick(b.d);
    expect(b.launcher.starts).toHaveLength(0);

    const w = setup();
    markReplyCheckDueAtStart(w.db, w.now());
    setState(w.db, 'unkilled_window', '{}', w.now());
    await dripTick(w.d);
    expect(w.launcher.starts).toHaveLength(0);

    const l = setup();
    markReplyCheckDueAtStart(l.db, l.now());
    const held = acquireLock(l.d.lockRoot, 'mail', 'other', l.d.lockDeps);
    expect(held).toBeTruthy();
    expect(await dripTick(l.d)).toMatchObject({ status: 'skipped', reason: 'locked' });
    held?.release();
    expect(l.launcher.starts).toHaveLength(0);

    const dry = setup({ env: { JOBBER_DRY_RUN: '1' } });
    markReplyCheckDueAtStart(dry.db, dry.now());
    await dripTick(dry.d);
    expect(dry.launcher.starts.filter((p) => p.profile === 'mail_reply_check')).toHaveLength(0);
    expect(dry.posts).toHaveLength(0);
  });
  it('the profile has the reply-watcher tools and NO gmail.send_email, no Bash', () => {
    const p = JSON.parse(readFileSync('config/run-profiles.json', 'utf8')).profiles.mail_reply_check;
    expect(p.allow).not.toContain('mcp__gmail__send_email');
    expect(p.allow.some((e: string) => /send|draft|delete|modify|label/.test(e))).toBe(false);
    expect(p.builtin_tools).not.toContain('Bash');
    const agent = readFileSync('.claude/agents/reply-watcher.md', 'utf8');
    const tools = /^tools: (.*)$/m.exec(agent)![1].split(',').map((x) => x.trim());
    for (const t of tools) expect(p.allow, t).toContain(t);
    expect(tools).not.toContain('mcp__gmail__send_email');
  });
});

describe('thread check before a follow-up (rule 10 stays, one more precondition)', () => {
  it('the library claim is unchanged without the flag; with it a mailbox check alone is not enough', () => {
    const s = setup();
    const id = s.approvedFollowup('thr1');
    recordReplyCheck(s.db, { messages: 0, errors: 0 }, s.now());
    expect(claimFollowupGuarded(s.db, id, { now: s.now(), maxAgeMin: 30, sendLimit: 5 })).toEqual({ claimed: true }); // rule 10 test shape, unchanged
    s.db.prepare("UPDATE followups SET status = 'approved'").run();
    expect(claimFollowupGuarded(s.db, id, { now: s.now(), maxAgeMin: 30, sendLimit: 5, requireThreadCheck: true })).toEqual({ claimed: false, reason: 'no_thread_check' });
    expect(claimFollowupForSend(s.db, id, { now: s.now(), maxAgeMin: 30, requireThreadCheck: true })).toBe(false);
    recordThreadCheck(s.db, { thread_id: 'thr1', messages: 0, errors: 0 }, s.now());
    expect(claimFollowupGuarded(s.db, id, { now: s.now(), maxAgeMin: 30, sendLimit: 5, requireThreadCheck: true })).toEqual({ claimed: true });
  });
  it('a thread check never counts as the mailbox check, and an erroring or stale or other-thread check does not unlock', () => {
    const s = setup();
    const id = s.approvedFollowup('thr1');
    recordThreadCheck(s.db, { thread_id: 'thr1', messages: 0, errors: 0 }, s.now());
    expect(hasFreshCleanReplyCheck(s.db, s.now(), 30)).toBe(false);
    expect(claimFollowupGuarded(s.db, id, { now: s.now(), maxAgeMin: 30, sendLimit: 5, requireThreadCheck: true })).toMatchObject({ reason: 'no_clean_reply_check' });
    recordReplyCheck(s.db, { messages: 0, errors: 0 }, s.now());
    s.db.prepare('DELETE FROM followup_thread_checks').run();
    recordThreadCheck(s.db, { thread_id: 'thr1', messages: 3, errors: 1 }, s.now());
    recordThreadCheck(s.db, { thread_id: 'other', messages: 0, errors: 0 }, s.now());
    expect(claimFollowupGuarded(s.db, id, { now: s.now(), maxAgeMin: 30, sendLimit: 5, requireThreadCheck: true })).toMatchObject({ reason: 'no_thread_check' });
    s.db.prepare('DELETE FROM followup_thread_checks').run();
    recordThreadCheck(s.db, { thread_id: 'thr1', messages: 0, errors: 0 }, new Date(s.now().getTime() - 31 * 60_000));
    expect(claimFollowupGuarded(s.db, id, { now: s.now(), maxAgeMin: 30, sendLimit: 5, requireThreadCheck: true })).toMatchObject({ reason: 'no_thread_check' });
  });
  it('the tick runs a scoped check first (on demand), then sends the follow-up', async () => {
    const s = setup();
    const id = s.approvedFollowup('thr1');
    recordReplyCheck(s.db, { messages: 0, errors: 0 }, s.now());
    const r1 = await dripTick(s.d);
    expect(r1.reason).toBe('reply_check');
    expect(s.launcher.starts[0].profile).toBe('mail_reply_check');
    expect(s.launcher.starts[0].prompt).toMatch(/thread_id: thr1\./);
    expect(s.db.prepare('SELECT status FROM followups WHERE id = ?').get(id)).toEqual({ status: 'approved' });
    const r2 = await dripTick(s.d);
    expect(r2.status).toBe('ran');
    expect(profiles(s)[1]).toBe('mail_drip');
  });
  it('a stale mailbox check gets a fresh mailbox check before the follow-up', async () => {
    const s = setup();
    s.approvedFollowup('thr1');
    recordReplyCheck(s.db, { messages: 0, errors: 0 }, new Date(s.now().getTime() - 3 * 3600_000));
    const r = await dripTick(s.d);
    expect(r.reason).toBe('reply_check');
    expect(s.launcher.starts[0].prompt).toMatch(/whole mailbox/);
  });
  it('a failed check holds the follow-up, tells the owner at most once an hour, and no follow-up run starts', async () => {
    const s = setup({ recordClean: false });
    s.approvedFollowup('thr1');
    recordReplyCheck(s.db, { messages: 0, errors: 0 }, s.now());
    await dripTick(s.d);
    expect(s.posts.filter((p) => p.topic === 'alerts')).toHaveLength(1);
    expect(s.posts[0].text).toMatch(/follow-up held/);
    // inside the retry hold: nothing new starts, no new notice
    await dripTick(s.d);
    expect(s.launcher.starts).toHaveLength(1);
    // after the 10 minute hold the check is tried again; the failure notice is still throttled to one per hour
    s.advance(11 * 60_000);
    recordReplyCheck(s.db, { messages: 0, errors: 0 }, s.now());
    await dripTick(s.d);
    expect(s.launcher.starts).toHaveLength(2);
    expect(s.posts.filter((p) => p.topic === 'alerts')).toHaveLength(1);
    expect(getState(s.db, STATE_RC_NOTICE_AT)).toBeTruthy();
    expect(profiles(s).every((p) => p === 'mail_reply_check')).toBe(true);
    s.advance(61 * 60_000);
    recordReplyCheck(s.db, { messages: 0, errors: 0 }, s.now());
    await dripTick(s.d);
    expect(s.posts.filter((p) => p.topic === 'alerts')).toHaveLength(2);
  });
});

describe('owner notice for email replies', () => {
  const row = (o: Record<string, unknown> = {}) => ({
    message_id: 'm1', job_id: 'j1', classification: 'replied', action: 'proposed', proposed_outcome: 'replied', from_addr: 'hr@acme.example',
    subject: 'Re: Role', excerpt: 'Thanks, please share your availability', needs_you: 0, company: 'Acme', title: 'React Dev', ...o,
  });
  it('groups replies in one message, flags needs-you with the bell, escapes html and caps the excerpt', () => {
    const text = formatReplyNotice([
      row(),
      row({ message_id: 'm2', needs_you: 1, subject: '<b>Test</b> link', excerpt: `<script>alert(1)</script> ${'x'.repeat(500)}` }),
      row({ message_id: 'm3', job_id: null, classification: 'bounce', action: 'bounced' }),
    ])!;
    expect(text).toContain('🔔');
    expect(text).toContain('needs you');
    expect(text).not.toContain('<script>');
    expect(text).toContain('&lt;script&gt;');
    expect(text).toContain('bounce');
    expect(text).toContain('not matched to a job');
    const quote = /"([^"]*x{20,}[^"]*)"/.exec(text)![1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    expect(quote.length).toBeLessThanOrEqual(201);
    expect(text.match(/new email repl/g)).toHaveLength(1);
  });
  it('redacts secret shapes in the excerpt', () => {
    const text = formatReplyNotice([row({ excerpt: 'my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 ok' })])!;
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });
  it('posts once to the inbox topic, marks rows notified, and old rows never flood', async () => {
    const s = setup();
    s.db.prepare("INSERT INTO processed_messages (message_id, job_id, classification, action, from_addr, subject, excerpt, needs_you, notified_at) VALUES ('old', NULL, 'replied', 'proposed', 'a@b.c', 's', 'e', 0, '2020-01-01')").run();
    s.db.prepare("INSERT INTO processed_messages (message_id, job_id, classification, action, from_addr, subject, excerpt, needs_you) VALUES ('new', NULL, 'interview', 'proposed', 'a@b.c', 'Interview slot', 'pick a time', 1)").run();
    s.db.prepare("INSERT INTO processed_messages (message_id, job_id, classification, action, from_addr, subject, excerpt, needs_you) VALUES ('nl', NULL, 'noise', 'ignored', 'no-reply@x.com', 'News', 'hello', 0)").run();
    expect(await notifyNewReplies(s.d)).toBe(1);
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0].topic).toBe('inbox');
    expect(await notifyNewReplies(s.d)).toBe(0);
    expect(s.posts).toHaveLength(1);
  });
  it('flags owner-only asks and ignores quoted text', () => {
    for (const t of ['please take this test', 'what is your expected CTC', 'share your availability for an interview slot', 'send your references', 'send your aadhaar', 'call me on phone', 'attach your documents']) {
      expect(ownerOnlyCodes('Re: role', t).length, t).toBeGreaterThan(0);
    }
    expect(ownerOnlyCodes('Re: role', 'Thank you!\n\nOn Mon, X wrote:\n> please send salary and a test link')).toEqual([]);
    expect(unquotedText('hi\n> quoted\nbye')).toBe('hi\nbye');
  });
});

describe('LinkedIn: inbox bypasses the spacing only', () => {
  const lisetup = (opts: Opts = {}) => {
    const s = setup(opts);
    return s;
  };
  it('inbox due at daemon start; the spacing and last-action stamps are not moved by the read', async () => {
    const s = lisetup();
    const next = new Date(s.now().getTime() + 15 * 60_000).toISOString();
    const last = new Date(s.now().getTime() - 2 * 60_000).toISOString();
    setState(s.db, LI_STATE_NEXT_AT, next, s.now());
    setState(s.db, LI_STATE_LAST_AT, last, s.now());
    setState(s.db, LI_STATE_INBOX_AT, new Date(s.now().getTime() - 5 * 60_000).toISOString(), s.now());
    // inbox read 5 minutes ago and spacing active: nothing runs
    expect((await linkedinDripTick(s.d)).reason).toBe('spacing');
    markInboxDueAtStart(s.db);
    const r = await linkedinDripTick(s.d);
    expect(r).toMatchObject({ status: 'ran', item: 'inbox' });
    expect(s.launcher.starts[0].profile).toBe('linkedin_drip');
    expect(getState(s.db, LI_STATE_NEXT_AT)).toBe(next);
    expect(getState(s.db, LI_STATE_LAST_AT)).toBe(last);
    // read again straight away: not due, and any other action still waits for its spacing
    expect((await linkedinDripTick(s.d)).reason).toBe('spacing');
  });
  it('the other gates still apply to a due inbox read (quiet hours, kill switch, halt, backoff)', async () => {
    const q = lisetup({ start: QUIET });
    markInboxDueAtStart(q.db);
    setState(q.db, LI_STATE_NEXT_AT, new Date(q.now().getTime() + 3600_000).toISOString(), q.now());
    expect((await linkedinDripTick(q.d)).reason).toBe('quiet_hours');
    const k = lisetup({ stopExists: () => true });
    markInboxDueAtStart(k.db);
    setState(k.db, LI_STATE_NEXT_AT, new Date(k.now().getTime() + 3600_000).toISOString(), k.now());
    expect((await linkedinDripTick(k.d)).reason).toBe('killed');
    const b = lisetup();
    markInboxDueAtStart(b.db);
    setState(b.db, LI_STATE_NEXT_AT, new Date(b.now().getTime() + 3600_000).toISOString(), b.now());
    setState(b.db, 'usage_backoff_until', new Date(b.now().getTime() + 3600_000).toISOString(), b.now());
    expect((await linkedinDripTick(b.d)).reason).toBe('usage_backoff');
    expect(q.launcher.starts.length + k.launcher.starts.length + b.launcher.starts.length).toBe(0);
  });
});

describe('LinkedIn notices and the digest', () => {
  const seed = (s: S) => {
    const pid = upsertPerson(s.db, { platform: 'linkedin', profileKey: 'linkedin.com/in/rec', name: 'Rita Rec', headline: 'Recruiter', company: 'Acme', category: 'recruiter' });
    return pid;
  };
  it('announces new inbound threads (bell for owner-only asks) and approved drafts with the skip hint, once', async () => {
    const s = setup();
    const pid = seed(s);
    await notifyLinkedinInbox(s.d); // first run only sets the baseline
    expect(s.posts).toHaveLength(0);
    recordInbound(s.db, { platform: 'linkedin', threadRef: '2-a', personId: pid, textHash: hashInboundText('x'), klass: 'reply', escalated: true }, s.now());
    const esc = addEscalation(s.db, { runId: null, platform: 'linkedin', personId: pid, threadRef: '2-a', reason: 'linkedin_reply_needed', detail: 'd', excerpt: 'What is your expected salary?' }, s.now());
    s.db.prepare("INSERT INTO reply_drafts (escalation_id, person_id, thread_ref, kind, body, attach_resume, status, created_at, approved_at) VALUES (?, ?, '2-a', 'reply', 'Thanks for reaching out.', 0, 'approved', ?, ?)")
      .run(esc, pid, s.now().toISOString(), s.now().toISOString());
    expect(await notifyLinkedinInbox(s.d)).toBe(2);
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0].topic).toBe('inbox');
    expect(s.posts[0].text).toContain('🔔');
    expect(s.posts[0].text).toContain('npm run replies -- skip 1');
    expect(await notifyLinkedinInbox(s.d)).toBe(0);
    expect(announcedEscalations(s.db).has(esc)).toBe(true);
  });
  it('the digest does not announce an escalation the LinkedIn notice already announced', async () => {
    const s = setup();
    const pid = seed(s);
    await notifyLinkedinInbox(s.d);
    recordInbound(s.db, { platform: 'linkedin', threadRef: '2-b', personId: pid, textHash: hashInboundText('y'), klass: 'reply', escalated: true }, s.now());
    addEscalation(s.db, { runId: null, platform: 'linkedin', personId: pid, threadRef: '2-b', reason: 'linkedin_reply_needed', detail: 'd', excerpt: 'hello there' }, s.now());
    await notifyLinkedinInbox(s.d);
    const sent: string[] = [];
    const r = await runEscalationDigest(s.db, { send: async (t) => { sent.push(t); return { ok: true }; }, now: s.now(), url: null, env: {} });
    expect(r).toEqual({ sent: false, reason: 'nothing_new' });
    expect(sent).toHaveLength(0);
  });
});
