import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { upsertPerson } from '../src/outreach/people.js';
import { recordDryRun } from '../src/safety/dryRun.js';
import { addEscalation } from '../src/outreach/service.js';
import { finishRun, startRun } from '../src/scheduler/runLog.js';
import { buildReport, formatReport } from '../src/scheduler/report.js';

describe('dry-run report', () => {
  it('summarises runs, would-be actions and open escalations', () => {
    const db = openDb(':memory:');
    const t = (m: number) => new Date(Date.UTC(2026, 9, 15, 5, m));
    startRun(db, { id: 'r1', at: t(0), trigger: 'scheduled', dryRun: true, tasks: [], status: 'running' });
    finishRun(db, 'r1', { at: t(5), status: 'ok', toolCalls: 12, tokensApprox: 3400 });
    startRun(db, { id: 'r2', at: t(10), trigger: 'scheduled', dryRun: true, tasks: [], status: 'skipped', stopReason: 'quiet_hours' });
    finishRun(db, 'r2', { at: t(10), status: 'skipped', stopReason: 'quiet_hours' });
    const pid = upsertPerson(db, { platform: 'naukri', profileKey: 'naukri:pat', name: 'Pat', company: 'Acme', category: 'recruiter' });
    recordDryRun(db, { runId: 'r1', action: 'message', platform: 'naukri', personId: pid, payload: { text: 'Hi Pat, following up.' } }, t(2), {});
    db.prepare("INSERT INTO touches (person_id, kind, body, idempotency_key, status, created_at) VALUES (?, 'followup', 'LI draft', 'k1', 'dry_run', ?)")
      .run(pid, t(3).toISOString());
    addEscalation(db, { runId: 'r1', platform: 'naukri', personId: pid, reason: 'salary question', detail: 'asks for CTC' }, t(4));

    const r = buildReport(db, { limit: 20 });
    expect(r.runs).toBe(2);
    expect(r.statusCounts).toEqual({ ok: 1, skipped: 1 });
    expect(r.skipReasons).toEqual({ quiet_hours: 1 });
    expect(r.budget.toolCalls).toBe(12);
    expect(r.wouldDo.map((a) => a.source).sort()).toEqual(['dry_run_actions', 'touches']);
    expect(r.escalations).toHaveLength(1);
    const text = formatReport(r);
    expect(text).toContain('quiet_hours=1');
    expect(text).toContain('Hi Pat, following up.');
    expect(text).toContain('salary question');
    expect(text).not.toMatch(/SECRET|API_KEY/);
  });

  it('is empty-safe', () => {
    const db = openDb(':memory:');
    const r = buildReport(db);
    expect(r.runs).toBe(0);
    expect(formatReport(r)).toContain('open escalations: 0');
  });
});
