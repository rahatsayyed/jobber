// A failure always carries a reason (src/failureReason.ts, updateOutreachStatus, markFollowupFailed) and the legacy backfill.
import { describe, expect, it, vi } from 'vitest';
import { openDb, saveJob, updateOutreachStatus } from '../src/db.js';
import { backfillLegacyReasons, composeReason, missingReasonCountToday, needsReason, unspecifiedReason } from '../src/failureReason.js';

function row(db: ReturnType<typeof openDb>, n: string, o: { status?: string | null; note?: string | null } = {}): number {
  const id = `job-${n}`;
  saveJob(db, { id, source: 'naukri', title: `Dev ${n}`, company: 'Acme', url: `https://x.test/${n}`, apply_url: `https://x.test/${n}`, description: 'd' });
  const r = db.prepare("INSERT INTO outreach_queue (job_id, apply_status, apply_note, status) VALUES (?, ?, ?, 'queued')").run(id, o.status ?? null, o.note ?? null);
  return Number(r.lastInsertRowid);
}
const noteOf = (db: ReturnType<typeof openDb>, id: number): string | null => (db.prepare('SELECT apply_note AS n FROM outreach_queue WHERE id = ?').get(id) as { n: string | null }).n;

describe('needsReason and composeReason', () => {
  it('flags the terminal non-success states only', () => {
    for (const v of ['failed', 'manual_review', 'needs_owner', 'needs_human', 'needs_answer', 'closed']) expect(needsReason('apply_status', v)).toBe(true);
    for (const v of ['submitted', 'held', 'queued']) expect(needsReason('apply_status', v)).toBe(false);
    expect(needsReason('email_status', 'failed')).toBe(true);
    expect(needsReason('connect_status', 'failed')).toBe(true);
    expect(needsReason('status', 'done')).toBe(false);
  });
  it('joins code and detail, cleans whitespace, and returns empty without a code', () => {
    expect(composeReason('external:no_popup', 'popup did\nnot open')).toBe('external:no_popup - popup did not open');
    expect(composeReason('  ', 'detail only')).toBe('');
    expect(composeReason(undefined)).toBe('');
    expect(unspecifiedReason('apply-operator', 'run123')).toBe('unspecified:apply-operator:run123');
  });
});

describe('updateOutreachStatus reasons', () => {
  it('stores the given reason code and detail', () => {
    const db = openDb(':memory:');
    const id = row(db, '1');
    updateOutreachStatus(db, id, 'apply_status', 'failed', { reason: 'open_failed:nav_timeout', detail: 'page never loaded' });
    expect(noteOf(db, id)).toBe('open_failed:nav_timeout - page never loaded');
    expect(missingReasonCountToday(db)).toBe(0);
  });

  it('stores unspecified:<operator>:<run> and counts a defect when no reason is given', () => {
    const db = openDb(':memory:');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const id = row(db, '2');
    updateOutreachStatus(db, id, 'apply_status', 'manual_review', { operator: 'apply-operator', runId: 'r9' });
    expect(noteOf(db, id)).toBe('unspecified:apply-operator:r9');
    expect(missingReasonCountToday(db)).toBe(1);
    expect(err.mock.calls.some((c) => String(c[0]).startsWith('[ALERT]'))).toBe(true);
    err.mockRestore();
  });

  it('keeps a reason a code path already stored and does not count a defect', () => {
    const db = openDb(':memory:');
    const id = row(db, '3', { status: 'needs_owner', note: 'unknown_apply_host:foo.com' });
    updateOutreachStatus(db, id, 'apply_status', 'needs_owner');
    expect(noteOf(db, id)).toBe('unknown_apply_host:foo.com');
    expect(missingReasonCountToday(db)).toBe(0);
  });

  it('does not ask for a reason on success and keeps connect/email failures too', () => {
    const db = openDb(':memory:');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const id = row(db, '4');
    updateOutreachStatus(db, id, 'apply_status', 'submitted');
    expect(noteOf(db, id)).toBeNull();
    updateOutreachStatus(db, id, 'connect_status', 'failed', { reason: 'connect_unavailable:no_button' });
    expect((db.prepare('SELECT status_reason AS r FROM outreach_queue WHERE id = ?').get(id) as { r: string }).r).toBe('connect_unavailable:no_button');
    updateOutreachStatus(db, id, 'email_status', 'failed', { reason: 'send_error:x' });
    expect(missingReasonCountToday(db)).toBe(0);
    vi.restoreAllMocks();
  });
});

describe('backfillLegacyReasons', () => {
  it('counts on dry, fills only blank failed/manual_review rows, and is idempotent', () => {
    const db = openDb(':memory:');
    const a = row(db, '5', { status: 'failed' });
    const b = row(db, '6', { status: 'manual_review', note: '  ' });
    const c = row(db, '7', { status: 'manual_review', note: 'external:no_popup' });
    const d = row(db, '8', { status: 'needs_owner' });
    expect(backfillLegacyReasons(db, { dry: true }).applyRows).toBe(2);
    expect(noteOf(db, a)).toBeNull();
    expect(backfillLegacyReasons(db).applyRows).toBe(2);
    expect(noteOf(db, a)).toBe('legacy:unknown');
    expect(noteOf(db, b)).toBe('legacy:unknown');
    expect(noteOf(db, c)).toBe('external:no_popup');
    expect(noteOf(db, d)).toBeNull();
    expect(backfillLegacyReasons(db).applyRows).toBe(0);
  });
});
