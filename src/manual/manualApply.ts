// src/manual/manualApply.ts
// The MANUAL APPLY QUEUE: jobs the machine will not (or cannot) finish and the owner applies to by hand. Read-only builder for the status snapshot,
// the Telegram digest, `npm run status -- working` and `npm run apply:manual`; the only writers are markDone and markSkip (owner CLI).
// Entries: (1) LinkedIn Easy Apply jobs while APPLY_LINKEDIN_EASY is not `true` (with it on they belong to the LinkedIn drip lane);
// (2) any row with apply_status needs_owner or manual_review that has a usable https address (needs_answer and needs_human have their own commands).
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { saveApplication } from '../db.js';
import { isLinkedInEasyApplyCandidate, linkedinJobPageUrl, type EasyApplyRow } from '../apply/easyApplyRows.js';
import { hostMatches } from '../lib/hostClass.js';
import { PROJECT_ROOT } from '../layout/config.js';
import { lexicallyAllowed, resolveJobIdResume, type ResolveDeps } from '../linkedin/attachment.js';
import { validateManualUrl } from './url.js';
import { resolveApplyEscalationsForJob } from '../outreach/applyEscalations.js';

type Db = BetterSqlite3.Database;

export const SUBMITTED_BY_OWNER = 'submitted_by_owner';
export const SKIPPED_BY_OWNER = 'skipped_by_owner';
/** apply_status values that put a row on the list (besides a pending LinkedIn Easy Apply row). */
export const MANUAL_STATUSES = ['needs_owner', 'manual_review'] as const;
export const MANUAL_ITEMS_CAP = 30;

export type ManualReason = 'easy_apply_off' | 'company_site_form' | 'listing_page' | 'easy_apply_failed' | 'no_relevant_role' | 'company_site_unresolved';

export interface ManualApplyItem {
  /** outreach_queue row id (the one `apply:manual done|skip` takes). */
  id: number;
  job_id: string;
  title: string;
  company: string;
  platform: string;
  /** https URL to open (host-validated with validateManualUrl). */
  open_url: string;
  /** Absolute path of the tailored resume PDF (stored path; may need a re-render, the CLI does that), or null. */
  resume_pdf: string | null;
  ats_note: string | null;
  reason: ManualReason;
  since: string;
}
// Plain words for a reason code (the dashboard chip).
/** Resolver codes (see externalApply.ts in browserctl) that mean the company-site link could not be read. */
const UNRESOLVED_CODES = new Set(['no_external_control', 'no_click_path', 'no_popup', 'popup_unstable', 'still_on_platform', 'invalid_url', 'interstitial_no_link']);
export const MANUAL_REASON_LABELS: Record<ManualReason, string> = {
  company_site_unresolved: 'Could not read the company site link',
  easy_apply_off: 'Easy Apply is off',
  company_site_form: 'Company site form',
  listing_page: 'Careers listing page',
  easy_apply_failed: 'Easy Apply could not finish',
  no_relevant_role: 'No relevant role on this careers page',
};
export const manualReasonLabel = (r: ManualReason): string => MANUAL_REASON_LABELS[r] ?? 'Apply by hand';

export const MANUAL_NOTE_MAX = 500;

export interface ManualApplyView { count: number; easyApplyOff: number; items: ManualApplyItem[] }

interface Row extends EasyApplyRow {
  id: number; job_id: string; title: string | null; company: string | null; apply_platform: string | null;
  apply_note: string | null; ats_note: string | null; resume_pdf_path: string | null; since: string | null;
}

const toIso = (s: string | null): string => {
  if (!s) return '';
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) || s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
};

const clean = (v: string | null | undefined, max: number): string => String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function reasonOf(r: Row, linkedinPage: boolean, url: string, env: NodeJS.ProcessEnv): ManualReason {
  // The failed-lane reason only means something while the lane is on; while LinkedIn Easy Apply is off the banner says "off", so the chip says it too.
  if (linkedinPage) return env.APPLY_LINKEDIN_EASY === 'true' && (r.apply_status === 'needs_owner' || r.apply_status === 'manual_review') ? 'easy_apply_failed' : 'easy_apply_off';
  const p = r.apply_platform ?? '';
  // A careers listing the apply-operator read and found no role for the resume on (apply_escalate reason no_relevant_role).
  if ((r.apply_note ?? '') === 'no_relevant_role') return 'no_relevant_role';
  // external:<code> from the resolver: a code that means the company link could not be read is company_site_unresolved; a host or form the applier cannot drive stays company_site_form.
  const note = r.apply_note ?? '';
  if (note.startsWith('external:')) return UNRESOLVED_CODES.has(note.slice('external:'.length)) ? 'company_site_unresolved' : 'company_site_form';
  if (p === 'none' || p === '' || p === 'naukri' || p === 'wellfound' || hostMatches(url, 'naukri.com') || hostMatches(url, 'wellfound.com')) return 'listing_page';
  return 'company_site_form';
}

