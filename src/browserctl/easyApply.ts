// browserctl LinkedIn Easy Apply, the code-owned half (the model never types a value, picks a file or names a URL):
//   - per-process state of one application (keyed by the IntentStore, like the Naukri apply state),
//   - reading the modal (fields, controls, risk text) from a tree,
//   - linkedin_easy_apply_fill: answers every field of the CURRENT modal step from the answer book, the resume-derived values or an answer the
//     owner stored with `npm run answers`; uploads the tailored resume through the same code-owned resolver DM attachments use; an unanswered
//     required question is recorded in apply_questions and the job is parked as needs_answer (never guessed),
//   - parking and closing: any unexpected step (more than MAX_EASY_APPLY_STEPS steps, an unknown button, a CAPTCHA or verification, a premium
//     upsell, a failed fill) closes the modal and marks the queue row needs_owner with a closed reason code.
// Everything on the page is untrusted data: results carry codes and counts only, never page text, a typed value or a path.
// LIVE-UNVERIFIED: the real modal markup (labels, field kinds, button names) has not been read from LinkedIn; every rule here fails closed.
import { readFileSync } from 'node:fs';
import type BetterSqlite3 from 'better-sqlite3';
import { loadAnswerBook, type AnswerBook, type AnswerRef, type AnswerValue } from '../apply/answers.js';
import { cleanLabel, pauseJobNeedsAnswer, recordQuestion, storedAnswer, type QuestionKind } from '../apply/questions.js';
import { matchOption, normOpt, yesNoOption } from '../applier/refs.js';
import { checkFile, resolveJobIdResume, type ResolvedAttachment, type ResolveDeps } from '../linkedin/attachment.js';
import { addEscalation } from '../outreach/service.js';
import { recordDryRun } from '../safety/dryRun.js';
import { dialogText, effectiveDialogKind, fileChipShown } from './commit.js';
import type { BcPage } from './driver.js';
import { writeDialogStructureDiag } from './diag.js';
import { killReason, refused, type EngineDeps, type EngineResult } from './engineTypes.js';
import { EASY_APPLY_DANGER_RE, EASY_APPLY_NEXT_RE, EASY_APPLY_REVIEW_RE, EASY_APPLY_SUBMIT_RE, normName } from './guard.js';
import type { ArmedIntent, IntentStore } from './intent.js';
import { escalateOverlay, overlayDetail, overlayReason, readOverlay, titleSlug } from './overlay.js';
import type { RawNode, RawTree } from './snapshot.js';

/** The modal may take at most this many Next/Review/Submit steps; one more is an unexpected flow. */
export const MAX_EASY_APPLY_STEPS = 8;
/** The host recorded on apply_questions for every Easy Apply question (one answers card per host). */
export const EASY_APPLY_HOST = 'linkedin.com';

/** Closed reason codes a parked application carries (apply_note is `easy_apply:<code>`). */
export const PARK_CODES = [
  'more_than_8_steps', 'unknown_button', 'verification', 'premium_upsell', 'resume_control_missing', 'resume_upload_failed', 'fill_failed',
  'validation_error', 'no_modal', 'modal_ambiguous', 'consent_required', 'unsupported_field', 'already_applied_on_page', 'unexpected_page',
  'submit_error', 'select_unsupported', 'operator_abort', 'overlay_needs_human', 'resume_mismatch',
] as const;
export type ParkCode = (typeof PARK_CODES)[number];

// ---- job page ----

/** The LinkedIn numeric job id of a job page URL (`/jobs/view/<id>`, `/jobs/view/<slug>-<id>` or `currentJobId=<id>`), or null. */
export function jobNumericIdOfUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
    const m = /\/jobs\/view\/(?:[^/]*-)?(\d{5,})(?:\/|$)/.exec(u.pathname);
    if (m) return m[1];
    const c = u.searchParams.get('currentJobId');
    return c && /^\d{5,}$/.test(c) ? c : null;
  } catch {
    return null;
  }
}

/** The canonical job page URL for a numeric id (no tracking parameters, never a raw stored href). */
export const canonicalJobPage = (numeric: string): string => `https://www.linkedin.com/jobs/view/${numeric}/`;

// ---- per-process state ----

