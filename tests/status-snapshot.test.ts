// tests/status-snapshot.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { clearHalt, haltPlatform, recordEvent } from '../src/outreach/limits.js';
import { buildSnapshot } from '../src/status/snapshot.js';

const NOW = new Date('2026-10-14T10:00:00.000Z');
const cfg = loadOutreachConfig({});

describe('buildSnapshot', () => {
  it('gives a zeroed snapshot for an empty db', () => {
    const db = openDb(':memory:');
    const s = buildSnapshot(db, cfg, NOW);
    expect(s.generatedAt).toBe(NOW.toISOString());
    expect(s.ceilings.linkedin_invite).toEqual({ used: 0, limit: 100, ok: true });
    expect(s.dailyCounters).toEqual([]);
    expect(s.halts).toEqual([]);
    expect(s.queue).toEqual([]);
    expect(s.funnel).toEqual({ discovered: 0, matched: 0, contacted: 0, replied: 0, interview: 0, offer: 0 });
    expect(s.lastSend).toBeNull();
    expect(s.degraded).toEqual([]);
  });

  it('lists an active halt and hides a cleared one', () => {
    const db = openDb(':memory:');
    haltPlatform(db, 'linkedin', 'checkpoint', NOW);
    haltPlatform(db, 'naukri', 'captcha', NOW);
    clearHalt(db, 'naukri', NOW);
    const s = buildSnapshot(db, cfg, NOW);
    expect(s.halts).toEqual([{ platform: 'linkedin', reason: 'checkpoint', setAt: NOW.toISOString() }]);
  });

  it('reflects recorded rate_events in ceilings', () => {
    const db = openDb(':memory:');
    recordEvent(db, 'linkedin_invite', new Date(NOW.getTime() - 3600_000));
    recordEvent(db, 'linkedin_invite', new Date(NOW.getTime() - 3600_000));
    const s = buildSnapshot(db, cfg, NOW);
    expect(s.ceilings.linkedin_invite.used).toBe(2);
  });

  it('groups the queue by status and lists todays counters', () => {
    const db = openDb(':memory:');
    const ins = db.prepare("INSERT INTO outreach_queue (job_id, status) VALUES (?, ?)");
    ins.run('a', 'queued');
    ins.run('b', 'queued');
    ins.run('c', 'sent');
    db.prepare('INSERT INTO daily_counters (day, key, count) VALUES (?, ?, ?)').run('2026-10-14', 'send_email', 1);
    db.prepare('INSERT INTO daily_counters (day, key, count) VALUES (?, ?, ?)').run('2026-10-13', 'send_email', 5);
    const s = buildSnapshot(db, cfg, NOW);
    expect(s.queue).toEqual([{ status: 'queued', count: 2 }, { status: 'sent', count: 1 }]);
    expect(s.dailyCounters).toEqual([{ key: 'send_email', count: 1 }]);
  });

  it('reports the latest sent email as lastSend', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO outreach_queue (job_id, status, email_status, email_sent_at) VALUES ('a', 'sent', 'sent', '2026-10-14 08:00:00')").run();
    const s = buildSnapshot(db, cfg, NOW);
    expect(s.lastSend).toEqual({ kind: 'email', at: '2026-10-14T08:00:00.000Z' });
  });

  it('falls back to empty values when tables are missing', () => {
    const db = openDb(':memory:');
    for (const t of ['rate_events', 'halt_flags', 'touches', 'daily_counters', 'outreach_queue']) db.exec(`DROP TABLE ${t}`);
    const s = buildSnapshot(db, cfg, NOW);
    expect(s.ceilings.naukri_apply).toEqual({ used: 0, limit: 0, ok: false });
    expect(s.degraded).toEqual(expect.arrayContaining(['ceilings', 'halts', 'queue', 'dailyCounters']));
    expect(s.halts).toEqual([]);
    expect(s.queue).toEqual([]);
    expect(s.dailyCounters).toEqual([]);
    expect(s.lastSend).toBeNull();
    expect(s.funnel.discovered).toBe(0);
  });
});
