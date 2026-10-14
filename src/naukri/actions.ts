// Gated Naukri message send. Every step fails closed; any throw is 'failed'.
import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { OutreachConfig } from '../outreach/config.js';
import { haltReason, haltPlatform, tryConsume } from '../outreach/limits.js';
import { planNextTouch, type TouchKind, type ContactSnapshot } from '../outreach/cadence.js';
import { companyPaused, normalizeCompany } from '../outreach/people.js';
import { inQuietHours, pacingFromConfig } from '../outreach/pacing.js';
import { loadTuning, type Tuning } from '../outreach/tuning.js';
import { gateOutbound, secretValuesFromEnv } from '../safety/outputGate.js';
import { isDryRun, recordDryRun } from '../safety/dryRun.js';
import { getState, setState } from '../scheduler/runLog.js';
import { reserveTouch, finishTouch } from '../linkedin/touches.js';

type Db = BetterSqlite3.Database;

export interface PageDriver {
  sendInThread(threadRef: string, text: string): Promise<{ confirmed: boolean; observedRecipient: string | null }>;
  // Optional pre-send check of the thread's real recipient (and company) on the page.
  verifyThread?(threadRef: string): Promise<{ recipient: string | null; company?: string | null }>;
}
export interface SendDeps {
  db: Db; cfg: OutreachConfig; now: Date; env: NodeJS.ProcessEnv; runId: string | null;
  driver: PageDriver;
  checkText: (text: string) => Promise<{ ok: boolean; normalized: string; verdict: 'pass' | 'warn' | 'block' }>;
  style: (text: string) => { ok: boolean; hits: string[] };
  tuning?: Tuning;
  // Visible thread page text, when the driver supplies it (copy check in the output gate).
  rawPageText?: string;
}
export type SendResult = {
  status: 'sent' | 'dry_run' | 'rate_limited' | 'halted' | 'blocked' | 'failed';
  reasons: string[]; touchId?: number;
};

export const MAX_NAUKRI_MESSAGE_CHARS = 1800;
const FAILURE_LIMIT = 3;