export interface EasyApplyState {
  /** Job keys whose Easy Apply control was clicked by the engine and showed the modal. */
  opened: Set<string>;
  /** Next/Review clicks per job key. */
  steps: Map<string, number>;
  /** The step count at which linkedin_easy_apply_fill last passed for the job key. */
  fillOk: Map<string, number>;
  /** Job keys whose Submit consumed the ceilings. */
  counted: Set<string>;
  /** Job keys whose tailored resume is on screen in the modal. */
  uploaded: Set<string>;
  /** Page texts before the Submit click, per job key (a confirmation is text that was NOT there before). */
  baseline: Map<string, Set<string>>;
  /** Director decisions handed to the operator, per `<job key>#<step>` (at most MAX_DIRECTOR_DECISIONS per step, then the job is parked). */
  director: Map<string, number>;
}
/** How many times one step may be handed back to the operator before the job is parked. */
export const MAX_DIRECTOR_DECISIONS = 2;
const states = new WeakMap<IntentStore, EasyApplyState>();
export function easyApplyState(intents: IntentStore): EasyApplyState {
  let s = states.get(intents);
  if (!s) { s = { opened: new Set(), steps: new Map(), fillOk: new Map(), counted: new Set(), uploaded: new Set(), baseline: new Map(), director: new Map() }; states.set(intents, s); }
  return s;
}
export function clearEasyApplyState(intents: IntentStore, key: string): void {
  const s = easyApplyState(intents);
  s.opened.delete(key); s.steps.delete(key); s.fillOk.delete(key); s.counted.delete(key); s.uploaded.delete(key); s.baseline.delete(key);
  for (const k of [...s.director.keys()]) if (k.startsWith(`${key}#`)) s.director.delete(k);
}

// ---- reading the modal ----

