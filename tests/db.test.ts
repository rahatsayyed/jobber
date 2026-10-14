import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, isSeen, saveJob, getJob, saveContact, saveOutreach, enqueueOutreach, listQueuedOutreach, listExcludedQueuedOutreach, updateOutreachStatus, type OutreachQueueItem } from '../src/db.js';
import type Database from 'better-sqlite3';

describe('db', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('should save a job and check if it is seen', () => {
    const job = {
      id: 'job-001',
      source: 'linkedin',
      title: 'Software Engineer',
      company: 'Acme Corp',
      url: 'https://example.com/job/001',
      apply_url: 'https://example.com/apply/001',
      description: 'Build awesome stuff',
    };

    saveJob(db, job);
    expect(isSeen(db, 'job-001')).toBe(true);
    expect(isSeen(db, 'nope')).toBe(false);
  });

  it('should return saved job via getJob', () => {
    const job = {
      id: 'job-002',
      source: 'indeed',
      title: 'Data Scientist',
      company: 'Tech Inc',
      url: 'https://example.com/job/002',
      apply_url: 'https://example.com/apply/002',
      description: 'Analyze data',
    };

    saveJob(db, job);
    const retrieved = getJob(db, 'job-002');
    expect(retrieved).toBeDefined();
    expect(retrieved?.title).toBe('Data Scientist');
  });

  it('should store contact with verified as integer', () => {
    const contact = {
      company: 'Acme Corp',
      email: 'contact@acme.com',
      type: 'email',
      verified: true,
      source: 'linkedin',
      confidence: 0.95,
    };

    saveContact(db, contact);

    const result = db.prepare('SELECT verified FROM contacts WHERE email = ?').get(contact.email) as any;
    expect(result).toBeDefined();
    expect(result.verified).toBe(1);
  });

  it('should insert outreach record', () => {
    // First save a job so we have a valid foreign key reference
    const job = {
      id: 'job-003',
      source: 'glassdoor',
      title: 'Backend Engineer',
      company: 'DevCo',
      url: 'https://example.com/job/003',
      apply_url: 'https://example.com/apply/003',
      description: 'Build backend services',
    };
    saveJob(db, job);

    const outreach = {
      job_id: 'job-003',
      contact_email: 'dev@devco.com',
      subject: 'Interested in Backend Engineer role',
      body: 'Hello, I am interested...',
      resume_path: '/path/to/resume.pdf',
    };

    saveOutreach(db, outreach);

    const count = (db.prepare('SELECT COUNT(*) as cnt FROM outreach').get() as any).cnt;
    expect(count).toBe(1);
  });
});

