// src/scheduler/plan.ts
import type { CeilingStatus, LimitKey } from '../outreach/limits.js';
import { inQuietHours, type QuietConfig } from '../outreach/quiet.js';
import type { ControlState, Platform } from './control.js';
import type { DueCounts, DuePlatform } from './due.js';
import { ACCEPT_CHECK_MAX_PER_WAKE } from '../linkedin/acceptCheck.js';

export type Operator = 'linkedin-operator' | 'naukri-operator' | 'wellfound-operator';
/**
 * discover_scripts: the code pass over the script providers (zero LLM, no agent). discover_agent: `source-operator` for queued source_tasks.
 * discover: LinkedIn / Naukri discovery by their operators. pipeline: sweep, reply check, match, vetoes, contacts, prepare.
 * mail: `mail-operator` (email send and email follow-ups). apply: `apply-operator` (queued apply rows, its own quota).
 */
export type TaskKind =
  | 'inbox' | 'followups' | 'new_outreach' | 'discover'
  | 'discover_scripts' | 'discover_agent' | 'pipeline' | 'mail' | 'apply'
  // manual: owner-submitted job URLs and careers pages, ingested by the scheduler in code before the session (always the first step).
  | 'manual'
  // manual_url: one owner-submitted job page for a platform operator (LinkedIn, Naukri, Wellfound); the operator's typed `<platform>_manual_job` tool reads and saves it.
  | 'manual_url'
  // accept_check: LinkedIn only; the operator calls the typed `linkedin_check_accepted` tool (no argument) once per quota unit.
  | 'accept_check';
/** Who executes a wake stage that is not a platform operator. `code` is run by the scheduler itself before the claude run starts. */
export type StageOperator = 'code' | 'source-operator' | 'pipeline' | 'mail-operator' | 'apply-operator';
export interface Stage { operator: StageOperator; kind: TaskKind; quota: number }
/** One step of the wake, in execution order (see `stepOrder`). */
export interface Step {
  operator: Operator | StageOperator; kind: TaskKind; quota: number; platform?: Platform; searches?: DiscoverSearches;
  /** Sending steps only: the quota split into the quotas of separate sequential Agent calls (see `CHUNK_SIZE`); the calls sum to `quota`. */
  chunks?: number[];
}
/** Names of the searches the discover tasks may run: LinkedIn from config/linkedin-discovery.json, Naukri (`naukri`) from config/naukri-discovery.json. */
export interface DiscoverSearches { jobs: string[]; posts: string[]; naukri?: string[]; wellfound?: string[] }
/** `quota` of a LinkedIn discover task is the number of searches it may run this wake; of a Naukri one, the job pages it may open for descriptions. `searches` names them. */
export interface OperatorTask { kind: TaskKind; quota: number; searches?: DiscoverSearches }
export interface Assignment { operator: Operator; platform: Platform; tasks: OperatorTask[] }
export type SkipReason = 'killed' | 'halted' | 'quiet_hours' | 'ceilings_exhausted' | 'nothing_due';
export type WakeDecision =
  | { kind: 'skip'; reason: SkipReason; detail?: string }
  | { kind: 'run'; tasks: Assignment[]; stages?: Stage[] };
export interface PlanKnobs {
  inboxEveryMin: number;
  naukriDiscoverEveryHours: number;
  /** Hours between LinkedIn discover tasks; absent means the default (a constant, no env key). */
  linkedinDiscoverEveryHours?: number;
  /** Hours between Wellfound discover tasks (WELLFOUND_DISCOVER_EVERY_HOURS); absent means WELLFOUND_DISCOVER_EVERY_HOURS_DEFAULT. */
  wellfoundDiscoverEveryHours?: number;
}