const RISK_RE = /captcha|verify (?:that )?you(?:'|’)?re (?:a )?human|security (?:check|verification)|verification code|we sent (?:you )?a (?:code|text)|try premium|upgrade to premium|premium (?:subscription|account)|reactivate premium|unusual activity/i;
const PREMIUM_RE = /premium/i;
const VALIDATION_RE = /please enter a (?:valid|whole)|is required|required field|make a selection|enter a valid|select an option/i;
/** Director rule: an unfamiliar button is NOT a park reason (the operator reads the dialog and chooses by ref); only money and upgrade words are. */
const UPLOAD_RE = /^(?:upload (?:a )?(?:resume|cv)|upload)$/;
const SENT_RE = /application (?:was )?(?:sent|submitted)|your application (?:was )?(?:sent|submitted)|successfully (?:applied|submitted)/i;

/** The ONE Easy Apply modal of a tree, or a code. */
export function easyApplyDialog(tree: RawTree): RawNode | 'none' | 'ambiguous' {
  const ds = tree.nodes.filter((x) => x.role === 'dialog' && effectiveDialogKind(tree, x.n, x.name) === 'easy_apply');
  return ds.length === 0 ? 'none' : ds.length === 1 ? ds[0] : 'ambiguous';
}

const inDialog = (tree: RawTree, dlg: number): RawNode[] => tree.nodes.filter((x) => x.dialog === dlg);

/** The names (normalized) of the buttons and links of the modal. */
export function dialogButtons(tree: RawTree, dlg: number): { node: RawNode; name: string }[] {
  return inDialog(tree, dlg).filter((x) => x.role === 'button' || x.role === 'link').map((x) => ({ node: x, name: normName(x.name) }));
}

/** What the modal's text or controls say is wrong, as a closed code; null when the step looks like an ordinary form step. */
export function scanDialog(tree: RawTree, dlg: number): ParkCode | null {
  const text = dialogText(tree, dlg);
  if (RISK_RE.test(text)) return PREMIUM_RE.test(text) ? 'premium_upsell' : 'verification';
  for (const b of dialogButtons(tree, dlg)) {
    if (b.name === '' ) continue; // unnamed icon buttons (close X) are not judged by name
    if (EASY_APPLY_DANGER_RE.test(b.name)) return 'unknown_button';
  }
  return null;
}

export interface FormField {
  kind: 'text' | 'select' | 'radio' | 'checkbox';
  label: string;
  /** The node to fill or click (the first radio for a group). */
  node: RawNode;
  /** Radio group members with their option labels. */
  options: { label: string; node: RawNode }[];
  filled: boolean;
  optional: boolean;
}

const PLACEHOLDER_RE = /^(?:select|choose|please select|select an option|--+)/i;
const clean = (s: string): string => cleanLabel(s);

/**
 * The fields of one modal step in DOM order. A field's label is the nearest text before it (LinkedIn puts the question in a label or legend
 * above the input), else its own accessible name; a radio's option label is its name, else the text right after it. Any field is required
 * unless its label says optional: when in doubt the job is parked, never guessed.
 */
export function readForm(tree: RawTree, dlg: number): FormField[] {
  const nodes = inDialog(tree, dlg);
  const out: FormField[] = [];
  let texts: string[] = [];
  let group: FormField | null = null;
  const lastText = (): string => {
    const t = texts.filter((x) => x.length > 0);
    if (t.length === 0) return '';
    const last = t[t.length - 1];
    return last.length <= 2 && t.length > 1 ? `${t[t.length - 2]} ${last}` : last;
  };
  const textOf = (x: RawNode): string => (x.role === 'text' ? x.text : x.name);
  for (let i = 0; i < nodes.length; i++) {
    const x = nodes[i];
    if (x.role === 'text' || x.role === 'heading') {
      const t = clean(textOf(x));
      if (t) texts.push(t.slice(0, 200));
      if (texts.length > 6) texts = texts.slice(-6);
      // Text between radios that is not an option label ends the group (a new question starts).
      if (group && t.length > 40) group = null;
      continue;
    }
    if (x.role === 'textbox' || x.role === 'searchbox') {
      if (x.secret) continue;
      const label = lastText() || clean(x.name);
      out.push({ kind: 'text', label, node: x, options: [], filled: (x.value ?? '').trim() !== '', optional: /\boptional\b/i.test(`${label} ${x.name}`) });
      texts = []; group = null;
    } else if (x.role === 'combobox') {
      const label = lastText() || clean(x.name);
      const v = (x.value ?? '').trim();
      out.push({ kind: 'select', label, node: x, options: [], filled: v !== '' && !PLACEHOLDER_RE.test(v), optional: /\boptional\b/i.test(`${label} ${x.name}`) });
      texts = []; group = null;
    } else if (x.role === 'radio') {
      let optLabel = clean(x.name);
      if (!optLabel) {
        const nx = nodes[i + 1];
        if (nx && (nx.role === 'text' || nx.role === 'heading')) { optLabel = clean(textOf(nx)); i++; }
      }
      if (group) {
        group.options.push({ label: optLabel, node: x });
        if (x.checked) group.filled = true;
      } else {
        const label = lastText();
        group = { kind: 'radio', label, node: x, options: [{ label: optLabel, node: x }], filled: x.checked === true, optional: /\boptional\b/i.test(label) };
        out.push(group);
        texts = [];
      }
    } else if (x.role === 'checkbox') {
      let label = clean(x.name);
      if (!label) {
        const nx = nodes[i + 1];
        if (nx && (nx.role === 'text' || nx.role === 'heading')) { label = clean(textOf(nx)); i++; }
      }
      if (!label) label = lastText();
      out.push({ kind: 'checkbox', label, node: x, options: [], filled: x.checked === true, optional: true });
      texts = []; group = null;
    } else if (x.role === 'button' || x.role === 'link') {
      texts = []; group = null;
    }
  }
  return out;
}

// ---- answers ----

type Resolved = { ok: true; value: AnswerValue } | { ok: false; why: 'consent' | 'unknown' };

interface ResolveCtx { book: AnswerBook; db: BetterSqlite3.Database; jobId: string; jobLocation?: string }

/** The answer for one question label: the answer book (profile, answer file, resume-derived), then an answer the owner stored. Never a guess. */
export function resolveLabel(label: string, ctx: ResolveCtx): Resolved {
  const lab = label.trim();
  if (!lab) return { ok: false, why: 'unknown' };
  const profile = (field: Extract<AnswerRef, { kind: 'profile' }>['field']): Resolved => {
    const v = ctx.book.resolve({ kind: 'profile', field }, { jobLocation: ctx.jobLocation });
    return v === null || v === '' ? { ok: false, why: 'unknown' } : { ok: true, value: v };
  };
  const s = ctx.book.suggest(lab);
  if (s.cls === 'consent' || s.cls === 'legal_attestation') return { ok: false, why: 'consent' };
  // Contact fields the resume profile answers on its own.
  if (/\be-?mail\b/i.test(lab)) return profile('email');
  if (/\b(first|given) name\b/i.test(lab)) return profile('name.first');
  if (/\b(last|family|sur) ?name\b/i.test(lab)) return profile('name.last');
  if (/^(?:full )?name$/i.test(lab) || /\bfull name\b/i.test(lab)) return profile('name.full');
  if (s.ref && ctx.book.has(s.ref)) {
    const v = ctx.book.resolve(s.ref, { jobLocation: ctx.jobLocation });
    if (v !== null && v !== undefined && v !== '') return { ok: true, value: v };
  }
  if (/\b(mobile|phone)\b/i.test(lab) && !/country code/i.test(lab)) return profile('phone');
  const stored = storedAnswer(ctx.db, ctx.jobId, EASY_APPLY_HOST, lab);
  if (stored !== null) return { ok: true, value: stored };
  return { ok: false, why: 'unknown' };
}

export interface FillCtx {
  deps: EngineDeps;
  page: BcPage;
  intent: ArmedIntent;
  jobId: string;
  key: string;
}

export interface EasyApplyDeps {
  /** Test seam: replaces the answer book loader. */
  answers?: () => AnswerBook;
  /** Test seam for the resume resolver (renderer root and re-render). */
  resume?: ResolveDeps;
}

export type Detail = Record<string, string | number | boolean>;
export type FillOutcome = EngineResult & { detail?: Detail };

const done = (code: string, detail?: Detail): FillOutcome => ({ ok: true, code, status: undefined, ...(detail ? { detail } : {}) });

// ---- parking and closing ----

/** Close the Easy Apply modal by code: Escape, then the "Discard" button of LinkedIn's confirmation. Never throws. */
export async function closeEasyApplyModal(page: BcPage): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      await page.press('Escape');
      await page.waitMs(300).catch(() => undefined);
      const t = await page.snapshot();
      const discard = t.nodes.find((x) => x.role === 'button' && (normName(x.name) === 'discard' || (x.dialog !== undefined && normName(x.name) === 'done')));
      if (discard) { await page.clickNode(discard.n); await page.waitMs(300).catch(() => undefined); }
      const again = await page.snapshot();
      if (easyApplyDialog(again) === 'none' && !again.nodes.some((x) => x.role === 'button' && normName(x.name) === 'discard')) return;
    } catch { return; }
  }
}

