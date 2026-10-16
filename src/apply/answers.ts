import { existsSync, readFileSync } from 'node:fs';
import { userDataPath } from '../lib/userData.js';

// Answer book for the browser apply flow. The matching logic is COPIED from
// the removed scripted Easy Apply (deleted in Task 23). Values are only
// ever returned to the calling typed tool; nothing here logs a value.

export type AnswerValue = string | number | boolean;
export type SponsorshipByRegion = { india: boolean; other: boolean };

export interface EasyApplyAnswers {
  years_experience: number;
  authorized_to_work: boolean;
  requires_sponsorship: boolean | SponsorshipByRegion;
  willing_to_relocate: boolean;
  notice_period_days: number;
  expected_salary: string;
  phone: string;
  linkedin_profile_url: string;
  custom?: Record<string, AnswerValue>;
}

export type AnswerRef =
  | { kind: 'profile'; field: 'name.first' | 'name.last' | 'name.full' | 'email' | 'phone' | 'linkedin_url' | 'location' }
  | { kind: 'answer'; key: keyof EasyApplyAnswers | `custom:${string}` }
  | { kind: 'resume_pdf' }
  | { kind: 'cover_letter' };

export type QuestionClass = 'known' | 'custom' | 'consent' | 'legal_attestation' | 'free_text' | 'unknown';

export interface AnswerBook {
  has(ref: AnswerRef): boolean;
  resolve(ref: AnswerRef, ctx: { jobLocation?: string }): string | number | boolean | null;
  suggest(question: string): { ref: AnswerRef | null; cls: QuestionClass };
}

/** Keyword/regex patterns matched (in order) against a screening question's text. */
export const QUESTION_PATTERNS: Array<{ pattern: RegExp; key: keyof EasyApplyAnswers }> = [
  { pattern: /years?\b.{0,20}\bexperience/i, key: 'years_experience' },
  { pattern: /authoriz(e|ed|ation)\b.{0,25}\bwork/i, key: 'authorized_to_work' },
  { pattern: /sponsorship/i, key: 'requires_sponsorship' },
  { pattern: /relocat/i, key: 'willing_to_relocate' },
  { pattern: /notice period/i, key: 'notice_period_days' },
  { pattern: /salary/i, key: 'expected_salary' },
  // "expected CTC" is India-market phrasing for the same question as "expected salary".
  // Requires "expected" adjacent to "CTC" so "current CTC" falls through to null.
  { pattern: /expected.{0,15}ctc/i, key: 'expected_salary' },
  { pattern: /phone/i, key: 'phone' },
  { pattern: /linkedin.{0,15}(profile|url)/i, key: 'linkedin_profile_url' },
];

export function normalizeQuestion(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\*+$/, '').trim();
}

/** Legacy pure matcher, kept identical in behavior (object-form sponsorship needs a location, see the book). */
export function resolveAnswer(question: string, answers: EasyApplyAnswers): AnswerValue | null {
  for (const { pattern, key } of QUESTION_PATTERNS) {
    if (pattern.test(question)) {
      return (answers[key] as AnswerValue | undefined) ?? null;
    }
  }
  if (answers.custom) {
    const normalized = normalizeQuestion(question);
    for (const [key, value] of Object.entries(answers.custom)) {
      if (normalizeQuestion(key) === normalized) return value;
    }
  }
  return null;
}

/** Human-readable descriptions of the fixed answer fields (for fallback prompts). */
export const ANSWER_TOPIC_DESCRIPTIONS: Record<Exclude<keyof EasyApplyAnswers, 'custom'>, string> = {
  years_experience: 'How many years of relevant work experience the candidate has',
  authorized_to_work: "Whether the candidate is authorized to work in the job's country without sponsorship",
  requires_sponsorship: 'Whether the candidate will require visa/work sponsorship',
  willing_to_relocate: 'Whether the candidate is willing to relocate for this role',
  notice_period_days: "The candidate's notice period, in days",
  expected_salary: "The candidate's expected salary or CTC",
  phone: "The candidate's phone number",
  linkedin_profile_url: "The candidate's LinkedIn profile URL",
};

export interface KnownAnswerTopic {
  key: string;
  description: string;
  value: unknown;
}

export function buildAnswerTopics(answers: EasyApplyAnswers): KnownAnswerTopic[] {
  const topics: KnownAnswerTopic[] = (
    Object.entries(ANSWER_TOPIC_DESCRIPTIONS) as [Exclude<keyof EasyApplyAnswers, 'custom'>, string][]
  ).map(([key, description]) => ({ key, description, value: answers[key] }));
  if (answers.custom) {
    for (const [key, value] of Object.entries(answers.custom)) {
      topics.push({
        key: `custom:${key}`,
        description: `A screening question the candidate already answered verbatim: ${JSON.stringify(key)}`,
        value,
      });
    }
  }
  return topics;
}

const FIXED_KEYS = new Set<string>(Object.keys(ANSWER_TOPIC_DESCRIPTIONS));