export function naukriIdempotencyKey(personId: number, kind: string, normalized: string): string {
  return `naukri:${personId}:${kind}:${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
const failKey = (runId: string | null, now: Date): string =>
  `naukri_send_failures_${runId ?? `adhoc_${now.toISOString().slice(0, 10)}`}`;
export const threadStateKey = (personId: number): string => `naukri_thread_${personId}`;

interface PersonRow {
  id: number; platform: string; profile_key: string; name: string | null; company_key: string;
  category: 'recruiter' | 'hiring_manager' | 'peer' | 'connection';
  stage: string | null; variant: 'rapport_first' | 'direct_referral' | null;
  cycle_started_at: string | null; cooldown_until: string | null; paused_reason: string | null;
}

function loadPerson(db: Db, id: number): PersonRow | null {
  const r = db.prepare(
    `SELECT p.id, p.platform, p.profile_key, p.name, p.company_key, p.category,
            c.stage, c.variant, c.cycle_started_at, c.cooldown_until, c.paused_reason
       FROM people p LEFT JOIN contact_state c ON c.person_id = p.id WHERE p.id = ?`,
  ).get(id) as PersonRow | undefined;
  return r ?? null;
}

function sentMessages(db: Db, p: PersonRow): { kind: TouchKind; sentAt: Date }[] {
  const rows = db.prepare(
    `SELECT kind, sent_at FROM touches WHERE person_id = ? AND status = 'sent' AND kind != 'connect'
       AND sent_at IS NOT NULL AND (? IS NULL OR sent_at >= ?) ORDER BY sent_at ASC, id ASC`,
  ).all(p.id, p.cycle_started_at, p.cycle_started_at) as { kind: TouchKind; sent_at: string }[];
  return rows.map((r) => ({ kind: r.kind, sentAt: new Date(r.sent_at) }));
}

// Naukri has no connect step: the connect anchor is the epoch so the first message is due at once.
function snapshot(p: PersonRow, messages: { kind: TouchKind; sentAt: Date }[]): ContactSnapshot {
  return {
    category: p.category, variant: p.variant, connected: true, connectedAt: null,
    connectSentAt: new Date(0), messages, replied: false, pausedReason: null, cooldownUntil: null,
  };
}

const fail = (reasons: string[], touchId?: number): SendResult => ({ status: 'failed', reasons, touchId });

function bumpFailures(d: SendDeps): number {
  const k = failKey(d.runId, d.now);
  const n = (Number.parseInt(getState(d.db, k) ?? '0', 10) || 0) + 1;
  setState(d.db, k, String(n), d.now);
  if (n >= FAILURE_LIMIT) {
    haltPlatform(d.db, 'naukri', `${n} consecutive naukri send failures`, d.now);
  }
  return n;
}

export async function naukriSendMessage(
  d: SendDeps,
  i: { personId: number; threadRef: string; text: string; jobId?: string; kind: TouchKind },
): Promise<SendResult> {
  let touchId: number | undefined;
  try {
    // (1) halts
    if (haltReason(d.db, 'naukri') !== null || haltReason(d.db, 'all') !== null) {
      return { status: 'halted', reasons: ['halted'] };
    }
    // quiet hours (mirrors the LinkedIn guard)
    const tuning = d.tuning ?? loadTuning(d.env);
    if (inQuietHours(d.now, pacingFromConfig(d.cfg, tuning))) {
      return { status: 'blocked', reasons: ['quiet_hours'] };
    }
    // (2) person and contact state
    const p = loadPerson(d.db, i.personId);
    if (!p) return { status: 'blocked', reasons: ['unknown_recipient'] };
    if (p.platform !== 'naukri') return { status: 'blocked', reasons: ['wrong_platform'] };
    if (!p.name || !p.name.trim()) return { status: 'blocked', reasons: ['recipient_name_unknown'] };
    const cooldown = p.cooldown_until ? new Date(p.cooldown_until) : null;
    if (
      p.paused_reason !== null ||
      ['replied_negative', 'closed', 'cooldown'].includes(p.stage ?? 'new') ||
      (cooldown && (Number.isNaN(cooldown.getTime()) || cooldown > d.now)) ||
      companyPaused(d.db, 'naukri', p.company_key)
    ) {
      return { status: 'blocked', reasons: ['contact_paused'] };
    }
    // (2b) thread must be verified server-side: last confirmed thread, or a recorded inbound thread
    const known = new Set<string>();
    const confirmed = getState(d.db, threadStateKey(p.id));
    if (confirmed) known.add(confirmed);
    const inboundRows = d.db.prepare(
      `SELECT thread_ref, klass, escalated, created_at FROM inbound_messages
        WHERE platform = 'naukri' AND person_id = ? ORDER BY created_at DESC, id DESC`,
    ).all(p.id) as { thread_ref: string; klass: string; escalated: number; created_at: string }[];
    for (const r of inboundRows) known.add(r.thread_ref);
    if (!i.threadRef || !known.has(i.threadRef)) {
      return { status: 'blocked', reasons: ['unverified_thread'] };
    }
    // reply-to-inbound is derived here, never caller supplied
    let replyToInbound = false;
    if (i.kind === 'followup') {
      const latest = inboundRows.find((r) => r.thread_ref === i.threadRef);
      if (latest && latest.escalated === 0 && ['recruiter_inquiry', 'reply'].includes(latest.klass)) {
        const later = d.db.prepare(
          `SELECT 1 AS hit FROM touches WHERE person_id = ? AND status = 'sent' AND created_at > ? LIMIT 1`,
        ).get(p.id, latest.created_at);
        replyToInbound = later === undefined;
      }
    }
    if (!replyToInbound) {
      const next = planNextTouch(snapshot(p, sentMessages(d.db, p)), d.now, tuning.cadenceGapsDays);
      if (!next || next.kind !== i.kind || next.dueAt > d.now) {
        return { status: 'blocked', reasons: ['cadence_not_due'] };
      }
    }
    // (3) length, style, fact
    const text = i.text ?? '';
    if (text.trim().length === 0) return { status: 'blocked', reasons: ['empty_text'] };
    if (text.length > MAX_NAUKRI_MESSAGE_CHARS) return { status: 'blocked', reasons: ['message_too_long'] };
    const st = d.style(text);
    if (!st.ok) return { status: 'blocked', reasons: ['style_gate', ...st.hits] };
    const ct = await d.checkText(text);
    if (!ct.ok || ct.verdict === 'block') return { status: 'blocked', reasons: ['fact_gate_block'] };
    const normalized = ct.normalized;
    if (typeof normalized !== 'string' || normalized.trim().length === 0) {
      return { status: 'blocked', reasons: ['empty_text'] };
    }
    if (normalized.length > MAX_NAUKRI_MESSAGE_CHARS) return { status: 'blocked', reasons: ['message_too_long'] };
    // (4) output gate. The expected thread is the last confirmed thread for this person (SQLite),
    // or the caller's ref on first contact.
    const expectedThread = i.threadRef; // already verified against SQLite above
    const g = gateOutbound(normalized, {
      recipientKey: p.profile_key, expectedRecipientKey: p.profile_key,
      threadId: i.threadRef, expectedThreadId: expectedThread,
      allowedUrls: [], allowedEmails: [],
      secretValues: secretValuesFromEnv(d.env), factVerdict: ct.verdict,
      ...(d.rawPageText ? { rawPageText: d.rawPageText } : {}),
    });
    if (!g.ok) return { status: 'blocked', reasons: ['output_gate', ...g.reasons] };
    // (5) dry run: nothing consumed, no driver, no touches row
    if (isDryRun(d.env)) {
      recordDryRun(d.db, {
        runId: d.runId, action: 'message', platform: 'naukri', personId: p.id,
        payload: { kind: i.kind, thread_ref: i.threadRef, job_id: i.jobId ?? null, text: normalized },
      }, d.now, d.env);
      return { status: 'dry_run', reasons: [] };
    }
    // (5b) page-side recipient/company verification before anything is typed
    if (d.driver.verifyThread) {
      const v = await d.driver.verifyThread(i.threadRef);
      const rec = v.recipient === null || v.recipient === undefined ? null : norm(v.recipient);
      const okRec = rec !== null && (rec === norm(p.name) || rec === norm(p.profile_key));
      const comp = v.company;
      const okComp = comp === undefined || comp === null || normalizeCompany(comp) === p.company_key;
      if (!okRec || !okComp) return { status: 'blocked', reasons: ['recipient_mismatch'] };
    }
    // (6) idempotent touch first: a duplicate must never consume a ceiling unit
    const r = reserveTouch(d.db, {
      personId: p.id, kind: i.kind, jobId: i.jobId ?? null, body: normalized,
      key: naukriIdempotencyKey(p.id, i.kind, normalized), now: d.now, dryRun: false,
    });
    if (!r.ok) return { status: 'blocked', reasons: ['duplicate', r.reason], touchId: r.touchId };
    touchId = r.touchId;
    // (7) ceiling, right before the send
    if (!tryConsume(d.db, 'naukri_message', d.cfg, d.now)) {
      finishTouch(d.db, touchId, 'refused', d.now);
      return { status: 'rate_limited', reasons: ['naukri_message ceiling reached'], touchId };
    }
    // (8) send
    let res: { confirmed: boolean; observedRecipient: string | null };
    try {
      res = await d.driver.sendInThread(i.threadRef, normalized);
    } catch {
      // the click may have gone out: never auto-retry
      finishTouch(d.db, touchId, 'unconfirmed', d.now);
      bumpFailures(d);
      return fail(['unconfirmed', 'driver_error'], touchId);
    }
    const observed = res.observedRecipient === null ? null : norm(res.observedRecipient);
    if (observed === null || (observed !== norm(p.name) && observed !== norm(p.profile_key))) {
      finishTouch(d.db, touchId, 'failed', d.now);
      bumpFailures(d);
      return fail(['recipient_mismatch'], touchId);
    }
    if (!res.confirmed) {
      finishTouch(d.db, touchId, 'unconfirmed', d.now);
      bumpFailures(d);
      return fail(['unconfirmed'], touchId);
    }
    // (9) record: finishTouch 'sent' is the commit point; bookkeeping errors never downgrade it
    finishTouch(d.db, touchId, 'sent', d.now);
    const sentTouchId = touchId;
    touchId = undefined;
    try {
      setState(d.db, failKey(d.runId, d.now), '0', d.now);
      setState(d.db, threadStateKey(p.id), i.threadRef, d.now);
      const next = planNextTouch(snapshot(p, sentMessages(d.db, p)), d.now, tuning.cadenceGapsDays);
      const at = d.now.toISOString();
      d.db.prepare('INSERT OR IGNORE INTO contact_state (person_id) VALUES (?)').run(p.id);
      d.db.prepare(
        `UPDATE contact_state SET stage = CASE WHEN stage = 'new' THEN 'active' ELSE stage END,
           last_touch_at = ?, followups_sent = followups_sent + ?, next_due_at = ?,
           cycle_started_at = COALESCE(cycle_started_at, ?), updated_at = ? WHERE person_id = ?`,
      ).run(at, i.kind === 'followup' ? 1 : 0, next ? next.dueAt.toISOString() : null, at, at, p.id);
    } catch {
      return { status: 'sent', reasons: ['bookkeeping_failed'], touchId: sentTouchId };
    }
    return { status: 'sent', reasons: [], touchId: sentTouchId };
  } catch (e) {
    if (touchId !== undefined) {
      try { finishTouch(d.db, touchId, 'unconfirmed', d.now); } catch { /* fail closed below */ }
    }
    return fail([`error: ${e instanceof Error ? e.message : 'unknown'}`], touchId);
  }
}
