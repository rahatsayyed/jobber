// Typed save of ONE owner-submitted job page for a platform operator (`linkedin_manual_job`, `naukri_manual_job`,
// `wellfound_manual_job`). The model passes nothing: code picks the next queued `manual_url` task of the platform, takes the URL from
// SQLite (validated again by classifyManualUrl), loads it in the operator's own session, reads the posting text, runs the input gate and
// the classifier screen, and saves the job at priority 1 under `manual:<platform>` linked to its request. Same save path and gates as the
// platform's discover tool (field gate, screen, saveJob); no send, no apply, no ceiling consumed. Page text never reaches the result.
// UNVERIFIED live: the title and company are parsed from the page title and first heading with best-effort rules, no live page has been read.
import type BetterSqlite3 from 'better-sqlite3';
import { haltReason } from '../outreach/limits.js';
import { isDryRun, recordDryRun } from '../safety/dryRun.js';
import { gateField } from '../safety/fieldGate.js';
import type { ScreenPurpose, ScreenVerdict } from '../safety/screen.js';
import { saveManualJobs } from './requests.js';
import { classifyManualUrl, type ManualPlatform } from './url.js';

type Db = BetterSqlite3.Database;

/** What the page read returns: the document title, the first heading and the visible text. All untrusted. */
export interface PageRead { docTitle?: unknown; heading?: unknown; text?: unknown }
export interface ManualJobIo {
  load(url: string): Promise<'ok' | 'login_required' | 'halted' | 'failed'>;
  read(): Promise<PageRead | null>;
}
export interface ManualJobDeps {
  db: Db;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  screen: (t: string, p: ScreenPurpose) => Promise<ScreenVerdict>;
}
export type ManualJobStatus = 'ok' | 'dry_run' | 'halted' | 'failed';
export interface ManualJobResult {
  status: ManualJobStatus;
  code: string;
  task_id?: number;
  job_ids: string[];
  /** Queued manual_url tasks of this platform left after this call. */
  remaining: number;
  injection_suspected?: boolean;
}

/** In-page script for a job page: title, first heading and visible text (capped). Arrow function only. */
export const MANUAL_PAGE_SRC = `(() => ({
  docTitle: document.title || '',
  heading: ((document.querySelector('h1') || {}).innerText || ''),
  text: (document.body ? document.body.innerText : '').slice(0, 20000),
}))()`;

const DESCRIPTION_MAX = 8000;

const remainingOf = (db: Db, platform: ManualPlatform): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM source_tasks WHERE reason = 'manual_url' AND platform = ? AND state IN ('queued', 'running')").get(platform) as { n: number }).n;

const halted = (db: Db, platform: ManualPlatform): boolean => !!(haltReason(db, platform) ?? haltReason(db, 'all'));

