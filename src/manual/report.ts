// The owner's update for a manual request: composed by code from the db (never by the model), plain text, every posting-derived
// field escaped as untrusted. Email goes out later through the mail stage, so it says "queued", never "sent", unless the db says sent.
import type BetterSqlite3 from 'better-sqlite3';
import { MATCH_FAIL_LIMIT } from '../db.js';
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
  strengths: string | null; gaps: string | null; excluded_reason: string | null; gate_flags: string | null; match_fails: number; company_key: string | null;
}
interface QueueRow {
  email_to: string | null; email_status: string | null; email_sent_at: string | null; connect_profile_url: string | null;
  connect_category: string | null; connect_status: string | null; apply_platform: string | null; apply_tier: string | null; apply_status: string | null; status: string | null;
}

/** A job is settled once the pipeline is done with it: vetoed, scored, or given up on after repeated rejected match saves. */
export function jobSettled(j: Pick<JobRow, 'score' | 'excluded_reason' | 'match_fails'>): boolean {
  return j.excluded_reason !== null || j.score !== null || j.match_fails >= MATCH_FAIL_LIMIT;
}

function jobLines(db: Db, r: ManualRequest, jobId: string, threshold: number): string[] {
  const j = db.prepare('SELECT id, title, company, source, score, confidence, strengths, gaps, excluded_reason, gate_flags, match_fails, company_key FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
  if (!j) return [`- job ${cleanUntrusted(jobId, 60)}: no longer in the database`];
  const head = `${cleanUntrusted(j.title, 90) || 'Untitled'} at ${cleanUntrusted(j.company, 60) || 'unknown company'}`;
  const out: string[] = [];
  if (j.excluded_reason) {
    out.push(`- ${head}: VETOED (${cleanUntrusted(j.excluded_reason, 160)})${j.score !== null ? `, score ${j.score}` : ''}. Not contacted. /include can override.`);
    return out;
  }
  if (j.score === null) {
    out.push(`- ${head}: ${j.match_fails >= MATCH_FAIL_LIMIT ? 'match failed twice, given up (see the wake log)' : 'not scored yet, waiting for the next wake'}.`);
    return out;
  }
  out.push(`- ${head}: score ${j.score}${j.confidence ? ` (${cleanUntrusted(j.confidence, 12)})` : ''}`);
  const s = firstText(j.strengths);
  const g = firstText(j.gaps);
  if (s) out.push(`  strength: ${cleanUntrusted(s, 140)}`);
  if (g) out.push(`  gap: ${cleanUntrusted(g, 140)}`);
  const flags = flagsOf(j.gate_flags).slice(0, 2);
  if (flags.length) out.push(`  flags: ${flags.map((f) => cleanUntrusted(f, 90)).join('; ')}`);
  const q = db.prepare('SELECT email_to, email_status, email_sent_at, connect_profile_url, connect_category, connect_status, apply_platform, apply_tier, apply_status, status FROM outreach_queue WHERE job_id = ? ORDER BY id').all(j.id) as QueueRow[];
  if (q.length === 0) {
    out.push(j.score < threshold && !r.force
      ? `  below threshold ${threshold}: not contacted (resubmit with --force to prepare it anyway)`
      : '  no contact, LinkedIn profile or apply route found, so nothing was queued');
    return out;
  }
  const email = q.find((x) => x.email_to);
  if (email) {
    const st = email.email_sent_at || email.email_status === 'sent' ? 'sent' : email.email_status && email.email_status !== 'queued' ? cleanUntrusted(email.email_status, 20) : 'queued (the mail stage sends it)';
    out.push(`  email: ${st} to ${cleanUntrusted(email.email_to, 80)} (verified address)`);
  } else out.push('  email: no verified address found');
  const people = q.filter((x) => x.connect_profile_url);
  if (people.length) {
    const cats = [...new Set(people.map((x) => cleanUntrusted(x.connect_category, 20) || 'person'))].join(', ');
    const sent = people.filter((x) => x.connect_status === 'sent').length;
    out.push(`  linkedin: ${people.length} people (${cats}), ${sent > 0 ? `${sent} connect sent` : 'connect queued'}`);
  } else out.push('  linkedin: no people found');
  const ap = q.find((x) => x.apply_platform && x.apply_platform !== 'none');
  if (ap) {
    const st = ap.apply_status ?? 'queued';
    out.push(`  apply: ${cleanUntrusted(st, 30)} (${cleanUntrusted(ap.apply_platform, 20)})`);
    if (['needs_owner', 'manual_review', 'unconfirmed', 'escalated'].includes(st)) {
      let e: { reason: string; detail: string | null } | undefined;
      try {
        e = db.prepare("SELECT reason, detail FROM escalations WHERE resolved_at IS NULL AND (detail LIKE ? OR detail LIKE ?) ORDER BY id DESC LIMIT 1").get(`%${j.id}%`, `%${(j.title ?? '').replace(/[%_]/g, '').slice(0, 60) || '\u0001'}%`) as typeof e;
      } catch {
        e = undefined; // no escalations table yet
      }
      if (e) out.push(`  needs you: ${cleanUntrusted(e.reason, 40)}: ${cleanUntrusted(e.detail, 200)}`);
    }
  } else out.push(`  apply: not apply-capable (${cleanUntrusted(q[0]!.apply_tier ?? '', 30) || 'discover only'}), outreach only`);
  const prior = j.company_key
    ? (db.prepare(`SELECT COUNT(DISTINCT q.job_id) AS n FROM outreach_queue q JOIN jobs o ON o.id = q.job_id
        WHERE o.company_key = ? AND q.job_id <> ? AND (q.email_sent_at >= datetime('now', '-90 days') OR q.connect_status = 'sent')`).get(j.company_key, j.id) as { n: number }).n
    : 0;
  if (prior > 0) out.push(`  note: this company was already contacted for ${prior} other role${prior > 1 ? 's' : ''} in the last 90 days`);
  return out;
}

/** The update for one request as one or more messages of at most 3500 characters (one posting per block, never split). */
export function composeManualReport(db: Db, r: ManualRequest, opts: { matchThreshold?: number; extra?: string[] } = {}): string[] {
  const threshold = opts.matchThreshold ?? 60;
  let where = r.url;
  try { const u = new URL(r.url); where = `${u.hostname}${u.pathname}`; } catch { /* keep raw */ }
  const ids = jobIdsOf(r);
  const head = [`Manual request #${r.id} (${r.kind}${r.force ? ', force' : ''}): ${cleanUntrusted(where, 110)}`, ...(opts.extra ?? []).map((x) => cleanUntrusted(x, 200))];
  if (ids.length === 0) return [[...head, r.report && r.status === 'failed' ? cleanUntrusted(r.report, 300) : 'No jobs were found or saved from this page.'].join('\n')];
  const blocks = ids.map((id) => jobLines(db, r, id, threshold).join('\n'));
  const chunks: string[] = [];
  let cur = head.join('\n');
  for (const b of blocks) {
    if (cur.length + b.length + 1 > CHUNK_CHARS && cur.length > 0) { chunks.push(cur); cur = `Manual request #${r.id} (continued)`; }
    cur += `\n${b.slice(0, CHUNK_CHARS - 100)}`;
  }
  chunks.push(cur);
  return chunks;
}

export interface FinalizeDeps {
  send: (text: string) => Promise<unknown>;
  now: () => Date;
  matchThreshold?: number;
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
      const j = db.prepare('SELECT score, excluded_reason, match_fails FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
      if (j && !jobSettled(j)) unsettled++;
    }
    if (open.length > 0 && runStatus !== 'ok' && !stale) { out.waiting.push(r.id); continue; }
    if (unsettled > 0 && !stale) { out.waiting.push(r.id); continue; }
    const extra: string[] = [];
    if (open.length > 0) {
      db.prepare("UPDATE source_tasks SET state = 'failed', updated_at = ? WHERE request_id = ? AND state IN ('queued', 'running')").run(d.now().toISOString(), r.id);
      extra.push('The page reader did not finish this page.');
    }
    if (unsettled > 0) extra.push(`${unsettled} job(s) were still unscored after 24 hours.`);
    const fresh = db.prepare('SELECT * FROM manual_requests WHERE id = ?').get(r.id) as ManualRequest;
    const messages = composeManualReport(db, fresh, { matchThreshold: d.matchThreshold, extra });
    for (const m of messages) {
      try { await d.send(m); } catch { /* the report stays in the database */ }
    }
    finishManualRequest(db, r.id, ids.length === 0 ? 'failed' : 'done', messages.join('\n---\n'), d.now());
    out.reported.push(r.id);
  }
  return out;
}