/** Mark the queue rows of the job needs_owner with a closed reason, raise one escalation, close the modal, disarm. */
export async function parkNeedsOwner(ctx: { deps: EngineDeps; page: BcPage; jobId: string; key: string }, code: ParkCode, extra?: string): Promise<FillOutcome> {
  const { deps, page, jobId, key } = ctx;
  const now = deps.now();
  try {
    deps.db.prepare("UPDATE outreach_queue SET apply_status = 'needs_owner', apply_note = ?, updated_at = datetime('now') WHERE job_id = ? AND COALESCE(apply_status, '') IN ('', 'queued', 'needs_answer', 'needs_owner')")
      .run(`easy_apply:${code}${extra ? `:${extra.replace(/[^\w .-]/g, ' ').trim().slice(0, 40)}` : ''}`, jobId);
    addEscalation(deps.db, {
      runId: deps.env.JOBBER_RUN_ID ?? null, platform: 'apply', reason: 'apply:linkedin_easy_apply', threadRef: `easyapply:${jobId.replace(/[^A-Za-z0-9_.-]/g, '_')}`.slice(0, 120),
      detail: `LinkedIn Easy Apply stopped for job ${jobId}: ${code}. Finish it by hand: npm run apply:manual -- list`,
    }, now);
  } catch { /* the modal is still closed and the intent dropped */ }
  await closeEasyApplyModal(page);
  clearEasyApplyState(deps.intents, key);
  deps.intents.disarm('linkedin');
  return { ok: false, status: 'manual_review', code: 'needs_owner', reason: `Easy Apply stopped (${code}); the modal is closed and the owner was told. Move to the next item.`, detail: { park: code } };
}

/**
 * The Easy Apply dialog shows no Next, Review or Submit control (a "Save this application?" prompt, a "Done" screen, a choice, a new kind of
 * step). The OPERATOR decides: the result is `blocked_by_overlay` (detail.director) carrying the dialog title, text and buttons; the operator
 * clicks one by ref and calls linkedin_easy_apply_fill again. At most MAX_DIRECTOR_DECISIONS per step, then the job is parked
 * `unknown_button:<dialog title>`. A human-only dialog (captcha, verification, login, payment, ID, restriction) parks at once.
 */
export async function stepDirector(ctx: { deps: EngineDeps; page: BcPage; jobId: string; key: string }, tree: RawTree, dlg: RawNode): Promise<FillOutcome> {
  const st = easyApplyState(ctx.deps.intents);
  const dk = `${ctx.key}#${st.steps.get(ctx.key) ?? 0}`;
  const used = st.director.get(dk) ?? 0;
  const ov = await readOverlay(ctx.page, tree, () => null, { rules: ctx.deps.overlayRules, expected: (_t, d) => d.n !== dlg.n });
  if (ov?.human) {
    const out = await parkNeedsOwner(ctx, 'overlay_needs_human', `${ov.human.rule} ${titleSlug(ov.title)}`);
    escalateOverlay(ctx.deps, ov, 'Easy Apply');
    return { ...out, reason: `${out.reason} ${overlayReason(ov)}`.slice(0, 600) };
  }
  const title = ov?.title || dlg.name || 'untitled';
  if (used >= MAX_DIRECTOR_DECISIONS) return await parkNeedsOwner(ctx, 'unknown_button', titleSlug(title));
  st.director.set(dk, used + 1);
  const info = ov ?? { title, text: '', buttons: [], source: 'tree' as const };
  return {
    ok: false, code: 'blocked_by_overlay', overlay: info,
    reason: `Easy Apply step has no Next, Review or Submit control: dialog "${info.title.slice(0, 80)}", buttons [${info.buttons.slice(0, 8).map((b) => b.name).join(' | ')}]: read it, click the right button by ref (decision ${used + 1} of ${MAX_DIRECTOR_DECISIONS}), then call linkedin_easy_apply_fill again`,
    detail: { ...overlayDetail(info), director: true, director_decision: used + 1 },
  };
}

