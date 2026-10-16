// src/scheduler/plan.ts
import type { CeilingStatus, LimitKey } from '../outreach/limits.js';
import { drawBurstSize, inQuietHours, type PacingConfig, type Rng } from '../outreach/pacing.js';
import type { ControlState, Platform } from './control.js';
import type { DueCounts } from './due.js';

export type Operator = 'linkedin-operator' | 'naukri-operator';
/**
 * discover_scripts: the code pass over the script providers (zero LLM, no agent). discover_agent: `source-operator` for queued source_tasks.
 * discover: LinkedIn / Naukri discovery by their operators. pipeline: sweep, reply check, match, vetoes, contacts, prepare.
 * mail: `mail-operator` (email send and email follow-ups). apply: `apply-operator` (Task 21, not planned here yet).
 */
export type TaskKind =
  | 'inbox' | 'followups' | 'new_outreach' | 'discover'
  | 'discover_scripts' | 'discover_agent' | 'pipeline' | 'mail' | 'apply';
/** Who executes a wake stage that is not a platform operator. `code` is run by the scheduler itself before the claude run starts. */
export type StageOperator = 'code' | 'source-operator' | 'pipeline' | 'mail-operator' | 'apply-operator';
export interface Stage { operator: StageOperator; kind: TaskKind; quota: number }
/** One step of the wake, in execution order (see `stepOrder`). */
export interface Step { operator: Operator | StageOperator; kind: TaskKind; quota: number; platform?: Platform }
/** Names of the searches the discover tasks may run: LinkedIn from config/linkedin-discovery.json, Naukri (`naukri`) from config/naukri-discovery.json. */
export interface DiscoverSearches { jobs: string[]; posts: string[]; naukri?: string[] }
/** `quota` of a LinkedIn discover task is the number of searches it may run this wake; of a Naukri one, the job pages it may open for descriptions. `searches` names them. */
export interface OperatorTask { kind: TaskKind; quota: number; searches?: DiscoverSearches }
export interface Assignment { operator: Operator; platform: Platform; tasks: OperatorTask[] }
export type SkipReason = 'killed' | 'halted' | 'quiet_hours' | 'ceilings_exhausted' | 'nothing_due';
export type WakeDecision =
  | { kind: 'skip'; reason: SkipReason; detail?: string }
  | { kind: 'run'; burst: number; tasks: Assignment[]; stages?: Stage[] };
export interface PlanKnobs {
  inboxEveryMin: number;
  naukriDiscoverEveryHours: number;
  /** Hours between LinkedIn discover tasks; absent means the default (a constant, no env key). */
  linkedinDiscoverEveryHours?: number;
}

export const INBOX_QUOTA = 5;
export const NAUKRI_DETAIL_QUOTA = 5;
export const LINKEDIN_DISCOVER_EVERY_HOURS = 6;
/** Hours between code passes over the script providers (a constant, no env key). */
export const SCRIPT_DISCOVER_EVERY_HOURS = 6;
/** Most unscored jobs one wake's pipeline stage takes (a constant, no env key); the rest wait for the next wake. */
export const PIPELINE_MAX_JOBS_PER_WAKE = 25;
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
  };
}

