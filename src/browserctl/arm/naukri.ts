// browserctl arm tools for Naukri: every code gate that used to live inside naukri_send_message and the
// native Apply click, then ONE armed intent. The commit path (commitNaukri.ts) refuses any send or apply
// without it. Arming also runs in a dry run: it records and creates a dry intent, whose commit records
// instead of clicking.
//
// armNaukriMessage = gates 1 to 10 of the old naukriSendMessage: halt, quiet hours, person and paused and
// cooldown, verified thread (unverified_thread: cold Naukri messages stay impossible), cadence, length,
// style, fact and output gates, ceiling read, dry run, live thread and recipient verification, the page
// screen, reserveTouch. tryConsume('naukri_message') moves to the commit path (right before the click).
// armNaukriApply = job known, not vetoed, not applied, apply class naukri, caps readable; the job page is
// opened from the stored apply_url (never a model URL).
import type BetterSqlite3 from 'better-sqlite3';
import { classifyApplyUrl } from '../../apply/registry.js';
import { getExcludedReason, getFirstHardStop } from '../../db.js';
import { finishTouch, pauseContact, reserveTouch } from '../../linkedin/touches.js';
import { naukriJobIdOfUrl, THREAD_REF_RE, threadRefOfUrl, threadUrl } from '../../naukri/page.js';
import {
  cadenceSnapshot, loadNaukriPerson, MAX_NAUKRI_MESSAGE_CHARS, naukriIdempotencyKey, norm, sentMessages, threadStateKey,
} from '../../naukri/sendState.js';
import { planNextTouch } from '../../outreach/cadence.js';
import type { OutreachConfig } from '../../outreach/config.js';
import { ceilings } from '../../outreach/limits.js';
import { companyPaused } from '../../outreach/people.js';
import { inQuietHours, pacingFromConfig } from '../../outreach/pacing.js';
import { loadTuning, type Tuning } from '../../outreach/tuning.js';
import { isDryRun, recordDryRun } from '../../safety/dryRun.js';
import { gateOutbound, secretValuesFromEnv } from '../../safety/outputGate.js';
import { getState } from '../../scheduler/runLog.js';
import type { Engine } from '../act.js';
import { DEFAULT_MAX_APPLIES_PER_DAY, threadHeaderName } from '../commitNaukri.js';
import { killReason, type EngineDeps } from '../engineTypes.js';
import type { IntentStore } from '../intent.js';
import { bindTouchRelease } from '../intent.js';
import { NAUKRI_POLICY } from '../policy.js';
import { renderTree, type RawTree } from '../snapshot.js';

export const NAUKRI_ARM_KINDS = ['role_ask', 'rapport', 'referral_ask', 'followup', 'feedback'] as const;
export type NaukriArmKind = (typeof NAUKRI_ARM_KINDS)[number];

export interface NaukriArmDeps {
  engine: Engine;
  intents: IntentStore;
  db: BetterSqlite3.Database;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  cfg: OutreachConfig;
  /** Fact gate on the outbound text (resume.check_text equivalent). */
  checkText: (text: string) => Promise<{ ok: boolean; normalized: string; verdict: 'pass' | 'warn' | 'block' }>;
  /** Style gate for one touch kind. */
  style: (text: string, kind: string) => { ok: boolean; hits: string[] };
  screen: EngineDeps['screen'];
  stopFile?: string;
  tuning?: Tuning;
}

export interface NaukriArmResult {
  status: 'armed' | 'refused' | 'halted' | 'rate_limited' | 'failed';
  code: string;
  reason?: string;
  intent_id?: string;
  expires_at?: string;
  class?: 'naukri_send' | 'naukri_apply';
  dry_run?: boolean;
  touch_id?: number;
  would?: Record<string, unknown>;
}

export interface NaukriSendArgs { person_id: number; thread_ref: string; text: string; kind: NaukriArmKind; job_id?: string }

const killDeps = (d: Pick<NaukriArmDeps, 'db' | 'env' | 'stopFile'>) => ({ db: d.db, env: d.env, stopFile: d.stopFile, policy: NAUKRI_POLICY });
const killCode = (k: string): 'killed' | 'halted' => (k.startsWith('kill switch') ? 'killed' : 'halted');

/** Page text for the screen and the copy check: our own composer value is not page text. */
function pageTextOf(tree: RawTree, epoch: number): string {
  return renderTree({ ...tree, nodes: tree.nodes.map((x) => (x.composer && x.role === 'textbox' ? { ...x, value: undefined } : x)) }, epoch);
}

