import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DISCOVER_ONLY_SOURCES, isDiscoverOnlySource } from '../src/lib/discoverOnly.js';
import { applyExternal } from '../src/apply/external.js';
import { applyEasyApply } from '../src/apply/linkedin.js';
import { enqueueOutreach, openDb, saveJob, saveOutreach } from '../src/db.js';

const queueItem = (job_id: string, apply_platform: string | null) => ({
  job_id, resume_pdf_path: null, email_subject: 'S', email_body: 'B', email_to: 'a@b.co',
  connect_note: null, connect_profile_url: null, connect_category: null, connect_company: null,
  apply_platform, apply_url: 'https://acme.wd5.myworkdayjobs.com/ext/job/x_R1',
});
const job = (id: string, source: string, apply_url: string) =>
  ({ id, source, title: 'Frontend Engineer', company: 'Acme', url: apply_url, apply_url, description: 'React' });

describe('isDiscoverOnlySource', () => {
  it('lists exactly the new vendors and aggregators', () => {
    expect([...DISCOVER_ONLY_SOURCES].sort()).toEqual(['hackernews', 'himalayas', 'personio', 'recruitee', 'smartrecruiters', 'weworkremotely', 'workable', 'workday']);
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
  });
});

describe('applyExternal refuses discover-only jobs before anything else', () => {
  it.each([
    ['wd:acme:ext:1', 'workday', 'https://acme.wd5.myworkdayjobs.com/ext/job/x_R1', 'apply.workday expected_platform', 'workday'],
    ['hn:2', 'hackernews', 'https://news.ycombinator.com/item?id=2', 'apply.auto without a pinned platform', undefined],
  ])('%s (%s)', async (id, source, url, _why, expected_platform) => {
    const db = openDb(':memory:');
    saveJob(db, job(id, source, url));
    saveOutreach(db, { job_id: id, contact_email: 'h@acme.com', subject: 'S', body: 'B', resume_path: '/tmp/fake-resume.pdf' });
    const launch = vi.fn();
    const runClaude = vi.fn();
    const learnedPlatformsPath = path.join(mkdtempSync(path.join(tmpdir(), 'discover-only-')), 'learned.json');
    const r = await applyExternal({ job_id: id, ...(expected_platform ? { expected_platform } : {}) }, { db, maxAppliesPerDay: 5, chromium: { launch } as any, bootstrap: { runClaude } as any, learnedPlatformsPath });
    expect(r.status).toBe('manual_review');
    expect(r.reason).toMatch(/discover-only/);
    expect(launch).not.toHaveBeenCalled();
    expect(runClaude).not.toHaveBeenCalled();
    expect(existsSync(learnedPlatformsPath)).toBe(false);
    expect(db.prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = ?").get('easy_apply')).toBeUndefined();
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

  it.each(['Workday', ' workday ', 'HACKERNEWS'])('applyExternal refuses source %j', async (source) => {
    const db = openDb(':memory:');
    saveJob(db, job('x:1', source, 'https://news.ycombinator.com/item?id=9'));
    const launch = vi.fn();
    const r = await applyExternal({ job_id: 'x:1' }, { db, maxAppliesPerDay: 5, chromium: { launch } as any });
    expect(r.status).toBe('manual_review');
    expect(r.reason).toMatch(/discover-only/);
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('applyEasyApply refuses discover-only jobs even with a linkedin.com url', () => {
  it.each(['hackernews', 'HackerNews', ' workday '])('%j', async (source) => {
    const db = openDb(':memory:');
    saveJob(db, job('li:1', source, 'https://www.linkedin.com/jobs/view/123'));
    const launch = vi.fn();
    const r = await applyEasyApply({ job_id: 'li:1' }, { db, maxAppliesPerDay: 5, chromium: { launch } as any });
    expect(r.status).toBe('manual_review');
    expect(r.reason).toMatch(/discover-only/);
    expect(launch).not.toHaveBeenCalled();
    expect(db.prepare('SELECT count FROM daily_counters WHERE key = ?').get('easy_apply')).toBeUndefined();
  });
});
