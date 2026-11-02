// src/outreach/escalationPolicy.ts
// Which escalation reasons deserve an owner Inbox item. Telemetry and ceilings are logged elsewhere (status page, diag files), never as Inbox rows.
// A dead job (page gone, redirected to a search list) is closed on the job itself. Pure functions plus one small job-closing write.
import type BetterSqlite3 from 'better-sqlite3';
import { parseApplyDetail, findJobByUrl, jobIdOfEscalation, FAILING_APPLY_STATUSES } from './applyEscalations.js';

type Db = BetterSqlite3.Database;

export type NoiseKind = 'layout_telemetry' | 'ceiling' | 'job_gone' | 'apply_tool_noise';

const LAYOUT_RE = /^\s*layout_drift/i;
const CEILING_REASON_RE = /profile_view_limit|rate_limited|custom_note_limit|note_quota|quota_exhausted|limit[_ ]reached/i;
const CEILING_DETAIL_RE = /limit reached|monthly .*quota|out of free custom notes/i;
const LISTING_RE = /career|listing|no (application )?form|not allowed|modal|hidden|no apply control|enquiry|email only|whatsapp|unidentifiable|not clickable/i;
const JOB_GONE_RE = /job gone|job_url_mismatch|redirected to search list|job (is )?no longer (available|exists)|job (has )?expired/i;

const noteOf = (detail: string): string => detail.split('\n').find((l) => l.startsWith('note:')) ?? '';

/** Null when the escalation is a real owner item. The caller must not store a noise row. */
export function noiseKind(platform: string, reason: string, detail: string | null | undefined): NoiseKind | null {
  const r = String(reason ?? '');
  const d = String(detail ?? '');
  if (platform === 'apply') {
    if (/^apply:(answers?|needs_answer|needs_human|captcha|consent|question)/i.test(r)) return null;
    if (JOB_GONE_RE.test(d) || JOB_GONE_RE.test(r)) return 'job_gone';
    if (/^apply:(drift|other)\b/i.test(r) && LISTING_RE.test(noteOf(d))) return 'apply_tool_noise';
    return null;
  }
  if (LAYOUT_RE.test(r)) return 'layout_telemetry';
  if (CEILING_REASON_RE.test(r) || (/limit|quota/i.test(r) && CEILING_DETAIL_RE.test(d))) return 'ceiling';
  return null;
}

export const NOISE_NOTES: Record<NoiseKind, string> = {
  layout_telemetry: 'telemetry, not owner work (layout drift is on the status page)',
  ceiling: 'a daily or monthly ceiling, nothing for the owner (see /limits)',
  job_gone: 'job is gone; marked expired, queue rows skipped',
  apply_tool_noise: 'apply tool drift on a careers or listing page, not owner work',
};

/** Host key for the dedupe of captcha, consent and blocked cards: one open row per reason and host. */
export function dedupeHost(reason: string, detail: string | null | undefined): string | null {
  if (!/^apply:(captcha|consent|blocked)\b/i.test(reason)) return null;
  return parseApplyDetail(detail ?? '').host;
}

/** Marks the job expired (excluded_reason, only when empty) and skips its failing queue rows. Returns the job id or null. Never throws. */
export function closeGoneJob(db: Db, detail: string | null | undefined, threadRef?: string | null): string | null {
  try {
    const jobId = jobIdOfEscalation(db, detail ?? null, threadRef ?? null) ?? findJobByUrl(db, parseApplyDetail(detail ?? '').url);
    if (!jobId) return null;
    db.prepare("UPDATE jobs SET excluded_reason = 'expired: job page gone' WHERE id = ? AND excluded_reason IS NULL").run(jobId);
    const ph = FAILING_APPLY_STATUSES.map(() => '?').join(',');
    db.prepare(`UPDATE outreach_queue SET apply_status = 'skipped' WHERE job_id = ? AND apply_status IN (${ph})`).run(jobId, ...FAILING_APPLY_STATUSES);
    return jobId;
  } catch {
    return null;
  }
}