/** Best-effort title and company from the heading or document title (unverified live). Pure. */
export function parsePosting(platform: ManualPlatform, docTitle: string, heading: string, url: string): { title: string; company: string } {
  const strip = (s: string): string => s.replace(/\s*[|–—-]\s*(?:LinkedIn|Naukri(?:\.com)?|Wellfound(?:\s*\(formerly AngelList Talent\))?)\s*$/i, '').trim();
  const base = strip(docTitle) || strip(heading);
  let title = '';
  let company = '';
  const hiring = /^(.+?)\s+hiring\s+(.+?)(?:\s+in\s+.+)?$/i.exec(base); // LinkedIn: "Acme hiring Senior Developer in Pune"
  const at = /^(.+?)\s+(?:at|@)\s+(.+?)(?:\s+[|–—-]\s+.*)?$/i.exec(base); // "Senior Developer at Acme"
  if (platform === 'linkedin' && hiring) { company = hiring[1]!; title = hiring[2]!; }
  else if (at) { title = at[1]!; company = at[2]!; }
  else {
    const parts = base.split(/\s+[-–—|]\s+/).map((x) => x.trim()).filter(Boolean);
    title = parts[0] ?? '';
    company = parts[1] ?? '';
  }
  if (heading && heading.trim().length >= 4 && heading.trim().length <= 160 && platform !== 'linkedin' && !title) title = heading.trim();
  if (!company && platform === 'wellfound') {
    try { company = /^\/company\/([^/]+)\//.exec(new URL(url).pathname)?.[1]?.replace(/-/g, ' ') ?? ''; } catch { company = ''; }
  }
  return { title: title.trim(), company: company.trim() };
}

export async function saveNextManualPlatformJob(platform: ManualPlatform, io: ManualJobIo, deps: ManualJobDeps): Promise<ManualJobResult> {
  const { db, env, now } = deps;
  const out = (status: ManualJobStatus, code: string, extra: Partial<ManualJobResult> = {}): ManualJobResult => {
    let remaining = 0;
    try { remaining = remainingOf(db, platform); } catch { remaining = 0; }
    return { status, code, job_ids: [], remaining, ...extra };
  };
  try {
    if (halted(db, platform)) return out('halted', 'halted');
  } catch {
    return out('failed', 'halt_state_unreadable');
  }
  const row = db.prepare("SELECT id, url, request_id FROM source_tasks WHERE reason = 'manual_url' AND platform = ? AND state IN ('queued', 'running') ORDER BY id LIMIT 1").get(platform) as { id: number; url: string | null; request_id: number | null } | undefined;
  if (!row) return out('ok', 'no_task');
  const close = (state: 'done' | 'failed'): void => {
    db.prepare('UPDATE source_tasks SET state = ?, updated_at = ? WHERE id = ?').run(state, now().toISOString(), row.id);
  };
  const cls = row.url && row.request_id ? classifyManualUrl(row.url) : null;
  if (!cls || cls.kind !== 'platform' || cls.platform !== platform) { close('failed'); return out('failed', 'bad_task', { task_id: row.id }); }

  if (isDryRun(env)) {
    recordDryRun(db, { runId: null, action: `${platform}_manual_job`, platform, payload: { task_id: row.id, job_id: cls.jobId } }, now(), env);
    return out('dry_run', 'dry_run', { task_id: row.id });
  }

  const loaded = await io.load(cls.canonicalUrl);
  if (loaded === 'halted') return out('halted', 'halted', { task_id: row.id });
  if (loaded !== 'ok') { if (loaded === 'failed') close('failed'); return out('failed', loaded, { task_id: row.id }); }
  let page: PageRead | null;
  try { page = await io.read(); } catch { page = null; }
  if (!page) { close('failed'); return out('failed', 'unreadable', { task_id: row.id }); }

  const docTitle = gateField(String(page.docTitle ?? ''), 300);
  const heading = gateField(String(page.heading ?? ''), 300);
  const body = gateField(String(page.text ?? ''), DESCRIPTION_MAX);
  if (docTitle.blocked || heading.blocked || body.blocked) { close('failed'); return out('failed', 'injection_suspected', { task_id: row.id, injection_suspected: true }); }
  const parsed = parsePosting(platform, docTitle.text, heading.text, cls.canonicalUrl);
  const title = gateField(parsed.title, 160);
  const company = gateField(parsed.company, 100);
  if (!title.text || title.blocked || company.blocked || body.text.length < 40) { close('failed'); return out('failed', 'unreadable', { task_id: row.id }); }

  let v: ScreenVerdict;
  try { v = await deps.screen(`${title.text}\n${company.text}\n${body.text}`, 'read'); } catch { return out('failed', 'classifier_unavailable', { task_id: row.id }); }
  if (v.blocked) { close('failed'); return out('failed', v.code, { task_id: row.id, injection_suspected: true }); }

  const job = { id: cls.jobId, source: cls.sourceKind, title: title.text, company: company.text || 'unknown', url: cls.canonicalUrl, apply_url: cls.canonicalUrl, description: body.text };
  const r = saveManualJobs(db, row.request_id!, [job], cls.sourceKind);
  close('done');
  return out('ok', r.fresh ? 'saved' : 'known', { task_id: row.id, job_ids: r.linked });
}
