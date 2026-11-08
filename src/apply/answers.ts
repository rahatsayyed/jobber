import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { userDataPath } from '../lib/userData.js';
import { deriveFromResume, monthsFromExperience } from './derive.js';
import { answerIntent, classifyIntent, INTENT_NAMES, intentHasFacts, sponsorNegated, type IntentName, type OwnerFacts } from './intents.js';

const YES_NO_OPT = (v: boolean, options?: string[]): AnswerValue | null =>
  !options || options.length === 0 ? v : (options.find((o) => o.trim().toLowerCase() === (v ? 'yes' : 'no')) ?? null);

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
  /** Optional. When absent they are derived from the resume (src/apply/derive.ts) or left unanswered. */
  current_location?: string;
  skills?: string;
  custom?: Record<string, AnswerValue>;
}

export type AnswerRef =
  | { kind: 'profile'; field: 'name.first' | 'name.last' | 'name.full' | 'email' | 'phone' | 'linkedin_url' | 'location' }
  | { kind: 'answer'; key: keyof EasyApplyAnswers | `custom:${string}` | `intent:${string}` }
  | { kind: 'resume_pdf' }
  | { kind: 'cover_letter' };

export type QuestionClass = 'known' | 'custom' | 'consent' | 'legal_attestation' | 'free_text' | 'unknown';

/** Context of one question: the job's location and, for `intent:` refs, the question text, the page's listed options and the job's company. */
export interface ResolveCtx {
  jobLocation?: string;
  question?: string;
  options?: string[];
  company?: string | null;
}

export interface AnswerBook {
  /** With `ctx.question` an `intent:` ref is judged completely (the answer must be computable); without it only the facts are checked. */
  has(ref: AnswerRef, ctx?: ResolveCtx): boolean;
  resolve(ref: AnswerRef, ctx: ResolveCtx): string | number | boolean | null;
  suggest(question: string): { ref: AnswerRef | null; cls: QuestionClass };
}

