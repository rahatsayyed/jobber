// tests/dash-run-window.test.ts
// The Run panel query (matched by time), the queue duplicate marking, the cold-mail dedupe and the plain-language helpers.
import { beforeEach, describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { migrateOutreachTables } from '../src/outreach/schema.js';
import { migrateSchedulerTables } from '../src/scheduler/runLog.js';
import { runWindow, runWindowBounds, RUN_PANEL_CAP, RUN_PANEL_JOBS } from '../src/dash/queries/runs.js';
import { jobDetail, markEmailRepeats } from '../src/dash/queries/jobs.js';
import { dedupeColdMails, jobLinks, type MailLink } from '../src/dash/queries/links.js';
import { applyState, applyVia, atsMeaning, connectState, emailState, queueCards, type QueueInfo } from '../apps/dashboard/src/lib/outreach-view.js';
import { parsePanelParams, statusLabel, titleWord, triggerName, crumbLabel, panelHref } from '../apps/dashboard/src/lib/view-models.js';

let db: BetterSqlite3.Database;
beforeEach(() => { db = openDb(':memory:'); migrateOutreachTables(db); migrateSchedulerTables(db); });

function run(id: string, o: Record<string, unknown> = {}) {
  const r = { planned_at: '2026-11-01T04:00:00.000Z', started_at: '2026-11-01T04:00:00.000Z', ended_at: '2026-11-01T04:10:00.000Z', trigger: 'scheduled', status: 'ok', ...o };
  db.prepare('INSERT INTO scheduler_runs (id, planned_at, started_at, ended_at, trigger, status, tasks, wall_sec, tool_calls, dry_run) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, r.planned_at, r.started_at, r.ended_at, r.trigger, r.status, JSON.stringify([{ operator: 'linkedin-operator', platform: 'linkedin', tasks: [{ kind: 'inbox' }] }]), 600, 12, 0);
}
const job = (id: string, source: string, created: string) => db.prepare('INSERT INTO jobs (id, source, title, company, score, created_at) VALUES (?,?,?,?,?,?)').run(id, source, `T ${id}`, `Co ${id}`, 70, created);

describe('runWindow', () => {
  it('returns null for an unknown id or a bad id', () => {
    expect(runWindow(db, 'nope')).toBeNull();
    expect(runWindow(db, 'bad id with spaces')).toBeNull();
  });

  it('counts only rows created inside the window, reading both ISO and SQLite time text', () => {
    run('r1');
    job('in1', 'remotive', '2026-11-01 04:02:00');   // SQLite UTC text, inside
    job('in2', 'naukri', '2026-11-01T04:09:59.000Z'); // ISO, inside
    job('in3', 'naukri', '2026-11-01 04:05:00');
    job('before', 'remotive', '2026-11-01 03:59:59');
    job('after', 'remotive', '2026-11-01 04:10:01');
    const w = runWindow(db, 'r1')!;
    expect(w.jobs.total).toBe(3);
    expect(w.jobs.by_source).toEqual([{ source: 'naukri', count: 2 }, { source: 'remotive', count: 1 }]);
    expect(w.jobs.items.map((j) => j.id).sort()).toEqual(['in1', 'in2', 'in3']);
    expect(w.run.operators).toEqual(['linkedin: inbox']);
    expect(w.window).toEqual({ from: '2026-11-01T04:00:00.000Z', to: '2026-11-01T04:10:00.000Z', open: false });
  });

  it('caps the job list at 20 and keeps the real total', () => {
    run('r1');
    for (let i = 0; i < RUN_PANEL_JOBS + 5; i++) job(`j${i}`, 'remotive', '2026-11-01 04:03:00');
    const w = runWindow(db, 'r1')!;
    expect(w.jobs.items).toHaveLength(RUN_PANEL_JOBS);
    expect(w.jobs.total).toBe(RUN_PANEL_JOBS + 5);
  });

  it('finds sent touches and emails in the window, and escalations by exact run id', () => {
    run('r1');
    db.prepare("INSERT INTO jobs (id, source, title, company) VALUES ('jx','remotive','Dev','Acme')").run();
    db.prepare("INSERT INTO people (id, platform, profile_key, name, company, company_key, category) VALUES (1,'linkedin','linkedin.com/in/a','Ann','Acme','acme','peer')").run();
    db.prepare("INSERT INTO touches (person_id, job_id, kind, idempotency_key, status, sent_at) VALUES (1,'jx','connect','k1','sent','2026-11-01T04:05:00.000Z')").run();
    db.prepare("INSERT INTO touches (person_id, job_id, kind, idempotency_key, status, sent_at) VALUES (1,'jx','message','k2','sent','2026-11-01T05:05:00.000Z')").run();
    db.prepare("INSERT INTO outreach_queue (job_id, email_to, email_status, email_sent_at) VALUES ('jx','a@b.io','sent','2026-11-01 04:06:00')").run();
    db.prepare("INSERT INTO outreach_queue (job_id, connect_profile_url, email_to, email_status, email_sent_at) VALUES ('jx','p2','a@b.io','sent','2026-11-01 07:00:00')").run();
    db.prepare("INSERT INTO escalations (run_id, platform, reason, created_at) VALUES ('r1','linkedin','needs_login','2026-11-01T06:00:00.000Z')").run();
    db.prepare("INSERT INTO escalations (run_id, platform, reason, created_at) VALUES ('other','linkedin','x','2026-11-01T04:01:00.000Z')").run();
    const w = runWindow(db, 'r1')!;
    expect(w.touches.total).toBe(1);
    expect(w.touches.items[0]).toMatchObject({ kind: 'connect', person_name: 'Ann', person_ref: '1', job_id: 'jx' });
    expect(w.emails.total).toBe(1);
    expect(w.emails.items[0]).toMatchObject({ job_id: 'jx', title: 'Dev', company: 'Acme' });
    expect(w.escalations.total).toBe(1); // exact match, even though it was created after the run ended
    expect(w.escalations.items[0].reason).toBe('needs_login');
    expect(JSON.stringify(w)).not.toContain('a@b.io'); // no recipient address leaves this query
  });

  it('uses now as the end of a run that is still going and counts overlapping runs', () => {
    run('r1', { ended_at: null, status: 'running' });
    run('r2', { started_at: '2026-11-01T04:05:00.000Z', planned_at: '2026-11-01T04:05:00.000Z', ended_at: '2026-11-01T04:06:00.000Z' });
    run('r3', { started_at: '2026-11-01T09:00:00.000Z', planned_at: '2026-11-01T09:00:00.000Z', ended_at: '2026-11-01T09:01:00.000Z' });
    job('now1', 'remotive', '2026-11-01 04:30:00');
    const w = runWindow(db, 'r1', new Date('2026-11-01T05:00:00.000Z'))!;
    expect(w.window.open).toBe(true);
    expect(w.window.to).toBe('2026-11-01T05:00:00.000Z');
    expect(w.jobs.total).toBe(1);
    expect(w.overlapping_runs).toBe(1);
  });

  it('keeps every list within the cap and strips control characters from third-party text', () => {
    run('r1');
    db.prepare("INSERT INTO jobs (id, source, title, company, created_at) VALUES ('t1','remotive',?, 'Co','2026-11-01 04:01:00')").run('Dev\u0007\u001b[31m red');
    const w = runWindow(db, 'r1')!;
    expect(w.jobs.items[0].title).not.toMatch(/[\u0000-\u0008\u001b]/);
    expect(RUN_PANEL_CAP).toBe(50);
  });

  it('runWindowBounds rejects a run with no usable start', () => {
    expect(runWindowBounds({ planned_at: null, started_at: null, ended_at: null }, new Date())).toBeNull();
    expect(runWindowBounds({ planned_at: 'garbage', started_at: null, ended_at: null }, new Date())).toBeNull();
  });
});

describe('queue rows with the same email', () => {
  it('markEmailRepeats points an older row at the newest row with the same recipient', () => {
    const rows = [{ id: 179, email_key: 'a@b.io' }, { id: 178, email_key: 'a@b.io' }, { id: 150, email_key: null }, { id: 140, email_key: 'c@d.io' }];
    expect(markEmailRepeats(rows).map((r) => [r.id, r.email_same_as])).toEqual([[179, null], [178, 179], [150, null], [140, null]]);
  });

  function twin() {
    db.prepare("INSERT INTO jobs (id, source, title, company, score) VALUES ('jn','naukri','MERN','Appiness',80)").run();
    const add = (profile: string, status: string | null, sentAt: string | null) => db.prepare(
      "INSERT INTO outreach_queue (job_id, connect_profile_url, connect_note, email_to, email_subject, email_body, email_status, email_sent_at, apply_platform, apply_tier, ats_coverage, created_at) VALUES ('jn',?,?,?,?,?,?,?,?,?,?,'2026-11-01 01:00:00')")
      .run(profile, 'note', 'Hr@Appiness.io', 'Hello', 'Body', status, sentAt, 'naukri', 'agent', 13);
    add('https://www.linkedin.com/in/a', null, null);
    add('https://www.linkedin.com/in/b', null, null);
  }

  it('two rows for one job and different LinkedIn contacts are both legal; the detail marks the older email as a repeat', () => {
    twin();
    expect(db.prepare("SELECT COUNT(*) AS n FROM outreach_queue WHERE job_id='jn'").get()).toEqual({ n: 2 });
    const d = jobDetail(db, 'jn')!;
    expect(d.queue.map((q) => q.email_same_as)).toEqual([null, 2]); // newest (id 2) first, the older row points at it
    expect(d.queue[0]).toMatchObject({ has_email: true, has_connect: true, apply_platform: 'naukri', ats_coverage: 13 });
    expect(JSON.stringify(d.queue)).not.toContain('Appiness.io'); // the address is only a hidden dedupe key
  });

  it('the Email thread lists the message once, newest row wins, with a duplicate count', () => {
    twin();
    const mails = jobLinks(db, 'jn').mails;
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ kind: 'cold', duplicates: 1 });
  });

  it('dedupeColdMails takes the sent time and panel link from an older twin when the newest was not marked sent', () => {
    const m = (ref: string | null, sent: string | null, to = 'a@b.io', kind: MailLink['kind'] = 'cold'): MailLink =>
      ({ ref, kind, n: null, job_id: 'j', label: 'Cold email', status: sent ? 'sent' : null, to, from: null, subject: 'S', sent_at: sent, created_at: null });
    const out = dedupeColdMails([m(null, null), m('7', '2026-11-01 04:00:00'), m(null, null, 'other@b.io'), m('f1', null, 'a@b.io', 'followup')]);
    expect(out.map((x) => [x.ref, x.to, x.duplicates ?? 0])).toEqual([['7', 'a@b.io', 1], [null, 'other@b.io', 0], ['f1', 'a@b.io', 0]]);
    expect(out[0].sent_at).toBe('2026-11-01 04:00:00');
  });
});

