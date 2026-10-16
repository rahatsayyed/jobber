import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadAnswerBook, resolveAnswer, QUESTION_PATTERNS, type EasyApplyAnswers } from '../src/apply/answers.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'web');
const book = () => loadAnswerBook({ answersPath: path.join(dir, 'answers.json'), profilePath: path.join(dir, 'resume.json') });

const answers: EasyApplyAnswers = {
  years_experience: 5,
  authorized_to_work: true,
  requires_sponsorship: false,
  willing_to_relocate: true,
  notice_period_days: 30,
  expected_salary: '25 LPA',
  phone: '+91-9999999999',
  linkedin_profile_url: 'https://linkedin.com/in/example',
};

describe('answer book', () => {
  it('fixed keys resolve from the fixture', () => {
    const b = book();
    expect(b.resolve({ kind: 'answer', key: 'years_experience' }, {})).toBe(5);
    expect(b.resolve({ kind: 'answer', key: 'notice_period_days' }, {})).toBe(30);
    expect(b.resolve({ kind: 'profile', field: 'email' }, {})).toBe('jane.fixture@example.com');
    expect(b.resolve({ kind: 'profile', field: 'name.first' }, {})).toBe('Jane');
    expect(b.resolve({ kind: 'profile', field: 'name.last' }, {})).toBe('Fixture');
    expect(b.resolve({ kind: 'profile', field: 'name.full' }, {})).toBe('Jane Q Fixture');
    expect(b.resolve({ kind: 'profile', field: 'location' }, {})).toBe('Fixture City');
    expect(b.resolve({ kind: 'profile', field: 'linkedin_url' }, {})).toBe('https://linkedin.com/in/fixture-person');
    expect(b.has({ kind: 'answer', key: 'years_experience' })).toBe(true);
  });

  it('custom keys match the question verbatim ignoring case, whitespace and a trailing star', () => {
    const b = book();
    const s = b.suggest('  what is your CURRENT ctc?* ');
    expect(s.cls).toBe('custom');
    expect(s.ref).toEqual({ kind: 'answer', key: 'custom:What is your current CTC?' });
    expect(b.resolve(s.ref!, {})).toBe('18 LPA');
  });

  it('object-form sponsorship resolves india, other, and null when location is empty', () => {
    const b = book();
    const ref = { kind: 'answer', key: 'requires_sponsorship' } as const;
    expect(b.resolve(ref, { jobLocation: 'Pune, India' })).toBe(false);
    expect(b.resolve(ref, { jobLocation: 'Dubai, UAE' })).toBe(true);
    expect(b.resolve(ref, { jobLocation: '' })).toBeNull();
    expect(b.resolve(ref, {})).toBeNull();
    expect(b.resolve(ref, { jobLocation: 'India or Dubai' })).toBeNull();
  });

  it('multi-location sponsorship with any non-India segment is null', () => {
    const ref = { kind: 'answer', key: 'requires_sponsorship' } as const;
    const b = book();
    for (const l of ['Bangalore, India; Dubai, UAE', 'India, UAE', 'Pune, India, Remote EMEA', 'India / UAE', 'Pune, India; Dubai']) {
      expect(b.resolve(ref, { jobLocation: l })).toBeNull();
    }
    expect(b.resolve(ref, { jobLocation: 'Pune, India; Mumbai, India' })).toBe(false);
    expect(b.resolve(ref, { jobLocation: 'Dubai; Riyadh' })).toBe(true);
  });

  it('empty-string answers are missing', () => {
    const ap = path.join(mkdtempSync(path.join(tmpdir(), 'ab-')), 'a.json');
    writeFileSync(ap, JSON.stringify({ expected_salary: '', custom: { 'Q?': '' } }));
    const b = loadAnswerBook({ answersPath: ap, profilePath: path.join(dir, 'resume.json') });
    expect(b.has({ kind: 'answer', key: 'expected_salary' })).toBe(false);
    expect(b.resolve({ kind: 'answer', key: 'expected_salary' }, {})).toBeNull();
    expect(b.has({ kind: 'answer', key: 'custom:Q?' })).toBe(false);
  });

  it('attestation inside a known pattern is not resolved', () => {
    const s = book().suggest('I certify I have the right to work and am authorized to work here');
    expect(s).toEqual({ ref: null, cls: 'legal_attestation' });
  });

  it('missing answer returns null', () => {
    const b = book();
    expect(b.resolve({ kind: 'answer', key: 'custom:nope' }, {})).toBeNull();
    expect(b.has({ kind: 'answer', key: 'custom:nope' })).toBe(false);
    expect(b.suggest('What is your favorite color?')).toEqual({ ref: null, cls: 'unknown' });
  });

  it('consent and attestation never resolve', () => {
    const b = book();
    const c = b.suggest('I agree to the privacy policy and consent to processing');
    expect(c.cls).toBe('consent');
    expect(c.ref).toBeNull();
    const l = b.suggest('I certify that the information is true and accurate');
    expect(l.cls).toBe('legal_attestation');
    expect(l.ref).toBeNull();
    const f = b.suggest('Why do you want to work here? Tell us about yourself.');
    expect(f.cls).toBe('free_text');
    expect(f.ref).toBeNull();
  });

  it('salary resolves only to expected_salary', () => {
    const b = book();
    const s = b.suggest('What are your salary expectations?');
    expect(s).toEqual({ ref: { kind: 'answer', key: 'expected_salary' }, cls: 'known' });
    expect(b.resolve(s.ref!, {})).toBe('25 LPA');
    expect(b.suggest('What is your current salary?').ref).toBeNull();
  });

  it('resolve never writes a value to console', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const b = book();
    b.resolve({ kind: 'answer', key: 'expected_salary' }, {});
    b.resolve({ kind: 'profile', field: 'email' }, {});
    b.suggest('Mobile phone number');
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
  });

  it('resume_pdf and cover_letter refs are not answer-book values', () => {
    const b = book();
    expect(b.has({ kind: 'resume_pdf' })).toBe(false);
    expect(b.resolve({ kind: 'cover_letter' }, {})).toBeNull();
  });

  it('missing files yield an empty book', () => {
    const b = loadAnswerBook({ answersPath: path.join(dir, 'nope.json'), profilePath: path.join(dir, 'nope2.json') });
    expect(b.resolve({ kind: 'answer', key: 'years_experience' }, {})).toBeNull();
    expect(b.resolve({ kind: 'profile', field: 'email' }, {})).toBeNull();
  });
});

