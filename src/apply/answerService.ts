// The owner's answer to one apply_questions row, behind every gate. Used by the CLI (scripts/answers.ts) and the dashboard API
// (src/web/questionRoutes.ts) so both refuse exactly the same things: the shape check (non-empty, within the field's maxlength, one of the
// listed options), the output gate (no link, address, path or secret that is not already in the resume) and, for a free-text answer of
// five words or more, the fact gate against the base resume. `always` also writes user-data/easy-apply-answers.json (never for consent).
import type BetterSqlite3 from 'better-sqlite3';
import { loadAnswerBook, saveCustomAnswer } from './answers.js';
import { checkAnswerShape, getQuestion, markAnswered, type AnswerOutcome } from './questions.js';
import { gateOutbound, secretValuesFromEnv } from '../safety/outputGate.js';
import { checkTextWithNormalized } from '../resumeFacts.js';
import { getBaseResume } from '../resume.js';
import { userDataPath } from '../lib/userData.js';

/** A free-text answer (five words or more) is fact-checked against the resume like an email; short values (a city, a number) are not claims. */
export const FREE_TEXT_WORDS = 5;

export interface AnswerDeps {
  now?: () => Date;
  answersPath?: string;
  profilePath?: string;
  /** Test seam: the base resume the fact gate checks against. */
  baseResume?: () => Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}

export type SubmitResult =
  | { ok: true; outcome: AnswerOutcome; always: boolean }
  | { ok: false; code: 'not_found' | 'not_open' | 'refused'; reason: string };

function allowedFrom(resume: Record<string, unknown>): { urls: string[]; emails: string[] } {
  const urls: string[] = [];
  const emails: string[] = [];
  const web = (resume.website as { url?: unknown } | undefined)?.url;
  if (typeof web === 'string') urls.push(web);
  const social = resume.social as Record<string, { url?: unknown }> | undefined;
  for (const v of Object.values(social ?? {})) if (typeof v?.url === 'string') urls.push(v.url);
  if (typeof resume.email === 'string') emails.push(resume.email);
  return { urls, emails };
}

export function submitAnswer(
  db: BetterSqlite3.Database, id: number, text: string, opts: { always: boolean; comment?: string | null }, deps: AnswerDeps = {},
): SubmitResult {
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const q = getQuestion(db, id);
  if (!q) return { ok: false, code: 'not_found', reason: `no question #${id}` };
  if (q.status !== 'open' && q.status !== 'agent_handle') return { ok: false, code: 'not_open', reason: `question #${id} is already ${q.status}` };
  const shape = checkAnswerShape(q, text);
  if (!shape.ok) return { ok: false, code: 'refused', reason: shape.reason };
  const value = shape.value;

  let resume: Record<string, unknown>;
  try { resume = (deps.baseResume ?? getBaseResume)() as Record<string, unknown>; } catch {
    return { ok: false, code: 'refused', reason: 'the base resume (user-data/resume.json) cannot be read, so the gates cannot run' };
  }
  const allow = allowedFrom(resume);
  const fact = checkTextWithNormalized(value, resume, {});
  const words = value.split(/\s+/).filter(Boolean).length;
  const factVerdict = words >= FREE_TEXT_WORDS ? fact.verdict : 'pass';
  const out = gateOutbound(fact.normalized_text, {
    recipientKey: 'form', expectedRecipientKey: 'form', factVerdict,
    allowedUrls: allow.urls, allowedEmails: allow.emails, secretValues: secretValuesFromEnv(env),
  });
  if (!out.ok) {
    const hint = out.reasons.includes('url_not_allowed') ? ' (a link must already be in user-data/resume.json)'
      : out.reasons.includes('fact_gate_block') ? ` (claims the resume does not support: ${[...fact.invented, ...fact.unsupported].slice(0, 5).join(', ')}; add the fact to user-data/resume.json first)` : '';
    return { ok: false, code: 'refused', reason: `the output gate refused this answer: ${out.reasons.join(', ')}${hint}` };
  }
  const stored = fact.normalized_text.trim();
  const cap = checkAnswerShape(q, stored);
  if (!cap.ok) return { ok: false, code: 'refused', reason: cap.reason };

  if (opts.always) {
    const book = loadAnswerBook({ answersPath: deps.answersPath, profilePath: deps.profilePath ?? userDataPath('resume.json') });
    const cls = book.suggest(q.label).cls;
    if (cls === 'consent' || cls === 'legal_attestation') return { ok: false, code: 'refused', reason: 'consent and attestation questions are never answered from a book; answer them by hand on the form' };
    saveCustomAnswer(q.label, cap.value, deps.answersPath);
  }
  const outcome = markAnswered(db, id, cap.value, opts.always ? 'always' : 'once', now(), opts.comment);
  return { ok: true, outcome, always: opts.always };
}
