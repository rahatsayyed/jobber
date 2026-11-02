// apply_draft_answer({question_id | field, text?}): the apply-operator drafts the answer to ONE open-ended application question
// (why this company or role, about you, a cover letter text box). Owner decision 2026-11-02: such questions are answered by the
// agent, not sent to the owner, as long as the text passes every gate. Factual questions (salary, notice, location, work
// authorization, links, ids, consent, demographics) are never drafted: `agentHandleAllowed` refuses them and they stay with the
// answer book, the resume-derived values or the owner.
//
// Without `text` the tool returns the drafting context (the question, the limits, the owner's guidance for this question, the job
// description after the injection screen, and compact resume facts). With `text` it runs the gates; on pass the question row becomes
// answered (scope once, source `drafted`) and the next apply_fill types it from the row exactly like an owner answer: the model never
// names a value to type. On a gate failure the reason codes come back so the operator may redraft ONCE; after the second failure the
// question goes back to the owner (needs_answer).
import { z } from 'zod';
import { getBaseResume } from '../../resume.js';
import { checkTextWithNormalized, strings } from '../../resumeFacts.js';
import { gateOutbound, secretValuesFromEnv } from '../../safety/outputGate.js';
import { checkStyle, loadStyleConfigSafe } from '../../safety/styleGate.js';
import { allowedFrom } from '../../apply/answerService.js';
import {
  agentHandleAllowed, getQuestion, markAnsweredForJob, normLabel, ownerGuidanceFor, recordQuestion, reopenForOwner, storedAnswer,
  type QuestionRow,
} from '../../apply/questions.js';
import { FieldIdSchema } from '../refs.js';
import {
  dryRunResult, envOf, inPage, nowOf, refuse, type ApplierDeps, type ApplyResult,
} from './common.js';
import { questionText, screenText } from './state.js';

export const DraftInput = z.object({
  question_id: z.number().int().positive().optional(),
  field: FieldIdSchema.optional(),
  text: z.string().max(4000).optional(),
}).strict();
export type DraftInputT = z.infer<typeof DraftInput>;

/** Default cap when the field sets no maxlength, and the shortest answer worth typing. */
export const DRAFT_DEFAULT_MAX = 1200;
export const DRAFT_MIN = 40;
/** One draft and one redraft per question per run. */
export const DRAFT_MAX_ATTEMPTS = 2;
const DESCRIPTION_CAP = 3500;

const bounded = (s: unknown, n: number): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Compact resume facts for the drafter: owner-written data, so no screen is needed. Capped. */
export function resumeFacts(resume: Record<string, unknown>): Record<string, unknown> {
  const arr = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);
  const skills = arr(resume.skills).flatMap((s) => (Array.isArray(s.items) ? (s.items as unknown[]).map((x) => bounded(x, 40)) : [])).filter(Boolean).slice(0, 30);
  const experience = arr(resume.experience).slice(0, 4).map((e) => ({
    title: bounded(e.title, 80), company: bounded(e.company, 80), start: bounded(e.start, 10), end: bounded(e.end, 10),
    highlights: (Array.isArray(e.description) ? (e.description as unknown[]) : []).slice(0, 3).map((d) => bounded(d, 220)),
  }));
  const projects = arr(resume.projects).slice(0, 3).map((p) => ({ name: bounded(p.name, 80), summary: bounded(Array.isArray(p.description) ? (p.description as unknown[])[0] : p.description, 220) }));
  return { headline: bounded(resume.jobTitle, 80), summary: bounded(resume.summary, 500), skills, experience, projects };
}

function resumeOf(deps: ApplierDeps): Record<string, unknown> | null {
  try { return (deps.draft?.baseResume ?? getBaseResume)() as Record<string, unknown>; } catch { return null; }
}

const attemptsOf = (deps: ApplierDeps, id: number): number => deps.state.draftAttempts?.get(id) ?? 0;

async function toOwner(deps: ApplierDeps, q: QuestionRow, code: string, reasons: string[]): Promise<ApplyResult> {
  reopenForOwner(deps.db, q.id);
  return { status: 'needs_answer', code, reasons, question_id: q.id, question: await questionText(q.label, deps) };
}