describe('plain-language states', () => {
  const base: QueueInfo = { id: 179, status: 'queued', email_status: null, connect_status: 'sent', apply_status: null, ats_coverage: 13, apply_platform: 'naukri', apply_tier: 'agent', has_email: true, has_connect: true, updated_at: '2026-11-01 02:00:00' };

  it('describes the example row without ever printing "Not recorded"', () => {
    const [card] = queueCards([{ ...base, email_same_as: 180 }]);
    expect(card.email).toMatchObject({ text: 'Queued, waiting for the send window', tone: 'warn' });
    expect(card.emailNote).toContain('#180');
    expect(card.connect).toMatchObject({ text: 'Sent', at: '2026-11-01 02:00:00', tone: 'good' });
    expect(card.apply.text).toBe('Waiting for the apply step of a wake');
    expect(card.via).toBe('Naukri, agent-driven');
    expect(card.fit.value).toBe('13%');
    expect(card.fit.meaning).toMatch(/^Low/);
    expect(JSON.stringify(card)).not.toMatch(/not recorded/i);
  });

  it('says what is true when a channel is not planned', () => {
    expect(emailState({ ...base, has_email: false }).text).toBe('No email planned for this job');
    expect(connectState({ ...base, has_connect: false }).text).toBe('No LinkedIn request planned for this job');
    expect(applyState({ ...base, apply_platform: null }).text).toMatch(/^Not applicable/);
    expect(applyState({ ...base, apply_platform: 'none' }).text).toMatch(/^Not applicable/);
    expect(applyVia('none', 'never')).toBeNull();
  });

  it('covers sent, failed, blocked and applied', () => {
    expect(emailState({ ...base, email_status: 'sent', email_sent_at: '2026-11-01 03:00:00' })).toMatchObject({ text: 'Sent', at: '2026-11-01 03:00:00', tone: 'good' });
    expect(emailState({ ...base, email_status: 'failed' }).tone).toBe('bad');
    expect(connectState({ ...base, connect_status: 'failed' }).text).toBe('Failed to send');
    expect(applyState({ ...base, apply_status: 'manual_review', apply_note: 'external:host_unknown' }).text).toContain('not a supported application site');
    expect(applyState({ ...base, apply_status: 'needs_answer' }).text).toMatch(/^Blocked/);
    expect(applyState({ ...base, apply_status: 'failed' }).tone).toBe('bad');
    const applied = applyState({ ...base, apply_status: 'submitted' }, [{ platform: 'naukri', method: 'agent', status: 'submitted', reason: null, applied_at: '2026-11-01 05:00:00' }]);
    expect(applied).toMatchObject({ text: 'Applied', at: '2026-11-01 05:00:00', tone: 'good' });
  });

  it('reads the ATS percentage with one line of meaning', () => {
    expect(atsMeaning(null).value).toBe('Not measured');
    expect(atsMeaning(85).meaning).toMatch(/^Strong/);
    expect(atsMeaning(60).meaning).toMatch(/^Fair/);
  });

  it('statusLabel and titleWord remove snake_case and raw codes', () => {
    expect(statusLabel('manual_review')).toBe('Needs your review');
    expect(statusLabel('submitted')).toBe('Applied');
    expect(statusLabel('some_new_code')).toBe('Some new code');
    expect(statusLabel(null)).toBe('');
    expect(titleWord('linkedin_easy')).toBe('LinkedIn Easy Apply');
    expect(titleWord('linkedin')).toBe('LinkedIn');
    expect(titleWord('some_platform')).toBe('Some platform');
    expect(triggerName('mail_drip')).toBe('Mail drip send');
    expect(triggerName('weird_one')).toBe('Weird one run');
  });
});

describe('run panel references', () => {
  it('?run=<id> opens the run panel and links to the Runs page', () => {
    expect(parsePanelParams(new URLSearchParams('run=fe7f018dc519b9d9'))).toEqual({ kind: 'run', id: 'fe7f018dc519b9d9' });
    expect(parsePanelParams(new URLSearchParams('run=bad%20id'))).toBeNull();
    expect(panelHref({ kind: 'run', id: 'abc' })).toBe('/runs?run=abc');
    expect(crumbLabel({ kind: 'run', id: 'abc' })).toBe('Run');
  });
});
