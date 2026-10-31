import { describe, it, expect } from 'vitest';
import { enqueueOutreach, openDb, saveJob } from '../src/db.js';
import { run } from '../scripts/apply-release-held.js';

function seed(platform: string, status: string, id: string) {
  return { platform, status, id };
}

describe('apply:release-held', () => {
  it('releases held generic rows only, is idempotent and honours --dry', () => {
    const db = openDb(':memory:');
    for (const r of [seed('greenhouse', 'held', 'a'), seed('browser', 'held', 'b'), seed('naukri', 'held', 'c'), seed('lever', 'submitted', 'd')]) {
      saveJob(db, { id: r.id, source: 'remotive', title: r.id, company: r.id, url: `https://x.example/${r.id}`, apply_url: 'https://boards.greenhouse.io/a/jobs/1', description: 'd', posted_at: null } as any);
      enqueueOutreach(db, { job_id: r.id, resume_pdf_path: '/x.pdf', email_subject: null, email_body: null, email_to: null, connect_note: null, connect_profile_url: null, connect_category: null, connect_company: null, apply_platform: r.platform, apply_tier: 'agent', apply_url: 'https://boards.greenhouse.io/a/jobs/1', resume_json: '{}' } as any);
    }
    db.exec("UPDATE outreach_queue SET apply_status = 'held' WHERE job_id IN ('a','b','c'); UPDATE outreach_queue SET apply_status = 'submitted' WHERE job_id = 'd'");
    expect(run(['--dry'], { db }).lines.join()).toContain('2 held');
    expect(run([], { db }).lines.join()).toContain('released 2');
    expect(run([], { db }).lines.join()).toContain('released 0');
    const s = db.prepare('SELECT job_id, apply_status FROM outreach_queue ORDER BY job_id').all();
    expect(s).toEqual([{ job_id: 'a', apply_status: null }, { job_id: 'b', apply_status: null }, { job_id: 'c', apply_status: 'held' }, { job_id: 'd', apply_status: 'submitted' }]);
    expect(run(['--x'], { db }).code).toBe(2);
  });
});