/** The manual apply queue, one entry per job (its lowest queue row id). Pure read; env decides whether LinkedIn Easy Apply rows are the drip lane's. */
export function buildManualQueue(db: Db, env: NodeJS.ProcessEnv = process.env, opts: { root?: string } = {}): ManualApplyView {
  const root = opts.root ?? PROJECT_ROOT;
  const rows = db.prepare(`
    SELECT q.id AS id, q.job_id AS job_id, j.title AS title, j.company AS company, q.apply_platform AS apply_platform, q.apply_url AS apply_url,
           j.apply_url AS job_apply_url, j.url AS url, j.source AS source, j.external_apply_url AS external_apply_url, q.apply_status AS apply_status,
           q.apply_note AS apply_note, q.ats_note AS ats_note, q.resume_pdf_path AS resume_pdf_path, COALESCE(q.updated_at, q.created_at) AS since,
           j.excluded_reason AS excluded_reason,
           EXISTS (SELECT 1 FROM applications a WHERE a.job_id = q.job_id AND a.status = 'submitted') AS already_applied
      FROM outreach_queue q JOIN jobs j ON j.id = q.job_id
     WHERE j.excluded_reason IS NULL
       AND COALESCE(q.status, '') <> 'needs_reprep' AND COALESCE(j.status, '') <> 'jd_pending'
       AND COALESCE(q.apply_status, '') NOT IN ('submitted', 'submitted_by_owner', 'skipped_by_owner', 'unconfirmed', 'needs_answer', 'needs_human')
       AND NOT EXISTS (SELECT 1 FROM outreach_queue q2 WHERE q2.job_id = q.job_id AND q2.apply_status IN ('submitted', 'submitted_by_owner', 'skipped_by_owner'))
     ORDER BY q.id`).all() as unknown as (Omit<Row, 'already_applied'> & { already_applied: number })[];
  const seen = new Set<string>();
  const items: ManualApplyItem[] = [];
  let easyApplyOff = 0;
  for (const r of rows) {
    if (seen.has(r.job_id) || r.already_applied) continue;
    const row: Row = { ...r, already_applied: false };
    const status = (r.apply_status ?? '').trim();
    const linkedinPage = linkedinJobPageUrl(row) !== null && !(r.external_apply_url ?? '').trim();
    let candidate: string | null = null;
    if (isLinkedInEasyApplyCandidate(row, env)) {
      // Easy Apply on: the drip lane owns it. Off: the owner applies by hand.
      if (env.APPLY_LINKEDIN_EASY === 'true') continue;
      candidate = linkedinJobPageUrl(row);
    } else if ((MANUAL_STATUSES as readonly string[]).includes(status)) {
      candidate = (r.external_apply_url ?? '').trim() || (r.apply_url ?? '').trim() || (r.job_apply_url ?? '').trim() || (r.url ?? '').trim() || null;
    }
    if (!candidate) continue;
    const v = validateManualUrl(candidate);
    if (!v.ok) continue;
    seen.add(r.job_id);
    const reason = reasonOf(row, linkedinPage, v.url, env);
    if (reason === 'easy_apply_off') easyApplyOff += 1;
    let pdf: string | null = null;
    if (r.resume_pdf_path && lexicallyAllowed(r.resume_pdf_path, root)) pdf = path.resolve(root, r.resume_pdf_path);
    items.push({
      id: r.id, job_id: r.job_id, title: clean(r.title, 120), company: clean(r.company, 80),
      platform: linkedinPage ? 'linkedin' : (r.apply_platform && r.apply_platform !== 'none' ? r.apply_platform : 'other'),
      open_url: v.url, resume_pdf: pdf, ats_note: r.ats_note ? clean(r.ats_note, 300) : null, reason, since: toIso(r.since),
    });
  }
  return { count: items.length, easyApplyOff, items };
}

