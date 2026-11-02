// browserctl commit path for LinkedIn Easy Apply: the only code that lets a click of the job page's own Easy Apply control or of a modal step
// control (Next, Review, Submit application) reach the page. Reached from the engine's click when the guard classified the live element as
// linkedin_easy_apply. Order for every click: kill switch and halt -> armed intent of this class -> live re-checks of the job (veto, hard stop,
// already applied) -> the browser is on the armed job's page -> fresh page read, element unchanged -> halt again -> dry run (record, nothing
// clicked) or live.
//   open   (Easy Apply control outside the modal): opens the modal; the intent is re-armed for the steps.
//   step   (Next / Review inside the modal): needs the code-owned fill to have passed for THIS step, at most MAX_EASY_APPLY_STEPS, no risk text
//          (CAPTCHA, verification, premium), no unknown button; an inline validation error after the click parks the job.
//   submit (Submit application): needs the review step after a passing fill; consumes the linkedin_easy_apply ceiling AND the shared
//          MAX_APPLIES_PER_DAY counter together (rolled back together), clicks once, and confirms ONLY by a "sent" text that was not on the page
//          before the click (or the job page now showing Applied after the modal closed). Anything else is `unconfirmed`, never retried.
// Anything unexpected closes the modal and marks the queue row needs_owner with a closed reason code (easyApply.parkNeedsOwner).
import { parseMaxAppliesPerDay } from '../lib/maxApplies.js';
import { getExcludedReason, getFirstHardStop, saveApplication } from '../db.js';
import { checkAndIncrement } from '../lib/rateLimit.js';
import { resolveApplyEscalationsForJob } from '../outreach/applyEscalations.js';
import { loadOutreachConfig } from '../outreach/config.js';
import { tryConsume } from '../outreach/limits.js';
import { recordDryRun } from '../safety/dryRun.js';
import { diagNote, writeCommitDiag } from './diag.js';
import type { BcPage } from './driver.js';
import {
  clearEasyApplyState, closeEasyApplyModal, dialogButtons, easyApplyDialog, easyApplyState, jobNumericIdOfUrl, jobShowsApplied, MAX_EASY_APPLY_STEPS,
  pageTexts, parkNeedsOwner, scanDialog, sentConfirmedNew, VALIDATION_RE, type ParkCode,
} from './easyApply.js';
import { dialogText, effectiveDialogKind } from './commit.js';
import { killReason, type EngineDeps, type EngineResult } from './engineTypes.js';
import { EASY_APPLY_OPEN_RE, EASY_APPLY_SUBMIT_RE, normName } from './guard.js';
import type { ArmedIntent } from './intent.js';
import type { LiveNode, RawTree } from './snapshot.js';

export interface EasyApplyCommitInput {
  deps: EngineDeps;
  page: BcPage;
  live: LiveNode;
  act: () => Promise<void>;
  redescribe: () => Promise<LiveNode | null>;
}

const DEFAULT_MAX_APPLIES_PER_DAY = 5;
const POLL_MS = 400;
const OPEN_WAIT_MS = 10_000;

const sameTarget = (a: LiveNode, b: LiveNode): boolean =>
  a.role === b.role && a.name === b.name && a.dialogName === b.dialogName && (a.dialog === undefined) === (b.dialog === undefined);