/**
 * Something is in the way of the Easy Apply flow (no modal, a click that threw): look for a blocking dialog the flow does not use. The OPERATOR
 * decides what to click: `blocked` is a `blocked_by_overlay` result carrying the dialog (title, text, buttons; the engine adds fresh refs),
 * the armed intent stays and nothing is parked. A human-only dialog (captcha, login wall, payment, ID) parks needs_owner with the dialog title.
 * `none` means no overlay and the original failure stands.
 */
export async function overlayRecovery(ctx: { deps: EngineDeps; page: BcPage; jobId: string; key: string }): Promise<{ status: 'blocked' | 'park'; out: FillOutcome } | { status: 'none' }> {
  let tree: RawTree | null = null;
  try { tree = await ctx.page.snapshot(); } catch { tree = null; }
  const ov = await readOverlay(ctx.page, tree, () => null, { rules: ctx.deps.overlayRules });
  if (!ov) return { status: 'none' };
  if (ov.human) {
    const out = await parkNeedsOwner(ctx, 'overlay_needs_human', `${ov.human.rule} ${titleSlug(ov.title)}`);
    escalateOverlay(ctx.deps, ov, 'Easy Apply');
    return { status: 'park', out: { ...out, reason: `${out.reason} ${overlayReason(ov)}`.slice(0, 600) } };
  }
  return { status: 'blocked', out: { ok: false, code: 'blocked_by_overlay', reason: overlayReason(ov), detail: overlayDetail(ov), overlay: ov } };
}

async function parkNeedsAnswer(ctx: FillCtx, qs: { label: string; kind: QuestionKind; options: string[] }[]): Promise<FillOutcome> {
  const { deps, page, jobId, key } = ctx;
  const now = deps.now();
  let n = 0;
  try {
    for (const q of qs) {
      try { recordQuestion(deps.db, { jobId, host: EASY_APPLY_HOST, label: q.label, kind: q.kind, options: q.options }, now); } catch { /* an unlabeled field cannot be recorded */ }
    }
    n = pauseJobNeedsAnswer(deps.db, jobId);
    addEscalation(deps.db, {
      runId: deps.env.JOBBER_RUN_ID ?? null, platform: 'apply', reason: 'apply:needs_answer', threadRef: `answers:${EASY_APPLY_HOST}`,
      detail: `needs your answer: ${n} question${n === 1 ? '' : 's'} for job ${jobId} on ${EASY_APPLY_HOST}; run: npm run answers -- list`,
    }, now);
  } catch { /* parked below either way */ }
  await closeEasyApplyModal(page);
  clearEasyApplyState(deps.intents, key);
  deps.intents.disarm('linkedin');
  return { ok: false, status: 'manual_review', code: 'needs_answer', reason: 'a required question has no reliable answer; the job is parked for the owner and the modal is closed. Move to the next item.', detail: { questions: n } };
}

// ---- the resume ----

const squash = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

