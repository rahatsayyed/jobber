// apply_escalate (plan 8G-2 task 20): hands one job to the owner. Reasons are a closed list; the detail is
// built by code from the open form model (screened, capped) plus an optional 100-char note that must pass
// the style gate. Blocks always stop: never solved, never waited out, never retried in the same run. The
// result carries codes only, never page text, an answer value or a credential.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { addEscalation } from '../outreach/service.js';
import { screenUntrusted } from '../safety/screen.js';
import { isDryRun } from '../safety/dryRun.js';
import { checkStyle, loadStyleConfigSafe, type StyleConfig } from '../safety/styleGate.js';
import { formatState } from '../webcore/state.js';
import type { FormModel } from '../webcore/formModel.js';
import { telegramNotifier } from '../platform/notify.js';
import { pingAssist, type AssistNotifier } from './assistPing.js';
import { openQuestionsForJob, pauseJobNeedsAnswer, recordQuestion, reopenAgentQuestionsForJob, storedAnswer } from '../apply/questions.js';
import { hostOfUrl, noteBlock, readPage } from '../webcore/login.js';
import { fileNotifier, type Notice } from '../scheduler/notify.js';
import { resolveRunId } from '../layout/runtime.js';
import { recordHostBlock } from './cooldown.js';
import { envOf, failedResult, nowOf, refuse, type ApplierDeps, type ApplyResult } from './tools/common.js';

export const ESCALATE_REASONS = [
  'captcha', 'mfa', 'phone_verification', 'email_verification', 'account_needed', 'question', 'consent',
  'marketing_checkbox', 'host_unknown', 'drift', 'blocked', 'cover_letter', 'login_failed', 'other', 'no_relevant_role',
] as const;
export type EscalateReason = (typeof ESCALATE_REASONS)[number];
/** Reasons that mean the site itself stopped us: recorded against the host (cooldown, bot_wall halt). */
export const BLOCK_REASONS: ReadonlySet<string> = new Set(['captcha', 'mfa', 'phone_verification', 'blocked']);

export const EscalateInput = z.object({
  job_id: z.string().regex(/^[\w.:@-]{1,200}$/),
  reason: z.enum(ESCALATE_REASONS),
  detail: z.string().max(100).optional(),
}).strict();
export type EscalateInputT = z.infer<typeof EscalateInput>;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_NOTIFY_PATH = path.join(ROOT, '.jobber', 'notify.jsonl');

/** The apply:assist ping goes to the `assist` Telegram topic. */
function assistTelegram(env: NodeJS.ProcessEnv): AssistNotifier {
  const tg = telegramNotifier(env);
  return { send: (text) => tg.send(text, { topic: 'assist' }) };
}
const DETAIL_CAP = 700;

/** Reasons only a person at a keyboard can clear on a generic site: the job pauses as `needs_human` and `npm run apply:assist -- <job_id>` helps. */
export const ASSIST_REASONS: ReadonlySet<string> = new Set(['captcha', 'mfa', 'phone_verification', 'email_verification', 'account_needed', 'login_failed']);

/** escalations.thread_ref allows [A-Za-z0-9_:./-] up to 120 characters: one open card per kind and host. */
export const threadRefFor = (kind: 'answers' | 'assist', host: string): string => `${kind}:${String(host || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_')}`.slice(0, 120);

/** One open apply_questions row per required, still-empty question on the open page that no book or derived value can answer. */
async function recordPageQuestions(deps: ApplierDeps, jobId: string, host: string, model: FormModel): Promise<void> {
  const now = nowOf(deps);
  for (const f of model.fields) {
    if (f.hidden || !f.required || f.filled) continue;
    if (f.type === 'file' || f.type === 'password' || f.type === 'checkbox' || f.type === 'hidden') continue;
    if (!['question', 'unknown', 'location', 'phone', 'linkedin_url'].includes(f.role) && f.type !== 'select' && f.type !== 'radio') continue;
    if (f.role === 'eeo' || f.role === 'consent' || f.role === 'marketing' || f.role === 'otp') continue;
    const s = deps.answers.suggest(f.label);
    if (s.cls === 'consent' || s.cls === 'legal_attestation') continue;
    if (s.ref && deps.answers.has(s.ref)) continue;
    if (storedAnswer(deps.db, jobId, host, f.label) !== null) continue;
    try {
      recordQuestion(deps.db, {
        jobId, host, label: f.label, maxLength: f.maxLength, options: f.options,
        kind: f.type === 'select' ? 'select' : f.type === 'radio' ? 'radio' : 'text',
      }, now);
    } catch { console.error('[applier] question not recorded'); }
  }
}

