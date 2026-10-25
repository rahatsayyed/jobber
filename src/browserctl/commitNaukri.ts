// browserctl commit path for Naukri: the only code that lets a Naukri send (thread composer Send or
// Enter) or an apply step (the job page Apply button and the chatbot controls) reach the page.
// Reached from the engine's click, press_key and click_at when the guard classified the live element as
// naukri_send or naukri_apply.
//
// naukri_send:  kill switch and halt -> armed intent -> fresh page read (thread id in the URL equals the
//   armed thread, header name equals the armed person, live composer text equals the armed text) ->
//   element unchanged -> halt again -> dry run (record, disarm) or live (consume the intent, tryConsume
//   naukri_message right before the click, watch for a 2xx POST, click, confirm by composer cleared AND
//   (our message echoed in the thread OR a 2xx POST)) -> finishTouch, thread and contact state.
//   Unconfirmed or error after the click counts toward the three-failure naukri halt.
// naukri_apply: the Apply click on the armed job's page consumes naukri_apply plus the shared easy_apply
//   counter once per job (rolled back together), dry run records and does not click; chatbot steps need
//   that counted Apply, are capped and re-checked through the text gate. A confirmation is only text that
//   was NOT on the page before the Apply click (a job description can never confirm itself).
// Anything after a click that cannot be confirmed is 'unconfirmed', never guessed.
import type BetterSqlite3 from 'better-sqlite3';
import { getExcludedReason, getFirstHardStop, saveApplication } from '../db.js';
import { checkAndIncrement } from '../lib/rateLimit.js';
import { finishTouch } from '../linkedin/touches.js';
import { naukriJobIdOfUrl, threadRefOfUrl } from '../naukri/page.js';
import { bumpFailures, loadNaukriPerson, norm, recordNaukriSent } from '../naukri/sendState.js';
import { loadOutreachConfig } from '../outreach/config.js';
import { tryConsume } from '../outreach/limits.js';
import { loadTuning } from '../outreach/tuning.js';
import { recordDryRun } from '../safety/dryRun.js';
import { diagNote, hostKind, nearButtonNames, writeCommitDiag, type DiagExtra } from './diag.js';
import type { BcPage } from './driver.js';
import { killReason, type EngineDeps, type EngineResult } from './engineTypes.js';
import { isNaukriApplyName, normName } from './guard.js';
import type { ArmedIntent, IntentStore } from './intent.js';
import { bindTouchRelease } from './intent.js';
import type { LiveNode, RawTree } from './snapshot.js';

export interface NaukriCommitInput {
  deps: EngineDeps;
  page: BcPage;
  cls: 'naukri_send' | 'naukri_apply';
  live: LiveNode;
  act: () => Promise<void>;
  redescribe: () => Promise<LiveNode | null>;
}