export function planWake(i: {
  now: Date;
  rng: Rng;
  pacing: PacingConfig;
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
  if (inQuietHours(i.now, i.pacing)) return { kind: 'skip', reason: 'quiet_hours' };

  const burst = drawBurstSize(i.rng, i.pacing); // the only RNG draw
  const allowed = new Set<Platform>(control.allowed);
  const ok = (k: LimitKey): boolean => ceilings[k].ok;
  const plats = (pairs: [Platform, LimitKey[]][]): Platform[] =>
    pairs.filter(([p, keys]) => allowed.has(p) && keys.some(ok)).map(([p]) => p);

  const ORDER: Platform[] = ['linkedin', 'naukri']; // stable order: linkedin first
  const byPlatform: Record<Platform, OperatorTask[]> = { linkedin: [], naukri: [] };
  let remaining = burst;

  const inboxDue = due.inboxLastCheckedMinAgo === null || due.inboxLastCheckedMinAgo >= knobs.inboxEveryMin;
  if (inboxDue) for (const p of control.allowed) byPlatform[p].push({ kind: 'inbox', quota: INBOX_QUOTA });

  const withWork = (ps: Platform[], by: Record<Platform, number>): Platform[] => ps.filter((p) => by[p] > 0);
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

  // Each platform takes min(its due, what is left of the burst), in stable order, so the total
  // spent equals the old single quota.
  for (const p of followPlats) {
    const q = Math.min(due.followupsDueByPlatform[p], remaining);
    if (q > 0) {
      byPlatform[p].push({ kind: 'followups', quota: q });
      remaining -= q;
    }
  }
  for (const p of outreachPlats) {
    const q = Math.min(due.newOutreachReadyByPlatform[p], remaining);
    if (q > 0) {
      byPlatform[p].push({ kind: 'new_outreach', quota: q });
      remaining -= q;
    }
  }
  const naukriDiscoverDue =
    due.naukriSearchLastHoursAgo === null || due.naukriSearchLastHoursAgo >= knobs.naukriDiscoverEveryHours;
  if (naukriDiscoverDue && discoverPlats.length > 0) {
    byPlatform.naukri.push({ kind: 'discover', quota: NAUKRI_DETAIL_QUOTA, searches: { jobs: naukriNames, posts: [] } });
  }

  // Discovery reads and saves jobs, it sends nothing, so it does not spend the burst. It needs the
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

  const tasks: Assignment[] = ORDER.filter((p) => byPlatform[p].length > 0).map((p) => ({
    operator: `${p}-operator` as Operator,
    platform: p,
    tasks: byPlatform[p],
  }));

  // Non-platform stages. Absent due fields mean "not tracked": nothing is planned from them.
  const stages: Stage[] = [];
  const scriptAge = due.scriptDiscoverLastHoursAgo;
  const scriptDue = i.codePassEnabled === true && (scriptAge === null || (scriptAge !== undefined && scriptAge >= SCRIPT_DISCOVER_EVERY_HOURS));
  if (scriptDue) stages.push({ operator: 'code', kind: 'discover_scripts', quota: 1 });
  const sourceTasks = due.sourceTasksQueued ?? 0;
  if (sourceTasks > 0) stages.push({ operator: 'source-operator', kind: 'discover_agent', quota: Math.min(sourceTasks, SOURCE_TASK_QUOTA) });
  const newJobsExpected =
    scriptDue || sourceTasks > 0 || byPlatform.linkedin.some((t) => t.kind === 'discover') || byPlatform.naukri.some((t) => t.kind === 'discover');
  const unmatched = due.unmatchedJobs ?? 0;
  // Email follow-ups need the reply check the pipeline stage starts with (step 0b), so they pull the stage in.
  const pipelineDue = unmatched > 0 || newJobsExpected || (due.emailFollowupsReady ?? 0) > 0;
  if (pipelineDue) stages.push({ operator: 'pipeline', kind: 'pipeline', quota: Math.min(unmatched, PIPELINE_MAX_JOBS_PER_WAKE) });
  const emailWork = (due.emailQueued ?? 0) + (due.emailFollowupsReady ?? 0);
  if (emailWork > 0 || pipelineDue) stages.push({ operator: 'mail-operator', kind: 'mail', quota: emailWork });

  if (tasks.length > 0 || stages.length > 0) return { kind: 'run', burst, tasks, ...(stages.length > 0 ? { stages } : {}) };

  const allowedTotal = (by: Record<Platform, number>): number => control.allowed.reduce((n, p) => n + by[p], 0);
  const workExists =
    allowedTotal(due.followupsDueByPlatform) > 0 ||
    allowedTotal(due.newOutreachReadyByPlatform) > 0 ||
    (naukriDiscoverDue && naukriNames.length > 0 && allowed.has('naukri'));
  return { kind: 'skip', reason: workExists ? 'ceilings_exhausted' : 'nothing_due' };
}

/**
 * The wake in execution order: 1 code pass over the script providers, 2 source-operator, 3 LinkedIn then Naukri discover,
 * 4 pipeline (sweep, reply check, match, vetoes, contacts, prepare), 5 mail-operator, 6 linkedin-operator then naukri-operator
 * for inbox, followups and new_outreach, 7 apply-operator (Task 21 adds its stage).
 */
export function stepOrder(d: Extract<WakeDecision, { kind: 'run' }>): Step[] {
  const out: Step[] = [];
  const stage = (kind: TaskKind): void => {
    const s = d.stages?.find((x) => x.kind === kind);
    if (s) out.push({ operator: s.operator, kind: s.kind, quota: s.quota });
  };
  stage('discover_scripts');
  stage('discover_agent');
  for (const a of d.tasks) for (const t of a.tasks) if (t.kind === 'discover') out.push({ operator: a.operator, platform: a.platform, kind: t.kind, quota: t.quota });
  stage('pipeline');
  stage('mail');
  for (const a of d.tasks) for (const t of a.tasks) if (t.kind !== 'discover') out.push({ operator: a.operator, platform: a.platform, kind: t.kind, quota: t.quota });
  stage('apply');
  return out;
}