/** The same view for the status snapshot: items capped, count is the full total. */
export function manualApplySummary(db: Db, env: NodeJS.ProcessEnv = process.env): { count: number; easyApplyOff: number; items: ManualApplyItem[] } {
  const v = buildManualQueue(db, env);
  return { count: v.count, easyApplyOff: v.easyApplyOff, items: v.items.slice(0, MANUAL_ITEMS_CAP) };
}

/** The one-line nudge for the digest, /escalations and `status working`; null when nothing waits. */
export function manualApplyLine(v: { count: number; easyApplyOff?: number }): string | null {
  if (v.count <= 0) return null;
  const n = v.count;
  const off = (v.easyApplyOff ?? 0) > 0 ? ' (Easy Apply is off)' : '';
  return `${n} job${n === 1 ? '' : 's'} ${n === 1 ? 'waits' : 'wait'} for you to apply by hand${off}: npm run apply:manual -- list`;
}

/** For the CLI: make sure each item's resume PDF exists (re-rendered on demand by the attachment resolver); a failure leaves resume_pdf null. */
export async function withResumePdfs(db: Db, items: ManualApplyItem[], deps: ResolveDeps = {}): Promise<ManualApplyItem[]> {
  const out: ManualApplyItem[] = [];
  for (const it of items) {
    const r = await resolveJobIdResume(db, it.job_id, deps);
    out.push({ ...it, resume_pdf: r.ok ? r.attachment.path : null });
  }
  return out;
}

export type MarkResult = { ok: true; job_id: string; title: string } | { ok: false; reason: string };

// The optional owner note, cleaned and prefixed so it is never mistaken for a machine note like `external:...`. Null when empty.
function ownerNote(note: string | null | undefined): string | null {
  const c = clean(note, MANUAL_NOTE_MAX);
  return c ? `owner: ${c}` : null;
}

function find(db: Db, id: number, env: NodeJS.ProcessEnv): ManualApplyItem | null {
  return buildManualQueue(db, env).items.find((i) => i.id === id) ?? null;
}

/** The owner applied by hand: every queue row of the job becomes submitted_by_owner and one applications row (method manual) counts it in the funnel. */
export function markDone(db: Db, id: number, env: NodeJS.ProcessEnv = process.env, now: Date = new Date(), note?: string | null): MarkResult {
  const it = find(db, id, env);
  if (!it) return { ok: false, reason: `#${id} is not on the manual apply list (npm run apply:manual -- list)` };
  const owner = ownerNote(note);
  db.transaction(() => {
    db.prepare("UPDATE outreach_queue SET apply_status = ?, apply_note = COALESCE(?, apply_note), updated_at = datetime('now') WHERE job_id = ? AND COALESCE(apply_status, '') NOT IN ('submitted', ?)").run(SUBMITTED_BY_OWNER, owner, it.job_id, SUBMITTED_BY_OWNER);
    const has = db.prepare("SELECT 1 FROM applications WHERE job_id = ? AND status = 'submitted' LIMIT 1").get(it.job_id);
    if (!has) saveApplication(db, { job_id: it.job_id, platform: it.platform, method: 'manual', account: 'owner', status: 'submitted', reason: 'submitted_by_owner', applied_at: now.toISOString() });
  })();
  resolveApplyEscalationsForJob(db, it.job_id, now);
  return { ok: true, job_id: it.job_id, title: it.title };
}

/** The owner does not want to apply: rows leave the list and are never picked again. */
export function markSkip(db: Db, id: number, env: NodeJS.ProcessEnv = process.env, note?: string | null): MarkResult {
  const it = find(db, id, env);
  if (!it) return { ok: false, reason: `#${id} is not on the manual apply list (npm run apply:manual -- list)` };
  db.prepare("UPDATE outreach_queue SET apply_status = ?, apply_note = COALESCE(?, apply_note), updated_at = datetime('now') WHERE job_id = ? AND COALESCE(apply_status, '') NOT IN ('submitted', 'submitted_by_owner')").run(SKIPPED_BY_OWNER, ownerNote(note), it.job_id);
  resolveApplyEscalationsForJob(db, it.job_id);
  return { ok: true, job_id: it.job_id, title: it.title };
}