async function ensureResume(ctx: FillCtx, tree: RawTree, dlg: number, x: EasyApplyDeps): Promise<'ok' | 'none_needed' | ParkCode> {
  const { deps, page, intent, key } = ctx;
  const st = easyApplyState(deps.intents);
  const text = dialogText(tree, dlg);
  const isReview = dialogButtons(tree, dlg).some((b) => EASY_APPLY_SUBMIT_RE.test(b.name));
  const att: ResolvedAttachment | undefined = intent.attachment
    ? { path: intent.attachment.path, name: intent.attachment.name, bytes: intent.attachment.bytes, rendered: false }
    : undefined;
  if (!att) return 'resume_upload_failed';
  if (isReview) {
    // The review page lists the resume the application will carry. A resume file on screen that is not our tailored one means LinkedIn
    // pre-selected an old saved CV (seen live: "Resume - ...pdf" on the review page, application sent with it). Park BEFORE Submit; the
    // dialog structure goes to .jobber/diag so the way to change the resume can be built from real data.
    const files = inDialog(tree, dlg).filter((n) => /\.(?:pdf|docx?)\b/i.test(n.role === 'text' ? n.text : n.name));
    // A name match alone proves nothing (LinkedIn keeps older uploads: "Rahat_Sayyed_Resume.pdf" squashes to our "Rahat-Sayyed-Resume.pdf"),
    // so the tailored file counts as attached only when THIS application's own upload was confirmed (st.uploaded).
    if (files.length > 0 && !(st.uploaded.has(key) && fileChipShown(tree, dlg, att.name))) {
      writeDialogStructureDiag({ now: deps.now, ...(deps.diagDir ? { diagDir: deps.diagDir } : {}) }, { platform: 'linkedin', code: 'resume_mismatch', tree, dlg });
      return 'resume_mismatch';
    }
    return 'none_needed';
  }
  if (st.uploaded.has(key)) return 'none_needed';
  const mentionsResume = /\b(resume|cv)\b/i.test(text);
  if (!mentionsResume) return 'none_needed';
  // Always upload this job's tailored file: the saved-resume list may already hold a file of the same name (an older upload, or another
  // job's tailored copy), which is NOT this job's resume. Success is proven by a NEW entry appearing, never by a name already on screen.
  const want = squash(att.name);
  const named = (t: RawTree, d: number): number => t.nodes.filter((n) => n.dialog === d && squash(n.role === 'text' ? n.text : n.name).includes(want)).length;
  const before = named(tree, dlg);
  let ctl = inDialog(tree, dlg).filter((n) => n.role === 'file' || ((n.role === 'button' || n.role === 'link') && UPLOAD_RE.test(normName(n.name))));
  // A looser pass: LinkedIn words this control in several ways ("Upload resume", "Upload", "Choose file", with a hint appended).
  if (ctl.length === 0) ctl = inDialog(tree, dlg).filter((n) => (n.role === 'button' || n.role === 'link') && /\b(upload|choose file|browse)\b/i.test(normName(n.name)));
  if (ctl.length === 0) {
    // No upload control. Keeping a saved resume would apply with a CV that never went through the fact gate (seen live: LinkedIn's own
    // "Resume - ...pdf" went out). Park, with the dialog structure written to .jobber/diag so the control's real role and name can be fixed.
    writeDialogStructureDiag({ now: deps.now, ...(deps.diagDir ? { diagDir: deps.diagDir } : {}) }, { platform: 'linkedin', code: 'resume_control_missing', tree, dlg });
    return 'resume_control_missing';
  }
  if (ctl.length > 1) ctl.sort((a, b) => Number(b.role === 'file') - Number(a.role === 'file'));
  // Re-validate the file right before reading it: still inside renderer/automation, a .pdf, a regular file, at most 2 MB.
  const chk = checkFile(att.path, deps.attachRoot);
  if (!chk.ok) return 'resume_upload_failed';
  let buffer: Buffer;
  try { buffer = readFileSync(chk.real); } catch { return 'resume_upload_failed'; }
  if (!page.attachFile) return 'resume_upload_failed';
  try {
    await page.attachFile(ctl[0].n, { name: att.name, mimeType: 'application/pdf', buffer });
  } catch {
    return 'resume_upload_failed';
  }
  for (let i = 0; i < 16; i++) {
    await page.waitMs(500).catch(() => undefined);
    const after = await page.snapshot().catch(() => null);
    const d = after ? easyApplyDialog(after) : 'none';
    if (after && d !== 'none' && d !== 'ambiguous' && named(after, d.n) > before) {
      // The new upload is listed first (newest on top) and LinkedIn normally selects it; select it explicitly so an older same-named file cannot stay chosen.
      const radios = inDialog(after, d.n).filter((n) => n.role === 'radio' && squash(n.name).includes(want));
      const newest = radios[0];
      if (newest && newest.checked !== true) {
        try { if (page.robustClick) await page.robustClick(newest.n); else await page.clickNode(newest.n); } catch { /* the review gate still blocks a wrong file */ }
      }
      st.uploaded.add(key);
      return 'ok';
    }
  }
  void x;
  writeDialogStructureDiag({ now: deps.now, ...(deps.diagDir ? { diagDir: deps.diagDir } : {}) }, { platform: 'linkedin', code: 'resume_upload_failed', tree, dlg });
  return 'resume_upload_failed';
}

// ---- fill ----

/** The wanted option label for a value in a list of listed options (yes/no for a boolean, the exact text otherwise), or null. */
function wantedOption(value: AnswerValue, options: string[]): string | null {
  if (typeof value === 'boolean') return yesNoOption(value, options);
  return matchOption(options, String(value));
}

/**
 * linkedin_easy_apply_fill: answer the current modal step. Every field is answered from the answer book / resume / owner answers; an
 * unanswered required field parks the job as needs_answer; anything unexpected parks it needs_owner. Takes no argument.
 */
