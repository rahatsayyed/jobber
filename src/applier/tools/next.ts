// apply_next({control}): next, back or save only (submit has its own gated tool). Enforces
// APPLY_MAX_STEPS and re-runs the checkbox gate (marketing unchecked and verified) before leaving a step.
import { z } from 'zod';
import { clickControl, readPage } from '../../webcore/login.js';
import { guardHopPage, settleHost, settleTransit } from '../hostGuard.js';
import { enforceCheckboxGate, acceptLegalRequired } from '../../webcore/signup.js';
import { loadWebConfig } from '../../webcore/config.js';
import { ControlIdSchema } from '../refs.js';
import {
  blockedResult, dryRunResult, envOf, inPage, refuse, type ApplierDeps, type ApplyResult,
} from './common.js';
import { screenedState } from './state.js';

export const NextInput = z.object({ control: ControlIdSchema }).strict();
export type NextInputT = z.infer<typeof NextInput>;

export function maxSteps(env: NodeJS.ProcessEnv): number {
  const raw = env.APPLY_MAX_STEPS;
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return 12;
  return Math.min(50, Math.max(1, Number(raw.trim())));
}

export async function handleNext(input: NextInputT, deps: ApplierDeps): Promise<ApplyResult> {
  const env = envOf(deps);
  let closeAfter = false;
  const result = await inPage(deps, async ({ page, job, model }) => {
    const c = model.controls.find((x) => x.id === input.control);
    if (!c) return refuse('unknown_control', 'no such control on this page');
    if (c.kind !== 'next' && c.kind !== 'back' && c.kind !== 'save' && c.kind !== 'apply') return refuse('control_not_allowed', 'only next, back, save and an Apply control that opens the form are allowed here');
    // An Apply control opens the form or modal of THIS job page. On a listing of many roles it would
    // open an arbitrary one: use apply_list_roles and apply_open_role there.
    if (c.kind === 'apply' && model.stepKind === 'listing') return refuse('listing_page', 'this page lists many roles; use apply_list_roles then apply_open_role');
    if (job.steps >= maxSteps(env)) return refuse('max_steps', 'APPLY_MAX_STEPS reached');

    const dry = dryRunResult(deps, 'apply_next', { job_id: job.jobId, control: c.id, kind: c.kind });
    if (dry) return dry;

    let clickId = c.id;
    if (c.kind !== 'back') {
      const gate = await enforceCheckboxGate(page, { acceptLegal: acceptLegalRequired(env) });
      if (gate.model.block) return blockedResult(deps, gate.model);
      if (!gate.ok) {
        deps.escalate?.('needs_owner', `${gate.code} on ${job.host}`);
        return { status: 'needs_owner', code: gate.code };
      }
      const same = gate.model.controls.find((x) => x.id === c.id && x.kind === c.kind && x.label === c.label);
      if (!same) return refuse('page_changed', 'the page changed; read the state again');
      clickId = same.id;
    }
    const before = settleHost(deps, job, page.url());
    if (before) { closeAfter = true; return before; }
    await clickControl(page, clickId);
    job.steps++;
    await page.waitForTimeout(loadWebConfig(env).settleMs).catch(() => undefined);
    // The click may have moved the page to the real application host (careers site to ATS vendor): an allowed hop goes on, any other host is parked.
    await settleTransit(deps, page, job);
    const after0 = settleHost(deps, job, page.url());
    if (after0) { closeAfter = true; return after0; }
    const after = await readPage(page);
    if (after.model.block) return blockedResult(deps, after.model);
    const unsafeAfter = guardHopPage(deps, job, after.raw);
    if (unsafeAfter) { closeAfter = true; return unsafeAfter; }
    const s = await screenedState(after.model, 'read', deps);
    if (!s.ok) return s.result;
    return { status: 'ok', code: 'moved', state: s.state };
  });
  if (closeAfter) await deps.runtime.close();
  return result;
}