export const DEFAULT_MAX_APPLIES_PER_DAY = 5;
export const MAX_CHATBOT_STEPS = 20;
const CONFIRM_RE = /(applied to\s*["“'].+["”']|successfully applied|application (has been )?(submitted|sent)|you have successfully applied)/i;

const sameTarget = (a: LiveNode, b: LiveNode): boolean =>
  a.role === b.role && a.name === b.name && a.dialogName === b.dialogName && (a.dialog === undefined) === (b.dialog === undefined);

// ---- per-process apply state (keyed by the IntentStore the arm tool and the engine share) ----
interface ApplyState {
  /** Job keys whose Apply click already consumed the counters (dedupe). */
  counted: Set<string>;
  /** Page texts present before the Apply click, per job key. */
  baseline: Map<string, Set<string>>;
  steps: Map<string, number>;
  // Job keys whose Apply click was ignored by the page: never clicked again in this process.
  ignored: Set<string>;
  // Job keys whose application moved to a followed naukri.com popup (the page URL is no longer the job page).
  adopted: Set<string>;
}
const states = new WeakMap<IntentStore, ApplyState>();
function applyState(intents: IntentStore): ApplyState {
  let s = states.get(intents);
  if (!s) { s = { counted: new Set(), baseline: new Map(), steps: new Map(), ignored: new Set(), adopted: new Set() }; states.set(intents, s); }
  return s;
}
/** Job keys whose Apply was counted in this process. */
export const applyCounted = (intents: IntentStore): Set<string> => applyState(intents).counted;

// ---- page helpers ----
/** Text a confirmation can come from: text, headings and control names, never field values. */
export function pageTexts(tree: RawTree): Set<string> {
  const out = new Set<string>();
  for (const x of tree.nodes) {
    if (x.role === 'textbox' || x.role === 'searchbox') continue;
    const t = norm(x.role === 'text' ? x.text : x.name).slice(0, 300);
    if (t) out.add(t);
  }
  return out;
}

/** An applied confirmation that was not on the page before: a new confirmation sentence or a new "Applied" control. */
export function confirmedNew(before: Set<string>, after: RawTree): boolean {
  for (const t of pageTexts(after)) {
    if (before.has(t)) continue;
    if (/\?\s*$/.test(t)) continue; // a bot question that merely mentions applying
    if (CONFIRM_RE.test(t) || t === 'applied') return true;
  }
  return false;
}

const chatbotOpen = (tree: RawTree): boolean =>
  tree.nodes.some((x) => x.composer === true && !x.secret);

function recordApplied(db: BetterSqlite3.Database, jobId: string, now: Date): boolean {
  const existing = db.prepare("SELECT 1 FROM applications WHERE job_id = ? AND platform = 'naukri' AND status = 'submitted' LIMIT 1").get(jobId);
  if (existing) return false;
  saveApplication(db, {
    job_id: jobId, platform: 'naukri', method: 'chatbot', account: 'naukri', status: 'submitted',
    reason: null, applied_at: now.toISOString(),
  });
  return true;
}

/**
 * Called by the engine after every read: when the armed apply job's page now shows a confirmation that
 * was not there before the Apply click, record the application once and disarm.
 */
export function observeApplyConfirmation(deps: EngineDeps, tree: RawTree): void {
  const armed = deps.intents.peek('naukri');
  if (!armed || armed.class !== 'naukri_apply' || !armed.pageKey || armed.jobId === undefined) return;
  const st = applyState(deps.intents);
  const base = st.baseline.get(armed.pageKey);
  if (!st.counted.has(armed.pageKey) || !base) return;
  if (!st.adopted.has(armed.pageKey) && naukriJobIdOfUrl(tree.url) !== armed.pageKey) return;
  if (!confirmedNew(base, tree)) return;
  recordApplied(deps.db, String(armed.jobId), deps.now());
  deps.intents.disarm('naukri');
}

export async function commitNaukri(i: NaukriCommitInput): Promise<EngineResult> {
  return i.cls === 'naukri_send' ? commitSend(i) : commitApply(i);
}

// ---------------------------------------------------------------------------------------------
// naukri_send
// ---------------------------------------------------------------------------------------------
const isNaukriPost = (r: unknown): boolean => {
  try {
    const x = r as { url(): string; status(): number; request(): { method(): string } };
    const h = new URL(x.url()).hostname.toLowerCase();
    return (h === 'naukri.com' || h.endsWith('.naukri.com')) && x.request().method() === 'POST' && x.status() >= 200 && x.status() < 300;
  } catch { return false; }
};

/** Recipient shown in the thread header: the first heading outside any dialog, '' when none. */
export function threadHeaderName(tree: RawTree): string {
  return tree.nodes.find((x) => x.role === 'heading' && x.dialog === undefined && x.name)?.name ?? '';
}

const echoCount = (tree: RawTree, want: string): number =>
  tree.nodes.filter((x) => x.role !== 'textbox' && x.role !== 'searchbox' && norm(x.role === 'text' ? x.text : x.name).includes(want)).length;

async function commitSend(i: NaukriCommitInput): Promise<EngineResult> {
  const { deps, page, live } = i;
  const { db } = deps;
  bindTouchRelease(deps.intents, db);
  deps.intents.sweep();
  const now = () => deps.now();
  const platform = 'naukri' as const;
  const runId = deps.env.JOBBER_RUN_ID ?? null;
  let intent: ArmedIntent | null = deps.intents.peek(platform);
  let clickIssued = false;

  const release = (status: 'failed' | 'unconfirmed' | 'refused'): void => {
    if (intent?.touchId !== undefined && !intent.dry) finishTouch(db, intent.touchId, status, now());
  };
  const abort = (code: string, reason: string, o: { status?: EngineResult['status'] } = {}): EngineResult => {
    release('failed');
    deps.intents.disarm(platform);
    return { ok: false, status: o.status ?? 'refused', code, reason };
  };

  // 1. kill switch and halt
  const k0 = killReason(deps);
  if (k0) return abort('halted', k0, { status: 'halted' });

  // 2. armed intent of the right class
  if (!intent) return { ok: false, status: 'refused', code: 'no_armed_intent', reason: 'arm the send with naukri_arm_send first' };
  const early = deps.intents.check(platform, 'naukri_send', intent.text);
  if (!early.ok) return abort(early.code, `armed intent refused: ${early.code}`);

  // 3. recipient on file, consistent with the intent
  const p = intent.personId === undefined ? null : loadNaukriPerson(db, intent.personId);
  if (!p || p.platform !== 'naukri' || !p.name || !intent.threadRef) return abort('unknown_recipient', 'armed recipient is not a known person');
  const threadRef = intent.threadRef;

  // 4. fresh page read
  let tree: RawTree;
  try { tree = await page.snapshot(); } catch { return abort('no_snapshot', 'could not read the page'); }
  const fresh = live.n >= 0 ? tree.nodes.find((x) => x.n === live.n) : undefined;
  if (live.n >= 0 && (!fresh || !sameTarget(fresh, live))) return abort('target_changed', 'page changed under the action; nothing clicked');

  // 5. live thread and recipient: the URL's thread id is the armed thread and the header names the armed person
  const url = page.url();
  if (threadRefOfUrl(url) !== threadRef) return abort('thread_mismatch', 'browser is not on the armed thread');
  const head = threadHeaderName(tree);
  if (!head) return abort('recipient_unverified', 'could not read the recipient name in the thread header');
  const h = norm(head);
  if (h !== norm(p.name) && h !== norm(p.profile_key)) return abort('recipient_mismatch', 'thread header names a different person');

  // 6. live composer text equals the armed text
  const boxes = tree.nodes.filter((x) => x.role === 'textbox' && x.composer && !x.secret);
  if (boxes.length !== 1) return abort(boxes.length === 0 ? 'composer_missing' : 'ambiguous_composer', 'expected exactly one message field');
  const box = boxes[0];
  const ln = await page.describe(box.n).catch(() => null);
  const chk = deps.intents.check(platform, 'naukri_send', ln?.value);
  if (!chk.ok) return abort(chk.code, `armed intent refused: ${chk.code}`);
  intent = chk.intent;

  // 7. element unchanged, halt again
  const again = await i.redescribe().catch(() => null);
  if (!again || !sameTarget(again, live)) return abort('target_changed', 'page changed under the action; nothing clicked');
  const k1 = killReason(deps);
  if (k1) return abort('halted', k1, { status: 'halted' });

  // 8. dry run: record, disarm, nothing clicked
  if (intent.dry || deps.cfg.dryRun) {
    recordDryRun(db, {
      runId, action: 'naukri_send', platform, personId: p.id,
      payload: { kind: intent.kind, thread_ref: intent.threadRef, job_id: intent.jobId ?? null, chars: intent.text?.length ?? 0, recipient: p.name },
    }, now(), deps.env);
    deps.intents.disarm(platform);
    return { ok: true, status: 'dry_run', code: 'dry_run' };
  }

  // 9. live: single-use intent, ceiling right before the click
  const used = deps.intents.consume(platform, intent.id);
  if (!used.ok) return abort(used.code, `armed intent refused: ${used.code}`);
  const ocfg = loadOutreachConfig(deps.env);
  if (!tryConsume(db, 'naukri_message', ocfg, now())) {
    release('refused');
    return { ok: false, status: 'rate_limited', code: 'rate_limited', reason: 'naukri_message ceiling reached' };
  }

  const text = intent.text ?? '';
  const want = norm(text).slice(0, 60);
  const echoBefore = echoCount(tree, want);
  const net = page.waitForResponse(isNaukriPost, deps.confirmTimeoutMs ?? 8000).then(() => true, () => false);
  try {
    clickIssued = true;
    await i.act();
    const confirmedNet = await net;
    await page.waitMs(deps.settleMs ?? 800).catch(() => undefined);
    const after = await page.snapshot();
    const box2 = after.nodes.find((x) => x.role === 'textbox' && x.composer && !x.secret);
    const cleared = box2 ? !box2.value : false;
    const echoed = echoCount(after, want) > echoBefore;
    const touch = intent.touchId !== undefined ? { touch_id: intent.touchId } : {};
    if (cleared && (echoed || confirmedNet)) {
      if (intent.touchId !== undefined) finishTouch(db, intent.touchId, 'sent', now());
      const ok = recordNaukriSent(db, p, threadRef, intent.kind, runId, now(), loadTuning(deps.env));
      return { ok: true, status: 'sent', code: ok ? 'sent' : 'sent_bookkeeping_failed', ...touch };
    }
    release('unconfirmed');
    try { bumpFailures(db, runId, now()); } catch { /* best effort */ }
    const dg = await writeCommitDiag(deps, page, { platform, code: 'unconfirmed', live, urlBefore: url, after });
    return {
      ok: false, status: 'unconfirmed', code: 'unconfirmed', ...touch,
      reason: `clicked but not confirmed (${confirmedNet ? 'response seen' : 'no response'}, ${echoed ? 'echo seen' : 'no echo'}, ${cleared ? 'composer cleared' : 'composer not cleared'}); verify manually${diagNote(dg)}`,
    };
  } catch {
    // A throw before the click is a failure; after it the message may have gone out: never auto-retry.
    if (clickIssued) {
      release('unconfirmed');
      try { bumpFailures(db, runId, now()); } catch { /* best effort */ }
      const dg0 = await writeCommitDiag(deps, page, { platform, code: 'unconfirmed', live, urlBefore: url, after: null });
      return { ok: false, status: 'unconfirmed', code: 'unconfirmed', reason: `error after the click; verify manually${diagNote(dg0)}` };
    }
    release('failed');
    return { ok: false, status: 'failed', code: 'error', reason: 'unexpected error before sending' };
  } finally {
    deps.intents.disarm(platform);
  }
}

// ---------------------------------------------------------------------------------------------
// naukri_apply
// ---------------------------------------------------------------------------------------------
async function commitApply(i: NaukriCommitInput): Promise<EngineResult> {
  const { deps, page, live } = i;
  const { db } = deps;
  const now = () => deps.now();
  const platform = 'naukri' as const;
  const st = applyState(deps.intents);
  const intent: ArmedIntent | null = deps.intents.peek(platform);
  const abort = (code: string, reason: string, status: EngineResult['status'] = 'refused'): EngineResult => {
    deps.intents.disarm(platform);
    return { ok: false, status, code, reason };
  };

  const k0 = killReason(deps);
  if (k0) return abort('halted', k0, 'halted');
  if (!intent) return { ok: false, status: 'refused', code: 'no_armed_intent', reason: 'arm the apply with naukri_arm_apply first' };
  const early = deps.intents.check(platform, 'naukri_apply');
  if (!early.ok) return abort(early.code, `armed intent refused: ${early.code}`);
  const key = intent.pageKey;
  if (!key || intent.jobId === undefined) return abort('no_armed_intent', 'the armed intent has no job');
  const jobId = String(intent.jobId);
  const urlBefore = page.url();
  if (st.ignored.has(key)) return abort('apply_click_ignored', 'Apply was already ignored by the page for this job in this run; not retried');

  // Live re-checks of the job: vetoes and an earlier application can appear after arming.
  if (getExcludedReason(db, jobId)) return abort('vetoed', 'the job is excluded');
  if (getFirstHardStop(db, jobId)) return abort('hard_stop', 'the job has a hard stop');
  if (db.prepare("SELECT 1 FROM applications WHERE job_id = ? AND status = 'submitted' LIMIT 1").get(jobId)) {
    return abort('already_applied', 'an application was already submitted for this job');
  }
  if (!st.adopted.has(key) && naukriJobIdOfUrl(page.url()) !== key) return abort('job_mismatch', 'browser is not on the armed job page');

  let before: RawTree;
  try { before = await page.snapshot(); } catch { return abort('no_snapshot', 'could not read the page'); }
  const fresh = live.n >= 0 ? before.nodes.find((x) => x.n === live.n) : undefined;
  if (live.n >= 0 && (!fresh || !sameTarget(fresh, live))) return abort('target_changed', 'page changed under the action; nothing clicked');

  const isApplyClick = (live.role === 'button' || live.role === 'link') && isNaukriApplyName(live.name);
  const counted = st.counted.has(key);

  if (isApplyClick) {
    // 1. Apply button on the armed job's page
  } else {
    // 2. chatbot step: only after the counted Apply, capped, re-checked through the text gate
    if (!counted) return abort('apply_not_started', 'click Apply under the armed intent before using the chatbot');
    const n = (st.steps.get(key) ?? 0) + 1;
    if (n > MAX_CHATBOT_STEPS) return abort('too_many_steps', 'too many chatbot steps for one application');
    st.steps.set(key, n);
    const box = before.nodes.find((x) => x.role === 'textbox' && x.composer && !x.secret);
    if (box) {
      const ln = await page.describe(box.n).catch(() => null);
      const why = deps.textGate?.(ln?.value ?? '', 'chatbot');
      if (why) return abort('output_gate', `chatbot answer refused: ${why}`);
    }
  }

  const again = await i.redescribe().catch(() => null);
  if (!again || !sameTarget(again, live)) return abort('target_changed', 'page changed under the action; nothing clicked');
  const k1 = killReason(deps);
  if (k1) return abort('halted', k1, 'halted');

  if (intent.dry || deps.cfg.dryRun) {
    recordDryRun(db, {
      runId: deps.env.JOBBER_RUN_ID ?? null, action: 'naukri_apply', platform,
      payload: { job_id: jobId, control: normName(live.name).slice(0, 40), apply_click: isApplyClick },
    }, now(), deps.env);
    deps.intents.disarm(platform);
    return { ok: true, status: 'dry_run', code: 'dry_run' };
  }

  if (isApplyClick && !counted) {
    const ocfg = loadOutreachConfig(deps.env);
    const maxRaw = Number(deps.env.MAX_APPLIES_PER_DAY ?? DEFAULT_MAX_APPLIES_PER_DAY);
    const max = Number.isFinite(maxRaw) && maxRaw >= 0 ? maxRaw : DEFAULT_MAX_APPLIES_PER_DAY;
    // Consume naukri_apply first; if the shared daily counter then refuses, remove the event just recorded
    // so a refusal leaves BOTH counters unconsumed.
    if (!tryConsume(db, 'naukri_apply', ocfg, now())) {
      return { ok: false, status: 'rate_limited', code: 'rate_limited', reason: 'naukri_apply ceiling reached, Apply NOT clicked' };
    }
    const ev = db.prepare("SELECT MAX(id) AS id FROM rate_events WHERE key = 'naukri_apply'").get() as { id: number | null };
    if (!checkAndIncrement(db, 'easy_apply', max)) {
      if (ev.id !== null) db.prepare('DELETE FROM rate_events WHERE id = ?').run(ev.id);
      return { ok: false, status: 'rate_limited', code: 'rate_limited', reason: `daily apply limit (${max}) reached, Apply NOT clicked` };
    }
    st.counted.add(key);
    st.baseline.set(key, pageTexts(before));
  }

  // A real pointer click for the Apply control when the page offers one (the counters above were consumed once;
  // a retry click inside robustClick never consumes again). Chatbot steps and click_at keep the plain act.
  const watch = isApplyClick ? page.watch?.() : undefined;
  const doClick = isApplyClick && live.n >= 0 && page.robustClick ? () => page.robustClick!(live.n) : i.act;
  const diagExtra = (tree: RawTree | null): DiagExtra => ({
    popups: watch?.popups() ?? [], responses: watch?.responses() ?? [], nearButtons: nearButtonNames(tree, live),
  });
  try {
    try {
      await doClick();
    } catch {
      // The click may have gone through: the apply is unresolved, the counters stay spent.
      deps.intents.disarm(platform);
      const dga = await writeCommitDiag(deps, page, { platform, code: 'unconfirmed', live, urlBefore, after: null, extra: diagExtra(null) });
      return { ok: false, status: 'unconfirmed', code: 'unconfirmed', reason: `error after the click; check the application by hand${diagNote(dga)}` };
    }

    const base = st.baseline.get(key) ?? pageTexts(before);
    const maxMs = deps.confirmTimeoutMs ?? 8000;
    const polls = Math.max(1, Math.ceil(maxMs / APPLY_POLL_MS));
    let after: RawTree | null = null;
    for (let k = 0; k < polls; k++) {
      await page.waitMs(k === 0 ? (deps.settleMs ?? 800) : APPLY_POLL_MS).catch(() => undefined);
      try { after = await page.snapshot(); } catch {
        deps.intents.disarm(platform);
        const dgb = await writeCommitDiag(deps, page, { platform, code: 'unconfirmed', live, urlBefore, after: null, extra: diagExtra(null) });
        return { ok: false, status: 'unconfirmed', code: 'unconfirmed', reason: `could not read the page after the click; check the application by hand${diagNote(dgb)}` };
      }
      const last = k === polls - 1;      // 1. a popup the click opened: an off-site one is never touched; a naukri.com one is followed
      const pops = watch?.popups() ?? [];
      const ext = pops.findIndex((p) => p.url && p.url !== 'about:blank' && hostKind(p.url) !== 'naukri');
      if (ext >= 0) {
        deps.intents.disarm(platform);
        const dgx = await writeCommitDiag(deps, page, { platform, code: 'external_apply', live, urlBefore, after, extra: diagExtra(after) });
        return { ok: false, status: 'manual_review', code: 'external_apply', reason: `Apply opened an external page; nothing was typed there, finish by hand${diagNote(dgx)}` };
      }
      const nk = pops.findIndex((p) => hostKind(p.url) === 'naukri');
      if (nk >= 0 && await watch!.adopt(nk)) {
        st.adopted.add(key);
        let pt: RawTree | null = null;
        try { pt = await page.snapshot(); } catch { pt = null; }
        if (pt && confirmedNew(base, pt)) {
          recordApplied(db, jobId, now());
          deps.intents.disarm(platform);
          return { ok: true, status: 'sent', code: 'applied' };
        }
        deps.intents.arm({ platform, kind: intent.kind, class: 'naukri_apply', jobId: intent.jobId, pageKey: key, text: null, dry: false });
        return { ok: true, code: pt && chatbotOpen(pt) ? 'chatbot_opened' : 'popup_opened', reason: 'Apply opened a naukri.com page (now the active page): snapshot it, answer a chatbot with naukri_type and continue with its controls' };
      }
      // 2. a confirmation, the Apply control turning Applied or disabled, or an apply response with a 2xx
      const ctl = applyControlState(after);
      const net = (watch?.responses() ?? []).some((r) => r.status >= 200 && r.status < 300);
      if (confirmedNew(base, after) || appliedTextNew(base, after) || (isApplyClick && (ctl === 'applied' || ctl === 'disabled')) || net) {
        recordApplied(db, jobId, now());
        deps.intents.disarm(platform);
        return { ok: true, status: 'sent', code: 'applied' };
      }
      // 3. the chatbot drawer
      if (chatbotOpen(after)) {
        // The application is in progress: keep the intent (fresh 120 s window) for the next chatbot step.
        deps.intents.arm({ platform, kind: intent.kind, class: 'naukri_apply', jobId: intent.jobId, pageKey: key, text: null, dry: false });
        return { ok: true, code: isApplyClick ? 'chatbot_opened' : 'chatbot_step', reason: 'answer the chatbot with naukri_type and continue with its controls' };
      }
      if (last) break;
    }

    deps.intents.disarm(platform);
    // The same enabled Apply control is still there: the click did nothing. Never retried for this job in this run.
    if (isApplyClick && after && applyControlState(after) === 'enabled' && (watch?.popups().length ?? 0) === 0) {
      st.ignored.add(key);
      const dgi = await writeCommitDiag(deps, page, { platform, code: 'apply_click_ignored', live, urlBefore, after, extra: diagExtra(after) });
      return { ok: false, status: 'unconfirmed', code: 'apply_click_ignored', reason: `Apply was clicked but the page did not react and the same Apply button is still there; escalate once and do not retry this job in this run${diagNote(dgi)}` };
    }
    const dgc = await writeCommitDiag(deps, page, { platform, code: 'unconfirmed', live, urlBefore, after, extra: diagExtra(after) });
    return { ok: false, status: 'unconfirmed', code: 'unconfirmed', reason: `clicked but no confirmation or chatbot appeared; check the application by hand${diagNote(dgc)}` };
  } finally {
    watch?.stop();
  }
}

const APPLY_POLL_MS = 400;
const APPLIED_BTN_RE = /^(?:applied|already applied)$/;

/** The job page's Apply control: 'applied' (Applied / Already applied), 'disabled', 'enabled' or 'missing'. */
export function applyControlState(tree: RawTree): 'applied' | 'disabled' | 'enabled' | 'missing' {
  let apply: boolean | null = null; // null: no Apply control seen, true: one enabled, false: only disabled ones
  for (const x of tree.nodes) {
    if (x.role !== 'button' && x.role !== 'link') continue;
    const nm = normName(x.name);
    if (APPLIED_BTN_RE.test(nm)) return 'applied';
    if (isNaukriApplyName(x.name)) apply = x.disabled ? (apply ?? false) : true;
  }
  return apply === null ? 'missing' : apply ? 'enabled' : 'disabled';
}

/** A short toast or heading that mentions "applied" and was not on the page before the click. */
export function appliedTextNew(before: Set<string>, after: RawTree): boolean {
  for (const x of after.nodes) {
    if (x.role !== 'text' && x.role !== 'heading') continue;
    const t = norm(x.role === 'text' ? x.text : x.name).slice(0, 300);
    if (!t || t.length > 100 || before.has(t) || /\?\s*$/.test(t)) continue;
    if (/\bapplied\b/i.test(t) && !/\b(also|people|others|candidates|jobs?|filters?|similar)\b/i.test(t)) return true;
  }
  return false;
}

