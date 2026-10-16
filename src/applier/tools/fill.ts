// apply_fill({field, ref}): types one value into one text field, by reference only. Code resolves the
// ref from the answer book; the value is never an input and never appears in a result.
import { z } from 'zod';
import { fillGuarded } from '../../webcore/login.js';
import type { AnswerRef } from '../../apply/answers.js';
import { checkRoleRef, FieldIdSchema, RefSchema } from '../refs.js';
import {
  dryRunResult, findField, inPage, noteFilled, refuse, resolveQuestion, type ApplierDeps, type ApplyResult,
} from './common.js';
import { questionText } from './state.js';

export const FillInput = z.object({ field: FieldIdSchema, ref: RefSchema }).strict();
export type FillInputT = z.infer<typeof FillInput>;

export async function handleFill(input: FillInputT, deps: ApplierDeps): Promise<ApplyResult> {
  const ref = input.ref as AnswerRef;
  return inPage(deps, async ({ page, job, model, raw }) => {
    const f = findField(model, input.field);
    if (!f) return refuse('unknown_field', 'no such field on this page');
    if (f.hidden) return refuse('hidden_field', 'the field is not visible');
    if (f.role === 'password' || f.role === 'password_confirm') return refuse('use_login', 'passwords are handled by the login and sign-up tools');
    if (f.role === 'otp') return refuse('otp_not_supported', 'one-time codes are never entered');
    if (f.type === 'file') return refuse('use_upload', 'use apply_upload for file fields');
    if (f.type === 'select' || f.type === 'radio' || f.type === 'checkbox' || f.role === 'eeo' || f.role === 'consent' || f.role === 'marketing') {
      return refuse('use_choose', 'use apply_choose for this field');
    }

    let value: string | number | boolean | null;
    if (f.role === 'question') {
      const r = await resolveQuestion(f, ref, deps, job, (l) => questionText(l, deps));
      if (!r.ok) return r.result;
      value = r.value;
    } else {
      if (f.role === 'unknown' || f.role === 'cover_letter') {
        return { status: 'needs_owner', code: 'unknown_field_role', question: await questionText(f.label, deps) };
      }
      if (checkRoleRef(f.role, ref) === 'mismatch') return refuse('role_ref_mismatch', 'that reference does not belong to this field');
      if (!deps.answers.has(ref)) return { status: 'needs_owner', code: 'missing_answer', question: await questionText(f.label, deps) };
      value = deps.answers.resolve(ref, { jobLocation: job.location });
      if (value === null || value === undefined || value === '') {
        return { status: 'needs_owner', code: 'missing_answer', question: await questionText(f.label, deps) };
      }
    }
    if (typeof value === 'boolean') return refuse('type_mismatch', 'a yes/no answer belongs to a choice field');

    const dry = dryRunResult(deps, 'apply_fill', { job_id: job.jobId, field: f.id, role: f.role });
    if (dry) return dry;
    await fillGuarded(page, job.host, f.id, String(value));
    noteFilled(deps, { job, model, raw }, f);
    return { status: 'ok', code: 'filled' };
  });
}
