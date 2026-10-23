// tests/status-render.test.ts
import { describe, expect, it } from 'vitest';
import { renderHealth, renderLimits, renderWorking } from '../src/status/render.js';
import type { Snapshot } from '../src/status/snapshot.js';

const base: Snapshot = {
  generatedAt: '2026-10-14T10:00:00.000Z',
  ceilings: {
    linkedin_invite: { used: 12, limit: 100, ok: true },
    linkedin_message: { used: 3, limit: 50, ok: true },
    naukri_apply: { used: 20, limit: 20, ok: false },
    naukri_message: { used: 0, limit: 10, ok: true },
    wellfound_apply: { used: 0, limit: 20, ok: true },
    wellfound_message: { used: 0, limit: 20, ok: true },
    wellfound_discover: { used: 0, limit: 12, ok: true },
    apply_attempt: { used: 0, limit: 30, ok: true },
    site_account: { used: 0, limit: 2, ok: true },
    linkedin_discover: { used: 0, limit: 12, ok: true },
  },
  dailyCounters: [{ key: 'send_email', count: 1 }],
  halts: [],
  queue: [
    { status: 'queued', count: 4 },
    { status: 'sent', count: 2 },
  ],
  funnel: { discovered: 50, matched: 10, contacted: 5, replied: 2, interview: 1, offer: 0 },
  lastSend: { kind: 'email', at: '2026-10-14T10:00:00.000Z' },
  degraded: [],
};

const empty: Snapshot = {
  ...base,
  ceilings: {
    linkedin_invite: { used: 0, limit: 100, ok: true },
    linkedin_message: { used: 0, limit: 50, ok: true },
    naukri_apply: { used: 0, limit: 20, ok: true },
    naukri_message: { used: 0, limit: 10, ok: true },
    wellfound_apply: { used: 0, limit: 20, ok: true },
    wellfound_message: { used: 0, limit: 20, ok: true },
    wellfound_discover: { used: 0, limit: 12, ok: true },
    apply_attempt: { used: 0, limit: 30, ok: true },
    site_account: { used: 0, limit: 2, ok: true },
    linkedin_discover: { used: 0, limit: 12, ok: true },
  },
  dailyCounters: [],
  queue: [],
  funnel: { discovered: 0, matched: 0, contacted: 0, replied: 0, interview: 0, offer: 0 },
  lastSend: null,
};

const halted: Snapshot = {
  ...base,
  halts: [{ platform: 'linkedin', reason: 'captcha', setAt: '2026-10-14T09:00:00.000Z' }],
  degraded: ['queue', 'funnel'],
};

describe('renderLimits', () => {
  it('lists ceilings, counters and no halts', () => {
    expect(renderLimits(base)).toBe(
      [
        'linkedin_invite 12/100 per week',
        'linkedin_message 3/50 per week',
        'naukri_apply 20/20 per day FULL',
        'naukri_message 0/10 per day',
        'wellfound_apply 0/20 per day',
        'wellfound_message 0/20 per day',
        'wellfound_discover 0/12 per day',
        'apply_attempt 0/30 per day',
        'site_account 0/2 per day',
        'linkedin_discover 0/12 per day',
        'send_email 1 today',
        'no halts',
      ].join('\n'),
    );
  });
  it('shows halts and degraded', () => {
    const out = renderLimits(halted).split('\n');
    expect(out).toContain('HALT linkedin: captcha (since 2026-10-14 14:30 IST)');
    expect(out[out.length - 1]).toBe('degraded: queue, funnel');
    expect(out).not.toContain('no halts');
  });
});

describe('renderWorking', () => {
  it('renders queue, last send IST and funnel', () => {
    expect(renderWorking(base)).toBe(
      [
        'queue queued: 4',
        'queue sent: 2',
        'last send: email 2026-10-14 15:30 IST',
        'discovered 50 -> matched 10 -> contacted 5 -> replied 2 -> interview 1 -> offer 0',
      ].join('\n'),
    );
  });
  it('renders the empty case', () => {
    expect(renderWorking(empty)).toBe(
      [
        'queue: empty',
        'no sends yet',
        'discovered 0 -> matched 0 -> contacted 0 -> replied 0 -> interview 0 -> offer 0',
      ].join('\n'),
    );
  });
  it('surfaces degraded', () => {
    expect(renderWorking(halted).split('\n').pop()).toBe('degraded: queue, funnel');
  });
});

describe('renderHealth', () => {
  it('renders windows, halts and doctor line', () => {
    expect(
      renderHealth(base, [
        { name: 'main', command: 'claude', active: true },
        { name: 'web', command: 'node', active: false },
      ]),
    ).toBe(['window main: claude (active)', 'window web: node', 'no halts', 'doctor: run npm run doctor'].join('\n'));
  });
  it('handles no windows and halts', () => {
    expect(renderHealth(halted, [])).toBe(
      [
        'tmux: no windows',
        'HALT linkedin: captcha (since 2026-10-14 14:30 IST)',
        'degraded: queue, funnel',
        'doctor: run npm run doctor',
      ].join('\n'),
    );
  });
});
