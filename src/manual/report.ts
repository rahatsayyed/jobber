// The owner's update for a manual request: composed by code from the db (never by the model), as Telegram HTML built with
// src/platform/tgHtml.ts (every posting-derived field is cleaned and escaped as untrusted; addresses are shown in full because the chat is
// owner-only). Email goes out later through the mail stage, so it says "queued", never "sent", unless the db says sent.
// `composeManualReport` gives the same report as plain text (stored in the request row and used by tests); the Telegram send uses the HTML.
import type BetterSqlite3 from 'better-sqlite3';
import { MATCH_FAIL_LIMIT, PREP_OFFER_LIMIT } from '../db.js';
import { DEFAULT_MATCH_THRESHOLD } from '../matchRubric.js';
import { JOB_STATUS_JD_PENDING, JOB_STATUS_REPEAT_CONTACT, repeatContactOf } from '../pipelineWork.js';
import {
  E, b, clean, code, headline, htmlToPlain, i as ital, join, line, link, type Html,
} from '../platform/tgHtml.js';
import { finishManualRequest, jobIdsOf, listManualRequests, type ManualRequest } from './requests.js';

type Db = BetterSqlite3.Database;

const CHUNK_CHARS = 3500;
const STALE_MS = 24 * 3600 * 1000;

/** Plain-text, single-line, bounded: strips control, invisible and bidi characters and angle brackets, so posting text cannot shape the message. */
export function cleanUntrusted(s: unknown, max = 160): string {
  const t = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, ' ')
    .replace(/[<>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

function firstText(json: string | null): string | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v) || v.length === 0) return null;
    const x = v[0] as unknown;
    if (typeof x === 'string') return x;
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      const t = o.text ?? o.requirement ?? o.name ?? o.quote;
      return typeof t === 'string' ? t : JSON.stringify(x);
    }
    return String(x);
  } catch {
    return null;
  }
}

