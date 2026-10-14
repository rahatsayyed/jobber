// src/scheduler/plan.ts
import type { CeilingStatus, LimitKey } from '../outreach/limits.js';
import { drawBurstSize, inQuietHours, type PacingConfig, type Rng } from '../outreach/pacing.js';
import type { ControlState, Platform } from './control.js';
import type { DueCounts } from './due.js';

export type Worker = 'inbox-recruiter-replies' | 'due-followups' | 'new-outreach' | 'naukri-search';
export interface Assignment { worker: Worker; quota: number; platforms: Platform[] }
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

  const tasks: Assignment[] = [];
  let remaining = burst;

  const inboxDue = due.inboxLastCheckedMinAgo === null || due.inboxLastCheckedMinAgo >= knobs.inboxEveryMin;
  if (inboxDue) tasks.push({ worker: 'inbox-recruiter-replies', quota: INBOX_QUOTA, platforms: [...control.allowed] });

  const followPlats = plats([
    ['linkedin', ['linkedin_message']],
    ['naukri', ['naukri_message']],
  ]);
  const outreachPlats = plats([
    ['linkedin', ['linkedin_invite']],
    ['naukri', ['naukri_message']],
  ]);
  const searchPlats = plats([['naukri', ['naukri_apply']]]);

  if (due.followupsDue > 0 && followPlats.length > 0 && remaining > 0) {
    const q = Math.min(due.followupsDue, remaining);
    tasks.push({ worker: 'due-followups', quota: q, platforms: followPlats });
    remaining -= q;
  }
  if (due.newOutreachReady > 0 && outreachPlats.length > 0 && remaining > 0) {
    const q = Math.min(due.newOutreachReady, remaining);
    tasks.push({ worker: 'new-outreach', quota: q, platforms: outreachPlats });
    remaining -= q;
  }
  const searchDue =
    due.naukriSearchLastHoursAgo === null || due.naukriSearchLastHoursAgo >= knobs.naukriSearchEveryHours;
  if (searchDue && searchPlats.length > 0) tasks.push({ worker: 'naukri-search', quota: 1, platforms: searchPlats });

  if (tasks.length > 0) return { kind: 'run', burst, tasks };

  const workExists = due.followupsDue > 0 || due.newOutreachReady > 0 || (searchDue && allowed.has('naukri'));
  return { kind: 'skip', reason: workExists ? 'ceilings_exhausted' : 'nothing_due' };
}