describe('QUESTION_PATTERNS port matches the legacy table', () => {
  it('has the same patterns and keys', () => {
    expect(QUESTION_PATTERNS.map((p) => p.key)).toEqual([
      'years_experience', 'authorized_to_work', 'requires_sponsorship', 'willing_to_relocate',
      'notice_period_days', 'expected_salary', 'expected_salary', 'phone', 'linkedin_profile_url',
    ]);
  });
  it('resolveAnswer behaves like the legacy function', () => {
    expect(resolveAnswer('How many years of experience do you have with React?', answers)).toBe(5);
    expect(resolveAnswer('Are you legally authorized to work in this country?', answers)).toBe(true);
    expect(resolveAnswer('Will you now or in the future require sponsorship for employment visa status?', answers)).toBe(false);
    expect(resolveAnswer('Are you willing to relocate for this role?', answers)).toBe(true);
    expect(resolveAnswer('What is your current notice period (in days)?', answers)).toBe(30);
    expect(resolveAnswer('What are your salary expectations?', answers)).toBe('25 LPA');
    expect(resolveAnswer('Mobile phone number', answers)).toBe('+91-9999999999');
    expect(resolveAnswer('Please share your LinkedIn profile URL', answers)).toBe('https://linkedin.com/in/example');
    expect(resolveAnswer('What is your expected CTC?', answers)).toBe('25 LPA');
    expect(resolveAnswer('What is your current CTC?', answers)).toBeNull();
    expect(resolveAnswer('What is your favorite color?', answers)).toBeNull();
    expect(resolveAnswer('What is your current notice period?', {} as EasyApplyAnswers)).toBeNull();
    const a = { notice_period_days: 0, expected_salary: '', willing_to_relocate: false } as unknown as EasyApplyAnswers;
    expect(resolveAnswer('What is your notice period?', a)).toBe(0);
    expect(resolveAnswer('Expected salary?', a)).toBe('');
    expect(resolveAnswer('Are you willing to relocate?', a)).toBe(false);
    const withCustom: EasyApplyAnswers = { ...answers, custom: { 'What is your current CTC?': '18 LPA' } };
    expect(resolveAnswer('what is your current ctc?*', withCustom)).toBe('18 LPA');
    expect(resolveAnswer('Some other unrelated question?', withCustom)).toBeNull();
  });
});