export async function runEasyApplyFill(deps: EngineDeps, page: BcPage, x: EasyApplyDeps = {}): Promise<FillOutcome> {
  const k0 = killReason(deps);
  if (k0) return { ok: false, code: k0.startsWith('kill switch') ? 'killed' : 'halted', status: 'halted', reason: k0 };
  const intent = deps.intents.peek('linkedin');
  if (!intent || intent.class !== 'linkedin_easy_apply' || !intent.pageKey || intent.jobId === undefined) {
    return refused('no_armed_intent', 'arm the application with linkedin_arm_send kind easy_apply first');
  }
  const key = intent.pageKey;
  const jobId = String(intent.jobId);
  const st = easyApplyState(deps.intents);
  const base = { deps, page, jobId, key };
  if (intent.dry || deps.cfg.dryRun) {
    try { recordDryRun(deps.db, { runId: deps.env.JOBBER_RUN_ID ?? null, action: 'linkedin_easy_apply_fill', platform: 'linkedin', payload: { job_id: jobId } }, deps.now(), deps.env); } catch { /* best effort */ }
    return { ok: true, status: 'dry_run', code: 'dry_run', reason: 'dry run: nothing was filled' };
  }
  if (!st.opened.has(key)) return refused('modal_not_opened', 'click the Easy Apply control under the armed intent first');
  if (jobNumericIdOfUrl(page.url()) !== key) return await parkNeedsOwner(base, 'unexpected_page');

  let tree: RawTree;
  try { tree = await page.snapshot(); } catch { return refused('no_snapshot', 'could not read the page'); }
  const dlgNode = easyApplyDialog(tree);
  if (dlgNode === 'none') {
    // The modal is gone from the tree: a blocking dialog may have replaced it. Handle that before giving up.
    const rec = await overlayRecovery(base);
    if (rec.status !== 'none') return rec.out;
  }
  if (dlgNode === 'none') return await parkNeedsOwner(base, 'no_modal');
  if (dlgNode === 'ambiguous') return await parkNeedsOwner(base, 'modal_ambiguous');
  const dlg = dlgNode.n;
  const steps = st.steps.get(key) ?? 0;
  if (steps >= MAX_EASY_APPLY_STEPS) return await parkNeedsOwner(base, 'more_than_8_steps');
  const risk = scanDialog(tree, dlg);
  if (risk) return await parkNeedsOwner(base, risk);

  // 1. the resume (its own step, or the review step shows it already)
  const resume = await ensureResume({ ...base, intent }, tree, dlg, x);
  if (resume !== 'ok' && resume !== 'none_needed') return await parkNeedsOwner(base, resume);
  if (resume === 'ok') {
    try { tree = await page.snapshot(); } catch { return refused('no_snapshot', 'could not read the page'); }
  }
  const dlg2 = easyApplyDialog(tree);
  if (dlg2 === 'none' || dlg2 === 'ambiguous') return await parkNeedsOwner(base, dlg2 === 'none' ? 'no_modal' : 'modal_ambiguous');

  // 2. the fields
  const job = deps.db.prepare('SELECT title, company FROM jobs WHERE id = ?').get(jobId) as { title: string | null; company: string | null } | undefined;
  const jobLocationRow = deps.db.prepare('SELECT description FROM jobs WHERE id = ?').get(jobId) as { description: string | null } | undefined;
  const jobLocation = (jobLocationRow?.description ?? '').split('\n', 1)[0]?.slice(0, 120);
  void job;
  const book = x.answers ? x.answers() : loadAnswerBook();
  const rctx: ResolveCtx = { book, db: deps.db, jobId, ...(jobLocation ? { jobLocation } : {}) };
  const fields = readForm(tree, dlg2.n);
  const unanswered: { label: string; kind: QuestionKind; options: string[] }[] = [];
  const planned: { f: FormField; value: AnswerValue }[] = [];
  const unchecks: FormField[] = [];
  let needsConsent = false;
  for (const f of fields) {
    if (f.kind === 'checkbox') {
      // "Follow <company>" is a marketing-style box: never checked, a pre-checked one is unchecked. Any other required-looking box is consent.
      if (/^follow\b/i.test(f.label)) { if (f.filled) unchecks.push(f); continue; }
      if (!f.filled && !f.optional) needsConsent = true;
      continue;
    }
    if (f.filled) continue; // LinkedIn pre-filled it from the profile, or an earlier fill did
    const r = resolveLabel(f.label, rctx);
    if (!r.ok) {
      if (f.optional) continue;
      if (r.why === 'consent') { needsConsent = true; continue; }
      if (f.label) unanswered.push({ label: f.label, kind: f.kind === 'select' ? 'select' : f.kind === 'radio' ? 'radio' : 'text', options: f.options.map((o) => o.label) });
      else return await parkNeedsOwner(base, 'unsupported_field');
      continue;
    }
    planned.push({ f, value: r.value });
  }
  if (needsConsent) return await parkNeedsOwner(base, 'consent_required');
  if (unanswered.length > 0) return await parkNeedsAnswer({ ...base, intent }, unanswered);

  // 3. fill, one field at a time, then verify
  let filled = 0;
  for (const p of planned) {
    const { f, value } = p;
    try {
      if (f.kind === 'text') {
        if (typeof value === 'boolean') return await parkNeedsOwner(base, 'unsupported_field');
        await page.fillNode(f.node.n, String(value));
      } else if (f.kind === 'select') {
        if (!page.selectOption) return await parkNeedsOwner(base, 'select_unsupported');
        const want = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
        if (!(await page.selectOption(f.node.n, want))) return await parkNeedsOwner(base, 'fill_failed');
      } else if (f.kind === 'radio') {
        const labels = f.options.map((o) => o.label);
        const want = wantedOption(value, labels);
        const opt = want === null ? undefined : f.options.find((o) => normOpt(o.label) === normOpt(want));
        if (!opt) return await parkNeedsOwner(base, 'fill_failed');
        if (page.robustClick) await page.robustClick(opt.node.n); else await page.clickNode(opt.node.n);
      }
      filled++;
      await page.waitMs(150).catch(() => undefined);
    } catch {
      return await parkNeedsOwner(base, 'fill_failed');
    }
  }
  for (const f of unchecks) {
    try { if (page.robustClick) await page.robustClick(f.node.n); else await page.clickNode(f.node.n); } catch { return await parkNeedsOwner(base, 'fill_failed'); }
  }

  // 4. verify what stuck
  let after: RawTree;
  try { after = await page.snapshot(); } catch { return refused('no_snapshot', 'could not read the page'); }
  const d3 = easyApplyDialog(after);
  if (d3 === 'none' || d3 === 'ambiguous') return await parkNeedsOwner(base, d3 === 'none' ? 'no_modal' : 'modal_ambiguous');
  const risk2 = scanDialog(after, d3.n);
  if (risk2) return await parkNeedsOwner(base, risk2);
  const check = readForm(after, d3.n);
  for (const f of check) {
    if (f.kind === 'checkbox') { if (/^follow\b/i.test(f.label) && f.filled) return await parkNeedsOwner(base, 'fill_failed'); continue; }
    if (!f.filled && !f.optional) return await parkNeedsOwner(base, 'fill_failed');
  }
  const names = dialogButtons(after, d3.n).map((b) => b.name);
  const next = names.some((n) => EASY_APPLY_SUBMIT_RE.test(n)) ? 'submit' : names.some((n) => EASY_APPLY_REVIEW_RE.test(n)) ? 'review' : names.some((n) => EASY_APPLY_NEXT_RE.test(n)) ? 'next' : 'none';
  // No Next / Review / Submit control: do not park at once. The operator reads the dialog (title, text, buttons with refs) and chooses.
  if (next === 'none') return await stepDirector(base, after, d3);
  st.fillOk.set(key, st.steps.get(key) ?? 0);
  return done('filled', { filled, next, step: (st.steps.get(key) ?? 0) + 1 });
}