function flagsOf(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

interface JobRow {
  id: string; title: string | null; company: string | null; source: string | null; score: number | null; confidence: string | null;
  strengths: string | null; gaps: string | null; excluded_reason: string | null; gate_flags: string | null; match_fails: number; company_key: string | null; status: string | null;
}
interface QueueRow {
  email_to: string | null; email_status: string | null; email_sent_at: string | null; connect_profile_url: string | null;
  connect_category: string | null; connect_status: string | null; apply_platform: string | null; apply_tier: string | null; apply_status: string | null; apply_note?: string | null; status: string | null;
}

/** A job is settled once the pipeline is done with it: vetoed, scored, or given up on after repeated rejected match saves. */
export function jobSettled(j: Pick<JobRow, 'score' | 'excluded_reason' | 'match_fails'> & { status?: string | null }): boolean {
  if (j.status === JOB_STATUS_JD_PENDING) return false; // waits for its job description: the request stays open
  return j.excluded_reason !== null || j.status === JOB_STATUS_REPEAT_CONTACT || j.score !== null || j.match_fails >= MATCH_FAIL_LIMIT;
}

const ind = (...p: Array<Html | string>): Html => join(['  ', ...p], '');
const emailLike = (s: string): boolean => /^[^\s@]+@[^\s@]+$/.test(s);

/** One job as HTML lines: a headline (emoji, bold title, company), then indented label/value lines. */
function jobLines(db: Db, r: ManualRequest, jobId: string, threshold: number): Html[] {
  const j = db.prepare('SELECT id, title, company, source, score, confidence, strengths, gaps, excluded_reason, gate_flags, match_fails, company_key, status FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
  if (!j) return [join([E.warn, `job ${clean(jobId, 60)}: no longer in the database`])];
  const name = (emoji: string): Html => join([emoji, b(clean(j.title, 90) || 'Untitled'), 'at', clean(j.company, 60) || 'unknown company']);
  const out: Html[] = [];
  if (j.excluded_reason === 'jd_unavailable') {
    out.push(name(E.fail), ind('the job description could not be read (the page is closed or removed, or never gave a full description). Nothing was matched or sent. /include can override.'));
    return out;
  }
  if (j.status === JOB_STATUS_JD_PENDING) {
    out.push(name(E.paused), ind('waiting for the job description. It is matched, prepared and contacted only after the full description was read from the job page (the next wake or LinkedIn drip tick does that).'));
    return out;
  }
  if (j.excluded_reason) {
    out.push(name(E.warn), ind(b('VETOED'), ` (${clean(j.excluded_reason, 160)})${j.score !== null ? `, score ${j.score}` : ''}. Not contacted. /include can override.`));
    return out;
  }
  if (j.status === JOB_STATUS_REPEAT_CONTACT) {
    const of = repeatContactOf(db, j.id);
    out.push(name(E.warn), ind(b('SKIPPED'), ` by the 90-day repeat-contact guard (this company and title was already contacted${of ? `, earlier job ${clean(of, 60)}` : ''}). Nothing was matched or sent. Resubmit with --force to override.`));
    return out;
  }
  if (j.score === null) {
    out.push(name(E.paused), ind(`${j.match_fails >= MATCH_FAIL_LIMIT ? 'match failed twice, given up (see the wake log)' : 'not scored yet, waiting for the next wake'}.`));
    return out;
  }
  out.push(name(E.ok), ind(b('score'), ` ${j.score}${j.confidence ? ` (${clean(j.confidence, 12)})` : ''}`));
  if (r.force) {
    const of = repeatContactOf(db, j.id);
    if (of) out.push(ind(ital(`note: the 90-day repeat-contact guard was overridden by --force (this company and title was contacted before, earlier job ${clean(of, 60)})`)));
  }
  const s = firstText(j.strengths);
  const g = firstText(j.gaps);
  if (s) out.push(ind(b('strength:'), ` ${clean(s, 140)}`));
  if (g) out.push(ind(b('gap:'), ` ${clean(g, 140)}`));
  const flags = flagsOf(j.gate_flags).slice(0, 2);
  if (flags.length) out.push(ind(b('flags:'), ` ${flags.map((f) => clean(f, 90)).join('; ')}`));
  const q = db.prepare('SELECT email_to, email_status, email_sent_at, connect_profile_url, connect_category, connect_status, apply_platform, apply_tier, apply_status, apply_note, status FROM outreach_queue WHERE job_id = ? ORDER BY id').all(j.id) as QueueRow[];
  if (q.length === 0) {
    out.push(ind(ital(j.score < threshold && !r.force
      ? `below threshold ${threshold}: not contacted (resubmit with --force to prepare it anyway)`
      : 'no contact, LinkedIn profile or apply route found, so nothing was queued')));
    return out;
  }
  const email = q.find((x) => x.email_to);
  if (email) {
    const st = email.email_sent_at || email.email_status === 'sent' ? 'sent' : email.email_status && email.email_status !== 'queued' ? clean(email.email_status, 20) : 'queued (the mail stage sends it)';
    const to = clean(email.email_to, 80);
    out.push(ind(b('email:'), ` ${st} to `, emailLike(to) ? link(to, `mailto:${to}`) : to, ' (verified address)'));
  } else out.push(ind(b('email:'), ' no verified address found'));
  const people = q.filter((x) => x.connect_profile_url);
  if (people.length) {
    const cats = [...new Set(people.map((x) => clean(x.connect_category, 20) || 'person'))].join(', ');
    const sent = people.filter((x) => x.connect_status === 'sent').length;
    out.push(ind(b('linkedin:'), ` ${people.length} people (${cats}), ${sent > 0 ? `${sent} connect sent` : 'connect queued'}`));
  } else out.push(ind(b('linkedin:'), ' no people found'));
  const ap = q.find((x) => x.apply_platform && x.apply_platform !== 'none');
  if (ap) {
    const st = ap.apply_status ?? 'queued';
    out.push(ind(b('apply:'), ` ${clean(st, 30)} (${clean(ap.apply_platform, 20)})`));
    if (st === 'needs_answer') out.push(ind(E.you, ' ', b('needs your answer:'), ` ${clean(ap.apply_note ?? '', 60) || 'questions'} (`, code('npm run answers -- list'), ')'));
    if (st === 'needs_human') out.push(ind(E.you, ' ', b('needs you:'), ' log in or pass a human check (', code(`npm run apply:assist -- ${clean(j.id, 100)}`), ')'));
    if (['needs_owner', 'manual_review', 'unconfirmed', 'escalated'].includes(st)) {
      let e: { reason: string; detail: string | null } | undefined;
      try {
        e = db.prepare("SELECT reason, detail FROM escalations WHERE resolved_at IS NULL AND (detail LIKE ? OR detail LIKE ?) ORDER BY id DESC LIMIT 1").get(`%${j.id}%`, `%${(j.title ?? '').replace(/[%_]/g, '').slice(0, 60) || '\u0001'}%`) as typeof e;
      } catch {
        e = undefined; // no escalations table yet
      }
      if (e) out.push(ind(E.you, ' ', b('needs you:'), ` ${clean(e.reason, 40)}: ${clean(e.detail, 200)}`));
    }
  } else out.push(ind(b('apply:'), ` not apply-capable (${clean(q[0]!.apply_tier ?? '', 30) || 'discover only'}), outreach only`));
  const prior = j.company_key
    ? (db.prepare(`SELECT COUNT(DISTINCT q.job_id) AS n FROM outreach_queue q JOIN jobs o ON o.id = q.job_id
        WHERE o.company_key = ? AND q.job_id <> ? AND (q.email_sent_at >= datetime('now', '-90 days') OR q.connect_status = 'sent')`).get(j.company_key, j.id) as { n: number }).n
    : 0;
  if (prior > 0) out.push(ind(ital(`note: this company was already contacted for ${prior} other role${prior > 1 ? 's' : ''} in the last 90 days`)));
  return out;
}

const joinLines = (parts: Html[]): string => parts.map((p) => p.s).join('\n');

/** The update for one request as one or more Telegram HTML messages of at most 3500 characters (one posting per block, never split). */
export function composeManualReportHtml(db: Db, r: ManualRequest, opts: { matchThreshold?: number; extra?: string[] } = {}): string[] {
  const threshold = opts.matchThreshold ?? DEFAULT_MATCH_THRESHOLD;
  let where = r.url;
  try { const u = new URL(r.url); where = `${u.hostname}${u.pathname}`; } catch { /* keep raw */ }
  const ids = jobIdsOf(r);
  const title = `Manual request #${r.id}`;
  const headOf = (continued: boolean): Html[] => continued
    ? [headline(E.ok, `${title} (continued)`)]
    : [
        headline(ids.length === 0 ? E.warn : E.ok, `${title} (${r.kind}${r.force ? ', force' : ''})`),
        line('Page', link(clean(where, 110), /^https?:\/\//i.test(r.url) ? r.url : null)),
        ...(opts.extra ?? []).map((x) => ital(clean(x, 200))),
      ];
  if (ids.length === 0) {
    return [joinLines([...headOf(false), r.report && r.status === 'failed' ? join([clean(r.report, 300)]) : ital('No jobs were found or saved from this page.')])];
  }
  const blocks = ids.map((id) => joinLines(jobLines(db, r, id, threshold)));
  const chunks: string[] = [];
  let cur = joinLines(headOf(false));
  for (const blk of blocks) {
    if (cur.length + blk.length + 2 > CHUNK_CHARS && cur.length > 0) { chunks.push(cur); cur = joinLines(headOf(true)); }
    cur += `\n\n${blk.length > CHUNK_CHARS - 100 ? blk.slice(0, CHUNK_CHARS - 100) : blk}`;
  }
  chunks.push(cur);
  return chunks;
}

/** The same report as plain text (stored in the request row; also what the tests read). */
export function composeManualReport(db: Db, r: ManualRequest, opts: { matchThreshold?: number; extra?: string[] } = {}): string[] {
  return composeManualReportHtml(db, r, opts).map(htmlToPlain);
}

export interface FinalizeDeps {
  /** Receives Telegram HTML (send it with html: true). */
  send: (text: string) => Promise<unknown>;
  now: () => Date;
  matchThreshold?: number;
  /** False when a platform's operator is not planned right now (halted, outside active hours, no session): its open task then keeps waiting. */
  platformActive?: (platform: string) => boolean;
}
export interface FinalizeResult { reported: number[]; waiting: number[] }

/**
 * After a wake: report every running request whose jobs are all settled, and finish it. A request with jobs still waiting (the 10-job
 * priority cap, a failed wake) stays running and is reported by a later wake, or after 24 hours with what exists. A source task the
 * source-operator left open after a clean wake is failed here, so a request is never silently dropped.
 */
export async function finalizeManualRequests(db: Db, runStatus: string, d: FinalizeDeps): Promise<FinalizeResult> {
  const out: FinalizeResult = { reported: [], waiting: [] };
  for (const r of listManualRequests(db, ['running'])) {
    const ids = jobIdsOf(r);
    const open = db.prepare("SELECT id FROM source_tasks WHERE request_id = ? AND state IN ('queued', 'running')").all(r.id) as { id: number }[];
    const stale = r.started_at ? d.now().getTime() - Date.parse(r.started_at) > STALE_MS : false;
    let unsettled = 0;
    for (const id of ids) {
      const j = db.prepare('SELECT score, excluded_reason, match_fails, status FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
      if (j && !jobSettled(j)) { unsettled++; continue; }
      if (j && j.score !== null && !j.excluded_reason && (r.force || j.score >= (d.matchThreshold ?? DEFAULT_MATCH_THRESHOLD))) {
        // Scored but the wake stopped before prepare: not settled while the job has no queue row and prep offers remain.
        const x = db.prepare('SELECT priority, prep_offers, status FROM jobs WHERE id = ?').get(id) as { priority: number | null; prep_offers: number | null; status: string | null } | undefined;
        const hasQueue = (db.prepare('SELECT COUNT(*) AS n FROM outreach_queue WHERE job_id = ?').get(id) as { n: number }).n > 0;
        if (x && (x.priority ?? 0) > 0 && (x.prep_offers ?? 0) < PREP_OFFER_LIMIT && x.status !== JOB_STATUS_REPEAT_CONTACT && !hasQueue) unsettled++;
      }
    }
    const inactiveOpen = d.platformActive
      ? (db.prepare("SELECT platform FROM source_tasks WHERE request_id = ? AND state IN ('queued', 'running')").all(r.id) as { platform: string }[]).some((t) => t.platform !== 'manual' && !d.platformActive!(t.platform))
      : false;
    if (open.length > 0 && (runStatus !== 'ok' || inactiveOpen) && !stale) { out.waiting.push(r.id); continue; }
    if (unsettled > 0 && !stale) { out.waiting.push(r.id); continue; }
    const extra: string[] = [];
    if (open.length > 0) extra.push('The page reader did not finish this page.');
    if (unsettled > 0) extra.push(`${unsettled} job(s) were still unscored after 24 hours.`);
    const fresh = db.prepare('SELECT * FROM manual_requests WHERE id = ?').get(r.id) as ManualRequest;
    const messages = composeManualReportHtml(db, fresh, { matchThreshold: d.matchThreshold, extra });
    let delivered = true;
    for (const m of messages) {
      try { await d.send(m); } catch { delivered = false; break; }
    }
    // Finish only after the report went out; otherwise the request stays running and a later wake retries (the 24 hour cutoff ends it).
    if (!delivered && !stale) { out.waiting.push(r.id); continue; }
    if (open.length > 0) db.prepare("UPDATE source_tasks SET state = 'failed', updated_at = ? WHERE request_id = ? AND state IN ('queued', 'running')").run(d.now().toISOString(), r.id);
    // The row keeps the plain text of the report (the dashboard shows it), not the Telegram markup.
    finishManualRequest(db, r.id, ids.length === 0 ? 'failed' : 'done', messages.map(htmlToPlain).join('\n---\n'), d.now());
    out.reported.push(r.id);
  }
  return out;
}