const ATTESTATION = /\b(certify|attest|under penalty|declare|true and (accurate|correct|complete)|truthful|accurate and complete)\b/i;
const CONSENT = /\b(i agree|agree to|consent|acknowledge|privacy (policy|notice)|terms (and|&) conditions|terms of (use|service)|opt[- ]?in|subscribe|newsletter|marketing)\b/i;
const FREE_TEXT = /\b(why|tell us|describe|about yourself|cover letter|explain|in your own words|what motivates|additional information)\b/i;
const NOT_EXPECTED_SALARY = /\b(current|present|last|previous|existing)\b.{0,15}\b(salary|ctc|compensation)\b/i;

function readJson(p: string | undefined): Record<string, unknown> | null {
  if (!p || !existsSync(p)) return null;
  try {
    const v = JSON.parse(readFileSync(p, 'utf8'));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function resolveSponsorship(v: unknown, jobLocation: string | undefined): boolean | null {
  if (typeof v === 'boolean') return v;
  if (!v || typeof v !== 'object') return null;
  const o = v as { india?: unknown; other?: unknown };
  const loc = (jobLocation ?? '').trim().toLowerCase();
  if (!loc) return null;
  // Split into separate locations on ; / & and the words or/and. A location is India only
  // when its LAST comma part is India ("Pune, India"); one that mentions India elsewhere
  // ("India, UAE", "Pune, India, Remote EMEA") is ambiguous. Mixed or ambiguous -> null.
  const locs = loc.split(/[;/&]|\b(?:or|and)\b/).map((x) => x.trim()).filter(Boolean);
  const kinds = locs.map((l) => {
    const parts = l.split(',').map((x) => x.trim()).filter(Boolean);
    if (parts[parts.length - 1] === 'india') return 'india';
    return /\bindia\b/.test(l) ? 'mixed' : 'other';
  });
  if (kinds.length === 0) return null;
  if (kinds.every((k) => k === 'india')) return typeof o.india === 'boolean' ? o.india : null;
  if (kinds.every((k) => k === 'other')) return typeof o.other === 'boolean' ? o.other : null;
  return null;
}

export function loadAnswerBook(deps: { answersPath?: string; profilePath?: string } = {}): AnswerBook {
  const answersRaw = readJson(deps.answersPath ?? userDataPath('easy-apply-answers.json'));
  const profileRaw = readJson(deps.profilePath ?? userDataPath('resume.json'));
  const answers = (answersRaw ?? {}) as Partial<EasyApplyAnswers>;

  const fullName = str(profileRaw?.name);
  const parts = fullName ? fullName.split(/\s+/) : [];
  const social = profileRaw?.social as { linkedin?: { url?: unknown } } | undefined;
  const profile: Record<string, string | null> = {
    'name.full': fullName,
    'name.first': parts[0] ?? null,
    'name.last': parts.length > 1 ? parts[parts.length - 1] : null,
    email: str(profileRaw?.email),
    phone: str(profileRaw?.phone),
    linkedin_url: str(social?.linkedin?.url),
    location: str(profileRaw?.location),
  };

  const customValue = (key: string): AnswerValue | undefined => {
    const c = answers.custom;
    if (!c || !Object.prototype.hasOwnProperty.call(c, key)) return undefined;
    return c[key] === '' ? undefined : c[key];
  };

  function resolve(ref: AnswerRef, ctx: { jobLocation?: string }): AnswerValue | null {
    if (ref.kind === 'profile') return profile[ref.field] ?? null;
    if (ref.kind !== 'answer') return null;
    const key = ref.key as string;
    if (key.startsWith('custom:')) return customValue(key.slice(7)) ?? null;
    if (!FIXED_KEYS.has(key)) return null;
    if (key === 'requires_sponsorship') return resolveSponsorship(answers.requires_sponsorship, ctx.jobLocation);
    const v = (answers as Record<string, unknown>)[key];
    return v === undefined || v === null || v === '' ? null : (v as AnswerValue);
  }

  return {
    has(ref) {
      if (ref.kind === 'profile') return profile[ref.field] != null;
      if (ref.kind !== 'answer') return false;
      const key = ref.key as string;
      if (key.startsWith('custom:')) return customValue(key.slice(7)) !== undefined;
      return FIXED_KEYS.has(key) && (answers as Record<string, unknown>)[key] != null && (answers as Record<string, unknown>)[key] !== '';
    },
    resolve,
    suggest(question) {
      // Consent/attestation keywords are checked BEFORE the verbatim custom match and the
      // known patterns, so such questions fail closed and never resolve.
      if (ATTESTATION.test(question)) return { ref: null, cls: 'legal_attestation' };
      if (CONSENT.test(question)) return { ref: null, cls: 'consent' };
      if (answers.custom) {
        const n = normalizeQuestion(question);
        for (const key of Object.keys(answers.custom)) {
          if (normalizeQuestion(key) === n) return { ref: { kind: 'answer', key: `custom:${key}` }, cls: 'custom' };
        }
      }
      if (!NOT_EXPECTED_SALARY.test(question)) {
        for (const { pattern, key } of QUESTION_PATTERNS) {
          if (pattern.test(question)) return { ref: { kind: 'answer', key }, cls: 'known' };
        }
      }
      if (FREE_TEXT.test(question)) return { ref: null, cls: 'free_text' };
      return { ref: null, cls: 'unknown' };
    },
  };
}