export async function armNaukriMessage(d: NaukriArmDeps, a: NaukriSendArgs): Promise<NaukriArmResult> {
  const { db } = d;
  bindTouchRelease(d.intents, db);
  d.intents.sweep();
  const now = d.now();
  let touchId: number | undefined;
  let liveTouch = false;
  const fail = (status: NaukriArmResult['status'], code: string, reason?: string): NaukriArmResult => {
    if (liveTouch && touchId !== undefined) { try { finishTouch(db, touchId, 'failed', now); } catch { /* fail closed below */ } }
    return { status, code, ...(reason ? { reason } : {}) };
  };
  try {
    if (!(NAUKRI_ARM_KINDS as readonly string[]).includes(a.kind)) return fail('refused', 'bad_kind', 'unknown kind');
    if (typeof a.thread_ref !== 'string' || !THREAD_REF_RE.test(a.thread_ref)) return fail('refused', 'bad_thread_ref', 'thread_ref must match [A-Za-z0-9_:./-]{1,120}');
    if (typeof a.person_id !== 'number' || !Number.isInteger(a.person_id)) return fail('refused', 'unknown_recipient', 'person_id must be an integer');

    // (1) halts and the kill switch
    const k = killReason(killDeps(d));
    if (k) return fail('halted', killCode(k), k);
    // quiet hours (mirrors the LinkedIn guard)
    const tuning = d.tuning ?? loadTuning(d.env);
    if (inQuietHours(now, pacingFromConfig(d.cfg, tuning))) return fail('refused', 'quiet_hours', 'quiet hours');

    // (2) person and contact state
    const p = loadNaukriPerson(db, a.person_id);
    if (!p) return fail('refused', 'unknown_recipient', 'recipient is not in people');
    if (p.platform !== 'naukri') return fail('refused', 'wrong_platform', 'recipient is not a Naukri contact');
    if (!p.name || !p.name.trim()) return fail('refused', 'recipient_name_unknown', 'recipient name is unknown');
    const cooldown = p.cooldown_until ? new Date(p.cooldown_until) : null;
    if (
      p.paused_reason !== null
      || ['replied_negative', 'closed', 'cooldown'].includes(p.stage ?? 'new')
      || (cooldown && (Number.isNaN(cooldown.getTime()) || cooldown > now))
      || companyPaused(db, 'naukri', p.company_key)
    ) return fail('refused', 'contact_paused', 'contact or company is paused');

    // (2b) the thread must be verified server-side: last confirmed thread, or a recorded inbound thread
    const known = new Set<string>();
    const confirmed = getState(db, threadStateKey(p.id));
    if (confirmed) known.add(confirmed);
    const inboundRows = db.prepare(
      `SELECT thread_ref, klass, escalated, created_at FROM inbound_messages
        WHERE platform = 'naukri' AND person_id = ? ORDER BY created_at DESC, id DESC`,
    ).all(p.id) as { thread_ref: string; klass: string; escalated: number; created_at: string }[];
    for (const r of inboundRows) if (r.klass === 'recruiter_inquiry' || r.klass === 'reply') known.add(r.thread_ref);
    if (!known.has(a.thread_ref)) return fail('refused', 'unverified_thread', 'the thread is not a known recruiter or reply thread');

    // (3) cadence: reply-to-inbound is derived here, never caller supplied
    let replyToInbound = false;
    if (a.kind === 'followup') {
      const latest = inboundRows.find((r) => r.thread_ref === a.thread_ref);
      if (latest && latest.escalated === 0 && ['recruiter_inquiry', 'reply'].includes(latest.klass)) {
        const later = db.prepare("SELECT 1 AS hit FROM touches WHERE person_id = ? AND status = 'sent' AND created_at > ? LIMIT 1").get(p.id, latest.created_at);
        replyToInbound = later === undefined;
      }
    }
    if (!replyToInbound) {
      const next = planNextTouch(cadenceSnapshot(p, sentMessages(db, p)), now, tuning.cadenceGapsDays);
      if (!next || next.kind !== a.kind || next.dueAt > now) return fail('refused', 'cadence_not_due', 'the next touch is not due for this kind');
    }

    // (4) length, style, fact
    const text = a.text ?? '';
    if (text.trim().length === 0) return fail('refused', 'empty_text', 'text is required');
    if (text.length > MAX_NAUKRI_MESSAGE_CHARS) return fail('refused', 'message_too_long', `over ${MAX_NAUKRI_MESSAGE_CHARS} characters`);
    const st = d.style(text, a.kind);
    if (!st.ok) return fail('refused', 'style_gate', `style: ${st.hits.join(', ')}`);
    const ct = await d.checkText(text);
    const stNorm = typeof ct.normalized === 'string' ? d.style(ct.normalized, a.kind) : st;
    if (!stNorm.ok) return fail('refused', 'style_gate', `style: ${stNorm.hits.join(', ')}`);
    if (!ct.ok || ct.verdict === 'block') return fail('refused', 'fact_gate_block', 'the fact gate blocked the text');
    const normalized = ct.normalized;
    if (typeof normalized !== 'string' || normalized.trim().length === 0) return fail('refused', 'empty_text', 'text is required');
    if (normalized.length > MAX_NAUKRI_MESSAGE_CHARS) return fail('refused', 'message_too_long', `over ${MAX_NAUKRI_MESSAGE_CHARS} characters`);

    // (5) output gate (recipient and thread are SQLite-verified above)
    const baseCtx = {
      recipientKey: p.profile_key, expectedRecipientKey: p.profile_key,
      threadId: a.thread_ref, expectedThreadId: a.thread_ref,
      allowedUrls: [] as string[], allowedEmails: [] as string[],
      secretValues: secretValuesFromEnv(d.env), factVerdict: ct.verdict,
    };
    const g = gateOutbound(normalized, baseCtx);
    if (!g.ok) return fail('refused', 'output_gate', `output gate: ${g.reasons.join(', ')}`);

    // (6) ceiling read: a spent ceiling refuses here; the commit path consumes it right before the click
    const c = ceilings(db, d.cfg, now).naukri_message;
    if (!c.ok) return fail('rate_limited', 'rate_limited', `${c.used} of ${c.limit} today`);

    // (7) live thread and recipient verification on the page
    const opened = await d.engine.open(threadUrl(a.thread_ref));
    if (!opened.ok) {
      const halted = opened.code === 'halted' || opened.code === 'killed';
      return fail(halted ? 'halted' : 'failed', opened.code, opened.reason);
    }
    const tree = d.engine.lastTree();
    const page = await d.engine.page();
    if (!tree || !page) return fail('failed', 'no_snapshot', 'could not read the page');
    if (threadRefOfUrl(page.url()) !== a.thread_ref) return fail('refused', 'thread_mismatch', 'browser is not on the requested thread');
    const head = threadHeaderName(tree);
    if (!head) return fail('refused', 'recipient_unverified', 'could not read the recipient name in the thread header');
    const h = norm(head);
    if (h !== norm(p.name) && h !== norm(p.profile_key)) return fail('refused', 'recipient_mismatch', 'thread header names a different person');
    const pageText = pageTextOf(tree, d.engine.refs.epoch);

    // (8) third-party page text: screen for sending, fail closed
    const v = await d.screen(pageText, 'send');
    if (v.blocked) {
      if (v.code === 'classifier_unavailable') return fail('failed', 'classifier_unavailable');
      pauseContact(db, p.id, 'injection_suspected', now);
      return fail('refused', 'injection_suspected', 'page text flagged by the input screen');
    }
    const og = gateOutbound(normalized, { ...baseCtx, rawPageText: pageText });
    if (!og.ok) return fail('refused', 'output_gate_page', `output gate: ${og.reasons.join(', ')}`);

    // (9) dry run, else the idempotent touch (a duplicate must never consume a ceiling unit)
    const dry = isDryRun(d.env);
    if (!dry) {
      const r = reserveTouch(db, {
        personId: p.id, kind: a.kind, jobId: a.job_id ?? null, body: normalized,
        key: naukriIdempotencyKey(p.id, a.kind, normalized), now, dryRun: false,
      });
      if (!r.ok) return fail('refused', 'duplicate', r.reason);
      touchId = r.touchId;
      liveTouch = true;
    }
    const intent = d.intents.arm({
      platform: 'naukri', kind: a.kind, class: 'naukri_send', threadRef: a.thread_ref, text: normalized, personId: p.id,
      ...(touchId !== undefined ? { touchId } : {}),
      ...(a.job_id !== undefined ? { jobId: a.job_id } : {}),
      dry,
    });
    if (dry) {
      try {
        recordDryRun(db, {
          runId: d.env.JOBBER_RUN_ID ?? null, action: 'naukri_arm_send', platform: 'naukri', personId: p.id,
          payload: { kind: a.kind, thread_ref: a.thread_ref, job_id: a.job_id ?? null, chars: normalized.length, recipient: p.name },
        }, now, d.env);
      } catch { /* the dry intent is still armed */ }
    }
    return {
      status: 'armed', code: 'armed', intent_id: intent.id, expires_at: new Date(intent.expiresAt).toISOString(),
      class: 'naukri_send', dry_run: dry, ...(touchId !== undefined ? { touch_id: touchId } : {}),
      would: { kind: a.kind, chars: normalized.length, recipient: p.name },
    };
  } catch (e) {
    void e; // exception text can carry page content
    return fail('failed', 'error', 'unexpected error while arming');
  }
}