/** Most items one Agent call of a sending step may handle (a constant, no env key): a longer quota is split into separate sequential calls, each a fresh subagent context. */
export const CHUNK_SIZE = 5;
export const INBOX_QUOTA = 5;
export const NAUKRI_DETAIL_QUOTA = 5;
export const WELLFOUND_DETAIL_QUOTA = 5;
export const WELLFOUND_DISCOVER_EVERY_HOURS_DEFAULT = 6;
export const LINKEDIN_DISCOVER_EVERY_HOURS = 6;
/** Hours between code passes over the script providers (a constant, no env key). */
export const SCRIPT_DISCOVER_EVERY_HOURS = 6;
/** The pipeline stage considers every unscored job saved in the last PIPELINE_WINDOW_HOURS hours (no fixed count), read in pages of PIPELINE_LIST_PAGE (one list_unscored_jobs result must stay one tool result: 22KB passed, 54KB did not), up to a hard ceiling. Defined in src/pipelineWork.ts beside the window and dedupe rules. */
export { PIPELINE_WINDOW_HOURS, PIPELINE_MAX_JOBS_PER_WAKE_CEILING } from '../pipelineWork.js';
import { PIPELINE_MAX_JOBS_PER_WAKE_CEILING as JOBS_CEILING } from '../pipelineWork.js';
/** Matcher agents dispatched at once; the wake waits for a wave to finish before the next. */
export const PIPELINE_MATCH_WAVE = 6;
/** Unscored jobs read per `db.list_unscored_jobs` call (kind unscored, offset 0, 20, 40 ...). */
export const PIPELINE_LIST_PAGE = 20;
/** Most matched jobs one wake sends to outreach-preparer (about 7 calls and a PDF render each): the highest stored scores; only jobs with a contact, a profile or apply_capable count toward it. The rest stay matched without an outreach row and come back as already_matched. */
export const PIPELINE_MAX_PREPARE_PER_WAKE = 15;
/** Most source_tasks one source-operator task may work per wake. */
export const SOURCE_TASK_QUOTA = 10;

function posInt(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 10000 ? n : fallback;
}

export function loadPlanKnobs(env: NodeJS.ProcessEnv = process.env): PlanKnobs {
  return {
    inboxEveryMin: posInt(env.INBOX_EVERY_MIN, 60),
    naukriDiscoverEveryHours: posInt(env.NAUKRI_DISCOVER_EVERY_HOURS, 6),
    ...(env.WELLFOUND_DISCOVER_EVERY_HOURS !== undefined
      ? { wellfoundDiscoverEveryHours: posInt(env.WELLFOUND_DISCOVER_EVERY_HOURS, WELLFOUND_DISCOVER_EVERY_HOURS_DEFAULT) }
      : {}),
  };
}

