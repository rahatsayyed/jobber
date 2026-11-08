import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadAnswerBook, type AnswerBook, type AnswerValue } from '../src/apply/answers.js';
import { classifyIntent, companyFromQuestion, ownerCountry, placesInQuestion } from '../src/apply/intents.js';
import { extractFormModel } from '../src/webcore/formModel.js';

// Synthetic owner: about 3.6 years of work ending "now", based in Pune, India. Nothing here is a real person.
function monthStr(back: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - back);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function bookFor(opts: { resume?: Record<string, unknown>; answers?: Record<string, unknown> } = {}): AnswerBook {
  const dir = mkdtempSync(path.join(tmpdir(), 'intents-'));
  const resume = opts.resume ?? {
    name: 'Test Person', email: 'test.person@example.com', location: 'Pune, India',
    experience: [
      { title: 'Engineer', company: 'Acme Technologies Pvt Ltd', start: monthStr(43), end: monthStr(20) },
      { title: 'Engineer', company: 'Globex Inc.', start: monthStr(19), end: null },
    ],
  };
  writeFileSync(path.join(dir, 'resume.json'), JSON.stringify(resume));
  writeFileSync(path.join(dir, 'answers.json'), JSON.stringify(opts.answers ?? { authorized_to_work: true }));
  return loadAnswerBook({ answersPath: path.join(dir, 'answers.json'), profilePath: path.join(dir, 'resume.json') });
}

const YN = ['Yes', 'No'];
function ask(b: AnswerBook, q: string, options?: string[], company?: string | null): AnswerValue | null {
  const s = b.suggest(q);
  if (!s.ref) return null;
  const ctx = { question: q, options, company };
  return b.has(s.ref, ctx) ? b.resolve(s.ref, ctx) : null;
}

describe('intent classes: years of experience threshold', () => {
  const b = bookFor();
  it('answers Yes/No from the resume months, several phrasings', () => {
    expect(ask(b, 'Do you have over 3 years over professional software engineering experience?*', YN)).toBe('Yes');
    expect(ask(b, 'Do you have more than 3 years of professional experience?', YN)).toBe('Yes');
    expect(ask(b, 'Do you have at least 3 years of work experience?', YN)).toBe('Yes');
    expect(ask(b, 'Do you have 3+ years of experience in software development?', YN)).toBe('Yes');
    expect(ask(b, 'Do you have 3 years or more of relevant experience?', YN)).toBe('Yes');
    expect(ask(b, 'Do you have over 5 years of professional experience?', YN)).toBe('No');
    expect(ask(b, 'Do you have at least 4 years of experience?', YN)).toBe('No');
    expect(ask(b, 'kya aapke paas 2 saal se zyada ka experience hai?', YN)).toBe('Yes');
  });
  it('returns a boolean when the page lists no options', () => {
    expect(ask(b, 'Do you have more than 3 years of professional experience?')).toBe(true);
  });
  it('a skill-specific threshold stays parked', () => {
    expect(ask(b, 'Do you have over 3 years of experience with Kubernetes?', YN)).toBeNull();
    expect(ask(b, 'Do you have 3+ years of React experience?', YN)).toBeNull();
  });
  it('no experience data means no guess', () => {
    const empty = bookFor({ resume: { name: 'Test Person', location: 'Pune, India' }, answers: {} });
    expect(ask(empty, 'Do you have over 3 years of professional experience?', YN)).toBeNull();
  });
  it('an owner integer number that equals the threshold is ambiguous for "over"', () => {
    const owner = bookFor({ resume: { name: 'T P', location: 'Pune, India' }, answers: { years_experience: 3 } });
    expect(ask(owner, 'Do you have over 3 years of experience?', YN)).toBeNull();
    expect(ask(owner, 'Do you have at least 3 years of experience?', YN)).toBe('Yes');
    expect(ask(owner, 'Do you have over 2 years of experience?', YN)).toBe('Yes');
    expect(ask(owner, 'Do you have at least 5 years of experience?', YN)).toBe('No');
  });
  it('no clean Yes/No option means the answer is not given', () => {
    expect(ask(b, 'Do you have over 3 years of professional experience?', ['Maybe', 'Unsure'])).toBeNull();
  });
});