// ---------------------------------------------------------------------------------------------
export interface NaukriApplyArgs { job_id: string }
export const JOB_ID_RE = /^[\w.:@-]{1,200}$/;

interface JobRow { id: string; source: string | null; apply_url: string | null }

/** Today's easy_apply counter has room (read only; the commit path consumes it). */
function easyApplyRoom(db: BetterSqlite3.Database, env: NodeJS.ProcessEnv): { used: number; max: number } {
  const maxRaw = Number(env.MAX_APPLIES_PER_DAY ?? DEFAULT_MAX_APPLIES_PER_DAY);
  const max = Number.isFinite(maxRaw) && maxRaw >= 0 ? maxRaw : DEFAULT_MAX_APPLIES_PER_DAY;
  const row = db.prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = 'easy_apply'").get() as { count: number } | undefined;
  return { used: row?.count ?? 0, max };
}

export async function armNaukriApply(d: Omit<NaukriArmDeps, 'checkText' | 'style'>, a: NaukriApplyArgs): Promise<NaukriArmResult> {
  const { db } = d;
  bindTouchRelease(d.intents, db);
  d.intents.sweep();
  const now = d.now();
  const fail = (status: NaukriArmResult['status'], code: string, reason?: string): NaukriArmResult =>
    ({ status, code, ...(reason ? { reason } : {}) });
  try {
    if (typeof a.job_id !== 'string' || !JOB_ID_RE.test(a.job_id)) return fail('refused', 'bad_job_id', 'job_id has a bad shape');
    const k = killReason(killDeps(d));
    if (k) return fail('halted', killCode(k), k);

    // Pre-flight, before any browser use
    const job = db.prepare('SELECT id, source, apply_url FROM jobs WHERE id = ?').get(a.job_id) as JobRow | undefined;
    if (!job) return fail('refused', 'unknown_job', 'no such job');
    if (getExcludedReason(db, a.job_id)) return fail('refused', 'vetoed', 'the job is excluded');
    if (getFirstHardStop(db, a.job_id)) return fail('refused', 'hard_stop', 'the job has a hard stop');
    if (db.prepare("SELECT 1 FROM applications WHERE job_id = ? AND status = 'submitted' LIMIT 1").get(a.job_id)) {
      return fail('refused', 'already_applied', 'an application was already submitted for this job');
    }
    const url = job.apply_url ?? '';
    const cls = classifyApplyUrl(url, job.source, d.env);
    const queued = db.prepare('SELECT apply_tier, apply_platform FROM outreach_queue WHERE job_id = ? ORDER BY id DESC LIMIT 1')
      .get(a.job_id) as { apply_tier: string | null; apply_platform: string | null } | undefined;
    if (cls.platform !== 'naukri' || cls.tier === 'never' || queued?.apply_tier === 'never' || queued?.apply_platform === 'none') {
      return fail('refused', 'class_none', 'this job is not applied to through Naukri');
    }
    const pageKey = naukriJobIdOfUrl(url);
    if (!pageKey) return fail('refused', 'no_job_key', 'the stored apply URL has no Naukri job id');
    const c = ceilings(db, d.cfg, now).naukri_apply;
    if (!c.ok) return fail('rate_limited', 'rate_limited', `naukri_apply ${c.used} of ${c.limit} today`);
    const room = easyApplyRoom(db, d.env);
    if (room.used >= room.max) return fail('rate_limited', 'rate_limited', `daily apply limit (${room.max}) reached`);

    // Open the job page from the stored URL and verify it is that job
    const opened = await d.engine.open(url);
    if (!opened.ok) {
      const halted = opened.code === 'halted' || opened.code === 'killed';
      return fail(halted ? 'halted' : 'failed', opened.code, opened.reason);
    }
    const tree = d.engine.lastTree();
    const page = await d.engine.page();
    if (!tree || !page) return fail('failed', 'no_snapshot', 'could not read the page');
    if (naukriJobIdOfUrl(page.url()) !== pageKey) return fail('refused', 'job_url_mismatch', 'browser is not on the job page');
    const v = await d.screen(pageTextOf(tree, d.engine.refs.epoch), 'send');
    if (v.blocked) {
      if (v.code === 'classifier_unavailable') return fail('failed', 'classifier_unavailable');
      return fail('refused', 'injection_suspected', 'page text flagged by the input screen');
    }

    const dry = isDryRun(d.env);
    const intent = d.intents.arm({ platform: 'naukri', kind: 'apply', class: 'naukri_apply', jobId: a.job_id, pageKey, text: null, dry });
    if (dry) {
      try {
        recordDryRun(db, { runId: d.env.JOBBER_RUN_ID ?? null, action: 'naukri_arm_apply', platform: 'naukri', payload: { job_id: a.job_id } }, now, d.env);
      } catch { /* the dry intent is still armed */ }
    }
    return {
      status: 'armed', code: 'armed', intent_id: intent.id, expires_at: new Date(intent.expiresAt).toISOString(),
      class: 'naukri_apply', dry_run: dry, would: { job_id: a.job_id },
    };
  } catch (e) {
    void e;
    return fail('failed', 'error', 'unexpected error while arming');
  }
}