export function planWake(i: {
  now: Date;
  quiet: QuietConfig;
  control: ControlState;
  ceilings: Record<LimitKey, CeilingStatus>;
  due: DueCounts;
  knobs: PlanKnobs;
  /** Named discovery searches; absent or empty means no discover task is planned. */
  discoverSearches?: DiscoverSearches;
  // The scheduler can run the code pass over the script providers (the driver has a `codePass`); without it no discover_scripts stage is planned.
  codePassEnabled?: boolean;
}): WakeDecision {
  const { control, ceilings, due, knobs } = i;
  if (control.killed) return { kind: 'skip', reason: 'killed', detail: control.killReason ?? undefined };
  if (control.allowed.length === 0) {
    const detail = Object.entries(control.halted)
      .filter(([, r]) => r)
      .map(([p, r]) => `${p}: ${r}`)
      .join('; ');
    return { kind: 'skip', reason: 'halted', detail: detail || undefined };
  }
  if (inQuietHours(i.now, i.quiet)) return { kind: 'skip', reason: 'quiet_hours' };

  const allowed = new Set<Platform>(control.allowed);
  const ok = (k: LimitKey): boolean => ceilings[k].ok;
  const plats = (pairs: [DuePlatform, LimitKey[]][]): DuePlatform[] =>
    pairs.filter(([p, keys]) => allowed.has(p) && keys.some(ok)).map(([p]) => p);

  const ORDER: Platform[] = ['linkedin', 'naukri', 'wellfound']; // stable order: linkedin first
  const byPlatform: Record<Platform, OperatorTask[]> = { linkedin: [], naukri: [], wellfound: [] };
  // Quota per task = what is due, bounded by the room left under the real ceiling (daily counter) of the action's key.
  // naukri_message is shared by Naukri follow-ups and Naukri new outreach, so room is tracked per key and spent in order.
  const room: Partial<Record<LimitKey, number>> = {};
  const roomLeft = (k: LimitKey): number => room[k] ?? Math.max(0, ceilings[k].limit - ceilings[k].used);
  const spend = (k: LimitKey, n: number): void => { room[k] = roomLeft(k) - n; };

  // Wellfound is planned only when its discovery config names a search (the scheduler passes the names only when
  // its session file exists): no session, no dispatch, so no operator call is wasted before the owner logs in.
  const wellfoundNames = i.discoverSearches?.wellfound ?? [];
  const wellfoundOn = wellfoundNames.length > 0 && allowed.has('wellfound');

  // Owner-submitted job pages for a platform operator. Planned even when nothing else is due, for every platform that is allowed
  // (not halted) and, for Wellfound, switched on (its session exists). Reading and saving a page sends nothing, so it spends no ceiling.
  const mp = due.manualPlatformTasks;
  if (mp) for (const p of ORDER) if ((mp[p] ?? 0) > 0 && allowed.has(p) && (p !== 'wellfound' || wellfoundOn)) byPlatform[p].push({ kind: 'manual_url', quota: mp[p] });

  // LinkedIn accept check: reads profiles of sent invites and marks accepted ones, so the followups task can message them.
  // Reads only, spends no ceiling; the quota is already bounded in code (ACCEPT_CHECK_MAX_PER_WAKE) by countDue.
  const acceptDue = due.acceptCheckDue ?? 0;
  if (allowed.has('linkedin') && acceptDue > 0) {
    byPlatform.linkedin.push({ kind: 'accept_check', quota: Math.min(acceptDue, ACCEPT_CHECK_MAX_PER_WAKE) });
  }

  const inboxDue = due.inboxLastCheckedMinAgo === null || due.inboxLastCheckedMinAgo >= knobs.inboxEveryMin;
  if (inboxDue) for (const p of control.allowed) if (p !== 'wellfound' || wellfoundOn) byPlatform[p].push({ kind: 'inbox', quota: INBOX_QUOTA });

  const withWork = (ps: DuePlatform[], by: Record<DuePlatform, number>): DuePlatform[] => ps.filter((p) => by[p] > 0);
  const followPlats = withWork(
    plats([
      ['linkedin', ['linkedin_message']],
      ['naukri', ['naukri_message']],
    ]),
    due.followupsDueByPlatform,
  );
  const outreachPlats = withWork(
    plats([
      ['linkedin', ['linkedin_invite']],
      ['naukri', ['naukri_message']],
    ]),
    due.newOutreachReadyByPlatform,
  );
  const naukriNames = i.discoverSearches?.naukri ?? [];
  const discoverPlats = naukriNames.length > 0 ? plats([['naukri', ['naukri_apply']]]) : [];

  // Each platform takes min(its due, the room left under its ceiling), in stable order.
  for (const p of followPlats) {
    const key: LimitKey = p === 'linkedin' ? 'linkedin_message' : 'naukri_message';
    const q = Math.min(due.followupsDueByPlatform[p], roomLeft(key));
    if (q > 0) {
      byPlatform[p].push({ kind: 'followups', quota: q });
      spend(key, q);
    }
  }
  for (const p of outreachPlats) {
    const key: LimitKey = p === 'linkedin' ? 'linkedin_invite' : 'naukri_message';
    const q = Math.min(due.newOutreachReadyByPlatform[p], roomLeft(key));
    if (q > 0) {
      byPlatform[p].push({ kind: 'new_outreach', quota: q });
      spend(key, q);
    }
  }
  // Newly accepted people become due for their first message in this same wake: the accept check pulls in a LinkedIn followups task
  // even when none was due at plan time (the operator reads its real queue and reports done 0 when empty).
  if (byPlatform.linkedin.some((t) => t.kind === 'accept_check') && !byPlatform.linkedin.some((t) => t.kind === 'followups') && ok('linkedin_message')) {
    const q = Math.min(roomLeft('linkedin_message'), CHUNK_SIZE);
    if (q > 0) byPlatform.linkedin.push({ kind: 'followups', quota: q });
  }
  const naukriDiscoverDue =
    due.naukriSearchLastHoursAgo === null || due.naukriSearchLastHoursAgo >= knobs.naukriDiscoverEveryHours;
  if (naukriDiscoverDue && discoverPlats.length > 0) {
    byPlatform.naukri.push({ kind: 'discover', quota: NAUKRI_DETAIL_QUOTA, searches: { jobs: naukriNames, posts: [] } });
  }
  // Wellfound discovery: a named search, the daily wellfound_discover ceiling, and a last-run age (undefined: not tracked, never due).
  const wellfoundAge = due.wellfoundDiscoverLastHoursAgo;
  const wellfoundDiscoverDue =
    wellfoundAge === null || (wellfoundAge !== undefined && wellfoundAge >= (knobs.wellfoundDiscoverEveryHours ?? WELLFOUND_DISCOVER_EVERY_HOURS_DEFAULT));
  if (wellfoundOn && wellfoundDiscoverDue && ceilings.wellfound_discover?.ok !== false) {
    byPlatform.wellfound.push({ kind: 'discover', quota: WELLFOUND_DETAIL_QUOTA, searches: { jobs: wellfoundNames, posts: [] } });
  }

  // Discovery reads and saves jobs, it sends nothing, so it spends no ceiling. It needs the
  // linkedin_discover ceiling, a named search and a last-run age (undefined: not tracked, never due).
  const names = i.discoverSearches ?? { jobs: [], posts: [] };
  const nameCount = names.jobs.length + names.posts.length;
  const discoverEvery = knobs.linkedinDiscoverEveryHours ?? LINKEDIN_DISCOVER_EVERY_HOURS;
  const discoverAge = due.linkedinDiscoverLastHoursAgo;
  const discoverDue = discoverAge === null || (discoverAge !== undefined && discoverAge >= discoverEvery);
  const discoverRoom = ceilings.linkedin_discover ? ceilings.linkedin_discover.limit - ceilings.linkedin_discover.used : 0;
  if (allowed.has('linkedin') && discoverDue && nameCount > 0 && ceilings.linkedin_discover?.ok && discoverRoom > 0) {
    byPlatform.linkedin.push({ kind: 'discover', quota: Math.min(nameCount, discoverRoom), searches: names });
  }

  // Non-platform stages. Absent due fields mean "not tracked": nothing is planned from them.
  const stages: Stage[] = [];
  const scriptAge = due.scriptDiscoverLastHoursAgo;
  const scriptDue = i.codePassEnabled === true && (scriptAge === null || (scriptAge !== undefined && scriptAge >= SCRIPT_DISCOVER_EVERY_HOURS));
  // Owner-submitted requests: ingested in code at the start of the wake. They may create manual_url source tasks (unknown hosts), so
  // the source-operator and the pipeline are planned for them even though the rows do not exist yet at plan time.
  const manualPending = due.manualRequestsPending ?? 0;
  if (manualPending > 0) stages.push({ operator: 'code', kind: 'manual', quota: manualPending });
  if (scriptDue) stages.push({ operator: 'code', kind: 'discover_scripts', quota: 1 });
  const sourceTasks = (due.sourceTasksQueued ?? 0) + manualPending;
  if (sourceTasks > 0) stages.push({ operator: 'source-operator', kind: 'discover_agent', quota: Math.min(sourceTasks, SOURCE_TASK_QUOTA) });
  const newJobsExpected =
    scriptDue || sourceTasks > 0 || manualPending > 0 || ORDER.some((p) => byPlatform[p].some((t) => t.kind === 'manual_url')) || byPlatform.linkedin.some((t) => t.kind === 'discover') || byPlatform.naukri.some((t) => t.kind === 'discover') || byPlatform.wellfound.some((t) => t.kind === 'discover');
  const unmatched = due.unmatchedJobs ?? 0;
  const matchedWaiting = due.matchedAwaitingPrepare ?? 0;
  // Email follow-ups need the reply check the pipeline stage starts with (step 0b), so they pull the stage in.
  const pipelineDue = unmatched > 0 || matchedWaiting > 0 || newJobsExpected || (due.emailFollowupsReady ?? 0) > 0;

  // The pipeline creates work in this same wake (matches, enqueued outreach rows), so like mail it pulls in LinkedIn
  // new_outreach even when the due count was 0 at plan time. The operator reads its real queue (outreach.next_contacts)
  // and reports done 0 when nothing is ready. Never for Naukri: cold Naukri outreach is not possible by design.
  if (pipelineDue && allowed.has('linkedin') && ceilings.linkedin_invite?.ok && !byPlatform.linkedin.some((t) => t.kind === 'new_outreach')) {
    const q = roomLeft('linkedin_invite');
    if (q > 0) byPlatform.linkedin.push({ kind: 'new_outreach', quota: q });
  }

  const tasks: Assignment[] = ORDER.filter((p) => byPlatform[p].length > 0).map((p) => ({
    operator: `${p}-operator` as Operator,
    platform: p,
    tasks: byPlatform[p],
  }));

  if (pipelineDue) stages.push({ operator: 'pipeline', kind: 'pipeline', quota: Math.max(Math.min(unmatched + matchedWaiting, JOBS_CEILING), manualPending > 0 ? 1 : 0) });
  // No mail stage: the wake only enqueues email. Cold emails and email follow-ups are sent one at a time by the mail drip lane
  // (src/scheduler/mailDrip.ts), never inside a wake, so queued email alone is not wake work.
  // Apply: its own quota = the smaller of what is left of MAX_APPLIES_PER_DAY and of APPLY_MAX_ATTEMPTS_PER_DAY.
  // Emitted last, only when queued apply rows exist and quota remains (plan 8G-2 task 21).
  const applyQueued = due.applyQueued ?? 0;
  const attempt = ceilings.apply_attempt;
  const applyQuota = Math.min(due.appliesLeftToday ?? 0, attempt ? Math.max(0, attempt.limit - attempt.used) : 0);
  // The pipeline pulls apply in too (it may enqueue apply rows this wake); the operator reads db.list_queued_outreach.
  if ((applyQueued > 0 || pipelineDue) && applyQuota > 0) stages.push({ operator: 'apply-operator', kind: 'apply', quota: applyQuota });

  if (tasks.length > 0 || stages.length > 0) return { kind: 'run', tasks, ...(stages.length > 0 ? { stages } : {}) };

  const allowedTotal = (by: Record<DuePlatform, number>): number => control.allowed.reduce((n, p) => n + (p === 'wellfound' ? 0 : by[p]), 0);
  const workExists =
    allowedTotal(due.followupsDueByPlatform) > 0 ||
    allowedTotal(due.newOutreachReadyByPlatform) > 0 ||
    (naukriDiscoverDue && naukriNames.length > 0 && allowed.has('naukri')) ||
    (wellfoundOn && wellfoundDiscoverDue) ||
    applyQueued > 0;
  return { kind: 'skip', reason: workExists ? 'ceilings_exhausted' : 'nothing_due' };
}

