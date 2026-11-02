// browserctl arm for LinkedIn Easy Apply (linkedin_arm_send kind `easy_apply`): every code gate, then ONE intent of class linkedin_easy_apply.
// The model passes a job id only. The job page URL is read from SQLite (jobs.apply_url / jobs.url), rebuilt from the numeric id so no tracking
// parameter or model text survives, and OPENED HERE by the engine (the model never supplies it). The tailored resume is resolved by the same
// code-owned resolver DM attachments use. Gates, in order: kill switch and halt, APPLY_LINKEDIN_EASY, job exists and is not vetoed / hard
// stopped / already applied, a pending queue row of the LinkedIn class, ceilings (linkedin_easy_apply, the shared MAX_APPLIES_PER_DAY room,
// the profile-view ceiling for the job page), the resume file, page checks (right job, an Easy Apply control, not already applied), the
// input screen on the page text. A job whose Apply goes to the company site is handed back to the external-apply route, never opened here.
import { getExcludedReason, getFirstHardStop } from '../../db.js';
import { classifyApplyUrl } from '../../apply/registry.js';
import { isLinkedInEasyApplyCandidate } from '../../apply/easyApplyRows.js';
import { resolveJobIdResume } from '../../linkedin/attachment.js';
import { loadOutreachConfig } from '../../outreach/config.js';
import { ceilings, haltReason, tryConsume } from '../../outreach/limits.js';
import { recordDryRun } from '../../safety/dryRun.js';
import { killReason } from '../engineTypes.js';
import { renderTree } from '../snapshot.js';
import { normName, EASY_APPLY_OPEN_RE } from '../guard.js';
import { bindTouchRelease } from '../intent.js';
import { canonicalJobPage, clearEasyApplyState, jobNumericIdOfUrl, jobShowsApplied } from '../easyApply.js';
import type { ArmDeps, ArmResult } from './linkedin.js';

export const JOB_ID_RE = /^[\w.:@-]{1,200}$/;
const DEFAULT_MAX_APPLIES_PER_DAY = 5;
/** apply_note a row carries once its page showed no Easy Apply control: the drip picker skips it and the external-apply route owns it. */
export const NOT_EASY_APPLY_NOTE = 'easy_apply:not_easy_apply';

interface JobRow {
  id: string; source: string | null; url: string | null; apply_url: string | null; external_apply_url: string | null; company: string | null;
}
interface QueueRow { id: number; apply_url: string | null; apply_status: string | null; apply_note: string | null; resume_pdf_path: string | null }

/** Today's shared apply counter room (read only; the commit path consumes it with the linkedin_easy_apply ceiling). */
function sharedRoom(deps: ArmDeps): { used: number; max: number } {
  const raw = Number(deps.env.MAX_APPLIES_PER_DAY ?? DEFAULT_MAX_APPLIES_PER_DAY);
  const max = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MAX_APPLIES_PER_DAY;
  const row = deps.db.prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = 'easy_apply'").get() as { count: number } | undefined;
  return { used: row?.count ?? 0, max };
}

/** The numeric LinkedIn job id of a stored job row (apply_url first, then url), or null. */
function numericIdOf(job: JobRow, q: QueueRow | undefined): string | null {
  for (const u of [q?.apply_url, job.apply_url, job.url]) {
    if (typeof u === 'string' && u) { const n = jobNumericIdOfUrl(u); if (n) return n; }
  }
  const m = /^li-job:(\d{5,})$/.exec(job.id);
  return m ? m[1] : null;
}