describe('intent classes: visa and sponsorship', () => {
  it('an India-based owner needs no sponsorship in the current location', () => {
    const b = bookFor();
    expect(ask(b, 'Will you now or in the future require sponsorship for a visa to remain in your current location?*', YN)).toBe('No');
    expect(ask(b, 'Do you require visa sponsorship to stay in your current country?', YN)).toBe('No');
    expect(ask(b, 'Will you need a visa to continue working in your current location?', YN)).toBe('No');
  });
  it('a named foreign place is not derived without an owner answer', () => {
    const b = bookFor();
    expect(ask(b, 'Do you require visa sponsorship to work in the US?', YN)).toBeNull();
  });
  it('the owner answer file decides when present, including the india/other split', () => {
    const b = bookFor({ answers: { requires_sponsorship: { india: false, other: true } } });
    expect(ask(b, 'Do you require sponsorship to work in the United States?', YN)).toBe('Yes');
    expect(ask(b, 'Do you require sponsorship to work in India?', YN)).toBe('No');
  });
  it('negated wording and "hold a visa" are never answered as sponsorship', () => {
    const b = bookFor();
    expect(ask(b, 'Can you work here without requiring sponsorship in your current location?', YN)).toBeNull();
    expect(classifyIntent('Do you hold a valid work visa?')).toBeNull();
  });
});

describe('intent classes: country, city and region of residence', () => {
  const b = bookFor();
  it('country of residence as text and as a select', () => {
    expect(ask(b, 'What is your current country of residence?*')).toBe('India');
    expect(ask(b, 'Which country do you live in?')).toBe('India');
    expect(ask(b, 'Country of residence', ['United States', 'India', 'Canada'])).toBe('India');
  });
  it('a country select without the country is not guessed', () => {
    expect(ask(b, 'What is your current country of residence?', ['United States', 'Canada'])).toBeNull();
  });
  it('city', () => {
    expect(ask(b, 'Which city do you live in?')).toBe('Pune');
    expect(ask(b, 'What city are you currently based in?')).toBe('Pune');
  });
  it('lives in a region list: Yes/No by country', () => {
    expect(ask(b, 'This role is open to candidates in the US or Canada. Do you currently live in this location?*', YN)).toBe('No');
    expect(ask(b, 'Are you currently located in India or the UK?', YN)).toBe('Yes');
    expect(ask(b, 'Do you currently reside in Europe?', YN)).toBe('No');
    expect(ask(b, 'Are you based in APAC?', YN)).toBe('Yes');
    expect(ask(b, 'Are you located in the EU or North America?', YN)).toBe('No');
  });
  it('relocation wording and unknown places stay out of this class', () => {
    expect(classifyIntent('Are you based in the US or willing to relocate?')).not.toBe('region_residence');
    expect(ask(b, 'Do you live in Springfield?', YN)).toBeNull();
  });
  it('no location fact means no answer', () => {
    const none = bookFor({ resume: { name: 'T P', experience: [] }, answers: {} });
    expect(ask(none, 'What is your current country of residence?')).toBeNull();
    expect(ask(none, 'Do you currently live in the US or Canada?', YN)).toBeNull();
  });
  it('helpers', () => {
    expect(ownerCountry('Pune, India')).toBe('india');
    expect(ownerCountry('Bengaluru')).toBe('india');
    expect(ownerCountry('Somewhere')).toBeNull();
    expect([...placesInQuestion('open to the US or Canada').countries].sort()).toEqual(['canada', 'united states']);
    expect(placesInQuestion('tell us about it').found).toBe(false);
  });
});

