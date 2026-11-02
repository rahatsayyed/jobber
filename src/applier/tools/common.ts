// Shared plumbing for the typed apply tools (plan 8G-2 task 18). Pure handler functions take injected
// deps (db, runtime, env, answer book, classifier) so tests need no MCP server; MCP wiring is task 20.
// Results that reach a model never carry raw exception text, a typed value, a path or a credential.
import type BetterSqlite3 from 'better-sqlite3';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebRuntime } from '../../webcore/runtime.js';
import type { LiPage } from '../../webcore/launch.js';
import { type FormField, type FormModel, type RawFormSnapshot } from '../../webcore/formModel.js';
import type { Verdict } from '../../layout/types.js';
import type { RecipeService } from '../recipes/learn.js';
import type { AtsLayoutGuard } from '../recipes/layoutGuard.js';
import { addEscalation } from '../../outreach/service.js';
import { FIXED_FAIL, HostChanged, haltedWeb, hostOfUrl, noteBlock, readPage } from '../../webcore/login.js';
import { isDryRun, recordDryRun } from '../../safety/dryRun.js';
import type { ClassifierPort } from '../../safety/inputGate.js';
import type { AnswerBook, AnswerRef, AnswerValue } from '../../apply/answers.js';
import type { ConfirmSignals } from '../confirm.js';
import { sameRef } from '../refs.js';
import { resolveHostCap } from '../../webcore/hostCaps.js';
import { checkAndIncrement } from '../../lib/rateLimit.js';
import { recordQuestion, storedAnswer, type QuestionKind } from '../../apply/questions.js';

export type Db = BetterSqlite3.Database;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_STOP_FILE = path.join(ROOT, '.jobber', 'STOP');

export type ApplyStatus =
  | 'ok' | 'refused' | 'needs_owner' | 'needs_answer' | 'needs_human' | 'blocked' | 'dry_run' | 'held'
  | 'rate_limited' | 'submitted' | 'unconfirmed' | 'failed';

export interface ApplyResult {
  status: ApplyStatus;
  code: string;
  reason?: string;
  /** Screened compact page state (never present when the screen blocked). */
  state?: string;
  /** needs_owner / needs_answer: the question text, screened. */
  question?: string;
  /** needs_answer: the apply_questions row the owner answers (`npm run answers -- answer <id> "<text>"`). */
  question_id?: number;
  platform?: string;
  host?: string;
  /** missing_required: field ids only. */
  fields?: string[];
  retry_after_sec?: number;
  /** apply_autofill: field ids the fast path filled, and required ids still open. Ids only, never values. */
  filled?: string[];
  unresolved?: string[];
  /** apply_recipe: a small status record (ids, counts and flags only). */
  info?: Record<string, string | number | boolean | null>;
}

export interface OpenJob {
  jobId: string;
  platform: string;
  /** Host of the page after the first navigation; every later action must still be on it. */
  host: string;
  url: string;
  allowedHosts: string[];
  location?: string;
  steps: number;
  submitted: boolean;
}

export interface ApplierSessionState {
  cur: OpenJob | null;
  /** Last open per host, epoch ms (the per-host gap). */
  lastOpen: Map<string, number>;
  /** Job ids escalated to the owner in this run: never opened again, never retried (task 20). */
  escalated: Set<string>;
}
export const createApplierState = (): ApplierSessionState => ({ cur: null, lastOpen: new Map(), escalated: new Set() });

export interface ApplierDeps {
  db: Db;
  runtime: WebRuntime;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  answers: AnswerBook;
  classifier?: ClassifierPort | (() => Promise<ClassifierPort>);
  /** Test seams: STOP file path and the directory prepared PDFs must live in. */
  stopFile?: string;
  resumeRoot?: string;
  /** Receives block and needs_owner outcomes; the MCP layer writes the Telegram escalation (task 20). Never gets a secret. */
  escalate?: (kind: string, detail: string) => void;
  /** Recipe confirmation signals for a platform (task 19). */
  recipeSignals?: (platform: string) => ConfirmSignals | null;
  /** ATS recipes: lookup, autofill counters and confirmed-only learning (task 19). Optional: without it the fast path reports recipe_miss. */
  recipes?: RecipeService;
  /** Layout memory for ats_<id> pages (task 19). Observes every page read; enforces drift when LAYOUT_ENFORCE=enforce. */
  layoutGuard?: AtsLayoutGuard;
  state: ApplierSessionState;
}

export const envOf = (d: ApplierDeps): NodeJS.ProcessEnv => d.env ?? process.env;
export const nowOf = (d: ApplierDeps): Date => (d.now ?? (() => new Date()))();

export const refuse = (code: string, reason?: string): ApplyResult => ({ status: 'refused', code, ...(reason ? { reason } : {}) });
export const failedResult = (): ApplyResult => ({ status: 'failed', code: 'error', reason: FIXED_FAIL });