export interface EscalateExtras {
  /** Notification sink; default appends to .jobber/notify.jsonl (and JOBBER_NOTIFY_CMD is NOT run here). */
  notify?: (n: Notice) => void | Promise<void>;
  styleCfg?: StyleConfig;
  /** Telegram sender for the needs_human ping (default: the code-composed Telegram sender; tests pass a fake). */
  telegram?: AssistNotifier;
  runId?: string | null;
}

function sendNotice(n: Notice, deps: ApplierDeps, x: EscalateExtras): void {
  try {
    const r = x.notify ? x.notify(n) : fileNotifier(DEFAULT_NOTIFY_PATH, () => nowOf(deps)).notify(n);
    if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => undefined);
  } catch { console.error('[applier] notify failed'); }
}

export async function handleEscalate(input: EscalateInputT, deps: ApplierDeps, x: EscalateExtras = {}): Promise<ApplyResult> {
  try {
    return await escalate(input, deps, x);
  } catch {
    console.error('[applier] apply_escalate failed');
    return failedResult();
  }
}

async function escalate(input: EscalateInputT, deps: ApplierDeps, x: EscalateExtras): Promise<ApplyResult> {
  const env = envOf(deps);
  const now = nowOf(deps);
  const db = deps.db;
  const job = db.prepare('SELECT id, COALESCE(NULLIF(external_apply_url, \'\'), apply_url) AS apply_url FROM jobs WHERE id = ?').get(input.job_id) as { id: string; apply_url: string | null } | undefined;
  if (!job) return refuse('unknown_job', 'no such job');
  const key = `${input.job_id}:${input.reason}`;
  const seen = (deps.state.escalated ??= new Set<string>());
  if (seen.has(key)) return { status: 'needs_owner', code: 'already_escalated', reason: 'the owner was already notified' };

  const cur = deps.state.cur && deps.state.cur.jobId === input.job_id ? deps.state.cur : null;
  const host = cur?.host ?? hostOfUrl(job.apply_url ?? '');
  const platform = cur?.platform ?? 'unknown';

  // Detail: code-built header, the compact form model of the open page (if this job is open), the note.
  // `job=<id>` lets the Inbox show which job a card is about and close the card when the job moves on (src/outreach/applyEscalations.ts).
  const lines = [`reason=${input.reason} platform=${platform} host=${host || 'unknown'} job=${input.job_id}`];
  let noteDropped = false;
  const note = (input.detail ?? '').trim();
  if (note) {
    const cfg = x.styleCfg ?? loadStyleConfigSafe('config/ai-tells.json').cfg;
    if (checkStyle(note, 'feedback', cfg).ok) lines.push(`note: ${note}`);
    else noteDropped = true;
  }
  let pageModel: FormModel | null = null;
  if (cur) {
    try {
      pageModel = await deps.runtime.serial(async () => {
        const page = deps.runtime.page();
        return page ? (await readPage(page)).model : null;
      });
      if (pageModel) lines.push(formatState(pageModel));
    } catch { /* the header alone is enough */ }
  }
  const composed = lines.join('\n');
  const v = await screenUntrusted(composed, 'escalate', { env, dryRun: isDryRun(env), classifier: deps.classifier, maxChars: 12000 });
  const detail = v.blocked
    ? `${lines[0]}\n[page text withheld: ${v.code}]`
    : v.text.slice(0, DETAIL_CAP) + (v.unscreened ? '\nclassifier=unscreened' : '');

  const runId = x.runId === undefined ? resolveRunId(env) : x.runId;
  let status: 'needs_owner' | 'needs_answer' | 'needs_human' = 'needs_owner';
  if (input.reason === 'question') {
    // Nothing reliable answers these: each required unanswered question gets (or refreshes) one apply_questions row, and the job pauses.
    if (pageModel && host) await recordPageQuestions(deps, input.job_id, host, pageModel);
    // Questions left to the agent that nobody drafted go back to the owner: the job is escalated, so it must not wait for a draft.
    if (openQuestionsForJob(db, input.job_id).length === 0) reopenAgentQuestionsForJob(db, input.job_id);
    const n = pauseJobNeedsAnswer(db, input.job_id);
    status = 'needs_answer';
    addEscalation(db, {
      runId, platform: 'apply', reason: 'apply:needs_answer', threadRef: threadRefFor('answers', host),
      detail: `needs your answer: ${n} question${n === 1 ? '' : 's'} for job ${input.job_id} on ${host || 'unknown host'}; run: npm run answers -- list`,
    }, now);
    sendNotice({ level: 'warn', title: `apply needs your answer: ${n} question${n === 1 ? '' : 's'}`, detail: `job=${input.job_id} host=${host || 'unknown'} run: npm run answers -- list`, runId: runId ?? undefined }, deps, x);
  } else if (ASSIST_REASONS.has(input.reason) && host) {
    // A login wall, sign-up, CAPTCHA or MFA: only a person can pass it. One escalation per HOST (open ones merge), however many jobs wait.
    status = 'needs_human';
    db.prepare("UPDATE outreach_queue SET apply_status = 'needs_human', apply_note = ?, updated_at = datetime('now') WHERE job_id = ?").run(`assist:${input.reason}`, input.job_id);
    addEscalation(db, {
      runId, platform: 'apply', reason: 'apply:needs_human', threadRef: threadRefFor('assist', host),
      detail: `needs you on ${host} (${input.reason}): run npm run apply:assist -- ${input.job_id}`,
    }, now);
    sendNotice({ level: 'warn', title: `apply needs a human on ${host}: ${input.reason}`, detail: `job=${input.job_id} run: npm run apply:assist -- ${input.job_id}`, runId: runId ?? undefined }, deps, x);
    // One Telegram ping per host per 6 hours, composed in code. Never blocks the park; the screenshot is taken only if the sender can send it.
    try {
      await pingAssist(db, {
        host, jobId: input.job_id, reason: input.reason, now, env,
        notifier: x.telegram ?? assistTelegram(env),
        screenshot: async () => (cur ? await deps.runtime.serial(async () => (await deps.runtime.page()?.screenshot({ type: 'png' })) ?? null) : null),
      });
    } catch { console.error('[applier] assist ping failed'); }
  } else {
    addEscalation(db, { runId, platform: 'apply', reason: `apply:${input.reason}`, detail }, now);
    sendNotice({ level: 'warn', title: `apply needs the owner: ${input.reason}`, detail: `job=${input.job_id} host=${host || 'unknown'}`, runId: runId ?? undefined }, deps, x);
  }
  if (status === 'needs_owner') {
    // `no_relevant_role`: a careers listing with no role that fits the resume. The note puts the row on the manual apply queue with that
    // reason (src/manual/manualApply.ts); the listing URL is the row's own apply url.
    db.prepare("UPDATE outreach_queue SET apply_status = 'needs_owner', apply_note = CASE WHEN ? THEN 'no_relevant_role' ELSE apply_note END, updated_at = datetime('now') WHERE job_id = ?")
      .run(input.reason === 'no_relevant_role' ? 1 : 0, input.job_id);
  }

  if (BLOCK_REASONS.has(input.reason)) {
    if (host) noteBlock(host);
    recordHostBlock(db, host, input.reason === 'blocked' ? 'blocked' : input.reason, now, runId, env);
  }

  // The job is finished for this run: no more typing, no retry.
  seen.add(key);
  seen.add(input.job_id);
  if (cur) {
    deps.state.cur = null;
    try { await deps.runtime.close(); } catch { console.error('[applier] close failed'); }
  }
  return {
    status, code: 'escalated',
    reason: noteDropped ? 'the owner was notified; the note was dropped by the style gate' : 'the owner was notified; nothing more is done for this job in this run',
    ...(host ? { host } : {}),
  };
}

