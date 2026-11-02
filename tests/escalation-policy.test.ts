import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { noiseKind, dedupeHost } from '../src/outreach/escalationPolicy.js';
import { run } from '../scripts/escalations-clean-noise.js';

describe('escalation policy', () => {
  it('flags telemetry, ceilings and dead jobs', () => {
    expect(noiseKind('linkedin', 'layout_drift', 'kind=search streak=3')).toBe('layout_telemetry');
    expect(noiseKind('linkedin', 'profile_view_limit', 'Daily profile view limit reached')).toBe('ceiling');
    expect(noiseKind('apply', 'apply:other', 'Naukri page redirected to search list (job gone); job_url_mismatch')).toBe('job_gone');
    expect(noiseKind('apply', 'apply:drift', 'reason=drift host=x.com\nnote: Careers listing page, no form')).toBe('apply_tool_noise');
  });
  it('keeps real owner items', () => {
    expect(noiseKind('linkedin', 'linkedin_reply_needed', 'Recruiter asks')).toBeNull();
    expect(noiseKind('apply', 'apply:needs_human', 'host=a.com')).toBeNull();
    expect(noiseKind('apply', 'apply:captcha', 'host=a.com')).toBeNull();
    expect(noiseKind('linkedin', '[blocked: injection_suspected]', null)).toBeNull();
  });
  it('dedupes per host', () => {
    expect(dedupeHost('apply:captcha', 'reason=captcha host=a.com')).toBe('a.com');
    expect(dedupeHost('apply:question', 'host=a.com')).toBeNull();
  });
  it('clean script resolves noise and duplicates, idempotent', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE escalations (id INTEGER PRIMARY KEY, platform TEXT, reason TEXT, detail TEXT, thread_ref TEXT, resolved_at TEXT, resolved_note TEXT)');
    const ins = db.prepare('INSERT INTO escalations (platform, reason, detail) VALUES (?,?,?)');
    ins.run('linkedin', 'layout_drift', 'x');
    ins.run('apply', 'apply:captcha', 'host=a.com');
    ins.run('apply', 'apply:captcha', 'host=a.com');
    ins.run('linkedin', 'linkedin_reply_needed', 'hi');
    expect(run(['--dry'], { db }).lines[0]).toContain('would resolve 2 of 4');
    expect(run([], { db }).lines[0]).toContain('resolved 2 of 4');
    expect(run([], { db }).lines[0]).toContain('resolved 0 of 2');
    expect((db.prepare('SELECT COUNT(*) c FROM escalations WHERE resolved_at IS NULL').get() as { c: number }).c).toBe(2);
  });
});
