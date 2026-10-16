// src/scheduler/plan.ts
import type { CeilingStatus, LimitKey } from '../outreach/limits.js';
import { drawBurstSize, inQuietHours, type PacingConfig, type Rng } from '../outreach/pacing.js';
import type { ControlState, Platform } from './control.js';
import type { DueCounts } from './due.js';

export type Operator = 'linkedin-operator' | 'naukri-operator';
export type TaskKind = 'inbox' | 'followups' | 'new_outreach' | 'search' | 'discover';
/** Names of the searches in config/linkedin-discovery.json the discover task may run. */
export interface DiscoverSearches { jobs: string[]; posts: string[] }
/** `quota` of a discover task is the number of searches it may run this wake; `searches` names them. */
export interface OperatorTask { kind: TaskKind; quota: number; searches?: DiscoverSearches }
export interface Assignment { operator: Operator; platform: Platform; tasks: OperatorTask[] }
export type SkipReason = 'killed' | 'halted' | 'quiet_hours' | 'ceilings_exhausted' | 'nothing_due';
export type WakeDecision =
  | { kind: 'skip'; reason: SkipReason; detail?: string }
  | { kind: 'run'; burst: number; tasks: Assignment[] };
export interface PlanKnobs {
  inboxEveryMin: number;
  naukriSearchEveryHours: number;
  /** Hours between LinkedIn discover tasks; absent means the default (a constant, no env key). */
  linkedinDiscoverEveryHours?: number;
}

export const INBOX_QUOTA = 5;
export const LINKEDIN_DISCOVER_EVERY_HOURS = 6;

function posInt(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 10000 ? n : fallback;
}

export function loadPlanKnobs(env: NodeJS.ProcessEnv = process.env): PlanKnobs {
  return {
    inboxEveryMin: posInt(env.INBOX_EVERY_MIN, 60),
    naukriSearchEveryHours: posInt(env.NAUKRI_SEARCH_EVERY_HOURS, 6),
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
  const searchPlats = plats([['naukri', ['naukri_apply']]]);

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
  const searchDue =
    due.naukriSearchLastHoursAgo === null || due.naukriSearchLastHoursAgo >= knobs.naukriSearchEveryHours;
  if (searchDue && searchPlats.length > 0) byPlatform.naukri.push({ kind: 'search', quota: 1 });

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

  if (tasks.length > 0) return { kind: 'run', burst, tasks };

  const allowedTotal = (by: Record<Platform, number>): number => control.allowed.reduce((n, p) => n + by[p], 0);
  const workExists =
    allowedTotal(due.followupsDueByPlatform) > 0 ||
    allowedTotal(due.newOutreachReadyByPlatform) > 0 ||
    (searchDue && allowed.has('naukri'));
  return { kind: 'skip', reason: workExists ? 'ceilings_exhausted' : 'nothing_due' };
}