describe('intent classes: previously worked at a company', () => {
  const b = bookFor();
  it('No unless the company is an employer in the resume', () => {
    expect(ask(b, 'Have you previously worked at or consulted for GitLab?*', YN)).toBe('No');
    expect(ask(b, 'Have you ever been employed by Initech?', YN)).toBe('No');
  });
  it('Yes when it matches an employer, ignoring legal suffixes', () => {
    expect(ask(b, 'Have you previously worked at Globex?', YN)).toBe('Yes');
    expect(ask(b, 'Have you worked for Acme Technologies before?', YN)).toBe('Yes');
    expect(ask(b, 'Did you ever work at Acme?', YN)).toBe('Yes');
  });
  it('"this company" wording uses the job company', () => {
    expect(ask(b, 'Have you previously worked for us?', YN, 'Globex Inc')).toBe('Yes');
    expect(ask(b, 'Have you previously worked for us?', YN, 'Hooli')).toBe('No');
    expect(ask(b, 'Have you previously worked for us?', YN, null)).toBeNull();
  });
  it('questions about relatives or friends are not this class; an empty history is not guessed', () => {
    expect(classifyIntent('Has a family member worked at GitLab?')).not.toBe('prior_employer');
    const noHist = bookFor({ resume: { name: 'T P', location: 'Pune, India', experience: [] }, answers: {} });
    expect(ask(noHist, 'Have you previously worked at GitLab?', YN)).toBeNull();
  });
  it('company extraction', () => {
    expect(companyFromQuestion('Have you previously worked at or consulted for GitLab?')).toBe('GitLab');
    expect(companyFromQuestion('Have you ever worked for Acme Corp?')).toBe('Acme Corp');
  });
});

describe('not derivable questions stay parked', () => {
  const b = bookFor();
  const parked = [
    'Rate your React skills from 0 to 5',
    'What is the split of your time between backend and frontend work?',
    'Are you subject to an employment agreement or post-employment restriction?',
    'What is your expected salary per month?',
    'Why do you want to work at GitLab?',
  ];
  for (const q of parked) {
    it(`parks: ${q}`, () => {
      const s = b.suggest(q);
      const v = s.ref ? ask(b, q, YN) : null;
      expect(v).toBeNull();
    });
  }
});

describe('intent refs in the typed tool schema', () => {
  it('accepts intent:<name> refs and nothing wider', async () => {
    const { RefSchema } = await import('../src/applier/refs.js');
    expect(RefSchema.safeParse({ kind: 'answer', key: 'intent:visa_sponsorship' }).success).toBe(true);
    expect(RefSchema.safeParse({ kind: 'answer', key: 'intent:a/b' }).success).toBe(false);
  });
});

describe('form roles for id-like and placeholder labels', () => {
  const field = (label: string, name: string, extra: Record<string, unknown> = {}) => extractFormModel({
    url: 'https://boards.greenhouse.io/x/jobs/1',
    fields: [{ type: 'text', name, label, required: true, filled: false, hidden: false, ...extra }],
    controls: [], notices: [],
  } as never).fields[0].role;
  it('id-like labels become the right role', () => {
    expect(field('your-fullname', 'your-fullname')).toBe('name.full');
    expect(field('full_name', 'full_name')).toBe('name.full');
    expect(field('fullName', 'fullName')).toBe('name.full');
    expect(field('first-name', 'first-name')).toBe('name.first');
    expect(field('Enter your City', 'city')).toBe('location');
  });
  it('a placeholder-looking label on a name field is the full name', () => {
    expect(field('Sarah Johnson', 'name')).toBe('name.full');
    expect(field('Sarah Johnson', 'applicant_fullname')).toBe('name.full');
  });
  it('a person-looking label on a non-name field is not', () => {
    expect(field('Sarah Johnson', 'company')).not.toBe('name.full');
    expect(field('Sarah Johnson', 'referrer_email_x')).not.toBe('name.full');
  });
});
