// src/linkedin/employer.ts
// People quality in code (finding 20): the category of a person comes from their headline, never
// from the model's request alone, and a send needs evidence that the person works at the company.
import { normalizeCompany } from '../outreach/people.js';
import type { Category } from '../outreach/cadence.js';

const RECRUITER = /\b(recruiters?|recruiting|recruitment|talent|sourcers?|sourcing|headhunters?|human resources|hr|people (?:operations|ops|partner|partners|team|and culture|&amp; culture)|staffing)\b/i;
const MANAGER = /\b(hiring manager|engineering manager|head of|director|vp|vice president|cto|chief|lead|manager)\b/i;
const ENGINEER = /\b(engineers?|developers?|programmers?|swe|sde|architect|devops|sre|full[- ]?stack|front[- ]?end|back[- ]?end)\b/i;

/**
 * Category from the headline. Recruiter/HR/talent wording gives recruiter, manager wording gives
 * hiring_manager, engineer wording gives peer. A requested recruiter or hiring_manager that the
 * headline does not support is never kept: it becomes peer. connection stays as requested.
 */
export function classifyCategory(headline: string, requested: Category): Category {
  if (requested === 'connection') return requested;
  const h = String(headline ?? '');
  if (RECRUITER.test(h)) return 'recruiter';
  if (MANAGER.test(h) && !ENGINEER.test(h)) return 'hiring_manager';
  return 'peer';
}

const GENERIC = new Set(['the', 'and', 'global', 'group', 'labs', 'lab', 'tech', 'technologies', 'technology', 'systems', 'solutions', 'software', 'digital', 'services']);
const norm = (s: string): string => normalizeCompany(String(s ?? '').replace(/&amp;/g, '&')).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * true when the normalised company name (or its distinctive first word, 4+ letters) appears in the
 * headline as whole words, false when the headline is present but does not name the company, null
 * when there is nothing to compare (empty headline or empty company).
 */
export function headlineMatchesCompany(headline: string, company: string): boolean | null {
  const h = norm(headline);
  const c = norm(company);
  if (!h || !c) return null;
  const hw = ` ${h} `;
  if (hw.includes(` ${c} `)) return true;
  if (h.replace(/ /g, '').includes(c.replace(/ /g, ''))) return true;
  const first = c.split(' ').find((t) => t.length >= 4 && !GENERIC.has(t));
  if (first && hw.includes(` ${first} `)) return true;
  return false;
}

export type EmployerVerdict =
  | { ok: true }
  | { ok: false; code: 'employer_mismatch' | 'employer_unverified'; reason: string };

/**
 * Send gate. Passes when the headline names the company, or a stored employer match exists
 * (people.employer_match = 1). A headline naming another employer, or an explicit stored 0, is
 * employer_mismatch; nothing to go on is employer_unverified. Fail closed.
 */
export function employerGate(p: { headline: string | null; company: string | null; employer_match: number | null }): EmployerVerdict {
  const m = headlineMatchesCompany(p.headline ?? '', p.company ?? '');
  if (m === true || p.employer_match === 1) return { ok: true };
  if (m === false || p.employer_match === 0) {
    return { ok: false, code: 'employer_mismatch', reason: 'profile headline does not name the company' };
  }
  return { ok: false, code: 'employer_unverified', reason: 'no headline or stored match shows the person works at the company' };
}
