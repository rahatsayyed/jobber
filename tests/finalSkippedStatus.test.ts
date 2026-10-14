import { describe, it, expect } from 'vitest';
import { openDb, saveJob, setJobExcluded, listQueuedOutreach, listExcludedQueuedOutreach, updateOutreachStatus } from '../src/db.js';

describe('skipped queue rows get status skipped (final review M5)', () => {
  it('after update_outreach_status(status, skipped) list_skipped_outreach no longer repeats the row', () => {
    const db = openDb(':memory:');
    saveJob(db, { id: 'j1', source: 't', title: 'Dev', company: 'A', url: 'u', apply_url: 'u', description: 'd' });
    const id = Number(db.prepare("INSERT INTO outreach_queue (job_id, email_status) VALUES ('j1', 'queued')").run().lastInsertRowid);
    setJobExcluded(db, 'j1', 'deadline passed: 2026-10-01');
    expect(listExcludedQueuedOutreach(db)).toEqual([{ id, job_id: 'j1', reason: 'deadline passed: 2026-10-01' }]);
    updateOutreachStatus(db, id, 'status', 'skipped');
    expect(listExcludedQueuedOutreach(db)).toEqual([]);
    expect(listQueuedOutreach(db)).toEqual([]);
    expect((db.prepare('SELECT status FROM outreach_queue WHERE id = ?').get(id) as any).status).toBe('skipped');
  });
});
