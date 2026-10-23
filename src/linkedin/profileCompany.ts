// Pure parser: the CURRENT employer of a LinkedIn profile, from the headline and the first Experience entry. Used to
// resolve the company of a hiring post whose text names none. Nothing here fetches or opens anything; the inputs are
// untrusted page text that the caller already read through the typed linkedin tools. Every page-shape assumption
// (headline "<role> at <company>", Experience entry layouts, "Present" on a current entry) is unverified on live LinkedIn.
import { normalizeCompany } from '../outreach/people.js';
import type { RawSnapshot } from './types.js';

export type CompanyConfidence = 'high' | 'low';
export type CompanySource = 'headline' | 'experience' | 'post+profile' | 'conflict';
export interface ProfileCompany { company: string; confidence: CompanyConfidence; source: CompanySource }

const NOT_A_COMPANY =
  /^(?:stealth|self[- ]?employed|freelanc|confidential|various|multiple|a|an|the|my|our|top|leading|startup|company|hiring|open to work|looking|seeking|work|home|remote|present|none|n\/a)\b/i;

const cleanName = (raw: string): string => {
  const cut = String(raw ?? '').split(/\s[-–—]\s|[,;(]/)[0];
  const c = cut.replace(/\s+/g, ' ').replace(/[.:!\s]+$/, '').trim();
  if (c.length < 2 || c.length > 60) return '';
  if (/[@<>]|https?:|:\/\//i.test(c) || !/^[A-Za-z0-9]/.test(c) || NOT_A_COMPANY.test(c)) return '';
  return c;
};

/** Employer named by a headline such as "Senior Recruiter at Acme Corp | Hiring" or "Talent Acquisition @ Globex"; '' when none. */
export function companyFromHeadline(headline: string): string {
  for (const seg of String(headline ?? '').split(/\s*[|•·]\s*/)) {
    const m = /^.*?(?:\sat\s|\s?@\s?)(.+)$/i.exec(seg.trim());
    if (m) {
      const c = cleanName(m[1]);
      if (c) return c;
    }
  }
  return '';
}

const EMPLOYMENT = '(?:full-time|part-time|self-employed|freelance|contract|internship|apprenticeship|seasonal|permanent|temporary|trainee)';
const TYPE_TAIL = new RegExp(`^(.+?)\\s*\\u00b7\\s*${EMPLOYMENT}\\b`, 'i');
const TYPE_LINE = new RegExp(`^${EMPLOYMENT}?\\s*\\u00b7?\\s*(?:\\d+\\s*(?:yrs?|mos?)\\b|$)`, 'i');
const DATE_LINE = /(?:\b(?:19|20)\d{2}\b|\bpresent\b)/i;

/** Company of the FIRST Experience entry, only when that entry is current (its dates say Present); '' otherwise. */
export function currentEmployerFromExperience(lines: string[]): string {
  const ls = lines.map((l) => String(l ?? '').trim()).filter((l) => l && !/^experience$/i.test(l) && !/^show all\b/i.test(l));
  const d = ls.slice(0, 6).findIndex((l) => DATE_LINE.test(l));
  if (d < 0 || !/\bpresent\b/i.test(ls[d])) return '';
  const entry = ls.slice(0, d);
  for (const l of entry) {
    const m = TYPE_TAIL.exec(l);
    if (m) {
      const c = cleanName(m[1]);
      if (c) return c;
    }
  }
  // Grouped roles: the company comes first, then "Full-time · 5 yrs".
  if (entry.length >= 2 && TYPE_LINE.test(entry[1]) && entry[1].length > 0) {
    const c = cleanName(entry[0]);
    if (c) return c;
  }
  // Title, company, [location], dates.
  if (entry.length >= 2) {
    const c = cleanName(entry[1]);
    if (c) return c;
  }
  return '';
}

const SECTION_END = /^(?:education|skills|about|activity|featured|licenses & certifications|interests|recommendations|projects|volunteering|courses|honors & awards|languages|publications|highlights)$/i;

/** Lines of the Experience section of the visible page text (capped), '' entries removed; empty without the heading. */
export function experienceLinesFromBody(bodyText: string): string[] {
  const ls = String(bodyText ?? '').split('\n').map((l) => l.trim());
  const i = ls.findIndex((l) => /^experience$/i.test(l));
  if (i < 0) return [];
  const out: string[] = [];
  for (const l of ls.slice(i + 1)) {
    if (SECTION_END.test(l)) break;
    if (l) out.push(l);
    if (out.length >= 40) break;
  }
  return out;
}

const norm = (s: string): string => normalizeCompany(s).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Same employer ignoring case, punctuation and legal suffixes; a whole-word prefix counts ("Acme" and "Acme Labs"). */
export function sameCompany(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `);
}

export interface ProfileCompanyInput {
  headline?: string;
  /** First entries of the Experience section, as lines or one newline-separated string. */
  experience?: string[] | string;
  /** Visible page text; its Experience section is used when `experience` is not given. */
  bodyText?: string;
  /** Company the post text already named (post patterns), when any. */
  postCompany?: string;
}

/**
 * Current employer of the poster. `high` only when the headline names it (and nothing in the post or the Experience
 * section contradicts it) or when the post text and the profile agree; anything else is `low`, and a disagreement
 * between post and profile (or headline and Experience) is `conflict`.
 */
export function profileCompany(i: ProfileCompanyInput): ProfileCompany | null {
  const h = companyFromHeadline(i.headline ?? '');
  const expLines = Array.isArray(i.experience) ? i.experience : typeof i.experience === 'string' ? i.experience.split('\n') : experienceLinesFromBody(i.bodyText ?? '');
  const e = currentEmployerFromExperience(expLines);
  const p = String(i.postCompany ?? '').trim();
  const cand = h || e;
  if (!cand) return null;
  const profileVals = [h, e].filter(Boolean);
  if (p) {
    if (profileVals.every((v) => sameCompany(p, v))) return { company: cand, confidence: 'high', source: 'post+profile' };
    return { company: cand, confidence: 'low', source: 'conflict' };
  }
  if (h) {
    if (e && !sameCompany(h, e)) return { company: h, confidence: 'low', source: 'conflict' };
    return { company: h, confidence: 'high', source: 'headline' };
  }
  return { company: e, confidence: 'low', source: 'experience' };
}

/** Same, over a parsed profile snapshot (headline from the parsed header, Experience from the visible body text). */
export function profileCompanyFromSnapshot(snap: RawSnapshot, postCompany?: string): ProfileCompany | null {
  if (!snap.profile) return null;
  return profileCompany({ headline: snap.profile.headline, bodyText: snap.bodyText, postCompany });
}
