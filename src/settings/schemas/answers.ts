// src/settings/schemas/answers.ts
// user-data/easy-apply-answers.json. Consumer: src/apply/linkedin.ts (EasyApplyAnswers, re-read from disk per call;
// resolveAnswer coerces values by field). The fixed fields are all required; `custom` is a free question -> answer map
// (the agent appends to it, Applying step 2a). An object-valued requires_sponsorship is a known conflict (CLAUDE.md Naukri
// section): linkedin.ts treats it as a boolean and fails closed to needs_answer, so it is a WARNING here, not an error.
import { z } from 'zod';
import { type SchemaResult, zodErrors } from './util.js';

const schema = z.object({
  years_experience: z.number().min(0).max(80),
  authorized_to_work: z.boolean(),
  requires_sponsorship: z.union([z.boolean(), z.record(z.string(), z.unknown())]),
  willing_to_relocate: z.boolean(),
  notice_period_days: z.number().int().min(0).max(1000),
  expected_salary: z.string().max(200),
  phone: z.string().max(40),
  linkedin_profile_url: z.string().max(300),
  custom: z.record(z.string().max(500), z.union([z.string().max(2000), z.number(), z.boolean()])).optional(),
});

export function validateAnswers(raw: unknown): SchemaResult {
  const r = schema.safeParse(raw);
  if (!r.success) return { errors: zodErrors(r.error), warnings: [] };
  const warnings: string[] = [];
  if (typeof r.data.requires_sponsorship === 'object') {
    warnings.push('requires_sponsorship: is an object; the Easy Apply flow expects true or false and will ask for an answer instead of applying');
  }
  return { errors: [], warnings };
}