const SUBMIT_ERROR_RE = /something went wrong|try again|couldn(?:'|’)?t submit|unable to submit|could not submit/i;

export async function commitEasyApply(i: EasyApplyCommitInput): Promise<EngineResult> {
  const { deps, page, live } = i;
  const { db } = deps;
  const now = (): Date => deps.now();
  const platform = 'linkedin' as const;
  const st = easyApplyState(deps.intents);
  const intent: ArmedIntent | null = deps.intents.peek(platform);
  const abort = (code: string, reason: string, status: EngineResult['status'] = 'refused'): EngineResult => {
    deps.intents.disarm(platform);
    return { ok: false, status, code, reason };
  };

  const k0 = killReason(deps);
  if (k0) return abort(k0.startsWith('kill switch') ? 'killed' : 'halted', k0, 'halted');
  if (!intent) return { ok: false, status: 'refused', code: 'no_armed_intent', reason: 'arm the application with linkedin_arm_send kind easy_apply first' };
  const early = deps.intents.check(platform, 'linkedin_easy_apply');
  if (!early.ok) return abort(early.code, `armed intent refused: ${early.code}`);
  const key = intent.pageKey;
  if (!key || intent.jobId === undefined) return abort('no_armed_intent', 'the armed intent has no job');
  const jobId = String(intent.jobId);
  const ctx = { deps, page, jobId, key };
  const park = async (code: ParkCode): Promise<EngineResult> => await parkNeedsOwner(ctx, code);

  // What was clicked: the page's Easy Apply control, a step control inside the modal, or the final submit.
  const name = normName(live.name);
  const isOpen = live.dialog === undefined && (live.role === 'button' || live.role === 'link') && EASY_APPLY_OPEN_RE.test(name);
  const inModal = live.dialog !== undefined;
  const isSubmit = inModal && EASY_APPLY_SUBMIT_RE.test(name);
  if (!isOpen && !inModal) return { ok: false, status: 'refused', code: 'wrong_control', reason: 'only the Easy Apply control and the modal step controls are clicked under this intent' };

  // Live re-checks of the job: a veto or an earlier application can appear after arming.
  if (getExcludedReason(db, jobId)) return abort('vetoed', 'the job is excluded');
  if (getFirstHardStop(db, jobId)) return abort('hard_stop', 'the job has a hard stop');
  if (db.prepare("SELECT 1 FROM applications WHERE job_id = ? AND status = 'submitted' LIMIT 1").get(jobId)) return abort('already_applied', 'an application was already submitted for this job');
  if (jobNumericIdOfUrl(page.url()) !== key) {
    if (inModal) return await park('unexpected_page');
    return abort('job_mismatch', 'the browser is not on the armed job page');
  }
  if (isOpen && live.role === 'link' && live.href) {
    try {
      const h = new URL(live.href, page.url());
      if (!/(^|\.)linkedin\.com$/i.test(h.hostname)) return abort('external_link', 'this Easy Apply link leaves LinkedIn; it is never followed');
    } catch { return abort('external_link', 'unreadable link'); }
  }

  let before: RawTree;
  try { before = await page.snapshot(); } catch { return abort('no_snapshot', 'could not read the page'); }
  const fresh = live.n >= 0 ? before.nodes.find((x) => x.n === live.n) : undefined;
  if (live.n >= 0 && (!fresh || !sameTarget(fresh, live))) return abort('target_changed', 'page changed under the action; nothing clicked');

  let dlgN: number | undefined;
  if (inModal) {
    // A step control must sit in THE Easy Apply modal; the fill must have passed for this very step; no risk text, no unknown button.
    if (!st.opened.has(key)) return { ok: false, status: 'refused', code: 'modal_not_opened', reason: 'click the Easy Apply control under the armed intent first' };
    const d = easyApplyDialog(before);
    if (d === 'none' || d === 'ambiguous' || live.dialog !== d.n || effectiveDialogKind(before, live.dialog!, live.dialogName) !== 'easy_apply') {
      return await park(d === 'ambiguous' ? 'modal_ambiguous' : 'no_modal');
    }
    dlgN = d.n;
    const risk = scanDialog(before, dlgN);
    if (risk) return await park(risk);
    const steps = st.steps.get(key) ?? 0;
    if (steps >= MAX_EASY_APPLY_STEPS) return await park('more_than_8_steps');
    if (st.fillOk.get(key) !== steps) return { ok: false, status: 'refused', code: 'fill_required', reason: 'call linkedin_easy_apply_fill for this step before clicking Next, Review or Submit' };
    if (isSubmit && !dialogButtons(before, dlgN).some((b) => EASY_APPLY_SUBMIT_RE.test(b.name))) return await park('unknown_button');
  } else if (st.opened.has(key)) {
    return abort('already_open', 'the Easy Apply modal is already open for this job');
  }

  const again = await i.redescribe().catch(() => null);
  if (!again || !sameTarget(again, live)) return abort('target_changed', 'page changed under the action; nothing clicked');
  const k1 = killReason(deps);
  if (k1) return abort(k1.startsWith('kill switch') ? 'killed' : 'halted', k1, 'halted');

  // Dry run: record, nothing clicked, the intent is dropped.
  if (intent.dry || deps.cfg.dryRun) {
    recordDryRun(db, {
      runId: deps.env.JOBBER_RUN_ID ?? null, action: 'linkedin_easy_apply', platform,
      payload: { job_id: jobId, control: name.slice(0, 40), step: isOpen ? 'open' : isSubmit ? 'submit' : 'next' },
    }, now(), deps.env);
    deps.intents.disarm(platform);
    return { ok: true, status: 'dry_run', code: 'dry_run' };
  }

  const reArm = (): void => {
    deps.intents.arm({ platform, kind: intent.kind, class: 'linkedin_easy_apply', jobId: intent.jobId, pageKey: key, text: null, dry: false, ...(intent.company ? { company: intent.company } : {}), ...(intent.attachment ? { attachment: intent.attachment } : {}) });
  };
  const click = async (): Promise<boolean> => {
    try { if (live.n >= 0 && page.robustClick) await page.robustClick(live.n); else await i.act(); return true; } catch { return false; }
  };

  // ---- open ----
  if (isOpen) {
    if (!(await click())) return abort('click_failed', 'the Easy Apply click failed; nothing was entered', 'failed');
    const t0 = Date.now();
    let waited = 0;
    let tree: RawTree | null = null;
    while (waited < OPEN_WAIT_MS) {
      await page.waitMs(deps.settleMs ?? POLL_MS).catch(() => undefined);
      waited += deps.settleMs ?? POLL_MS;
      try { tree = await page.snapshot(); } catch { tree = null; }
      if (tree) {
        const d = easyApplyDialog(tree);
        if (d !== 'none' && d !== 'ambiguous') break;
      }
      if (Date.now() - t0 > OPEN_WAIT_MS || waited >= (deps.dialogWaitMs ?? OPEN_WAIT_MS)) break;
    }
    const d = tree ? easyApplyDialog(tree) : 'none';
    if (!tree || d === 'none' || d === 'ambiguous') {
      const dg = await writeCommitDiag(deps, page, { platform, code: 'no_dialog_after_apply', live, urlBefore: before.url, after: tree });
      const out = await parkNeedsOwner(ctx, d === 'ambiguous' ? 'modal_ambiguous' : 'no_modal');
      return { ...out, reason: `${out.reason}${diagNote(dg)}` };
    }
    const risk = scanDialog(tree, d.n);
    if (risk) return await park(risk);
    st.opened.add(key);
    st.steps.set(key, 0);
    reArm();
    return { ok: true, code: 'modal_opened', reason: 'the Easy Apply modal is open: call linkedin_easy_apply_fill, then click Next, Review or Submit application' };
  }

  // ---- next / review ----
  if (!isSubmit) {
    if (!(await click())) return abort('click_failed', 'the click failed', 'failed');
    st.steps.set(key, (st.steps.get(key) ?? 0) + 1);
    await page.waitMs(deps.settleMs ?? POLL_MS).catch(() => undefined);
    let after: RawTree;
    try { after = await page.snapshot(); } catch { return await park('no_modal'); }
    const d = easyApplyDialog(after);
    if (d === 'none' || d === 'ambiguous') return await park(d === 'none' ? 'no_modal' : 'modal_ambiguous');
    const risk = scanDialog(after, d.n);
    if (risk) return await park(risk);
    if (VALIDATION_RE.test(dialogText(after, d.n))) return await park('validation_error');
    reArm();
    return { ok: true, code: 'step_ok', reason: 'next step: call linkedin_easy_apply_fill again' };
  }

  // ---- submit ----
  const ocfg = loadOutreachConfig(deps.env);
  const max = parseMaxAppliesPerDay(deps.env);
  if (!st.counted.has(key)) {
    // linkedin_easy_apply first; when the shared daily counter then refuses, the event just recorded is removed so a refusal leaves BOTH unconsumed.
    if (!tryConsume(db, 'linkedin_easy_apply', ocfg, now())) {
      await closeEasyApplyModal(page);
      clearEasyApplyState(deps.intents, key);
      return abort('rate_limited', 'linkedin_easy_apply ceiling reached, Submit NOT clicked', 'rate_limited');
    }
    const ev = db.prepare("SELECT MAX(id) AS id FROM rate_events WHERE key = 'linkedin_easy_apply'").get() as { id: number | null };
    if (!checkAndIncrement(db, 'easy_apply', max)) {
      if (ev.id !== null) db.prepare('DELETE FROM rate_events WHERE id = ?').run(ev.id);
      await closeEasyApplyModal(page);
      clearEasyApplyState(deps.intents, key);
      return abort('rate_limited', `daily apply limit (${max}) reached, Submit NOT clicked`, 'rate_limited');
    }
    st.counted.add(key);
    st.baseline.set(key, pageTexts(before));
  }
  const baseline = st.baseline.get(key) ?? pageTexts(before);
  const record = (status: 'submitted' | 'manual_review', reason: string | null): void => {
    try {
      saveApplication(db, { job_id: jobId, platform: 'linkedin', method: 'easy_apply', account: 'linkedin-main', status, reason, applied_at: status === 'submitted' ? now().toISOString() : null });
      db.prepare("UPDATE outreach_queue SET apply_status = ?, apply_note = ?, updated_at = datetime('now') WHERE job_id = ?").run(status, status === 'submitted' ? null : `easy_apply:${reason ?? 'unconfirmed'}`, jobId);
      if (status === 'submitted') resolveApplyEscalationsForJob(db, jobId, now());
    } catch { /* the counters stay spent; the log line below still tells the owner */ }
  };
  const finishUp = async (): Promise<void> => {
    await closeEasyApplyModal(page);
    clearEasyApplyState(deps.intents, key);
    deps.intents.disarm(platform);
  };

  if (!(await click())) {
    // The click may have gone through: counters stay spent, the application is unresolved.
    record('manual_review', 'submit_click_failed');
    await finishUp();
    return { ok: false, status: 'unconfirmed', code: 'unconfirmed', reason: 'error at the Submit click; check the application by hand' };
  }
  const maxMs = deps.confirmTimeoutMs ?? 8000;
  const polls = Math.max(1, Math.ceil(maxMs / POLL_MS));
  let after: RawTree | null = null;
  let errored = false;
  for (let p = 0; p < polls; p++) {
    await page.waitMs(p === 0 ? (deps.settleMs ?? 800) : POLL_MS).catch(() => undefined);
    try { after = await page.snapshot(); } catch { after = null; break; }
    if (sentConfirmedNew(baseline, after)) {
      record('submitted', null);
      await finishUp();
      return { ok: true, status: 'sent', code: 'applied' };
    }
    const d = easyApplyDialog(after);
    if (d !== 'none' && d !== 'ambiguous' && SUBMIT_ERROR_RE.test(dialogText(after, d.n))) { errored = true; break; }
  }
  // The modal may have closed on its own: the job page itself must now show Applied (text that was not there before the click).
  if (after && !errored && easyApplyDialog(after) === 'none' && jobShowsApplied(after) && !jobShowsApplied(before)) {
    record('submitted', null);
    await finishUp();
    return { ok: true, status: 'sent', code: 'applied' };
  }
  const dg = await writeCommitDiag(deps, page, { platform, code: 'unconfirmed', live, urlBefore: before.url, after });
  record('manual_review', errored ? 'submit_error' : 'unconfirmed');
  await finishUp();
  return {
    ok: false, status: 'unconfirmed', code: errored ? 'submit_error' : 'unconfirmed',
    reason: `Submit was clicked but ${errored ? 'the page shows an error' : 'no confirmation was seen'}; check the application by hand, it is never retried${diagNote(dg)}`,
  };
}
