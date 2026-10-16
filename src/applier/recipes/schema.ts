// Declarative ATS recipe schema (plan 8G-2 task 19). A recipe is data: a closed vocabulary of field roles
// and step kinds, safe selectors, and answer-book refs. It holds no code, no URLs beyond one path, and no
// typed values. Everything that reaches disk or a model passes validateRecipe.
import { z } from 'zod';
import { FIELD_ROLES, type FieldRole } from '../../webcore/formModel.js';
import { isSafeSelector } from '../../lib/safeSelector.js';
import { RefSchema, checkRoleRef } from '../refs.js';
import type { AnswerRef } from '../../apply/answers.js';

export const RECIPE_PLATFORM_RE = /^[a-z0-9]{1,30}$/;

// Passwords, one-time codes and unclassified fields are never recipe fields.
const EXCLUDED: readonly FieldRole[] = ['password', 'password_confirm', 'otp', 'unknown'];
export const RECIPE_ROLES = FIELD_ROLES.filter((r) => !EXCLUDED.includes(r)) as FieldRole[];
export const RECIPE_STEP_KINDS = ['landing', 'listing', 'signin', 'account', 'form', 'review'] as const;
export const RECIPE_FIELD_TYPES = ['text', 'email', 'tel', 'url', 'number', 'file', 'textarea', 'select', 'radio', 'checkbox'] as const;

const role = z.enum(RECIPE_ROLES as [FieldRole, ...FieldRole[]]);
const selector = z.string().min(1).max(200).refine(isSafeSelector, 'unsafe selector');

const RecipeFieldSchema = z.object({
  role,
  selector,
  type: z.enum(RECIPE_FIELD_TYPES),
  ref: RefSchema.optional(),
  required: z.boolean().optional(),
}).strict().refine((f) => f.ref === undefined || checkRoleRef(f.role, f.ref as AnswerRef) === 'ok', 'ref does not fit the role');

const ControlHintSchema = z.object({ selector }).strict();

const RecipeStepSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,23}$/),
  kind: z.enum(RECIPE_STEP_KINDS),
  match: z.object({ roles: z.array(role).max(20), minFields: z.number().int().min(0).max(20) }).strict()
    .refine((m) => m.minFields <= m.roles.length, 'minFields exceeds roles'),
  fields: z.array(RecipeFieldSchema).max(30),
  next: ControlHintSchema.optional(),
  submit: ControlHintSchema.optional(),
}).strict();

export const RecipeObject = z.object({
  schema: z.literal(1),
  id: z.string().regex(RECIPE_PLATFORM_RE),
  platform: z.string().regex(RECIPE_PLATFORM_RE),
  verified: z.boolean(),
  source: z.enum(['shipped', 'learned', 'proposed']),
  note: z.string().max(200).regex(/^[\x20-\x7e]*$/).optional(),
  steps: z.array(RecipeStepSchema).min(1).max(8),
  confirmation: z.object({
    urlPath: z.string().regex(/^\/[A-Za-z0-9_./-]{0,80}$/).optional(),
    roles_absent: z.array(role).max(20),
  }).strict(),
}).strict();

export const RecipeSchema = RecipeObject.refine((r) => r.id === r.platform, 'id and platform differ');

export type Recipe = z.infer<typeof RecipeSchema>;
export type RecipeStep = Recipe['steps'][number];
export type RecipeField = RecipeStep['fields'][number];

export function validateRecipe(raw: unknown): { ok: true; recipe: Recipe } | { ok: false; why: string } {
  const r = RecipeSchema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    return { ok: false, why: `recipe invalid at ${first?.path.join('.') || 'root'}` };
  }
  return { ok: true, recipe: r.data };
}

/** The ref a role uses when the recipe field names none. Roles with no fixed ref (questions, cover letters, self-identification) have none. */
export function defaultRefFor(r: FieldRole): AnswerRef | null {
  switch (r) {
    case 'name.first': case 'name.last': case 'name.full': case 'email': case 'phone': case 'linkedin_url': case 'location':
      return { kind: 'profile', field: r };
    case 'resume': return { kind: 'resume_pdf' };
    default: return null;
  }
}
