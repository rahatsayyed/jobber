// browserctl commit path for Wellfound: the only code that lets a Wellfound send (thread composer Send or
// Enter) or an apply step (the job page Apply button and the application form's Submit application) reach
// the page. Reached from the engine's click, press_key and click_at when the guard classified the live
// element as wellfound_send or wellfound_apply. Same design as commitNaukri.ts.
//
// wellfound_send:  kill switch and halt -> armed intent -> fresh page read (thread id in the URL equals the
//   armed thread, header name equals the armed person, live composer text equals the armed text) ->
//   element unchanged -> halt again -> dry run (record, disarm) or live (consume the intent, tryConsume
//   wellfound_message right before the click, watch for a 2xx POST, click, confirm by composer cleared AND
//   (our message echoed in the thread OR a 2xx POST)) -> finishTouch, thread and contact state.
//   Unconfirmed or error after the click counts toward the three-failure wellfound halt.
// wellfound_apply: the Apply click on the armed job's page consumes wellfound_apply plus the shared
//   easy_apply counter once per job (rolled back together), dry run records and does not click. The
//   application form that follows is a dialog with an optional note field: the note is only ever the exact
//   text armed (and gated) by wellfound_arm_apply, the Submit application click re-checks the live field
//   against it. A confirmation is only text that was NOT on the page before the Apply click (a job
//   description can never confirm itself).
// Anything after a click that cannot be confirmed is 'unconfirmed', never guessed.
import type BetterSqlite3 from 'better-sqlite3';
import { getExcludedReason, getFirstHardStop, saveApplication } from '../db.js';
import { checkAndIncrement } from '../lib/rateLimit.js';
import { finishTouch } from '../linkedin/touches.js';
import { loadOutreachConfig } from '../outreach/config.js';
import { tryConsume } from '../outreach/limits.js';
import { loadTuning } from '../outreach/tuning.js';
import { recordDryRun } from '../safety/dryRun.js';
import { threadRefOfUrl, wellfoundJobIdOfUrl } from '../wellfound/page.js';
import { bumpFailures, loadWellfoundPerson, norm, recordWellfoundSent } from '../wellfound/sendState.js';
import { diagNote, writeCommitDiag } from './diag.js';
import type { BcPage } from './driver.js';
import { DEFAULT_MAX_APPLIES_PER_DAY, pageTexts, threadHeaderName } from './commitNaukri.js';
import { killReason, type EngineDeps, type EngineResult } from './engineTypes.js';
import { isWellfoundApplyName, normName, textMatches } from './guard.js';
import type { ArmedIntent, IntentStore } from './intent.js';
import { bindTouchRelease } from './intent.js';
import type { LiveNode, RawTree } from './snapshot.js';

export interface WellfoundCommitInput {
  deps: EngineDeps;
  page: BcPage;
  cls: 'wellfound_send' | 'wellfound_apply';
  live: LiveNode;
  act: () => Promise<void>;
  redescribe: () => Promise<LiveNode | null>;
}

