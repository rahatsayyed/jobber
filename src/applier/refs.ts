// Reference-only inputs for the typed apply tools (plan 8G-2 task 18, D10). The model never supplies
// a value: it names a page field by id (f1, f2, ...) and an AnswerRef; code resolves the ref from the
// answer book. Pure helpers, no I/O.
import { z } from 'zod';
import type { AnswerRef } from '../apply/answers.js';
import type { FieldRole } from '../webcore/formModel.js';

export const FIELD_ID = /^f\d{1,3}$/;
export const CONTROL_ID = /^c\d{1,3}$/;

const FIXED_ANSWER_KEYS = [
  'years_experience', 'authorized_to_work', 'requires_sponsorship', 'willing_to_relocate',
  'notice_period_days', 'expected_salary', 'phone', 'linkedin_profile_url',
];
// A custom key names an entry that must already exist in the answer book; code checks it.
const ANSWER_KEY = new RegExp(`^(?:${FIXED_ANSWER_KEYS.join('|')}|custom:.{1,200})$`);

export const FieldIdSchema = z.string().regex(FIELD_ID);
export const ControlIdSchema = z.string().regex(CONTROL_ID);

export const RefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('profile'), field: z.enum(['name.first', 'name.last', 'name.full', 'email', 'phone', 'linkedin_url', 'location']) }).strict(),
  z.object({ kind: z.literal('answer'), key: z.string().max(220).regex(ANSWER_KEY) }).strict(),
  z.object({ kind: z.literal('resume_pdf') }).strict(),
  z.object({ kind: z.literal('cover_letter') }).strict(),
]);

const PROFILE_ONLY: Partial<Record<FieldRole, string>> = {
  'name.first': 'name.first', 'name.last': 'name.last', 'name.full': 'name.full', email: 'email', location: 'location',
};

/** Which refs may feed which field role. Question fields are checked separately against the book's own suggestion. */
export function checkRoleRef(role: FieldRole, ref: AnswerRef): 'ok' | 'mismatch' {
  const only = PROFILE_ONLY[role];
  if (only) return ref.kind === 'profile' && ref.field === only ? 'ok' : 'mismatch';
  if (role === 'phone') return (ref.kind === 'profile' && ref.field === 'phone') || (ref.kind === 'answer' && ref.key === 'phone') ? 'ok' : 'mismatch';
  if (role === 'linkedin_url') {
    return (ref.kind === 'profile' && ref.field === 'linkedin_url') || (ref.kind === 'answer' && ref.key === 'linkedin_profile_url') ? 'ok' : 'mismatch';
  }
  if (role === 'resume') return ref.kind === 'resume_pdf' ? 'ok' : 'mismatch';
  if (role === 'question') return ref.kind === 'answer' ? 'ok' : 'mismatch';
  return 'mismatch';
}

export function sameRef(a: AnswerRef, b: AnswerRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'profile' && b.kind === 'profile') return a.field === b.field;
  if (a.kind === 'answer' && b.kind === 'answer') return a.key === b.key;
  return true;
}

export const normOpt = (s: string): string => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** The listed option equal to `wanted` (case and whitespace insensitive), or null. Returns the page's own spelling. */
export function matchOption(options: string[], wanted: string): string | null {
  const w = normOpt(wanted);
  if (!w) return null;
  return options.find((o) => normOpt(o) === w) ?? null;
}

/** Yes/No mapping for a boolean answer; null when the list has no plain Yes/No option. */
export function yesNoOption(value: boolean, options: string[]): string | null {
  return matchOption(options, value ? 'yes' : 'no');
}

/** The explicit self-identification decline wording. Anything else is never chosen for an EEO field. */
export const DECLINE_RE = /decline|prefer not|do not wish|don'?t wish|rather not|choose not|not (?:to )?(?:say|answer|disclose|specify|identify)/i;