/** The short text a confirmation can come from: text, headings and control names, never field values. */
export function pageTexts(tree: RawTree): Set<string> {
  const out = new Set<string>();
  for (const x of tree.nodes) {
    if (x.role === 'textbox' || x.role === 'searchbox') continue;
    const t = squash(x.role === 'text' ? x.text : x.name).slice(0, 300);
    if (t) out.add(t);
  }
  return out;
}

/** The application-sent confirmation: a new text that says it was sent (never one that was already on the page). */
export function sentConfirmedNew(before: Set<string>, tree: RawTree): boolean {
  for (const t of pageTexts(tree)) {
    if (before.has(t) || /\?\s*$/.test(t)) continue;
    if (SENT_RE.test(t)) return true;
  }
  return false;
}

/** The Applied marker on the job page itself (outside any dialog): "Applied" or "Applied 2 minutes ago". */
export function jobShowsApplied(tree: RawTree): boolean {
  return tree.nodes.some((x) => x.dialog === undefined && x.role !== 'dialog' && /^(?:applied\b|you applied\b|application submitted)/.test(squash(x.role === 'text' ? x.text : x.name)) && !/\b(people|candidates|others|jobs?|similar)\b/.test(squash(x.role === 'text' ? x.text : x.name)));
}

export { RISK_RE, VALIDATION_RE };
