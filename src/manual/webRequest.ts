// Dashboard side of /apply: describing a URL for the confirm step, the narrow write, and the read-only list. Code only; nothing here
// fetches a URL. The write goes through createManualRequest (the same function scripts/apply-request.ts uses) on a short-lived connection.
import BetterSqlite3 from 'better-sqlite3';
import { cleanUntrusted } from './report.js';
import { createManualRequest, MANUAL_REPORT_MAX_CHARS, type CreateResult } from './requests.js';
import { classifyManualUrl, validateManualUrl } from './url.js';

type Db = BetterSqlite3.Database;

export type ManualDescription =
  | { ok: true; url: string; requestKind: 'url' | 'careers'; classification: string; lines: string[] }
  | { ok: false; reason: string };

/** Validates with the shared validator and says in words how the request will be fetched. */
export function describeManualRequest(raw: unknown, force: boolean): ManualDescription {
  const v = validateManualUrl(raw);
  if (!v.ok) return v;
  const cls = classifyManualUrl(v.url);
  if (cls.kind === 'unsupported') return { ok: false, reason: cls.reason };
  const what = cls.requestKind === 'url' ? 'single job page' : 'careers page';
  let classification: string;
  if (cls.kind === 'ats') classification = `ATS vendor ${cls.ats}, board ${cleanUntrusted(cls.slug, 60)} (${what})`;
  else if (cls.kind === 'platform') classification = `job platform ${cls.platform} (${what})`;
  else classification = `unknown host, read by the page reader (${what})`;
  let where = v.url;
  try { const u = new URL(v.url); where = `${u.hostname}${u.pathname}`; } catch { /* keep raw */ }
  return {
    ok: true, url: v.url, requestKind: cls.requestKind, classification,
    lines: [
      `Page: ${cleanUntrusted(where, 160)}`,
      `Type: ${classification}`,
      `Priority run: yes${force ? ', force (below-threshold scores are prepared anyway; vetoes and hard stops still apply)' : ''}`,
    ],
  };
}

/** The exact text a confirm token is bound to; the control character keeps it out of the chat box's text space. */
export function applyTokenText(url: string, force: boolean): string {
  return `\u0001apply-request|${force ? 1 : 0}|${url}`;
}

/**
 * The only write the dashboard can make: open the data file, insert (or find) one manual_requests row through createManualRequest, close.
 * fileMustExist: the dashboard never creates the database.
 */
export function enqueueManualRequest(path: string, url: string, force: boolean, now: Date): CreateResult {
  const db = new BetterSqlite3(path, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    return createManualRequest(db, url, { force, now });
  } finally {
    db.close();
  }
}

export interface RecentRequest {
  id: number; url: string; kind: string; status: string; force: boolean; created_at: string; finished_at: string | null; report: string;
}

/** The latest requests, newest first, for the read-only handle. Report text is posting-derived: single-line control characters and angle brackets stripped. */
export function listRecentRequests(db: Db, limit = 20): RecentRequest[] {
  let rows: { id: number; url: string; kind: string; status: string; force: number; created_at: string; finished_at: string | null; report: string | null }[];
  try {
    rows = db.prepare('SELECT id, url, kind, status, force, created_at, finished_at, report FROM manual_requests ORDER BY id DESC LIMIT ?').all(limit) as typeof rows;
  } catch {
    return [];
  }
  return rows.map((r) => ({
    id: r.id, url: cleanUntrusted(r.url, 300), kind: cleanUntrusted(r.kind, 12), status: cleanUntrusted(r.status, 12), force: r.force === 1,
    created_at: cleanUntrusted(r.created_at, 40), finished_at: r.finished_at ? cleanUntrusted(r.finished_at, 40) : null,
    report: cleanMultiline(r.report ?? '', MANUAL_REPORT_MAX_CHARS),
  }));
}

function cleanMultiline(s: string, max: number): string {
  return s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => cleanUntrusted(l, 400))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, max);
}

/** An identical open request, so the confirm step can say it would be a duplicate. */
export function openRequestFor(db: Db, url: string): { id: number; status: string } | null {
  try {
    return (db.prepare("SELECT id, status FROM manual_requests WHERE url = ? AND status IN ('pending', 'running') ORDER BY id LIMIT 1").get(url) as { id: number; status: string } | undefined) ?? null;
  } catch {
    return null;
  }
}
