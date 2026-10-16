// apply_submit({}): the one irreversible click. Order (plan 8G-2 task 18): halt, kill switch, dry run,
// APPLY_SUBMIT_MODE=hold, classifier, then (no block, required fields filled, every marketing box
// verified unchecked), then ONE transaction for MAX_APPLIES_PER_DAY (`easy_apply`) and the per-host daily
// counter, then the click, then confirmation. Only a confirmed page writes applications.status='submitted'.
import { z } from 'zod';
import { FIXED_FAIL, clickControl, hostOfUrl, readPage } from '../../webcore/login.js';
import { acceptLegalRequired, enforceCheckboxGate } from '../../webcore/signup.js';
import { hostAllowed } from '../../webcore/runtime.js';
import { loadWebConfig } from '../../webcore/config.js';
import { detectConfirmation } from '../confirm.js';
import {
  blockedResult, consumeSubmitCounters, dryRunResult, envOf, inPage, layoutDriftRefusal, nowOf, preflight, recordApplication, refuse,
  type ApplierDeps, type ApplyResult,
} from './common.js';
import { screenedState } from './state.js';

export const SubmitInput = z.object({}).strict();

/** Anything other than exactly `submit` holds at review (fail closed). */
export const submitMode = (env: NodeJS.ProcessEnv): 'submit' | 'hold' => (env.APPLY_SUBMIT_MODE === 'submit' ? 'submit' : 'hold');

export async function handleSubmit(_input: z.infer<typeof SubmitInput>, deps: ApplierDeps): Promise<ApplyResult> {
  const env = envOf(deps);
  let closeAfter = false;
  const out = await (async (): Promise<ApplyResult> => {
    const g = preflight(deps);
    if (g) return g;
    const job = deps.state.cur;
    if (!job) return refuse('no_job', 'call apply_open first');
    if (job.submitted || deps.db.prepare("SELECT 1 FROM applications WHERE job_id = ? AND status = 'submitted' LIMIT 1").get(job.jobId)) {
      return refuse('already_submitted', 'a submit was already made for this job');
    }
    const dry = dryRunResult(deps, 'apply_submit', { job_id: job.jobId, host: job.host });
    if (dry) return dry;
    if (submitMode(env) !== 'submit') {
      return inPage(deps, async ({ model }) => {
        const s = await screenedState(model, 'read', deps);
        deps.recipes?.noteOutcome({ platform: job.platform, jobId: job.jobId, outcome: 'held' });
        return { status: 'held', code: 'hold_mode', reason: 'APPLY_SUBMIT_MODE is not submit', ...(s.ok ? { state: s.state } : {}) };
      });
    }
    return inPage(deps, async ({ page, job: j, model, layout }): Promise<ApplyResult> => {
      const drift = layoutDriftRefusal(deps, j, model, layout);
      if (drift) return drift;
      const sc = await screenedState(model, 'send', deps);
      if (!sc.ok) return sc.result;

      const gate = await enforceCheckboxGate(page, { acceptLegal: acceptLegalRequired(env) });
      if (gate.model.block) return blockedResult(deps, gate.model);
      if (!gate.ok) {
        deps.escalate?.('needs_owner', `${gate.code} on ${j.host}`);
        return { status: 'needs_owner', code: gate.code };
      }
      const m = gate.model;
      const missing = m.fields
        .filter((f) => !f.hidden && f.required && f.consentClass !== 'marketing' && (f.type === 'checkbox' ? !f.checked : !f.filled))
        .map((f) => f.id);
      if (missing.length > 0) return { status: 'needs_owner', code: 'missing_required', fields: missing };
      const subs = m.controls.filter((c) => c.kind === 'submit');
      if (subs.length === 0) return refuse('no_submit_control', 'no submit control on this page');
      if (subs.length > 1) return refuse('ambiguous_submit', 'more than one submit control on this page');
      if (hostOfUrl(page.url()) !== j.host) return refuse('host_changed', 'the page moved to another host; nothing was submitted');

      const used = consumeSubmitCounters(deps.db, env, j.platform, j.host);
      if (used === 'daily_cap') return { status: 'rate_limited', code: 'daily_cap', reason: 'MAX_APPLIES_PER_DAY reached' };
      if (used === 'host_cap') return { status: 'rate_limited', code: 'host_cap', reason: 'host_cap' };

      // From here a click may have gone out: the job is marked and is never submitted again automatically.
      j.submitted = true;
      closeAfter = true;
      const now = nowOf(deps);
      let after;
      try {
        await clickControl(page, subs[0].id);
        await page.waitForTimeout(loadWebConfig(env).settleMs).catch(() => undefined);
        after = await readPage(page);
      } catch {
        console.error('[applier] submit click failed');
        recordApplication(deps.db, j, 'manual_review', 'submit click failed', now);
        deps.recipes?.noteOutcome({ platform: j.platform, jobId: j.jobId, outcome: 'failed' });
        return { status: 'failed', code: 'error', reason: FIXED_FAIL };
      }
      if (!hostAllowed(page.url(), j.allowedHosts)) {
        recordApplication(deps.db, j, 'manual_review', 'left the application host after submit', now);
        deps.recipes?.noteOutcome({ platform: j.platform, jobId: j.jobId, outcome: 'unconfirmed' });
        return { status: 'unconfirmed', code: 'left_host', reason: 'the page left the application host; check it by hand' };
      }
      const c = detectConfirmation(m, after, deps.recipeSignals?.(j.platform) ?? deps.recipes?.signals(j.platform) ?? null);
      if (c.confirmed) {
        recordApplication(deps.db, j, 'submitted', null, now);
        deps.recipes?.noteOutcome({ platform: j.platform, jobId: j.jobId, outcome: 'confirmed' });
        return { status: 'submitted', code: 'confirmed', reason: c.layer };
      }
      deps.recipes?.noteOutcome({ platform: j.platform, jobId: j.jobId, outcome: 'unconfirmed' });
      recordApplication(deps.db, j, 'manual_review', after.model.block ? `blocked after submit: ${after.model.block}` : 'submit not confirmed', now);
      if (after.model.block) return blockedResult(deps, after.model);
      return { status: 'unconfirmed', code: 'no_confirmation', reason: 'no confirmation was seen; check it by hand' };
    });
  })();
  if (closeAfter) await deps.runtime.close();
  return out;
}
