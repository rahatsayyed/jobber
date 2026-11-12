// The one severity model (src/status/severity.ts): critical, action, info, the ranking and the summary line.
import { describe, expect, it } from 'vitest';
import { severityCounts, severityOf, severitySummary, sortBySeverity } from '../src/status/severity.js';

const sev = (i: Parameters<typeof severityOf>[0]) => severityOf(i).severity;

describe('severityOf', () => {
  it('rates a recruiter, interview, salary or plain reply as critical', () => {
    for (const askKind of ['reply', 'recruiter_inquiry', 'salary', 'interview_slot', 'question']) {
      expect(sev({ group: 'human', platform: 'linkedin', reason: 'linkedin_reply_needed', askKind })).toBe('critical');
    }
  });
  it('rates captcha, login wall, expired session, halt, broken parse, usage limit and the kill switch as critical', () => {
    for (const reason of ['apply:captcha', 'apply:needs_human', 'login_wall', 'linkedin session_expired', 'layout_drift_halt', 'discover_broken_parse', 'usage_limit_hit', 'kill switch on', 'logged_out']) {
      expect(sev({ group: 'platform', platform: reason.startsWith('apply:') ? 'apply' : 'linkedin', reason })).toBe('critical');
    }
  });
  it('rates owner-unblockable work as action', () => {
    for (const reason of ['apply:needs_answer', 'apply:needs_owner', 'apply:question', 'apply:host_unknown', 'apply:drift']) {
      expect(sev({ group: 'human', platform: 'apply', reason, askKind: 'question' })).toBe('action');
    }
    expect(sev({ group: 'platform', platform: 'naukri', reason: 'overlay_unknown:Survey' })).toBe('action');
    expect(sev({ group: 'human', platform: 'linkedin', reason: 'something', askKind: 'other' })).toBe('action');
  });
  it('rates counts, caps, skipped profiles and screen noise as info', () => {
    expect(sev({ group: 'noise', platform: 'linkedin', reason: '[blocked: injection_suspected]' })).toBe('info');
    expect(sev({ group: 'platform', platform: 'linkedin', reason: 'dialog_controls_missing' })).toBe('info');
    expect(sev({ group: 'platform', platform: 'linkedin', reason: 'note_quota_exhausted' })).toBe('info');
    expect(sev({ group: 'platform', platform: 'linkedin', reason: 'profile_mismatch' })).toBe('info');
  });
  it('gives a one-line hint for every item', () => {
    const r = severityOf({ group: 'platform', platform: 'linkedin', reason: 'dialog_controls_missing' });
    expect(r.hint).toMatch(/^Why: .* Do: /);
    expect(r.hint).not.toContain('\n');
  });
});

describe('ranking and summary', () => {
  const items = [
    { id: 1, group: 'platform', platform: 'linkedin', reason: 'dialog_controls_missing', last_at: '2026-11-01T00:00:00Z' },
    { id: 2, group: 'human', platform: 'apply', reason: 'apply:needs_owner', askKind: 'question', last_at: '2026-11-02T00:00:00Z' },
    { id: 3, group: 'human', platform: 'linkedin', reason: 'linkedin_reply_needed', askKind: 'interview_slot', last_at: '2026-11-03T00:00:00Z' },
    { id: 4, group: 'human', platform: 'linkedin', reason: 'linkedin_reply_needed', askKind: 'reply', last_at: '2026-11-02T00:00:00Z' },
    { id: 5, group: 'platform', platform: 'linkedin', reason: 'x_failed', last_at: '2026-11-04T00:00:00Z', resolved_at: '2026-11-05T00:00:00Z' },
  ];
  it('sorts by severity, then the one waiting longest first', () => {
    expect(sortBySeverity(items).map((i) => i.id)).toEqual([4, 3, 2, 1, 5]);
  });
  it('counts only open items and writes "N critical, N action"', () => {
    const c = severityCounts(items);
    expect(c).toEqual({ critical: 2, action: 1, info: 1 });
    expect(severitySummary(c)).toBe('2 critical, 1 action');
  });
});
