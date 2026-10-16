// apply_choose({field, option, ref?}): select, radio and checkbox fields. The option must be one the
// page itself lists; for a question the answer book decides which option is right (boolean -> Yes/No),
// for self-identification only the explicit decline option is ever chosen, marketing boxes are never
// checked (a pre-checked one is unchecked by code and verified), and consent follows D12.
import { z } from 'zod';
import { clickField, hostOfUrl, readPage } from '../../webcore/login.js';
import { acceptLegalRequired } from '../../webcore/signup.js';
import type { AnswerRef } from '../../apply/answers.js';
import type { LiPage } from '../../webcore/launch.js';
import type { FormField } from '../../webcore/formModel.js';
import { DECLINE_RE, FieldIdSchema, matchOption, normOpt, RefSchema, yesNoOption } from '../refs.js';
import {
  dryRunResult, envOf, failedResult, findField, inPage, refuse, resolveQuestion, type ApplierDeps, type ApplyResult, type OpenJob,
} from './common.js';
import { questionText } from './state.js';

export const ChooseInput = z.object({
  field: FieldIdSchema,
  // A label picked from the options the page lists; code checks it against that list.
  option: z.string().min(1).max(80),
  ref: RefSchema.optional(),
}).strict();
export type ChooseInputT = z.infer<typeof ChooseInput>;

const idx = (id: string): number => Number(id.slice(1)) - 1;
const YES = /^(yes|check|checked|true)$/i;

// One code-built, parameter-free-of-page-text script: the option label is embedded as a JSON string
// literal and only a listed option ever reaches it.
function radioScript(index: number, option: string): string {
  return `/*apply_radio*/(() => {
  const a = document.querySelector('[data-jf="${index}"]');
  if (!a) return false;
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const labelOf = (e) => { let t = ''; if (e.id) { const l = document.querySelector('label[for="' + CSS.escape(e.id) + '"]'); if (l) t = l.textContent; } if (!t) { const w = e.closest('label'); if (w) t = w.textContent; } if (!t) t = e.getAttribute('aria-label') || e.getAttribute('value') || ''; return norm(t); };
  const want = norm(${JSON.stringify(option)});
  const group = Array.from(document.querySelectorAll('input[type=radio]')).filter((r) => r.name === a.name);
  const t = group.find((r) => labelOf(r) === want);
  if (!t) return false;
  t.click();
  return t.checked === true;
})()`;
}

async function doChoose(page: LiPage, f: FormField, option: string): Promise<boolean> {
  if (f.type === 'select') {
    const loc = page.locator(`[data-jf="${idx(f.id)}"]`).first();
    if (!loc.selectOption) return false;
    try { await loc.selectOption({ label: option }, { timeout: 10000 }); return true; } catch { return false; }
  }
  try { return (await page.evaluate<boolean>(radioScript(idx(f.id), option))) === true; } catch { return false; }
}

export async function handleChoose(input: ChooseInputT, deps: ApplierDeps): Promise<ApplyResult> {
  const ref = input.ref as AnswerRef | undefined;
  return inPage(deps, async ({ page, job, model }) => {
    const f = findField(model, input.field);
    if (!f) return refuse('unknown_field', 'no such field on this page');
    if (f.hidden) return refuse('hidden_field', 'the field is not visible');
    if (f.type === 'checkbox') return chooseCheckbox(page, f, input.option, deps, job);
    if (f.type !== 'select' && f.type !== 'radio') return refuse('use_fill', 'use apply_fill for text fields');
    if (f.role === 'password' || f.role === 'password_confirm' || f.role === 'otp') return refuse('use_login', 'not a choice field');
    const options = f.options ?? [];

    let chosen: string | null;
    if (f.role === 'eeo') {
      if (!options.some((o) => DECLINE_RE.test(o))) {
        return { status: 'needs_owner', code: 'eeo_no_decline', question: await questionText(f.label, deps) };
      }
      chosen = matchOption(options, input.option);
      if (!chosen) return refuse('option_not_listed', 'that option is not on the page');
      if (!DECLINE_RE.test(chosen)) return refuse('eeo_decline_only', 'only the decline option is chosen for self-identification');
    } else if (f.role === 'question') {
      const r = await resolveQuestion(f, ref, deps, job, (l) => questionText(l, deps));
      if (!r.ok) return r.result;
      const derived = typeof r.value === 'boolean' ? yesNoOption(r.value, options) : matchOption(options, String(r.value));
      if (!derived) return { status: 'needs_owner', code: 'option_not_listed', question: await questionText(f.label, deps) };
      chosen = matchOption(options, input.option);
      if (!chosen) return refuse('option_not_listed', 'that option is not on the page');
      if (normOpt(chosen) !== normOpt(derived)) return refuse('option_mismatch', 'that option is not the one the answer book gives');
    } else {
      return { status: 'needs_owner', code: 'unknown_field_role', question: await questionText(f.label, deps) };
    }

    const dry = dryRunResult(deps, 'apply_choose', { job_id: job.jobId, field: f.id, role: f.role });
    if (dry) return dry;
    if (hostOfUrl(page.url()) !== job.host) return refuse('host_changed', 'the page moved to another host; nothing was chosen');
    if (!(await doChoose(page, f, chosen))) return failedResult();
    return { status: 'ok', code: 'chosen' };
  });
}

async function chooseCheckbox(page: LiPage, f: FormField, option: string, deps: ApplierDeps, job: OpenJob): Promise<ApplyResult> {
  const cls = f.consentClass;
  if (cls === 'marketing') {
    // Never checked. A pre-checked box is clicked once and the page is re-read to verify.
    if (!f.checked) return { status: 'ok', code: 'marketing_unchecked' };
    const dry = dryRunResult(deps, 'apply_choose', { job_id: job.jobId, field: f.id, role: 'marketing' });
    if (dry) return dry;
    await clickField(page, f.id);
    const again = (await readPage(page)).model.fields.find((x) => x.id === f.id);
    if (!again || again.checked) {
      deps.escalate?.('needs_owner', `marketing_checkbox on ${job.host}`);
      return { status: 'needs_owner', code: 'marketing_checkbox', question: await questionText(f.label, deps) };
    }
    return { status: 'ok', code: 'marketing_unchecked' };
  }
  if (cls === 'legal_required' && f.required && acceptLegalRequired(envOf(deps))) {
    if (!YES.test(option.trim())) return refuse('option_not_listed', 'the only choice for this box is yes');
    if (f.checked) return { status: 'ok', code: 'consent_checked' };
    const dry = dryRunResult(deps, 'apply_choose', { job_id: job.jobId, field: f.id, role: 'consent' });
    if (dry) return dry;
    await clickField(page, f.id);
    const again = (await readPage(page)).model.fields.find((x) => x.id === f.id);
    if (!again?.checked) return { status: 'needs_owner', code: 'consent', question: await questionText(f.label, deps) };
    return { status: 'ok', code: 'consent_checked' };
  }
  // Attestations, background checks, data sharing, a legal box the owner switched off, any other box.
  return { status: 'needs_owner', code: 'consent', question: await questionText(f.label, deps) };
}
