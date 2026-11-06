import { describe, expect, it } from 'vitest';
import { openDb, listUnscoredJobs, saveMatchResultsChecked, saveJob, type Job } from '../src/db.js';
import { createManualRequest, getManualRequest } from '../src/manual/requests.js';
import { finalizeManualRequests } from '../src/manual/report.js';
import { countDue } from '../src/scheduler/due.js';
import { FULL_JD } from './helpers/jdFixtures.js';

const NOW = new Date('2026-10-15T08:00:00.000Z');
const job = (id: string): Job => ({ id, source: 'remotive', title: `Role ${id}`, company: `Co ${id}`, url: `https://x.test/${id}`, apply_url: `https://x.test/${id}`, description: FULL_JD });

describe('review fixes: finalize waits and retries', () => {
  function seed() {
    const db = openDb(':memory:');
    const r = createManualRequest(db, 'https://www.linkedin.com/jobs/view/123');
    if (!r.ok) throw new Error('create');
    saveJob(db, job('p1'));
    db.prepare("UPDATE jobs SET score = 4, priority = 1 WHERE id = 'p1'").run();
    db.prepare("UPDATE manual_requests SET status = 'running', job_ids = ?, started_at = ? WHERE id = ?").run(JSON.stringify(['p1']), NOW.toISOString(), r.id);
    return { db, id: r.id };
  }
  it('keeps the request running while a scored priority job has no queue row', async () => {
    const { db, id } = seed();
    const d = { send: async () => undefined, now: () => NOW, matchThreshold: 3 };
    expect((await finalizeManualRequests(db, 'ok', d)).waiting).toEqual([id]);
    db.prepare("INSERT INTO outreach_queue (job_id, status) VALUES ('p1', 'queued')").run();
    expect((await finalizeManualRequests(db, 'ok', d)).reported).toEqual([id]);
  });
  it('keeps the request running when the open task platform is not active', async () => {
    const { db, id } = seed();
    db.prepare("INSERT INTO outreach_queue (job_id, status) VALUES ('p1', 'queued')").run();
    db.prepare("INSERT INTO source_tasks (platform, reason, state, created_at, updated_at, request_id) VALUES ('linkedin', 'manual_url', 'queued', 'x', 'x', ?)").run(id);
    const base = { send: async () => undefined, now: () => NOW };
    expect((await finalizeManualRequests(db, 'ok', { ...base, platformActive: () => false })).waiting).toEqual([id]);
    expect((db.prepare('SELECT state FROM source_tasks').get() as { state: string }).state).toBe('queued');
    expect((await finalizeManualRequests(db, 'ok', { ...base, platformActive: () => true })).reported).toEqual([id]);
  });
  it('a failed send leaves the request running for a retry', async () => {
    const { db, id } = seed();
    db.prepare("INSERT INTO outreach_queue (job_id, status) VALUES ('p1', 'queued')").run();
    const bad = { send: async () => { throw new Error('down'); }, now: () => NOW };
    expect((await finalizeManualRequests(db, 'ok', bad)).waiting).toEqual([id]);
    expect(getManualRequest(db, id)!.status).toBe('running');
    expect((await finalizeManualRequests(db, 'ok', { send: async () => undefined, now: () => NOW })).reported).toEqual([id]);
  });
});

describe('review fixes: priority work, match omissions, offers', () => {
  it('countDue counts a leftover priority job', () => {
    const db = openDb(':memory:');
    saveJob(db, job('m1'));
    db.prepare("UPDATE jobs SET priority = 1 WHERE id = 'm1'").run();
    expect(countDue(db, NOW, undefined, {}).priorityWaiting).toBe(1);
  });
  it('a job offered to the matcher but missing from the saved rows gets a match failure', () => {
    const db = openDb(':memory:');
    saveJob(db, job('a'));
    saveJob(db, job('b'));
    const ids = listUnscoredJobs(db, { kind: 'unscored', limit: 10 }).map((j) => j.id);
    expect(ids.sort()).toEqual(['a', 'b']);
    saveMatchResultsChecked(db, [{ job_id: 'a', error: 'x' } as never]);
    expect((db.prepare("SELECT match_fails AS n FROM jobs WHERE id = 'b'").get() as { n: number }).n).toBe(1);
  });
  it('oncePerRun does not burn a second prep offer on a re-list', () => {
    const db = openDb(':memory:');
    saveJob(db, job('s'));
    db.prepare("UPDATE jobs SET score = 4.5 WHERE id = 's'").run();
    listUnscoredJobs(db, { kind: 'matched', limit: 10, matchThreshold: 3, oncePerRun: true });
    listUnscoredJobs(db, { kind: 'matched', limit: 10, matchThreshold: 3, oncePerRun: true });
    expect((db.prepare("SELECT prep_offers AS n FROM jobs WHERE id = 's'").get() as { n: number }).n).toBe(1);
  });
});