export async function handleDraftAnswer(input: DraftInputT, deps: ApplierDeps): Promise<ApplyResult> {
  if ((input.question_id === undefined) === (input.field === undefined)) return refuse('invalid_input', 'pass exactly one of question_id or field');
  return inPage(deps, async ({ job, model, raw }) => {
    const env = envOf(deps);
    const now = nowOf(deps);
    const db = deps.db;

    // 1. Which question, and which field of the open page it is.
    const visible = model.fields.filter((f) => !f.hidden);
    let q: QuestionRow | null;
    let field = input.field !== undefined ? visible.find((f) => f.id === input.field) : undefined;
    if (input.field !== undefined) {
      if (!field) return refuse('unknown_field', 'no such visible field on this page');
      if (field.role !== 'question' || (field.type !== 'textarea' && field.type !== 'text')) return refuse('not_free_text', 'only a free-text question field can be drafted');
      if (field.filled) return refuse('already_filled', 'the field already has a value');
      if (!agentHandleAllowed(field.label, 'text')) return refuse('not_draftable', 'only a motivational or descriptive question is drafted; factual questions come from the answer book or the owner');
      const r = recordQuestion(db, { jobId: job.jobId, host: job.host, label: field.label, kind: 'text', maxLength: field.maxLength }, now);
      if (r.status === 'skipped') return refuse('question_skipped', 'the owner chose not to answer this question');
      q = getQuestion(db, r.id);
    } else {
      q = getQuestion(db, input.question_id!);
      if (!q) return refuse('unknown_question', 'no such question');
      if (q.host !== job.host) return refuse('wrong_host', 'that question belongs to another host');
      field = visible.find((f) => f.role === 'question' && normLabel(f.label) === q!.norm_label && (f.type === 'textarea' || f.type === 'text'));
      if (!field) return refuse('not_on_page', 'that question is not an unanswered free-text field of the open page');
    }
    if (!q) return refuse('unknown_question', 'no such question');
    if (q.status === 'answered') return refuse('already_answered', 'this question already has an answer; use apply_fill');
    if (q.status !== 'open' && q.status !== 'agent_handle') return refuse('not_open', `the question is ${q.status}`);
    if (!agentHandleAllowed(q.label, q.kind)) return refuse('not_draftable', 'only a motivational or descriptive question is drafted; factual questions come from the answer book or the owner');
    if (storedAnswer(db, job.jobId, job.host, q.label) !== null) return refuse('already_answered', 'this question already has an answer; use apply_fill');
    const s = deps.answers.suggest(q.label);
    if (s.ref && deps.answers.has(s.ref)) return refuse('answer_book_has_it', 'the answer book answers this question; use apply_fill');
    db.prepare('INSERT OR IGNORE INTO apply_question_jobs (question_id, job_id) VALUES (?, ?)').run(q.id, job.jobId);

    const cap = Math.min(DRAFT_DEFAULT_MAX, field.maxLength ?? q.max_length ?? DRAFT_DEFAULT_MAX);
    if (cap < DRAFT_MIN) return toOwner(deps, q, 'field_too_short', ['field_too_short']);
    const label = await questionText(q.label, deps);
    if (label === '[question withheld]') return toOwner(deps, q, 'question_withheld', ['question_withheld']);

    // 2. The job the answer is for, from SQLite. The description is third-party text: screened before the drafter sees it.
    const jobRow = db.prepare('SELECT title, company, description FROM jobs WHERE id = ?').get(job.jobId) as { title: string | null; company: string | null; description: string | null } | undefined;
    if (!jobRow) return refuse('unknown_job', 'no such job');
    const description = String(jobRow.description ?? '');
    const screened = await screenText(description.slice(0, 6000), 'read', deps, 6000);
    if (screened.blocked) return toOwner(deps, q, 'description_flagged', [`description_${screened.code}`]);
    const resume = resumeOf(deps);
    if (!resume) return refuse('resume_unreadable', 'the base resume cannot be read, so the gates cannot run');

    const attempts = attemptsOf(deps, q.id);
    if (attempts >= DRAFT_MAX_ATTEMPTS) return toOwner(deps, q, 'draft_failed', ['draft_limit']);

    // 3. Context mode: no text yet.
    if (input.text === undefined) {
      const styleCfg = deps.draft?.styleCfg ?? loadStyleConfigSafe('config/ai-tells.json').cfg;
      return {
        status: 'ok', code: 'draft_context', question_id: q.id, question: label, host: job.host,
        context: {
          field: field.id, min_chars: DRAFT_MIN, max_chars: cap, attempts_left: DRAFT_MAX_ATTEMPTS - attempts,
          owner_guidance: ownerGuidanceFor(db, q.label, job.host, 3).map((g) => ({ comment: g.comment, status: g.status })),
          style: { max_words: styleCfg.max_words.answer ?? 160, max_exclamations: styleCfg.max_exclamations, no_dashes: styleCfg.forbid_em_dash, no_markdown: styleCfg.forbid_markdown, avoid_phrases: styleCfg.banned_phrases },
          job: { title: bounded(jobRow.title, 160), company: bounded(jobRow.company, 120), description: screened.text.slice(0, DESCRIPTION_CAP) },
          ...(screened.unscreened ? { classifier: 'unscreened' } : {}),
          resume: resumeFacts(resume),
        },
      };
    }

    // 4. Draft mode: every gate runs and every reason is reported, so one redraft can fix them all.
    const n = attempts + 1;
    deps.state.draftAttempts?.set(q.id, n);
    const text = String(input.text).replace(/\r\n?/g, '\n').trim();
    const reasons: string[] = [];
    if (text.length < DRAFT_MIN) reasons.push('too_short');
    if (text.length > cap) reasons.push('too_long');
    const styleCfg = deps.draft?.styleCfg ?? loadStyleConfigSafe('config/ai-tells.json').cfg;
    const style = checkStyle(text, 'answer', styleCfg);
    for (const rule of new Set(style.hits.map((h) => h.rule))) reasons.push(`style:${rule}`);
    let fact: ReturnType<typeof checkTextWithNormalized> | null = null;
    try {
      fact = checkTextWithNormalized(text, resume, { jobTitle: jobRow.title ?? undefined, company: jobRow.company ?? undefined, jobDescription: description });
    } catch { reasons.push('fact_gate_error'); }
    if (fact && fact.verdict === 'block') reasons.push('fact_gate_block');
    const body = fact ? fact.normalized_text.trim() : text;
    if (fact && body.length > cap && !reasons.includes('too_long')) reasons.push('too_long');
    if (fact) {
      const allow = allowedFrom(resume);
      const g = gateOutbound(body, {
        recipientKey: 'form', expectedRecipientKey: 'form', factVerdict: fact.verdict,
        allowedUrls: allow.urls, allowedEmails: allow.emails, secretValues: secretValuesFromEnv(env),
        rawPageText: `${raw.text ?? ''}\n${description}`, ownTexts: strings(resume),
      });
      for (const r of g.reasons) if (r !== 'fact_gate_block' && !reasons.includes(r)) reasons.push(r);
    }

    if (reasons.length > 0) {
      const hints = fact && fact.verdict === 'block' ? [...fact.invented, ...fact.unsupported].slice(0, 3).map((x) => bounded(x, 80)) : [];
      if (n >= DRAFT_MAX_ATTEMPTS) return toOwner(deps, q, 'draft_failed', reasons);
      return {
        status: 'refused', code: 'draft_rejected', reasons, question_id: q.id,
        reason: `redraft once: ${reasons.join(', ')}${hints.length ? ` (claims not in the resume: ${hints.join('; ')})` : ''}`,
      };
    }

    const dry = dryRunResult(deps, 'apply_draft_answer', { job_id: job.jobId, question_id: q.id, chars: body.length });
    if (dry) return dry;
    const out = markAnsweredForJob(db, q.id, job.jobId, body, now, 'drafted');
    return {
      status: 'ok', code: 'drafted', question_id: q.id, ...(field ? { fields: [field.id] } : {}),
      reason: 'stored; call apply_fill for this field with a ref of kind answer (key custom:drafted)', ...(out.released.length ? { info: { released: out.released.length } } : {}),
    };
  });
}