/** Fail closed: a STOP file that exists, or that cannot be examined, or JOBBER_KILL=1, stops the tool. */
export function killSwitchActive(deps: ApplierDeps): boolean {
  if (envOf(deps).JOBBER_KILL === '1') return true;
  try {
    lstatSync(deps.stopFile ?? DEFAULT_STOP_FILE);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code !== 'ENOENT';
  }
}

/** Halt (apply, web, all) then kill switch. null means go ahead. */
export function preflight(deps: ApplierDeps): ApplyResult | null {
  const h = haltedWeb(deps.db);
  if (h) return refuse('halted', h);
  if (killSwitchActive(deps)) return refuse('killed', 'the kill switch is on');
  return null;
}

export function dryRunResult(deps: ApplierDeps, action: string, payload: Record<string, unknown>): ApplyResult | null {
  const env = envOf(deps);
  if (!isDryRun(env)) return null;
  recordDryRun(deps.db, { runId: null, action, platform: 'web', payload }, nowOf(deps), env);
  return { status: 'dry_run', code: 'dry_run' };
}

export function blockedResult(deps: ApplierDeps, model: FormModel): ApplyResult {
  noteBlock(model.host);
  deps.escalate?.('block', `${model.block} on ${model.host}`);
  return { status: 'blocked', code: model.block ?? 'blocked' };
}

export interface PageCtx { page: LiPage; job: OpenJob; model: FormModel; raw: RawFormSnapshot; layout: Verdict | null }

/**
 * Under LAYOUT_ENFORCE=enforce a drifted ATS layout stops the tool before it touches the page. The owner
 * gets an 'apply' escalation (platform and step kind only). Warn and off modes never refuse.
 */
export function layoutDriftRefusal(deps: ApplierDeps, job: OpenJob, model: FormModel, layout: Verdict | null): ApplyResult | null {
  if (!deps.layoutGuard?.enforce() || !layout || layout.class !== 'drift') return null;
  try {
    addEscalation(deps.db, { runId: null, platform: 'apply', reason: 'layout_drift', detail: `platform=${job.platform} kind=${model.stepKind}` }, nowOf(deps));
  } catch { console.error('[applier] escalation failed'); }
  deps.escalate?.('layout_drift', `${job.platform} ${model.stepKind}`);
  return refuse('layout_drift', 'the page layout no longer matches what was learned; continue by hand');
}

/** Tells the recipe service which field the operator filled (advisory; never throws, never carries a value). */
export function noteFilled(deps: ApplierDeps, c: Pick<PageCtx, 'job' | 'model' | 'raw'>, f: FormField): void {
  try {
    const i = Number(f.id.slice(1)) - 1;
    deps.recipes?.noteFilled({ platform: c.job.platform, jobId: c.job.jobId, stepKind: c.model.stepKind, field: f, raw: c.raw.fields?.[i] });
  } catch { console.error('[applier] note failed'); }
}

/**
 * Runs `fn` on the open page behind the runtime queue: halt, kill switch, an open job, the page still
 * on the job's host, a fresh form model, and no block. A throw becomes a fixed code-authored failure.
 */
export async function inPage(deps: ApplierDeps, fn: (c: PageCtx) => Promise<ApplyResult>): Promise<ApplyResult> {
  const g = preflight(deps);
  if (g) return g;
  const job = deps.state.cur;
  if (!job) return refuse('no_job', 'call apply_open first');
  if (job.submitted) return refuse('already_submitted', 'this application was already submitted');
  try {
    return await deps.runtime.serial(async (): Promise<ApplyResult> => {
      const page = deps.runtime.page();
      if (!page) { deps.state.cur = null; return refuse('no_session', 'the page is closed; call apply_open again'); }
      if (hostOfUrl(page.url()) !== job.host) return refuse('host_changed', 'the page moved to another host; nothing was done');
      const { raw, model } = await readPage(page);
      if (model.block) return blockedResult(deps, model);
      let layout: Verdict | null = null;
      try { layout = deps.layoutGuard?.observe(job.platform, model) ?? null; } catch { console.error('[applier] layout observe failed'); }
      return fn({ page, job, model, raw, layout });
    });
  } catch (e) {
    if (e instanceof HostChanged) return refuse('host_changed', 'the page moved to another host; nothing was typed');
    console.error('[applier] tool failed');
    return failedResult();
  }
}

export const findField = (m: FormModel, id: string): FormField | undefined => m.fields.find((f) => f.id === id);

export type Resolved = { ok: true; value: AnswerValue } | { ok: false; result: ApplyResult };

/**
 * A free question: the answer book alone decides which ref answers it. A question the book cannot
 * classify (free text, consent, attestation, unknown), a missing answer or no ref is `needs_owner`
 * with the question text; a ref for another topic is a refusal. Nothing is guessed.
 */
