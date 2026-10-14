// tests/outreach-cadence.test.ts
import { describe, it, expect } from 'vitest';
import { cooldownUntil, planNextTouch, sequenceFor, type ContactSnapshot } from '../src/outreach/cadence.js';

const D = (day: number): Date => new Date(Date.UTC(2026, 9, 1 + day, 10, 0, 0));

const base = (over: Partial<ContactSnapshot> = {}): ContactSnapshot => ({
  category: 'peer',
  variant: 'rapport_first',
  connected: false,
  connectedAt: null,
  connectSentAt: null,
  messages: [],
  replied: false,
  pausedReason: null,
  cooldownUntil: null,
  ...over,
});

describe('sequenceFor', () => {
  it('rapport_first peers get a referral ask as the third message', () => {
    expect(sequenceFor('peer', 'rapport_first')).toEqual(['rapport', 'followup', 'referral_ask', 'followup', 'feedback']);
  });
  it('direct_referral peers and existing connections ask for a referral first', () => {
    expect(sequenceFor('peer', 'direct_referral')[0]).toBe('referral_ask');
    expect(sequenceFor('connection', null)[0]).toBe('referral_ask');
  });
  it('recruiters and hiring managers get a role-specific ask and never a referral ask', () => {
    expect(sequenceFor('recruiter', null)).not.toContain('referral_ask');
    expect(sequenceFor('hiring_manager', null)[0]).toBe('role_ask');
  });
});

describe('planNextTouch', () => {
  it('starts with a connection request for someone not yet contacted', () => {
    expect(planNextTouch(base(), D(0))).toEqual({ kind: 'connect', dueAt: D(0) });
  });

  it('waits while the request is unaccepted', () => {
    expect(planNextTouch(base({ connectSentAt: D(0) }), D(5))).toBeNull();
  });

  it('sends the first message 3 days after the request when accepted early', () => {
    const s = base({ connectSentAt: D(0), connected: true, connectedAt: D(1) });
    expect(planNextTouch(s, D(1))).toEqual({ kind: 'rapport', dueAt: D(3) });
  });

  it('waits a day after a late acceptance', () => {
    const s = base({ connectSentAt: D(0), connected: true, connectedAt: D(5) });
    expect(planNextTouch(s, D(5))).toEqual({ kind: 'rapport', dueAt: D(6) });
  });

  it('spaces follow-ups by 4, 5, 7 and 10 days', () => {
    const msgs: ContactSnapshot['messages'] = [{ kind: 'rapport', sentAt: D(3) }];
    const s = base({ connectSentAt: D(0), connected: true, connectedAt: D(1), messages: msgs });
    expect(planNextTouch(s, D(4))).toEqual({ kind: 'followup', dueAt: D(7) });
    msgs.push({ kind: 'followup', sentAt: D(7) });
    expect(planNextTouch({ ...s, messages: [...msgs] }, D(8))).toEqual({ kind: 'referral_ask', dueAt: D(12) });
  });

  it('messages an existing connection immediately', () => {
    expect(planNextTouch(base({ category: 'connection', variant: null }), D(0))).toEqual({
      kind: 'referral_ask',
      dueAt: D(0),
    });
  });

  it('stops after the feedback message', () => {
    const msgs = ['rapport', 'followup', 'referral_ask', 'followup', 'feedback'].map((kind, i) => ({
      kind: kind as 'rapport',
      sentAt: D(i),
    }));
    const s = base({ connectSentAt: D(0), connected: true, connectedAt: D(1), messages: msgs });
    expect(planNextTouch(s, D(60))).toBeNull();
  });

  it('stops on a reply, a pause, or an active cooldown', () => {
    const s = base({ connectSentAt: D(0), connected: true, connectedAt: D(1) });
    expect(planNextTouch({ ...s, replied: true }, D(10))).toBeNull();
    expect(planNextTouch({ ...s, pausedReason: 'company_positive_reply' }, D(10))).toBeNull();
    expect(planNextTouch({ ...s, cooldownUntil: D(80) }, D(10))).toBeNull();
  });

  it('starts a fresh cycle after a cooldown ends (snapshot has no touches)', () => {
    expect(planNextTouch(base({ cooldownUntil: D(80) }), D(81))).toEqual({ kind: 'connect', dueAt: D(81) });
  });
});

describe('cooldownUntil', () => {
  it('uses 75 days for ignored and not_now, 120 for an explicit stop', () => {
    expect(cooldownUntil('ignored', D(0))).toEqual(D(75));
    expect(cooldownUntil('not_now', D(0))).toEqual(D(75));
    expect(cooldownUntil('explicit_stop', D(0))).toEqual(D(120));
  });
  it('honours user-supplied cooldown days', () => {
    expect(cooldownUntil('ignored', D(0), { ignored: 10, not_now: 20, explicit_stop: 30 })).toEqual(D(10));
  });
});

describe('planNextTouch with custom gaps', () => {
  it('uses the supplied gaps instead of the defaults', () => {
    const s = base({ connectSentAt: D(0), connected: true, connectedAt: D(1) });
    expect(planNextTouch(s, D(1), [1, 1, 1, 1, 1])).toEqual({ kind: 'rapport', dueAt: D(2) });
  });
});
