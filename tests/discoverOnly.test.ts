import { describe, it, expect } from 'vitest';
import { DISCOVER_ONLY_SOURCES, isApplyBlockedSource, isDiscoverOnlySource } from '../src/lib/discoverOnly.js';
import { IMPORTED_IDS } from '../src/sources/providers/index.js';
import { enqueueOutreach, openDb, saveJob } from '../src/db.js';

const queueItem = (job_id: string, apply_platform: string | null) => ({
  job_id, resume_pdf_path: null, email_subject: 'S', email_body: 'B', email_to: 'a@b.co',
  connect_note: null, connect_profile_url: null, connect_category: null, connect_company: null,
  apply_platform, apply_url: 'https://acme.wd5.myworkdayjobs.com/ext/job/x_R1',
});
const job = (id: string, source: string, apply_url: string) =>
  ({ id, source, title: 'Frontend Engineer', company: 'Acme', url: apply_url, apply_url, description: 'React' });

describe('isApplyBlockedSource', () => {
  it('blocks discover-only, aggregator and gen sources, not board or search sources', () => {
    for (const s of ['workday', 'hackernews', 'himalayas', 'weworkremotely', 'gen:acme', 'GEN:Acme']) expect(isApplyBlockedSource(s)).toBe(true);
    for (const s of ['greenhouse', 'lever', 'ashby', 'adzuna', 'naukri', '', null, undefined]) expect(isApplyBlockedSource(s)).toBe(false);
  });
});

describe('isDiscoverOnlySource', () => {
  it('lists exactly the new vendors and aggregators', () => {
    const base = ['hackernews', 'himalayas', 'personio', 'recruitee', 'smartrecruiters', 'weworkremotely', 'workable', 'workday'];
    // The feeds imported from career-ops (src/sources/providers) are discover-only too.
    expect([...DISCOVER_ONLY_SOURCES].sort()).toEqual([...base, ...IMPORTED_IDS].sort());
    for (const s of IMPORTED_IDS) expect(isDiscoverOnlySource(s)).toBe(true);
    for (const s of ['greenhouse', 'lever', 'ashby', 'linkedin', 'adzuna', 'remotive', 'naukri', '', null, undefined]) expect(isDiscoverOnlySource(s)).toBe(false);
    expect(isDiscoverOnlySource('workday')).toBe(true);
    for (const s of ['Workday', ' workday ', 'HACKERNEWS']) expect(isDiscoverOnlySource(s)).toBe(true);
  });
});

describe('enqueueOutreach forces apply_platform none for discover-only sources', () => {
  it('coerces workday and aggregator jobs, leaves greenhouse and unknown jobs alone, keeps email fields', () => {
    const db = openDb(':memory:');
    saveJob(db, job('wd:acme:ext:1', 'workday', 'https://acme.wd5.myworkdayjobs.com/ext/job/x_R1'));
    saveJob(db, job('hn:1', 'hackernews', 'https://news.ycombinator.com/item?id=1'));
    saveJob(db, job('gh:acme:1', 'greenhouse', 'https://boards.greenhouse.io/acme/jobs/1'));
    const row = (id: number) => db.prepare('SELECT apply_platform, email_to FROM outreach_queue WHERE id = ?').get(id) as any;
    expect(row(enqueueOutreach(db, queueItem('wd:acme:ext:1', 'workday')))).toEqual({ apply_platform: 'none', email_to: 'a@b.co' });
    expect(row(enqueueOutreach(db, queueItem('hn:1', 'greenhouse')))).toEqual({ apply_platform: 'none', email_to: 'a@b.co' });
    expect(row(enqueueOutreach(db, queueItem('gh:acme:1', 'greenhouse'))).apply_platform).toBe('greenhouse');
    expect(row(enqueueOutreach(db, queueItem('unknown-job', 'lever'))).apply_platform).toBe('lever');
    expect(row(enqueueOutreach(db, queueItem('wd:acme:ext:1', null))).apply_platform).toBe('none');
    saveJob(db, job('jobicy:abc', 'jobicy', 'https://jobicy.com/jobs/1-x'));
    expect(row(enqueueOutreach(db, queueItem('jobicy:abc', 'greenhouse')))).toEqual({ apply_platform: 'none', email_to: 'a@b.co' });
  });
});

describe('case variants and missing job rows', () => {
  it('enqueueOutreach coerces case-variant sources; a job_id with no jobs row passes the platform through', () => {
    const db = openDb(':memory:');
    saveJob(db, job('wd:1', 'Workday', 'https://acme.wd5.myworkdayjobs.com/ext/job/x_R1'));
    saveJob(db, job('hn:3', ' workday ', 'https://news.ycombinator.com/item?id=3'));
    saveJob(db, job('hn:4', 'HACKERNEWS', 'https://news.ycombinator.com/item?id=4'));
    const plat = (id: number) => (db.prepare('SELECT apply_platform FROM outreach_queue WHERE id = ?').get(id) as any).apply_platform;
    for (const j of ['wd:1', 'hn:3', 'hn:4']) expect(plat(enqueueOutreach(db, queueItem(j, 'workday')))).toBe('none');
    expect(plat(enqueueOutreach(db, queueItem('no-such-job', 'greenhouse')))).toBe('greenhouse');
  });
});
