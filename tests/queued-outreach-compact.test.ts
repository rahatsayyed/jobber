import { describe, it, expect } from 'vitest';
import { QUEUE_COMPACT_MAX_LIMIT, enqueueOutreach, listQueuedOutreach, listQueuedOutreachCompact, openDb, saveJob, updateOutreachStatus } from '../src/db.js';

// Bug 1 of wake a3cb0b53: the full queue was about 56 KB and Claude Code saved it to a file the operator could not read.
// The compact apply form is paged and never carries resume JSON, email bodies or notes.

const big = (n: number) => 'x'.repeat(n);

function seed(count: number) {
  const db = openDb(':memory:');
  for (let i = 0; i < count; i++) {
    const id = `job-${i}`;
    saveJob(db, { id, source: 'remotive', title: `Full Stack Developer ${i}`, company: `Company ${i}`, url: `https://example.test/${id}`, apply_url: `https://boards.greenhouse.io/c${i}/jobs/${i}`, description: 'd', posted_at: null } as any);
    enqueueOutreach(db, {
      job_id: id,
      resume_pdf_path: `/tmp/resume-${i}.pdf`,
      email_subject: 'Application for Full Stack Developer',
      email_body: big(1200),
      email_to: null,
      connect_note: big(280),
      connect_profile_url: `https://www.linkedin.com/in/person-${i}`,
      connect_category: 'recruiter',
      connect_company: `Company ${i}`,
      apply_platform: i % 3 === 0 ? 'naukri' : i % 3 === 1 ? 'greenhouse' : 'none',
      apply_tier: 'safe',
      apply_url: `https://boards.greenhouse.io/c${i}/jobs/${i}`,
      resume_json: big(4000),
    });
  }
  return db;
}

describe('listQueuedOutreachCompact', () => {
  it('stays well under 20 KB for 100 realistic rows while the full list is far larger', () => {
    const db = seed(100);
    expect(JSON.stringify(listQueuedOutreach(db)).length).toBeGreaterThan(100_000);
    const page = listQueuedOutreachCompact(db, { limit: 100 }); /* clamped to the maximum page */
    expect(page.rows.length).toBe(QUEUE_COMPACT_MAX_LIMIT);
    expect(JSON.stringify(page).length).toBeLessThan(20_000);
    const second = listQueuedOutreachCompact(db, { limit: 100, offset: QUEUE_COMPACT_MAX_LIMIT });
    expect(second.rows.length).toBe(100 - QUEUE_COMPACT_MAX_LIMIT);
    expect(JSON.stringify(second).length).toBeLessThan(20_000);
    expect(JSON.stringify(listQueuedOutreachCompact(db, {})).length).toBeLessThan(4_000);
  });

  it('returns only the apply fields', () => {
    const db = seed(1);
    const row = listQueuedOutreachCompact(db, {}).rows[0]!;
    expect(Object.keys(row).sort()).toEqual(['apply_platform', 'apply_status', 'apply_tier', 'apply_url', 'company', 'id', 'job_id', 'status', 'title']);
  });

  it('pages with limit (default 10) and offset and reports the total', () => {
    const db = seed(25);
    const first = listQueuedOutreachCompact(db, {});
    expect(first.rows.length).toBe(10);
    expect(first).toMatchObject({ total: 25, offset: 0, limit: 10 });
    const last = listQueuedOutreachCompact(db, { offset: 20 });
    expect(last.rows.length).toBe(5);
    expect(last.rows[0].job_id).toBe('job-20');
  });

  it('only_pending_apply keeps rows with an apply platform and no apply_status yet', () => {
    const db = seed(6); // platforms: naukri, greenhouse, none, naukri, greenhouse, none
    const rows = listQueuedOutreachCompact(db, { onlyPendingApply: true, limit: 50 });
    expect(rows.total).toBe(4);
    expect(rows.rows.every((r) => r.apply_platform && r.apply_platform !== 'none')).toBe(true);
    const doneId = rows.rows[0].id;
    updateOutreachStatus(db, doneId, 'apply_status', 'submitted');
    const after = listQueuedOutreachCompact(db, { onlyPendingApply: true, limit: 50 });
    expect(after.total).toBe(3);
    expect(after.rows.map((r) => r.id)).not.toContain(doneId);
  });
});