/**
 * The `escalate` callback the tools receive for block and drift outcomes: a block is persisted against its
 * host (cooldown, bot_wall halt) and the owner is notified. Detail format is code-authored: "<kind> on <host>".
 */
export function createEscalationSink(deps: Pick<ApplierDeps, 'db' | 'env' | 'now'>, x: EscalateExtras = {}): (kind: string, detail: string) => void {
  return (kind, detail) => {
    try {
      const env = deps.env ?? process.env;
      const now = (deps.now ?? (() => new Date()))();
      const runId = x.runId === undefined ? resolveRunId(env) : x.runId;
      if (kind === 'block') {
        const m = /^([a-z_]{1,40}) on ([A-Za-z0-9.-]{1,253})$/.exec(detail);
        if (m) {
          const r = recordHostBlock(deps.db, m[2], m[1], now, runId, env);
          sendNotice({ level: r.halted ? 'halt' : 'warn', title: `apply blocked: ${m[1]}`, detail: `host=${m[2]}${r.cooldown ? ' cooldown' : ''}${r.halted ? ' apply halted' : ''}`, runId: runId ?? undefined }, deps as ApplierDeps, x);
        }
      } else {
        sendNotice({ level: 'info', title: `apply: ${String(kind).slice(0, 40)}`, detail: String(detail).slice(0, 200), runId: runId ?? undefined }, deps as ApplierDeps, x);
      }
    } catch { console.error('[applier] sink failed'); }
  };
}
