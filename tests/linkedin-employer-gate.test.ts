// Finding 20: people quality enforced in code. Category from the headline, employer match stored at
// registration, and a typed send gate that refuses before any ceiling or touch is consumed.
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { upsertPerson } from '../src/outreach/people.js';
import { DEFAULT_STYLE_CONFIG } from '../src/safety/styleGate.js';
import { profileKeyOf } from '../src/linkedin/urls.js';
import { loadLinkedinConfig } from '../src/linkedin/config.js';
import { preSendGuard, type GuardInput } from '../src/linkedin/guard.js';
import { classifyCategory, headlineMatchesCompany } from '../src/linkedin/employer.js';

const URL1 = 'https://www.linkedin.com/in/jane-doe';
const OK_TIME = new Date('2026-10-14T06:00:00Z');
let db: ReturnType<typeof openDb>;

function add(o: { headline?: string; company?: string; employerMatch?: number | null }): number {
  return upsertPerson(db, {
    platform: 'linkedin', profileKey: profileKeyOf(URL1), name: 'Jane Doe',
    headline: o.headline, company: o.company ?? 'Lemon.io', category: 'peer', employerMatch: o.employerMatch,
  });
}
function input(over: Partial<GuardInput> = {}): GuardInput {
  return {
    db, now: OK_TIME, env: {}, action: 'invite', kind: 'connect', profileUrl: URL1,
    text: 'Hi Jane, I saw the platform team is hiring and would like to connect.',
    factCheck: (t) => ({ verdict: 'pass' as const, normalized_text: t }), styleCfg: DEFAULT_STYLE_CONFIG,
    cfg: loadLinkedinConfig({ JOBBER_DRY_RUN: 'false' }), ...over,
  };
}
const touches = () => (db.prepare('SELECT COUNT(*) AS n FROM touches').get() as { n: number }).n;

beforeEach(() => { db = openDb(':memory:'); });

describe('classifyCategory', () => {
  it('recruiter terms give recruiter', () => {
    for (const h of ['Technical Recruiter at Lemon.io', 'Talent Acquisition Partner', 'Head of People Operations', 'HR Business Partner', 'Sourcer | Talent']) {
      expect(classifyCategory(h, 'peer')).toBe('recruiter');
    }
  });
  it('an engineer or developer headline is never recruiter, even when recruiter was requested', () => {
    for (const h of ['Senior Software Engineer at Lemon.io', 'Full Stack Developer', 'Staff Engineer at Cobalt', 'Frontend Engineer, React']) {
      expect(classifyCategory(h, 'recruiter')).toBe('peer');
    }
  });
  it('managers and heads of engineering are hiring managers', () => {
    expect(classifyCategory('Engineering Manager at Acme', 'peer')).toBe('hiring_manager');
  });
  it('unknown or empty headline never keeps a requested recruiter', () => {
    expect(classifyCategory('', 'recruiter')).toBe('peer');
    expect(classifyCategory('Dreamer and builder', 'recruiter')).toBe('peer');
    expect(classifyCategory('Dreamer and builder', 'peer')).toBe('peer');
  });
});

describe('headlineMatchesCompany', () => {
  it('matches the company token in the headline, case and punctuation insensitive', () => {
    expect(headlineMatchesCompany('Technical Recruiter at Lemon.io', 'Lemon.io')).toBe(true);
    expect(headlineMatchesCompany('Talent Partner | LEMON', 'Lemon.io Inc.')).toBe(true);
    expect(headlineMatchesCompany('Engineering Manager at Acme Robotics', 'Acme')).toBe(true);
  });
  it('another employer is a mismatch, an empty headline is unknown', () => {
    expect(headlineMatchesCompany('Talent Partner at Borealis Labs', 'Lemon.io')).toBe(false);
    expect(headlineMatchesCompany('', 'Lemon.io')).toBeNull();
    expect(headlineMatchesCompany('Recruiter at Acme', '')).toBeNull();
  });
});

describe('registration stores the match', () => {
  it('employer_match is 1, 0 or null from the headline', () => {
    add({ headline: 'Recruiter at Lemon.io' });
    const get = () => (db.prepare('SELECT employer_match AS m FROM people').get() as { m: number | null }).m;
    expect(get()).toBe(1);
    add({ headline: 'Recruiter at Borealis' });
    expect(get()).toBe(0);
  });
});

describe('typed send gate', () => {
  it('headline naming another employer is refused as employer_mismatch, nothing reserved', () => {
    add({ headline: 'Talent Partner at Borealis Labs' });
    expect(preSendGuard(input())).toMatchObject({ ok: false, status: 'refused', code: 'employer_mismatch' });
    expect(touches()).toBe(0);
  });
  it('no headline and no stored match is employer_unverified', () => {
    add({});
    expect(preSendGuard(input())).toMatchObject({ ok: false, status: 'refused', code: 'employer_unverified' });
    expect(touches()).toBe(0);
  });
  it('a matching headline passes', () => {
    add({ headline: 'Technical Recruiter at Lemon.io' });
    expect(preSendGuard(input())).toMatchObject({ ok: true });
  });
  it('a stored employer match passes even without a headline', () => {
    add({ employerMatch: 1 });
    expect(preSendGuard(input())).toMatchObject({ ok: true });
  });
  it('dry run still runs the check', () => {
    add({ headline: 'Talent Partner at Borealis Labs' });
    expect(preSendGuard(input({ cfg: loadLinkedinConfig({}) }))).toMatchObject({ ok: false, code: 'employer_mismatch' });
    expect(preSendGuard(input({ callDryRun: true }))).toMatchObject({ ok: false, code: 'employer_mismatch' });
  });
  it('messages are gated the same way', () => {
    add({ headline: 'Talent Partner at Borealis Labs' });
    expect(preSendGuard(input({ action: 'message', kind: 'rapport' }))).toMatchObject({ ok: false, code: 'employer_mismatch' });
  });
});
