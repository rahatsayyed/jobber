// src/scheduler/plan.ts
import type { CeilingStatus, LimitKey } from '../outreach/limits.js';
import { drawBurstSize, inQuietHours, type PacingConfig, type Rng } from '../outreach/pacing.js';
import type { ControlState, Platform } from './control.js';
import type { DueCounts } from './due.js';

export type Operator = 'linkedin-operator' | 'naukri-operator' | 'apply-operator';
export type TaskKind = 'inbox' | 'followups' | 'new_outreach' | 'search' | 'apply';
export interface OperatorTask { kind: TaskKind; quota: number }
// 'apply' is not a platform: the apply operator routes per queued row (plan 8G-2 task 21).
export interface Assignment { operator: Operator; platform: Platform | 'apply'; tasks: OperatorTask[] }
export type SkipReason = 'killed' | 'halted' | 'quiet_hours' | 'ceilings_exhausted' | 'nothing_due';
export type WakeDecision =
  | { kind: 'skip'; reason: SkipReason; detail?: string }
  | { kind: 'run'; burst: number; tasks: Assignment[] };
export interface PlanKnobs { inboxEveryMin: number; naukriSearchEveryHours: number }

export const INBOX_QUOTA = 5;

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

  const tasks: Assignment[] = ORDER.filter((p) => byPlatform[p].length > 0).map((p) => ({
    operator: `${p}-operator` as Operator,
    platform: p,
    tasks: byPlatform[p],
  }));

  // Apply: its own quota (not the burst) = the smaller of what is left of MAX_APPLIES_PER_DAY and of
  // APPLY_MAX_ATTEMPTS_PER_DAY. Emitted last, only when queued apply rows exist and quota remains.
  const applyQueued = due.applyQueued ?? 0;
  const attempt = ceilings.apply_attempt;
  const applyQuota = Math.min(due.appliesLeftToday ?? 0, attempt ? Math.max(0, attempt.limit - attempt.used) : 0);
  if (applyQueued > 0 && applyQuota > 0) {
    tasks.push({ operator: 'apply-operator', platform: 'apply', tasks: [{ kind: 'apply', quota: applyQuota }] });
  }

  if (tasks.length > 0) return { kind: 'run', burst, tasks };

  const allowedTotal = (by: Record<Platform, number>): number => control.allowed.reduce((n, p) => n + by[p], 0);
  const workExists =
    allowedTotal(due.followupsDueByPlatform) > 0 ||
    allowedTotal(due.newOutreachReadyByPlatform) > 0 ||
    (searchDue && allowed.has('naukri')) ||
    applyQueued > 0;
  return { kind: 'skip', reason: workExists ? 'ceilings_exhausted' : 'nothing_due' };
}