export const MAX_FORM_STEPS = 6;
const CONFIRM_RE = /(application (?:has been |was )?(?:sent|submitted)|you(?:'|’)ve applied|you have applied|successfully applied|applied to\s+\S.*)/i;

const sameTarget = (a: LiveNode, b: LiveNode): boolean =>
  a.role === b.role && a.name === b.name && a.dialogName === b.dialogName && (a.dialog === undefined) === (b.dialog === undefined);

// ---- per-process apply state (keyed by the IntentStore the arm tool and the engine share) ----
interface ApplyState {
  /** Job keys whose Apply click already consumed the counters (dedupe). */
  counted: Set<string>;
  /** Page texts present before the Apply click, per job key. */
  baseline: Map<string, Set<string>>;
  steps: Map<string, number>;
}
const states = new WeakMap<IntentStore, ApplyState>();
function applyState(intents: IntentStore): ApplyState {
  let s = states.get(intents);
  if (!s) { s = { counted: new Set(), baseline: new Map(), steps: new Map() }; states.set(intents, s); }
  return s;
}
/** Job keys whose Apply was counted in this process. */
export const wellfoundApplyCounted = (intents: IntentStore): Set<string> => applyState(intents).counted;

/** An applied confirmation that was not on the page before: a new confirmation sentence or a new "Applied" control. */
export function confirmedNewWellfound(before: Set<string>, after: RawTree): boolean {
  for (const t of pageTexts(after)) {
    if (before.has(t)) continue;
    if (/\?\s*$/.test(t)) continue; // a question that merely mentions applying
    if (CONFIRM_RE.test(t) || t === 'applied') return true;
  }
  return false;
}

/** A form is open: any dialog node, or an editable composer field. */
const formOpen = (tree: RawTree): boolean => tree.nodes.some((x) => x.dialog !== undefined || x.role === 'dialog' || (x.composer === true && !x.secret));

function recordApplied(db: BetterSqlite3.Database, jobId: string, now: Date): boolean {
  const existing = db.prepare("SELECT 1 FROM applications WHERE job_id = ? AND platform = 'wellfound' AND status = 'submitted' LIMIT 1").get(jobId);
  if (existing) return false;
  saveApplication(db, {
    job_id: jobId, platform: 'wellfound', method: 'native', account: 'wellfound', status: 'submitted',
    reason: null, applied_at: now.toISOString(),
  });
  return true;
}

/**
 * Called by the engine after every read: when the armed apply job's page now shows a confirmation that
 * was not there before the Apply click, record the application once and disarm.
 */
export function observeWellfoundApplyConfirmation(deps: EngineDeps, tree: RawTree): void {
  const armed = deps.intents.peek('wellfound');
  if (!armed || armed.class !== 'wellfound_apply' || !armed.pageKey || armed.jobId === undefined) return;
  const st = applyState(deps.intents);
  const base = st.baseline.get(armed.pageKey);
  if (!st.counted.has(armed.pageKey) || !base) return;
  if (wellfoundJobIdOfUrl(tree.url) !== armed.pageKey) return;
  if (!confirmedNewWellfound(base, tree)) return;
  recordApplied(deps.db, String(armed.jobId), deps.now());
  deps.intents.disarm('wellfound');
}

export async function commitWellfound(i: WellfoundCommitInput): Promise<EngineResult> {
  return i.cls === 'wellfound_send' ? commitSend(i) : commitApply(i);
}

// ---------------------------------------------------------------------------------------------
// wellfound_send
// ---------------------------------------------------------------------------------------------
const isWellfoundPost = (r: unknown): boolean => {
  try {
    const x = r as { url(): string; status(): number; request(): { method(): string } };
    const h = new URL(x.url()).hostname.toLowerCase();
    return (h === 'wellfound.com' || h.endsWith('.wellfound.com')) && x.request().method() === 'POST' && x.status() >= 200 && x.status() < 300;
  } catch { return false; }
};

const echoCount = (tree: RawTree, want: string): number =>
  tree.nodes.filter((x) => x.role !== 'textbox' && x.role !== 'searchbox' && norm(x.role === 'text' ? x.text : x.name).includes(want)).length;

async function commitSend(i: WellfoundCommitInput): Promise<EngineResult> {
  const { deps, page, live } = i;
  const { db } = deps;
  bindTouchRelease(deps.intents, db);
  deps.intents.sweep();
  const now = () => deps.now();
  const platform = 'wellfound' as const;
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
  if (!intent) return { ok: false, status: 'refused', code: 'no_armed_intent', reason: 'arm the send with wellfound_arm_send first' };
  const early = deps.intents.check(platform, 'wellfound_send', intent.text);
  if (!early.ok) return abort(early.code, `armed intent refused: ${early.code}`);

  // 3. recipient on file, consistent with the intent
  const p = intent.personId === undefined ? null : loadWellfoundPerson(db, intent.personId);
  if (!p || p.platform !== 'wellfound' || !p.name || !intent.threadRef) return abort('unknown_recipient', 'armed recipient is not a known person');
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
  const chk = deps.intents.check(platform, 'wellfound_send', ln?.value);
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
      runId, action: 'wellfound_send', platform, personId: p.id,
      payload: { kind: intent.kind, thread_ref: intent.threadRef, job_id: intent.jobId ?? null, chars: intent.text?.length ?? 0, recipient: p.name },
    }, now(), deps.env);
    deps.intents.disarm(platform);
    return { ok: true, status: 'dry_run', code: 'dry_run' };
  }

  // 9. live: single-use intent, ceiling right before the click
  const used = deps.intents.consume(platform, intent.id);
  if (!used.ok) return abort(used.code, `armed intent refused: ${used.code}`);
  const ocfg = loadOutreachConfig(deps.env);
  if (!tryConsume(db, 'wellfound_message', ocfg, now())) {
    release('refused');
    return { ok: false, status: 'rate_limited', code: 'rate_limited', reason: 'wellfound_message ceiling reached' };
  }

  const text = intent.text ?? '';
  const want = norm(text).slice(0, 60);
  const echoBefore = echoCount(tree, want);
  const net = page.waitForResponse(isWellfoundPost, deps.confirmTimeoutMs ?? 8000).then(() => true, () => false);
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
      const ok = recordWellfoundSent(db, p, threadRef, intent.kind, runId, now(), loadTuning(deps.env));
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
// wellfound_apply
// ---------------------------------------------------------------------------------------------
async function commitApply(i: WellfoundCommitInput): Promise<EngineResult> {
  const { deps, page, live } = i;
  const { db } = deps;
  const now = () => deps.now();
  const platform = 'wellfound' as const;
  const st = applyState(deps.intents);
  const intent: ArmedIntent | null = deps.intents.peek(platform);
  const abort = (code: string, reason: string, status: EngineResult['status'] = 'refused'): EngineResult => {
    deps.intents.disarm(platform);
    return { ok: false, status, code, reason };
  };

  const k0 = killReason(deps);
  if (k0) return abort('halted', k0, 'halted');
  if (!intent) return { ok: false, status: 'refused', code: 'no_armed_intent', reason: 'arm the apply with wellfound_arm_apply first' };
  // The note (when armed) is checked against the live field at the step that submits it; the click itself carries no text.
  const early = deps.intents.check(platform, 'wellfound_apply', intent.text);
  if (!early.ok) return abort(early.code, `armed intent refused: ${early.code}`);
  const key = intent.pageKey;
  if (!key || intent.jobId === undefined) return abort('no_armed_intent', 'the armed intent has no job');
  const jobId = String(intent.jobId);
  const urlBefore = page.url();

  // Live re-checks of the job: vetoes and an earlier application can appear after arming.
  if (getExcludedReason(db, jobId)) return abort('vetoed', 'the job is excluded');
  if (getFirstHardStop(db, jobId)) return abort('hard_stop', 'the job has a hard stop');
  if (db.prepare("SELECT 1 FROM applications WHERE job_id = ? AND status = 'submitted' LIMIT 1").get(jobId)) {
    return abort('already_applied', 'an application was already submitted for this job');
  }
  if (wellfoundJobIdOfUrl(page.url()) !== key) return abort('job_mismatch', 'browser is not on the armed job page');

  let before: RawTree;
  try { before = await page.snapshot(); } catch { return abort('no_snapshot', 'could not read the page'); }
  const fresh = live.n >= 0 ? before.nodes.find((x) => x.n === live.n) : undefined;
  if (live.n >= 0 && (!fresh || !sameTarget(fresh, live))) return abort('target_changed', 'page changed under the action; nothing clicked');

  const isApplyClick = (live.role === 'button' || live.role === 'link') && isWellfoundApplyName(live.name) && live.dialog === undefined;
  const counted = st.counted.has(key);

  if (isApplyClick) {
    // 1. Apply button on the armed job's page
  } else {
    // 2. form step (Submit application): only after the counted Apply, capped, field re-checked
    if (!counted) return abort('apply_not_started', 'click Apply under the armed intent before using the application form');
    const n = (st.steps.get(key) ?? 0) + 1;
    if (n > MAX_FORM_STEPS) return abort('too_many_steps', 'too many form steps for one application');
    st.steps.set(key, n);
    const box = before.nodes.find((x) => x.role === 'textbox' && x.composer && !x.secret);
    if (box) {
      const ln = await page.describe(box.n).catch(() => null);
      const value = ln?.value ?? '';
      if (value.trim() !== '') {
        // A non-empty note must be exactly the armed note (an empty field is fine: the note is optional).
        if (intent.text === null || !textMatches(intent.text, value)) return abort('intent_text_mismatch', 'the note field differs from the armed note; nothing submitted');
        const why = deps.textGate?.(value, 'plain');
        if (why) return abort('output_gate', `note refused: ${why}`);
      }
    }
  }

  const again = await i.redescribe().catch(() => null);
  if (!again || !sameTarget(again, live)) return abort('target_changed', 'page changed under the action; nothing clicked');
  const k1 = killReason(deps);
  if (k1) return abort('halted', k1, 'halted');

  if (intent.dry || deps.cfg.dryRun) {
    recordDryRun(db, {
      runId: deps.env.JOBBER_RUN_ID ?? null, action: 'wellfound_apply', platform,
      payload: { job_id: jobId, control: normName(live.name).slice(0, 40), apply_click: isApplyClick, note_chars: intent.text?.length ?? 0 },
    }, now(), deps.env);
    deps.intents.disarm(platform);
    return { ok: true, status: 'dry_run', code: 'dry_run' };
  }

  if (isApplyClick && !counted) {
    const ocfg = loadOutreachConfig(deps.env);
    const maxRaw = Number(deps.env.MAX_APPLIES_PER_DAY ?? DEFAULT_MAX_APPLIES_PER_DAY);
    const max = Number.isFinite(maxRaw) && maxRaw >= 0 ? maxRaw : DEFAULT_MAX_APPLIES_PER_DAY;
    // Consume wellfound_apply first; if the shared daily counter then refuses, remove the event just recorded
    // so a refusal leaves BOTH counters unconsumed.
    if (!tryConsume(db, 'wellfound_apply', ocfg, now())) {
      return { ok: false, status: 'rate_limited', code: 'rate_limited', reason: 'wellfound_apply ceiling reached, Apply NOT clicked' };
    }
    const ev = db.prepare("SELECT MAX(id) AS id FROM rate_events WHERE key = 'wellfound_apply'").get() as { id: number | null };
    if (!checkAndIncrement(db, 'easy_apply', max)) {
      if (ev.id !== null) db.prepare('DELETE FROM rate_events WHERE id = ?').run(ev.id);
      return { ok: false, status: 'rate_limited', code: 'rate_limited', reason: `daily apply limit (${max}) reached, Apply NOT clicked` };
    }
    st.counted.add(key);
    st.baseline.set(key, pageTexts(before));
  }

  try {
    await i.act();
  } catch {
    // The click may have gone through: the apply is unresolved, the counters stay spent.
    deps.intents.disarm(platform);
    const dga = await writeCommitDiag(deps, page, { platform, code: 'unconfirmed', live, urlBefore, after: null });
    return { ok: false, status: 'unconfirmed', code: 'unconfirmed', reason: `error after the click; check the application by hand${diagNote(dga)}` };
  }
  await page.waitMs(deps.settleMs ?? 800).catch(() => undefined);
  let after: RawTree;
  try { after = await page.snapshot(); } catch {
    deps.intents.disarm(platform);
    const dgb = await writeCommitDiag(deps, page, { platform, code: 'unconfirmed', live, urlBefore, after: null });
    return { ok: false, status: 'unconfirmed', code: 'unconfirmed', reason: `could not read the page after the click; check the application by hand${diagNote(dgb)}` };
  }
  const base = st.baseline.get(key) ?? pageTexts(before);
  if (confirmedNewWellfound(base, after)) {
    recordApplied(db, jobId, now());
    deps.intents.disarm(platform);
    return { ok: true, status: 'sent', code: 'applied' };
  }
  if (isApplyClick && formOpen(after)) {
    // The application form is open: keep the intent (fresh 120 s window, same note) for the form steps.
    deps.intents.arm({ platform, kind: intent.kind, class: 'wellfound_apply', jobId: intent.jobId, pageKey: key, text: intent.text, dry: false });
    return { ok: true, code: 'form_opened', reason: 'optionally type the armed note into the note field, then click Submit application' };
  }
  deps.intents.disarm(platform);
  const dgc = await writeCommitDiag(deps, page, { platform, code: 'unconfirmed', live, urlBefore, after });
  return { ok: false, status: 'unconfirmed', code: 'unconfirmed', reason: `clicked but no confirmation or form appeared; check the application by hand${diagNote(dgc)}` };
}