export async function resolveQuestion(
  f: FormField, ref: AnswerRef | undefined, deps: ApplierDeps, job: OpenJob,
  questionText: (label: string) => Promise<string>,
): Promise<Resolved> {
  const ask = async (code: string): Promise<Resolved> => ({ ok: false, result: await needsAnswer(deps, job, f, code, questionText) });
  const s = deps.answers.suggest(f.label);
  // Consent and attestation boxes are never answered from any book: they wait for the owner by hand.
  if (s.cls === 'consent' || s.cls === 'legal_attestation') {
    return { ok: false, result: { status: 'needs_owner', code: s.cls, question: await questionText(f.label) } };
  }
  const checkLen = (v: AnswerValue): Resolved => {
    if (typeof v !== 'boolean' && f.maxLength && String(v).length > f.maxLength) {
      return { ok: false, result: refuse('answer_too_long', `the stored answer is longer than the field allows (${f.maxLength}); shorten it with npm run answers`) };
    }
    return { ok: true, value: v };
  };
  // 1. The answer book (answer file, profile, values derived from the resume): its own suggestion decides which ref answers this field.
  if (s.ref && deps.answers.has(s.ref)) {
    if (!ref) return ask('ref_required');
    if (!sameRef(ref, s.ref)) return { ok: false, result: refuse('role_ref_mismatch', 'that answer does not belong to this question') };
    const v = deps.answers.resolve(s.ref, { jobLocation: job.location });
    if (v !== null && v !== undefined && v !== '') return checkLen(v);
  }
  // 2. An answer the owner gave for this very question (`once` for this job, `always` for this host and label). Code picks it from the
  //    field's own label; the model's ref only has to be an answer ref. Nothing is matched loosely.
  const stored = storedAnswer(deps.db, job.jobId, job.host, f.label);
  if (stored !== null) {
    if (!ref || ref.kind !== 'answer') return ask('ref_required');
    return checkLen(stored);
  }
  // 3. Nothing reliable: the job pauses as needs_answer. Never guess.
  return ask(s.ref ? 'missing_answer' : s.cls);
}

const kindOf = (f: FormField): QuestionKind => (f.type === 'select' ? 'select' : f.type === 'radio' ? 'radio' : f.type === 'checkbox' ? 'checkbox' : 'text');

/**
 * The result for a question nothing reliable can answer. A REQUIRED field gets one apply_questions row (deduped by normalized label and host)
 * and the status `needs_answer`; an optional field is simply left blank (`optional_unanswered`); a question the owner skipped ends the job.
 */
export async function needsAnswer(
  deps: ApplierDeps, job: OpenJob, f: FormField, code: string, questionText: (label: string) => Promise<string>,
): Promise<ApplyResult> {
  if (!f.required) return refuse('optional_unanswered', 'an optional question without a reliable answer is left blank');
  const question = await questionText(f.label);
  let id: number | undefined;
  try {
    const r = recordQuestion(deps.db, {
      jobId: job.jobId, host: job.host, label: f.label, kind: kindOf(f), options: f.options, maxLength: f.maxLength,
    }, nowOf(deps));
    id = r.id;
    if (r.status === 'skipped') return refuse('question_skipped', 'the owner chose not to answer this question');
  } catch { console.error('[applier] question not recorded'); }
  return { status: 'needs_answer', code, question, ...(id !== undefined ? { question_id: id } : {}) };
}

/** MAX_APPLIES_PER_DAY, same parsing the legacy tools used (integer, default 5). */
export function maxAppliesPerDay(env: NodeJS.ProcessEnv): number {
  const raw = env.MAX_APPLIES_PER_DAY;
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return 5;
  return Number(raw.trim());
}

export function hostDayCount(db: Db, host: string): number {
  const row = db.prepare("SELECT count FROM apply_host_day WHERE host = ? AND day = date('now')").get(host) as { count: number } | undefined;
  return row?.count ?? 0;
}

/**
 * Consumes the global daily apply counter (`easy_apply`, MAX_APPLIES_PER_DAY) and the per-host daily
 * counter together in ONE immediate transaction: either both move or neither does. The host is
 * checked first so a host at its cap never burns a global slot.
 */
export function consumeSubmitCounters(db: Db, env: NodeJS.ProcessEnv, platform: string, host: string): 'ok' | 'daily_cap' | 'host_cap' {
  const cap = resolveHostCap(platform, env).cap;
  const run = db.transaction((): 'ok' | 'daily_cap' | 'host_cap' => {
    if (hostDayCount(db, host) >= cap) return 'host_cap';
    if (!checkAndIncrement(db, 'easy_apply', maxAppliesPerDay(env))) return 'daily_cap';
    db.prepare(
      "INSERT INTO apply_host_day (host, day, count) VALUES (?, date('now'), 1) ON CONFLICT(host, day) DO UPDATE SET count = count + 1",
    ).run(host);
    return 'ok';
  });
  return run.immediate();
}

export function recordApplication(db: Db, job: OpenJob, status: 'submitted' | 'manual_review', reason: string | null, now: Date): void {
  db.prepare('INSERT INTO applications (job_id, platform, method, account, status, reason, applied_at) VALUES (?,?,?,?,?,?,?)')
    .run(job.jobId, job.platform, 'browser', null, status, reason, status === 'submitted' ? now.toISOString() : null);
  db.prepare("UPDATE outreach_queue SET apply_status = ?, updated_at = datetime('now') WHERE job_id = ?").run(status, job.jobId);
}
