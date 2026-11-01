import { beforeEach, describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { migrateOutreachTables } from '../src/outreach/schema.js';
import { migrateSchedulerTables } from '../src/scheduler/runLog.js';
import { listJobs } from '../src/dash/queries/jobs.js';
import { listPeople } from '../src/dash/queries/people.js';
import { listSentEmails } from '../src/dash/queries/mail.js';
import { listSchedulerRuns } from '../src/dash/runlog.js';
import { keysToTmux } from '../src/web/terminalRoutes.js';
import { ceilingLabel, funnelHref, inventoryMetrics, queueStatusInfo, TERMINAL_HELPER_KEYS } from '../apps/dashboard/src/lib/view-models.js';

let db: BetterSqlite3.Database;
beforeEach(() => { db = openDb(':memory:'); migrateOutreachTables(db); migrateSchedulerTables(db); });

describe('Jobs list filters used by the Home links', () => {
  beforeEach(() => {
    db.prepare("INSERT INTO jobs (id, source, title, company, score) VALUES ('a','x','A','Acme',80)").run();
    db.prepare("INSERT INTO jobs (id, source, title, company) VALUES ('b','x','B','Acme')").run();
    db.prepare("INSERT INTO jobs (id, source, title, company, score) VALUES ('c','x','C','Globex',30)").run();
    db.prepare("INSERT INTO outreach_queue (job_id, email_status, email_sent_at, status) VALUES ('c','sent','2026-10-01','done')").run();
  });
  it('scored=1 keeps only jobs with a score', () => {
    expect(listJobs(db, { scored: true }).items.map((j) => j.id).sort()).toEqual(['a', 'c']);
    expect(listJobs(db, {}).items).toHaveLength(3);
  });
  it('contacted=1 keeps the jobs the funnel counts as contacted', () => {
    expect(listJobs(db, { contacted: true }).items.map((j) => j.id)).toEqual(['c']);
  });
  it('contacted=1 is empty, not an error, when a table is missing', () => {
    const bare = openDb(':memory:');
    bare.exec('DROP TABLE outreach');
    expect(listJobs(bare, { contacted: true }).items).toEqual([]);
  });
});

describe('People list links', () => {
  it('carries the message count, job count and the newest job of each person', () => {
    db.prepare("INSERT INTO jobs (id, source, title, company) VALUES ('j1','x','Old role','Acme')").run();
    db.prepare("INSERT INTO jobs (id, source, title, company) VALUES ('j2','x','New role','Acme')").run();
    db.prepare("INSERT INTO people (id, platform, profile_key, name, company_key, category) VALUES (1,'linkedin','linkedin.com/in/a','Ann','acme','peer')").run();
    db.prepare("INSERT INTO people (id, platform, profile_key, name, company_key, category) VALUES (2,'linkedin','linkedin.com/in/b','Bo','acme','peer')").run();
    db.prepare("INSERT INTO touches (person_id, job_id, kind, idempotency_key) VALUES (1,'j1','connect','k1')").run();
    db.prepare("INSERT INTO touches (person_id, job_id, kind, idempotency_key) VALUES (1,'j2','message','k2')").run();
    db.prepare("INSERT INTO touches (person_id, job_id, kind, idempotency_key) VALUES (1,'j2','followup','k3')").run();
    const rows = listPeople(db, {}).items;
    expect(rows.find((p) => p.id === 1)).toMatchObject({ touch_count: 3, job_count: 2, last_job_id: 'j2', last_job_title: 'New role' });
    expect(rows.find((p) => p.id === 2)).toMatchObject({ touch_count: 0, job_count: 0, last_job_id: null, last_job_title: null });
  });
});

describe('Mail list and Runs list links', () => {
  it('counts the sent follow-ups of a sent mail', () => {
    db.prepare("INSERT INTO jobs (id, source, title, company) VALUES ('j1','x','T','Acme')").run();
    db.prepare("INSERT INTO outreach_queue (id, job_id, email_to, email_subject, email_sent_at, email_status, status) VALUES (1,'j1','a@b.io','S','2026-10-01','sent','done')").run();
    db.prepare("INSERT INTO followups (job_id, n, status) VALUES ('j1',1,'sent')").run();
    db.prepare("INSERT INTO followups (job_id, n, status) VALUES ('j1',2,'drafted')").run();
    expect(listSentEmails(db, {}).items[0].followups_sent).toBe(1);
  });
  it('counts the inbox items a run created', () => {
    db.prepare("INSERT INTO scheduler_runs (id, planned_at, trigger, status) VALUES ('r1','2026-10-01T00:00:00Z','scheduled','ok')").run();
    db.prepare("INSERT INTO scheduler_runs (id, planned_at, trigger, status) VALUES ('r2','2026-10-02T00:00:00Z','scheduled','ok')").run();
    db.prepare("INSERT INTO escalations (run_id, reason, created_at) VALUES ('r1','x','2026-10-01'), ('r1','y','2026-10-01')").run();
    const items = listSchedulerRuns(db, {})!.items;
    expect(items.find((r) => r.id === 'r1')!.escalations).toBe(2);
    expect(items.find((r) => r.id === 'r2')!.escalations).toBe(0);
  });
});

describe('Home link helpers', () => {
  it('every Home tile and funnel step opens a filtered list', () => {
    const tiles = inventoryMetrics({ discovered: 5 }, 3, 60);
    expect(Object.fromEntries(tiles.map((m) => [m.key, m.href]))).toEqual({
      total: '/jobs', scored: '/jobs?scored=1', matched: '/jobs?bucket=matched', applied: '/jobs?bucket=applied', awaiting: '/jobs?bucket=pending', failed: '/jobs?bucket=failed',
    });
    expect(funnelHref('contacted')).toBe('/jobs?contacted=1');
    expect(funnelHref('interview')).toBe('/outcomes?outcome=interview');
    expect(funnelHref('unknown')).toBeNull();
  });
  it('names the queue statuses and daily limits in plain words', () => {
    expect(queueStatusInfo('queued')).toMatchObject({ label: 'Queued', href: '/jobs?bucket=pending' });
    expect(queueStatusInfo('weird_state')).toMatchObject({ label: 'weird state', href: null });
    expect(ceilingLabel('send_email')).toBe('Emails sent today');
    expect(ceilingLabel('some_new_key')).toBe('some new key');
  });
});

describe('terminal Send-keys helper row', () => {
  it('turns each helper button into the tmux key it names', () => {
    const calls = Object.fromEntries(TERMINAL_HELPER_KEYS.map((k) => [k.label, keysToTmux(k.keys)]));
    expect(calls).toEqual({
      Enter: [['Enter']], 'Ctrl+C': [['C-c']], Esc: [['Escape']], Tab: [['Tab']], Left: [['Left']], Up: [['Up']], Down: [['Down']], Right: [['Right']],
    });
  });
  it('types a command literally and ends it with Enter', () => {
    expect(keysToTmux('echo hello\r')).toEqual([['-l', '--', 'echo hello'], ['Enter']]);
  });
});