/** Keyword/regex patterns matched (in order) against a screening question's text. */
export const QUESTION_PATTERNS: Array<{ pattern: RegExp; key: keyof EasyApplyAnswers }> = [
  { pattern: /\byears? of exp\b|\byrs? of exp\b|\btotal (exp|experience)\b/i, key: 'years_experience' },
  // Current residence only. "Native", "preferred" and "interested" locations are NOT the current location and stay with the owner.
  { pattern: /\b(current|present)\b.{0,12}\b(location|city)\b|\bcurrent(ly)? (based|located)\b|\bwhere .{0,20}(are you|do you).{0,12}(based|located|live|reside)\b/i, key: 'current_location' },
  { pattern: /\bskill ?sets?\b|\b(key|technical|primary|core) skills\b/i, key: 'skills' },
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
  current_location: 'Where the candidate lives now (city), from the answer file or the resume',
  skills: "The candidate's skills list, from the answer file or the resume",
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

  // Values the resume supports on its own; the owner's answer file always wins. Nothing is estimated (src/apply/derive.ts).
  const derived = deriveFromResume(profileRaw);
  const fixedValue = (key: string): unknown => {
    const v = (answers as Record<string, unknown>)[key];
    if (v !== undefined && v !== null && v !== '') return v;
    if (key === 'years_experience' || key === 'current_location' || key === 'skills') return (derived as unknown as Record<string, unknown>)[key] ?? undefined;
    return undefined;
  };

  // Exact key first; then a key that is the same question after normalization (case, spaces, trailing star). Never anything fuzzier.
  const customValue = (key: string): AnswerValue | undefined => {
    const c = answers.custom;
    if (!c) return undefined;
    let hit: string | undefined = Object.prototype.hasOwnProperty.call(c, key) ? key : undefined;
    if (hit === undefined) {
      const n = normalizeQuestion(key).slice(0, 200);
      hit = Object.keys(c).find((k) => normalizeQuestion(k).slice(0, 200) === n);
    }
    if (hit === undefined) return undefined;
    return c[hit] === '' ? undefined : c[hit];
  };

  const experience = Array.isArray(profileRaw?.experience) ? (profileRaw!.experience as unknown[]) : [];
  const months = monthsFromExperience(experience, new Date());
  const stated = typeof answers.years_experience === 'number' && Number.isFinite(answers.years_experience) ? Math.floor(answers.years_experience) : null;
  const rs = (answers as Record<string, unknown>).requires_sponsorship;
  const rsObj = rs as Partial<SponsorshipByRegion> | null | undefined;
  const facts: OwnerFacts = {
    // The owner's own number wins unless the resume dates agree with it (then the exact months decide). An empty fact stays null.
    experienceMonths: months !== null && (stated === null || Math.floor(months / 12) === stated) ? months : null,
    statedYears: stated ?? (months !== null ? Math.floor(months / 12) : null),
    location: str(answers.current_location) ?? str(profileRaw?.location),
    requiresSponsorship: typeof rs === 'boolean' ? rs
      : rsObj && typeof rsObj === 'object' && typeof rsObj.india === 'boolean' && typeof rsObj.other === 'boolean' ? { india: rsObj.india, other: rsObj.other } : null,
    employers: experience.map((e) => str((e as { company?: unknown })?.company)).filter((x): x is string => x !== null),
  };
  const intentOf = (key: string): IntentName | null => (key.startsWith('intent:') && (INTENT_NAMES as readonly string[]).includes(key.slice(7)) ? (key.slice(7) as IntentName) : null);

  function resolve(ref: AnswerRef, ctx: ResolveCtx): AnswerValue | null {
    if (ref.kind === 'profile') return profile[ref.field] ?? null;
    if (ref.kind !== 'answer') return null;
    const key = ref.key as string;
    if (key.startsWith('intent:')) {
      const intent = intentOf(key);
      if (!intent || !ctx.question) return null;
      const v = answerIntent(intent, facts, { question: ctx.question, options: ctx.options, company: ctx.company });
      if (v !== null || intent !== 'visa_sponsorship' || sponsorNegated(ctx.question)) return v;
      // The old job-location rule for the {india, other} form stays as the fallback.
      const legacy = resolveSponsorship(answers.requires_sponsorship, ctx.jobLocation);
      return legacy === null ? null : (YES_NO_OPT(legacy, ctx.options));
    }
    if (key.startsWith('custom:')) return customValue(key.slice(7)) ?? null;
    if (!FIXED_KEYS.has(key)) return null;
    if (key === 'requires_sponsorship') return resolveSponsorship(answers.requires_sponsorship, ctx.jobLocation);
    const v = fixedValue(key);
    return v === undefined || v === null || v === '' ? null : (v as AnswerValue);
  }

  return {
    has(ref, ctx) {
      if (ref.kind === 'profile') return profile[ref.field] != null;
      if (ref.kind !== 'answer') return false;
      const key = ref.key as string;
      if (key.startsWith('intent:')) {
        const intent = intentOf(key);
        if (!intent) return false;
        return ctx?.question ? resolve(ref, ctx) !== null : intentHasFacts(intent, facts);
      }
      if (key.startsWith('custom:')) return customValue(key.slice(7)) !== undefined;
      return FIXED_KEYS.has(key) && (key === 'requires_sponsorship' ? (answers as Record<string, unknown>)[key] != null : fixedValue(key) != null);
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
      // Intent classes (src/apply/intents.ts) run BEFORE the literal patterns: "require sponsorship ... in your current location" is a
      // sponsorship question, not a current-location one.
      const intent = classifyIntent(question);
      if (intent) return { ref: { kind: 'answer', key: `intent:${intent}` }, cls: 'known' };
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

/**
 * Owner CLI only (`npm run answers -- answer <id> "<text>" --always`): stores one answer in the `custom` map keyed by the NORMALIZED
 * label, so the exact-match rule finds it on every later form. An existing key for the same normalized question is replaced.
 * Atomic write, file mode kept. The agent never calls this.
 */
export function saveCustomAnswer(label: string, value: AnswerValue, answersPath: string = userDataPath('easy-apply-answers.json')): void {
  const key = normalizeQuestion(label).slice(0, 200);
  if (!key) throw new Error('empty question label');
  const raw = readJson(answersPath);
  if (!raw) throw new Error('user-data/easy-apply-answers.json is missing or not valid JSON; run npm run user-data -- init first');
  const custom = { ...((raw.custom as Record<string, AnswerValue> | undefined) ?? {}) };
  for (const k of Object.keys(custom)) if (normalizeQuestion(k).slice(0, 200) === key) delete custom[k];
  custom[key] = value;
  const next = { ...raw, custom };
  const tmp = `${answersPath}.tmp-${process.pid}`;
  const mode = statSync(answersPath).mode & 0o777;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, answersPath);
}