export async function armEasyApply(deps: ArmDeps, a: { job_id?: string }): Promise<ArmResult> {
  const { db } = deps;
  bindTouchRelease(deps.intents, db);
  deps.intents.sweep();
  const now = (): Date => deps.now();
  const fail = (status: ArmResult['status'], code: string, reason?: string): ArmResult => ({ status, code, ...(reason ? { reason } : {}) });

  if (typeof a.job_id !== 'string' || !JOB_ID_RE.test(a.job_id)) return fail('refused', 'bad_job_id', 'kind easy_apply needs a job_id');
  const k = killReason(deps);
  if (k) return fail('halted', k.startsWith('kill switch') ? 'killed' : 'halted', k);
  const h = haltReason(db, 'linkedin');
  if (h !== null) return fail('halted', 'halted', `linkedin halted: ${h}`);
  // Easy Apply is a LinkedIn drip lane action only: never in a wake and never in an interactive session (the lane marks its run).
  if (deps.env.JOBBER_RUN_LANE !== 'linkedin_drip') return fail('refused', 'drip_lane_only', 'Easy Apply runs only in the LinkedIn drip lane');
  if (deps.env.APPLY_LINKEDIN_EASY !== 'true') return fail('refused', 'easy_apply_off', 'APPLY_LINKEDIN_EASY is not true; the owner applies to these jobs by hand');

  // Pre-flight from SQLite, before any browser use.
  const job = db.prepare('SELECT id, source, url, apply_url, external_apply_url, company FROM jobs WHERE id = ?').get(a.job_id) as JobRow | undefined;
  if (!job) return fail('refused', 'unknown_job', 'no such job');
  if (getExcludedReason(db, a.job_id)) return fail('refused', 'vetoed', 'the job is excluded');
  if (getFirstHardStop(db, a.job_id)) return fail('refused', 'hard_stop', 'the job has a hard stop');
  if (db.prepare("SELECT 1 FROM applications WHERE job_id = ? AND status = 'submitted' LIMIT 1").get(a.job_id)) return fail('refused', 'already_applied', 'an application was already submitted for this job');
  const q = db.prepare("SELECT id, apply_url, apply_status, apply_note, resume_pdf_path FROM outreach_queue WHERE job_id = ? AND COALESCE(apply_status, '') IN ('', 'queued') ORDER BY id DESC LIMIT 1")
    .get(a.job_id) as QueueRow | undefined;
  if (!q) return fail('refused', 'no_pending_row', 'no pending queue row for this job');
  if ((q.apply_note ?? '') === NOT_EASY_APPLY_NOTE) return fail('refused', 'not_easy_apply', 'this job applies on the company site');
  if (!isLinkedInEasyApplyCandidate({ apply_url: q.apply_url, job_apply_url: job.apply_url, url: job.url, source: job.source, external_apply_url: job.external_apply_url, apply_status: q.apply_status }, deps.env)) {
    return fail('refused', 'not_a_linkedin_easy_apply_job', 'the job is not a LinkedIn job page row for Easy Apply');
  }
  const cls = classifyApplyUrl(q.apply_url || job.apply_url || job.url, job.source, deps.env);
  if (cls.platform !== 'linkedin_easy') return fail('refused', 'not_a_linkedin_easy_apply_job', 'the registry does not class this job as LinkedIn Easy Apply');
  const numeric = numericIdOf(job, q);
  if (!numeric) return fail('refused', 'bad_job_url', 'no LinkedIn job id on this job');

  // Ceilings: the Easy Apply ceiling, the shared daily apply room, and the profile-view ceiling (a job page is a view).
  const c = ceilings(db, loadOutreachConfig(deps.env), now());
  if (!c.linkedin_easy_apply.ok) return fail('rate_limited', 'rate_limited', `linkedin_easy_apply ${c.linkedin_easy_apply.used} of ${c.linkedin_easy_apply.limit} today`);
  const room = sharedRoom(deps);
  if (room.used >= room.max) return fail('rate_limited', 'rate_limited', `daily apply limit (${room.max}) reached`);
  if (!c.linkedin_profile_view.ok) return fail('rate_limited', 'profile_view_limit', 'daily profile view limit reached');

  // The tailored resume, by the code-owned resolver (inside renderer/automation, re-rendered when missing, generic upload name).
  const resume = await resolveJobIdResume(db, a.job_id, deps.attach);
  if (!resume.ok) return fail('refused', resume.code, resume.reason);

  // Open the job page (URL rebuilt from the numeric id) and read it. The view is charged right before the navigation.
  if (!tryConsume(db, 'linkedin_profile_view', loadOutreachConfig(deps.env), now())) return fail('rate_limited', 'profile_view_limit', 'daily profile view limit reached');
  const opened = await deps.engine.open(canonicalJobPage(numeric));
  if (!opened.ok) {
    const halted = opened.code === 'halted' || opened.code === 'killed';
    return fail(halted ? 'halted' : 'failed', opened.code, opened.reason);
  }
  const tree = deps.engine.lastTree();
  const page = await deps.engine.page();
  if (!tree || !page) return fail('failed', 'no_snapshot', 'could not read the page');
  if (jobNumericIdOfUrl(page.url()) !== numeric) return fail('refused', 'job_page_mismatch', 'the browser is not on the requested job page');

  // Third-party page text: screen for sending, fail closed.
  const v = await deps.screen(renderTree(tree, deps.engine.refs.epoch), 'send');
  if (v.blocked) {
    if (v.code === 'classifier_unavailable') return fail('failed', 'classifier_unavailable');
    return fail('refused', 'injection_suspected', 'page text flagged by the input screen');
  }

  if (jobShowsApplied(tree)) {
    db.prepare("UPDATE outreach_queue SET apply_status = 'needs_owner', apply_note = 'easy_apply:already_applied_on_page', updated_at = datetime('now') WHERE job_id = ? AND COALESCE(apply_status, '') IN ('', 'queued')").run(a.job_id);
    return fail('refused', 'already_applied_on_page', 'the job page already shows Applied; the owner can mark it done with npm run apply:manual');
  }
  const controls = tree.nodes.filter((x) => x.dialog === undefined && (x.role === 'button' || x.role === 'link') && !x.disabled);
  const easy = controls.filter((x) => EASY_APPLY_OPEN_RE.test(normName(x.name)));
  if (easy.length === 0) {
    const plainApply = controls.some((x) => /^apply(?: now| on company(?:'s)? (?:site|website))?$/.test(normName(x.name)));
    if (plainApply) {
      // Apply goes to the company site: hand the row back to the external-apply route (the apply-operator resolves it) and never retry it here.
      db.prepare("UPDATE outreach_queue SET apply_platform = 'linkedin', apply_tier = 'agent', apply_note = ?, updated_at = datetime('now') WHERE job_id = ? AND COALESCE(apply_status, '') IN ('', 'queued')").run(NOT_EASY_APPLY_NOTE, a.job_id);
      return fail('refused', 'not_easy_apply', 'this job applies on the company site; it was handed to the external-apply route');
    }
    return fail('refused', 'easy_apply_control_missing', 'the job page shows no Easy Apply control');
  }

  const dry = deps.cfg.dryRun;
  clearEasyApplyState(deps.intents, numeric);
  const intent = deps.intents.arm({
    platform: 'linkedin', kind: 'easy_apply', class: 'linkedin_easy_apply', text: null, jobId: a.job_id, pageKey: numeric,
    ...(job.company ? { company: job.company } : {}),
    attachment: { path: resume.attachment.path, name: resume.attachment.name, bytes: resume.attachment.bytes, attached: false },
    dry,
  });
  if (dry) {
    try {
      recordDryRun(db, { runId: null, action: 'linkedin_arm_send', platform: 'linkedin', payload: { kind: 'easy_apply', class: 'linkedin_easy_apply', job_id: a.job_id } }, now(), deps.env);
    } catch { /* the dry intent is still armed */ }
  }
  return {
    status: 'armed', code: 'armed', intent_id: intent.id, expires_at: new Date(intent.expiresAt).toISOString(), class: 'linkedin_easy_apply', dry_run: dry,
    would: { kind: 'easy_apply', chars: 0, recipient: job.company ?? '' },
    attachment: { name: resume.attachment.name, bytes: resume.attachment.bytes },
  };
}