describe('outreach_queue', () => {
  // Changed deliberately (final review M6): listQueuedOutreach now skips queued rows whose job has no jobs row, so tests seed the jobs.
  const seedJobs = (db: ReturnType<typeof openDb>, ...ids: string[]) => ids.forEach((id) => saveJob(db, { id, source: 'remotive', title: 'Dev', company: 'Co', url: `https://example.test/${id}`, apply_url: null, description: 'd', posted_at: null } as any));
  it('enqueues an item and returns its new row id', () => {
    const db = openDb(':memory:');
    const id = enqueueOutreach(db, {
      job_id: 'li-job:123',
      resume_pdf_path: '/tmp/resume.pdf',
      email_subject: 'Application for Full Stack Developer',
      email_body: 'Hi there...',
      email_to: 'hr@acme.com',
      connect_note: null,
      connect_profile_url: null,
      connect_category: null,
      connect_company: null,
      apply_platform: 'greenhouse',
      apply_url: 'https://boards.greenhouse.io/acme/jobs/123',
    });
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('lists only queued rows, ordered by created_at', () => {
    const db = openDb(':memory:');
    seedJobs(db, 'job-a', 'job-b');
    const id1 = enqueueOutreach(db, {
      job_id: 'job-a', resume_pdf_path: null, email_subject: null, email_body: null,
      email_to: null, connect_note: 'note a', connect_profile_url: 'https://linkedin.com/in/a',
      connect_category: 'recruiter', connect_company: 'Acme Corp', apply_platform: 'none', apply_url: null,
    });
    updateOutreachStatus(db, id1, 'status', 'done'); // should be excluded from listQueuedOutreach

    const id2 = enqueueOutreach(db, {
      job_id: 'job-b', resume_pdf_path: null, email_subject: null, email_body: null,
      email_to: null, connect_note: 'note b', connect_profile_url: 'https://linkedin.com/in/b',
      connect_category: 'peer', connect_company: 'Beta Inc', apply_platform: 'none', apply_url: null,
    });

    const queued = listQueuedOutreach(db);
    expect(queued).toHaveLength(1);
    expect(queued[0].id).toBe(id2);
    expect(queued[0].job_id).toBe('job-b');
    expect(queued[0].connect_company).toBe('Beta Inc');
  });

  it('updates a single field without touching others', () => {
    const db = openDb(':memory:');
    seedJobs(db, 'job-c');
    const id = enqueueOutreach(db, {
      job_id: 'job-c', resume_pdf_path: null, email_subject: 'Subj', email_body: 'Body',
      email_to: 'x@y.com', connect_note: null, connect_profile_url: null,
      connect_category: null, connect_company: null, apply_platform: 'none', apply_url: null,
    });

    updateOutreachStatus(db, id, 'email_status', 'sent');

    const [row] = listQueuedOutreach(db);
    expect(row.email_status).toBe('sent');
    expect(row.email_subject).toBe('Subj'); // untouched
    expect(row.status).toBe('queued'); // untouched (still queued overall)
  });

  it('a row with both a recruiter and peer connect target is two separate rows sharing job_id', () => {
    const db = openDb(':memory:');
    seedJobs(db, 'job-d');
    enqueueOutreach(db, {
      job_id: 'job-d', resume_pdf_path: '/tmp/r.pdf', email_subject: 'S', email_body: 'B',
      email_to: 'z@y.com', connect_note: 'recruiter note', connect_profile_url: 'https://linkedin.com/in/recruiter',
      connect_category: 'recruiter', connect_company: 'Delta LLC', apply_platform: 'none', apply_url: null,
    });
    enqueueOutreach(db, {
      job_id: 'job-d', resume_pdf_path: '/tmp/r.pdf', email_subject: 'S', email_body: 'B',
      email_to: 'z@y.com', connect_note: 'peer note', connect_profile_url: 'https://linkedin.com/in/peer',
      connect_category: 'peer', connect_company: 'Delta LLC', apply_platform: 'none', apply_url: null,
    });

    const queued = listQueuedOutreach(db);
    expect(queued).toHaveLength(2);
    expect(queued.every((r) => r.job_id === 'job-d')).toBe(true);
    expect(queued.map((r) => r.connect_category).sort()).toEqual(['peer', 'recruiter']);
  });

  it('listQueuedOutreach skips queued rows whose job has an excluded_reason, and listExcludedQueuedOutreach reports them', () => {
    const db = openDb(':memory:');
    const mkJob = (id: string) => saveJob(db, { id, source: 'remotive', title: 'Dev', company: 'Co', url: `https://example.test/${id}`, apply_url: null, description: 'd', posted_at: null } as any);
    mkJob('ex-1');
    mkJob('ok-1');
    const row = (job_id: string) => enqueueOutreach(db, {
      job_id, resume_pdf_path: null, email_subject: 'S', email_body: 'B', email_to: 'a@b.com',
      connect_note: null, connect_profile_url: null, connect_category: null, connect_company: null,
      apply_platform: 'none', apply_url: null,
    });
    const exId = row('ex-1');
    row('ok-1');
    const orphanId = row('no-job-row'); // no jobs row at all: skipped and reported as "unknown job" (final review M6; was listed before)
    db.prepare("UPDATE jobs SET excluded_reason = 'deadline passed: 2026-01-01' WHERE id = 'ex-1'").run();

    expect(listQueuedOutreach(db).map((r) => r.job_id).sort()).toEqual(['ok-1']);
    expect(listExcludedQueuedOutreach(db)).toEqual([
      { id: exId, job_id: 'ex-1', reason: 'deadline passed: 2026-01-01' },
      { id: orphanId, job_id: 'no-job-row', reason: 'unknown job' },
    ]);
  });

  it('listQueuedOutreach omits resume_json but keeps every other column', () => {
    const db = openDb(':memory:');
    seedJobs(db, 'job-e');
    enqueueOutreach(db, {
      job_id: 'job-e', resume_pdf_path: '/tmp/e.pdf', email_subject: 'S', email_body: 'B',
      email_to: 'e@y.com', connect_note: 'note', connect_profile_url: 'https://linkedin.com/in/e',
      connect_category: 'peer', connect_company: 'Echo', apply_platform: 'greenhouse',
      apply_url: 'https://boards.greenhouse.io/echo/jobs/1', resume_json: '{"name":"Test User"}',
    });
    const [row] = listQueuedOutreach(db);
    expect('resume_json' in row).toBe(false);
    expect(row).toMatchObject({
      resume_pdf_path: '/tmp/e.pdf', email_subject: 'S', email_body: 'B', email_to: 'e@y.com',
      connect_note: 'note', connect_profile_url: 'https://linkedin.com/in/e', connect_category: 'peer',
      connect_company: 'Echo', apply_platform: 'greenhouse',
      apply_url: 'https://boards.greenhouse.io/echo/jobs/1', status: 'queued',
    });
    expect(Object.keys(row).sort()).toEqual([
      'apply_platform', 'apply_status', 'apply_url', 'connect_category', 'connect_company', 'connect_note',
      'connect_profile_url', 'connect_status', 'created_at', 'email_body', 'email_status', 'email_subject',
      'email_to', 'id', 'job_id', 'resume_pdf_path', 'status', 'updated_at',
    ]);
  });
});