/** The call sizes of a sending step: `quota` split into pieces of at most CHUNK_SIZE (12 gives 5, 5, 2). */
export function chunkQuota(quota: number): number[] {
  const out: number[] = [];
  for (let left = quota; left > 0; left -= CHUNK_SIZE) out.push(Math.min(left, CHUNK_SIZE));
  return out;
}

/**
 * The wake in execution order: 0 manual requests (code, only when some are pending), 1 code pass over the script providers, 2 source-operator, 3 LinkedIn then Naukri discover,
 * 4 pipeline (sweep, reply check, match, vetoes, contacts, prepare), 5 mail-operator, 6 linkedin-operator then naukri-operator
 * for inbox, followups and new_outreach, 7 apply-operator.
 */
export function stepOrder(d: Extract<WakeDecision, { kind: 'run' }>): Step[] {
  const out: Step[] = [];
  const stage = (kind: TaskKind): void => {
    const s = d.stages?.find((x) => x.kind === kind);
    if (s) out.push({ operator: s.operator, kind: s.kind, quota: s.quota });
  };
  stage('manual');
  stage('discover_scripts');
  stage('discover_agent');
  for (const a of d.tasks) for (const t of a.tasks) if (t.kind === 'manual_url') out.push({ operator: a.operator, platform: a.platform, kind: t.kind, quota: t.quota });
  for (const a of d.tasks) for (const t of a.tasks) if (t.kind === 'discover') out.push({ operator: a.operator, platform: a.platform, kind: t.kind, quota: t.quota, searches: t.searches });
  // accept_check reads profiles only and must run before the followups steps so a newly accepted person can be messaged in the same wake.
  for (const a of d.tasks) for (const t of a.tasks) if (t.kind === 'accept_check') out.push({ operator: a.operator, platform: a.platform, kind: t.kind, quota: t.quota });
  stage('pipeline');
  stage('mail');
  for (const a of d.tasks) for (const t of a.tasks) {
    if (t.kind === 'discover' || t.kind === 'manual_url' || t.kind === 'accept_check') continue;
    const sending = t.kind === 'followups' || t.kind === 'new_outreach';
    out.push({ operator: a.operator, platform: a.platform, kind: t.kind, quota: t.quota, ...(sending ? { chunks: chunkQuota(t.quota) } : {}) });
  }
  stage('apply');
  const apply = out[out.length - 1];
  if (apply?.kind === 'apply') apply.chunks = chunkQuota(apply.quota);
  return out;
}
