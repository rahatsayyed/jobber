import { describe, it, expect } from 'vitest';
import { openDb, saveJob, listQueuedOutreach, listExcludedQueuedOutreach } from '../src/db.js';

describe('queued rows whose job has no row in jobs (final review M6)', () => {
  it('listQueuedOutreach skips them and listExcludedQueuedOutreach reports "unknown job"', () => {
    const db = openDb(':memory:');
    saveJob(db, { id: 'j1', source: 't', title: 'Dev', company: 'A', url: 'u', apply_url: 'u', description: 'd' });
    const ok = Number(db.prepare("INSERT INTO outreach_queue (job_id, email_status) VALUES ('j1', 'queued')").run().lastInsertRowid);
    const orphan = Number(db.prepare("INSERT INTO outreach_queue (job_id, email_status) VALUES ('unknown:999', 'queued')").run().lastInsertRowid);
    expect(listQueuedOutreach(db).map((r) => r.id)).toEqual([ok]);
    expect(listExcludedQueuedOutreach(db)).toEqual([{ id: orphan, job_id: 'unknown:999', reason: 'unknown job' }]);
  });
});
