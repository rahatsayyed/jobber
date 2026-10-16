// apply_next({control}): next, back or save only (submit has its own gated tool). Enforces
// APPLY_MAX_STEPS and re-runs the checkbox gate (marketing unchecked and verified) before leaving a step.
import { z } from 'zod';
import { clickControl, hostOfUrl, readPage } from '../../webcore/login.js';
import { enforceCheckboxGate, acceptLegalRequired } from '../../webcore/signup.js';
import { hostAllowed } from '../../webcore/runtime.js';
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
    if (c.kind !== 'next' && c.kind !== 'back' && c.kind !== 'save') return refuse('control_not_allowed', 'only next, back and save are allowed here');
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
    if (hostOfUrl(page.url()) !== job.host) return refuse('host_changed', 'the page moved to another host; nothing was clicked');
    await clickControl(page, clickId);
    job.steps++;
    await page.waitForTimeout(loadWebConfig(env).settleMs).catch(() => undefined);
    if (!hostAllowed(page.url(), job.allowedHosts)) {
      closeAfter = true;
      deps.state.cur = null;
      return refuse('host_changed', 'the click left the application host; the session was closed');
    }
    const after = await readPage(page);
    if (after.model.block) return blockedResult(deps, after.model);
    const s = await screenedState(after.model, 'read', deps);
    if (!s.ok) return s.result;
    return { status: 'ok', code: 'moved', state: s.state };
  });
  if (closeAfter) await deps.runtime.close();
  return result;
}
