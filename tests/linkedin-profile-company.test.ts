import { describe, it, expect } from 'vitest';
import {
  companyFromHeadline, currentEmployerFromExperience, experienceLinesFromBody, profileCompany, profileCompanyFromSnapshot, sameCompany,
} from '../src/linkedin/profileCompany.js';
import type { RawSnapshot } from '../src/linkedin/types.js';

const EXP_TITLE_FIRST = ['Senior Recruiter', 'Acme Corp · Full-time', 'Jan 2022 - Present · 3 yrs 9 mos', 'Bengaluru, India'];
const EXP_COMPANY_FIRST = ['Acme Corp', 'Full-time · 5 yrs', 'Senior Recruiter', 'Jan 2022 - Present · 3 yrs 9 mos'];

describe('companyFromHeadline', () => {
  it('reads "<role> at <company>" and stops at separators', () => {
    expect(companyFromHeadline('Senior Recruiter at Acme Corp | Hiring React Developers')).toBe('Acme Corp');
    expect(companyFromHeadline('Talent Acquisition @ Globex, Bengaluru')).toBe('Globex');
    expect(companyFromHeadline('Engineering Manager at Booking.com')).toBe('Booking.com');
    expect(companyFromHeadline('CTO | Founder at Initech • Mentor')).toBe('Initech');
  });
  it('returns empty for headlines that name no employer', () => {
    expect(companyFromHeadline('Helping startups hire great people')).toBe('');
    expect(companyFromHeadline('Open to work')).toBe('');
    expect(companyFromHeadline('Developer at Stealth Startup')).toBe('');
    expect(companyFromHeadline('Consultant at Self-employed')).toBe('');
    expect(companyFromHeadline('Hiring at https://evil.example/x')).toBe('');
    expect(companyFromHeadline('')).toBe('');
  });
});

describe('currentEmployerFromExperience', () => {
  it('reads the company of a title-first entry', () => {
    expect(currentEmployerFromExperience(EXP_TITLE_FIRST)).toBe('Acme Corp');
  });
  it('reads the company of a company-first (grouped roles) entry', () => {
    expect(currentEmployerFromExperience(EXP_COMPANY_FIRST)).toBe('Acme Corp');
  });
  it('ignores a first entry that has ended', () => {
    expect(currentEmployerFromExperience(['Engineer', 'Initech · Full-time', 'Mar 2018 - Jun 2020 · 2 yrs 3 mos'])).toBe('');
  });
  it('returns empty on empty or unreadable input', () => {
    expect(currentEmployerFromExperience([])).toBe('');
    expect(currentEmployerFromExperience(['Show all 5 experiences'])).toBe('');
  });
});

describe('experienceLinesFromBody', () => {
  it('takes the first entry after the Experience heading up to the next section', () => {
    const body = ['Jane Doe', 'About', 'I like hiring', 'Experience', ...EXP_TITLE_FIRST, 'Engineer', 'Initech · Full-time', '2018 - 2020', 'Education', 'MIT'].join('\n');
    const lines = experienceLinesFromBody(body);
    expect(lines.slice(0, 3)).toEqual(['Senior Recruiter', 'Acme Corp · Full-time', 'Jan 2022 - Present · 3 yrs 9 mos']);
    expect(lines).not.toContain('MIT');
  });
  it('is empty without an Experience heading', () => {
    expect(experienceLinesFromBody('Jane\nAbout\nhi')).toEqual([]);
  });
});

describe('sameCompany', () => {
  it('compares ignoring case, legal suffixes and punctuation', () => {
    expect(sameCompany('Acme Corp', 'ACME')).toBe(true);
    expect(sameCompany('Acme Pvt Ltd', 'acme')).toBe(true);
    expect(sameCompany('Acme', 'Globex')).toBe(false);
    expect(sameCompany('', 'Acme')).toBe(false);
  });
});

describe('profileCompany', () => {
  it('headline names the employer: high', () => {
    expect(profileCompany({ headline: 'Senior Recruiter at Acme Corp' })).toEqual({ company: 'Acme Corp', confidence: 'high', source: 'headline' });
  });
  it('experience alone is low', () => {
    expect(profileCompany({ headline: 'Hiring manager', experience: EXP_TITLE_FIRST })).toEqual({ company: 'Acme Corp', confidence: 'low', source: 'experience' });
  });
  it('experience that agrees with the post company is high', () => {
    expect(profileCompany({ headline: '', experience: EXP_COMPANY_FIRST, postCompany: 'Acme' })).toEqual({ company: 'Acme Corp', confidence: 'high', source: 'post+profile' });
  });
  it('headline and experience agree: high', () => {
    expect(profileCompany({ headline: 'Recruiter at Acme', experience: EXP_TITLE_FIRST })?.confidence).toBe('high');
  });
  it('headline that agrees with the post company is high', () => {
    expect(profileCompany({ headline: 'Recruiter at Acme Corp', postCompany: 'Acme' })).toMatchObject({ confidence: 'high', source: 'post+profile' });
  });
  it('disagreement between the post and the profile is low and flagged as conflict', () => {
    expect(profileCompany({ headline: 'Recruiter at Acme Corp', postCompany: 'Globex' })).toEqual({ company: 'Acme Corp', confidence: 'low', source: 'conflict' });
    expect(profileCompany({ headline: '', experience: EXP_TITLE_FIRST, postCompany: 'Globex' })).toMatchObject({ confidence: 'low', source: 'conflict' });
  });
  it('headline and experience that disagree are low', () => {
    expect(profileCompany({ headline: 'Recruiter at Globex', experience: EXP_TITLE_FIRST })).toEqual({ company: 'Globex', confidence: 'low', source: 'conflict' });
  });
  it('nothing usable returns null', () => {
    expect(profileCompany({})).toBeNull();
    expect(profileCompany({ headline: 'Open to work', experience: [] })).toBeNull();
    expect(profileCompany({ headline: '', experience: 'Show all 5 experiences' })).toBeNull();
  });
  it('accepts experience as a newline string', () => {
    expect(profileCompany({ experience: EXP_TITLE_FIRST.join('\n') })?.company).toBe('Acme Corp');
  });
});

describe('profileCompanyFromSnapshot', () => {
  const snap = (headline: string, bodyText: string): RawSnapshot => ({
    url: 'https://www.linkedin.com/in/jane/', title: 'Jane', results: [], invitations: [], messages: [], messageHeaderName: null, notices: [],
    dialogText: null, hasPasswordInput: false, bodyText,
    profile: { name: 'Jane Doe', headline, degree: '2nd', location: '', about: null, actions: ['Connect'], pending: false, hasBell: false, hasMessageButton: false },
  });
  it('uses the parsed headline and the Experience section of the body', () => {
    const r = profileCompanyFromSnapshot(snap('Hiring lead', ['Jane Doe', 'Experience', ...EXP_TITLE_FIRST].join('\n')), 'Acme');
    expect(r).toEqual({ company: 'Acme Corp', confidence: 'high', source: 'post+profile' });
  });
  it('is null for a page that is not a profile', () => {
    expect(profileCompanyFromSnapshot({ ...snap('x', ''), profile: null })).toBeNull();
  });
});
