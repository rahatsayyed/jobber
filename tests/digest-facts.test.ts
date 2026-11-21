// The digest reads the span's facts from SQLite (applies, JD reads, hiring posts, real mail) and never counts a fact twice.
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { composeDigest, digestTickOnce, enqueueNotice, renderStatusDigest, unsentRows } from '../src/platform/digest.js';
import { EMPTY_FACTS, readDigestFacts } from '../src/platform/digestFacts.js';
import { KEY_DIGEST_LAST_AT } from '../src/platform/digest.js';
import { getState, setState } from '../src/scheduler/runLog.js';
import type { QuietConfig } from '../src/outreach/quiet.js';

const QUIET: QuietConfig = { quietStartHour: 22, quietEndHour: 7, tzOffsetMinutes: 330 };
const FROM = new Date('2026-11-20T06:00:00.000Z');
const TO = new Date('2026-11-20T07:00:00.000Z');
const IN = '2026-11-20 06:30:00'; // sqlite datetime format
const IN_ISO = '2026-11-20T06:40:00.000Z';
const BEFORE = '2026-11-20 05:59:59';
const AT_END = '2026-11-20 07:00:00'; // end is exclusive

function world() {
  const db = openDb(':memory:');
  const job = (id: string, source: string, o: { created?: string; jd?: string | null } = {}) =>
    db.prepare('INSERT INTO jobs (id, source, title, company, created_at, jd_fetched_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, source, 't', 'c', o.created ?? BEFORE, o.jd ?? null);
  const app = (platform: string, method: string, status: string, at: string) =>
    db.prepare('INSERT INTO applications (job_id, platform, method, status, created_at) VALUES (?, ?, ?, ?, ?)').run('j', platform, method, status, at);
  return { db, job, app };
}

describe('readDigestFacts', () => {
  it('counts only rows inside [from, to) and only submitted applications', () => {
    const { db, job, app } = world();
    app('linkedin', 'easy_apply', 'submitted', IN);
    app('linkedin', 'easy_apply', 'submitted', IN);
    app('naukri', 'native', 'submitted', IN);
    app('naukri', 'native', 'submitted', BEFORE); // before the span
    app('naukri', 'native', 'submitted', AT_END); // end is exclusive
    app('naukri', 'native', 'failed', IN); // not submitted
    app('naukri', 'manual', 'submitted', IN); // owner did it by hand
    job('a', 'naukri', { jd: IN });
    job('b', 'linkedin-jobs', { jd: IN_ISO }); // ISO stamps work too
    job('c', 'naukri', { jd: BEFORE });
    job('p1', 'linkedin-posts', { created: IN });
    job('p2', 'linkedin-posts', { created: IN_ISO });
    job('p3', 'linkedin-posts', { created: BEFORE });
    job('d', 'remotive', { created: IN }); // a new job, not a post
    db.prepare("INSERT INTO outreach_queue (job_id, email_status, email_sent_at) VALUES ('a', 'sent', ?)").run(IN_ISO);
    db.prepare("INSERT INTO outreach_queue (job_id, email_status, email_sent_at) VALUES ('b', 'sent', ?)").run(BEFORE);
    db.prepare("INSERT INTO outreach_queue (job_id, email_status) VALUES ('c', 'queued')").run();
    db.prepare("INSERT INTO followups (job_id, n, status, sent_at) VALUES ('a', 1, 'sent', ?)").run(IN_ISO);
    db.prepare("INSERT INTO followups (job_id, n, status, sent_at) VALUES ('b', 1, 'approved', NULL)").run();
    const f = readDigestFacts(db, FROM, TO);
    expect(f.applies.sort((x, y) => x.platform.localeCompare(y.platform))).toEqual([
      { platform: 'linkedin', method: 'easy_apply', count: 2 }, { platform: 'naukri', method: 'native', count: 1 },
    ]);
    expect(f.jdBySource.sort((x, y) => x.source.localeCompare(y.source))).toEqual([{ source: 'linkedin-jobs', count: 1 }, { source: 'naukri', count: 1 }]);
    expect(f.hiringPosts).toBe(2);
    expect(f.mail).toEqual({ cold: 1, followup: 1, autoReply: 0 });
  });

  it('an empty span gives empty facts and a missing table counts as 0', () => {
    const { db } = world();
    expect(readDigestFacts(db, FROM, TO)).toEqual(EMPTY_FACTS);
    db.exec('DROP TABLE followups');
    expect(readDigestFacts(db, FROM, TO).mail.followup).toBe(0);
  });
});

describe('composeDigest with facts', () => {
  it('shows applies, JD reads and hiring posts from the database', () => {
    const { db, job, app } = world();
    app('linkedin', 'easy_apply', 'submitted', IN);
    app('naukri', 'native', 'submitted', IN);
    job('a', 'naukri', { jd: IN });
    job('b', 'naukri', { jd: IN });
    job('c', 'linkedin-jobs', { jd: IN });
    job('p1', 'linkedin-posts', { created: IN });
    enqueueNotice(db, 'wake_summary', { newJobs: 5, bySource: { remotive: 5 } }, FROM);
    const c = composeDigest(unsentRows(db), { from: FROM, to: TO }, 0, readDigestFacts(db, FROM, TO));
    expect(c.text).toContain('• applies: linkedin easy apply 1, naukri 1');
    expect(c.text).toContain('• 5 new jobs (remotive 5)');
    expect(c.text).toContain('• 1 hiring post');
    expect(c.text).toContain('• 3 job descriptions read (naukri 2, linkedin-jobs 1)');
    process.stdout.write(`\n--- example digest (with database facts) ---\n${c.text.replace(/<\/?[a-z]+>/g, '')}\n---\n`);
  });

  it('does not count a fact twice: queued mail, apply, JD and post rows are ignored when facts are given', () => {
    const { db, app, job } = world();
    // the database says: 1 cold mail, 1 follow-up, 1 Easy Apply, 1 JD, 1 post
    db.prepare("INSERT INTO outreach_queue (job_id, email_status, email_sent_at) VALUES ('a', 'sent', ?)").run(IN_ISO);
    db.prepare("INSERT INTO followups (job_id, n, status, sent_at) VALUES ('a', 1, 'sent', ?)").run(IN_ISO);
    app('linkedin', 'easy_apply', 'submitted', IN);
    job('a', 'naukri', { jd: IN });
    job('p1', 'linkedin-posts', { created: IN });
    // the queue says the same things again (and a dry mail)
    enqueueNotice(db, 'mail_sent', { kind: 'cold', dry: false }, FROM);
    enqueueNotice(db, 'mail_sent', { kind: 'followup', dry: false }, FROM);
    enqueueNotice(db, 'mail_sent', { kind: 'cold', dry: true }, FROM);
    enqueueNotice(db, 'linkedin_action', { action: 'easy_apply', dry: false }, FROM);
    enqueueNotice(db, 'linkedin_action', { action: 'invite', dry: false }, FROM);
    enqueueNotice(db, 'apply_done', { platform: 'linkedin' }, FROM);
    enqueueNotice(db, 'jd_read', { count: 1 }, FROM);
    enqueueNotice(db, 'hiring_posts', { count: 1 }, FROM);
    const c = composeDigest(unsentRows(db), { from: FROM, to: TO }, 0, readDigestFacts(db, FROM, TO));
    expect(c.text).toContain('• 2 emails (1 cold, 1 follow-up)');
    expect(c.text).toContain('• LinkedIn: invite 1'); // the queued Easy Apply is not repeated here
    expect(c.text).toContain('• applies: linkedin easy apply 1');
    expect(c.text).toContain('• 1 job description read');
    expect(c.text).toContain('• 1 hiring post');
    expect(c.text).toContain('dry run, nothing really sent: 1 mail, 0 LinkedIn'); // dry runs write no database rows: the queue supplies them
  });

  it('a hiring post already in the wake summary sources is not listed twice', () => {
    const { db, job } = world();
    job('p1', 'linkedin-posts', { created: IN });
    enqueueNotice(db, 'wake_summary', { newJobs: 3, bySource: { 'linkedin-posts': 1, remotive: 2 } }, FROM);
    const c = composeDigest(unsentRows(db), { from: FROM, to: TO }, 0, readDigestFacts(db, FROM, TO));
    expect(c.text).toContain('3 new jobs (remotive 2, linkedin-posts 1)');
    expect(c.text).not.toContain('hiring post');
  });

  it('without facts the queue alone is used, as before', () => {
    const { db } = world();
    enqueueNotice(db, 'mail_sent', { kind: 'cold', dry: false }, FROM);
    enqueueNotice(db, 'apply_done', { platform: 'naukri' }, FROM);
    const c = composeDigest(unsentRows(db), { from: FROM, to: TO }, 0);
    expect(c.text).toContain('• 1 email (1 cold)');
    expect(c.text).toContain('• applies: naukri 1');
  });

  it('an empty hour sends nothing: no rows and no facts', () => {
    const { db } = world();
    expect(composeDigest([], { from: FROM, to: TO }, 0, readDigestFacts(db, FROM, TO)).empty).toBe(true);
  });
});

describe('digest tick and status command read the same facts', () => {
  const send = () => { const sent: string[] = []; return { sent, fn: async (t: string) => { sent.push(t); return { ok: true }; } }; };

  it('a tick with database facts but no queued rows sends one digest; a quiet hour sends nothing', async () => {
    const { db, app } = world();
    setState(db, KEY_DIGEST_LAST_AT, FROM.toISOString(), FROM);
    const s = send();
    const deps = { db, env: {}, now: () => TO, quiet: QUIET, send: s.fn };
    expect(await digestTickOnce(deps)).toBe('empty'); // nothing in the span
    expect(s.sent).toHaveLength(0);
    setState(db, KEY_DIGEST_LAST_AT, FROM.toISOString(), FROM);
    app('naukri', 'native', 'submitted', IN);
    expect(await digestTickOnce(deps)).toBe('sent');
    expect(s.sent[0]).toContain('applies: naukri 1');
    expect(getState(db, KEY_DIGEST_LAST_AT)).toBe(TO.toISOString());
  });

  it('npx tsx scripts/status.ts digest (renderStatusDigest) shows the same numbers', () => {
    const { db, app, job } = world();
    app('naukri', 'native', 'submitted', IN);
    job('a', 'naukri', { jd: IN });
    enqueueNotice(db, 'mail_sent', { kind: 'cold', dry: false }, new Date(IN_ISO));
    db.prepare("INSERT INTO outreach_queue (job_id, email_status, email_sent_at) VALUES ('a', 'sent', ?)").run(IN_ISO);
    const fromTick = composeDigest(unsentRows(db), { from: FROM, to: TO }, 0, readDigestFacts(db, FROM, TO)).text.replace(/<\/?[a-z]+>/g, '');
    const status = renderStatusDigest(db, TO, TO.getTime() - FROM.getTime());
    for (const line of ['• 1 email (1 cold)', '• applies: naukri 1', '• 1 job description read (naukri 1)']) {
      expect(fromTick).toContain(line);
      expect(status).toContain(line);
    }
  });
});
