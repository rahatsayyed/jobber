// Pure recipe logic (plan 8G-2 task 19): does a page match a recipe step, which fields would the fast path
// fill, which required fields are still open. No I/O and no page access; the tool in
// src/applier/tools/autofill.ts drives the typed fill, upload and next handlers with this plan.
import type { AnswerBook, AnswerRef } from '../../apply/answers.js';
import type { FieldRole, FormField, FormModel } from '../../webcore/formModel.js';
import type { ConfirmSignals } from '../confirm.js';
import { checkRoleRef } from '../refs.js';
import { defaultRefFor, type Recipe, type RecipeStep } from './schema.js';

export interface RecipeVerdict {
  class: 'match' | 'partial' | 'drift' | 'unknown';
  score: number;
  missing: FieldRole[];
  step: RecipeStep | null;
}

const RANK = { match: 3, partial: 2, drift: 1, unknown: 0 } as const;
const visibleFields = (m: FormModel): FormField[] => m.fields.filter((f) => !f.hidden);

/**
 * `match`: every role the step names is on the page and every required recipe field is present.
 * `partial`: at least `minFields` of the named roles are present and no required recipe field is missing.
 * `drift`: a step of this kind exists but the page no longer looks like it. `unknown`: no step of this kind.
 */
export function matchStep(recipe: Recipe, model: FormModel): RecipeVerdict {
  const cands = recipe.steps.filter((s) => s.kind === model.stepKind);
  if (cands.length === 0) return { class: 'unknown', score: 0, missing: [], step: null };
  const have = new Set(visibleFields(model).map((f) => f.role));
  let best: RecipeVerdict | null = null;
  for (const step of cands) {
    const roles = [...new Set(step.match.roles)];
    const present = roles.filter((r) => have.has(r)).length;
    const missing = roles.filter((r) => !have.has(r));
    const requiredMissing = step.fields.some((f) => f.required && !have.has(f.role));
    const score = roles.length === 0 ? 1 : present / roles.length;
    let cls: RecipeVerdict['class'];
    if (requiredMissing) cls = 'drift';
    else if (present === roles.length) cls = 'match';
    else if (present >= step.match.minFields) cls = 'partial';
    else cls = 'drift';
    const v: RecipeVerdict = { class: cls, score, missing, step };
    if (!best || RANK[v.class] > RANK[best.class] || (RANK[v.class] === RANK[best.class] && v.score > best.score)) best = v;
  }
  return best!;
}

export interface PlanItem { id: string; action: 'fill' | 'upload'; ref: AnswerRef }

const TEXTY = new Set(['text', 'email', 'tel', 'url', 'number', 'textarea']);

/**
 * Fields the fast path would fill, in page order. A role field uses the recipe's ref (or the role default)
 * and only when the answer book has it. A required free question is filled only when the book itself names
 * the ref for that question. Hidden fields (honeypots), filled fields, choice fields, cover letters,
 * self-identification and consent boxes are never planned.
 */
export function planFields(step: RecipeStep, model: FormModel, book: AnswerBook): PlanItem[] {
  const out: PlanItem[] = [];
  for (const f of model.fields) {
    if (f.hidden || f.filled) continue;
    if (f.type === 'file') {
      if (f.role === 'resume' && step.fields.some((x) => x.role === 'resume')) out.push({ id: f.id, action: 'upload', ref: { kind: 'resume_pdf' } });
      continue;
    }
    if (!TEXTY.has(f.type)) continue;
    if (f.role === 'question') {
      if (!f.required) continue;
      const s = book.suggest(f.label);
      if (s.ref && book.has(s.ref)) out.push({ id: f.id, action: 'fill', ref: s.ref });
      continue;
    }
    const rf = step.fields.find((x) => x.role === f.role);
    if (!rf) continue;
    const ref = (rf.ref as AnswerRef | undefined) ?? defaultRefFor(f.role);
    if (!ref || checkRoleRef(f.role, ref) !== 'ok' || !book.has(ref)) continue;
    out.push({ id: f.id, action: 'fill', ref });
  }
  return out;
}

/** Visible required fields that are still empty. Checkboxes are left to the next/submit checkbox gate. */
export function unresolvedFields(model: FormModel): string[] {
  return model.fields.filter((f) => !f.hidden && f.required && f.type !== 'checkbox' && !f.filled).map((f) => f.id);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');

/** What the confirmation check may additionally trust for this platform: the recipe's one URL path. */
export function confirmSignals(recipe: Recipe): ConfirmSignals | null {
  const p = recipe.confirmation.urlPath;
  return p ? { urlPath: [new RegExp(`^${escapeRe(p.replace(/\/+$/, ''))}(?:/|$)`)] } : null;
}

/** True when none of the recipe's `roles_absent` is on the page any more. Informational: the submit tool also needs the form to be gone. */
export function confirmationShape(recipe: Recipe, model: FormModel): boolean {
  const have = new Set(visibleFields(model).map((f) => f.role));
  return recipe.confirmation.roles_absent.every((r) => !have.has(r));
}
