// Classify a snapshot Observation against stored layout memory and relearn from consistent
// observations (plan 8B). Pure: no I/O, no clock reads (time comes in through ctx.now), and the
// input file is never mutated (a new file object is returned).
import { createHash } from 'node:crypto';
import type { LandmarkId, LayoutFile, KindMemory, Observation, Variant, Verdict } from './types.js';
import type { LayoutConfig } from './config.js';
import { CRITICAL, MAX_RUN_IDS, MIN_SET, RUN_ID_RE } from './vocab.js';

export type { Verdict } from './types.js';

export interface ApplyResult {
  file: LayoutFile;
  verdict: Verdict;
  events: Array<'promoted' | 'went_stale' | 'drift_escalate' | 'drift_halt' | 'variant_replaced'>;
}

// Same caps the store enforces, so a result always passes its validate.
const MAX_VARIANTS = 3;
const MAX_LANDMARKS = 40;
const MAX_COUNT = 1_000_000; // clamp for obs, runs and counters
// A null or malformed run id counts as one anonymous run id.
const ANON_RUN = 'norun';

function best(promoted: Variant[], obs: Observation): { v: Variant; score: number } | null {
  const have = new Set(obs.landmarks);
  let out: { v: Variant; score: number } | null = null;
  for (const v of promoted) {
    const inter = v.landmarks.filter((l) => have.has(l)).length;
    const score = v.landmarks.length === 0 ? 0 : inter / v.landmarks.length;
    if (!out || score > out.score) out = { v, score };
  }
  return out;
}

export function classify(file: LayoutFile, obs: Observation, cfg: LayoutConfig): Verdict {
  if (obs.nonDrift) return { class: obs.nonDrift };
  // An observation for another platform is never compared against this file.
  if (obs.platform !== file.platform) return { class: 'unknown', score: 0, missing: [], variant: null };
  const promoted = (file.kinds[obs.kind]?.variants ?? []).filter((v) => v.promoted);
  const b = best(promoted, obs);
  if (!b) return { class: 'unknown', score: 0, missing: [], variant: null };
  const have = new Set(obs.landmarks);
  const missing = b.v.landmarks.filter((l) => !have.has(l));
  const critical = CRITICAL[obs.platform]?.[obs.kind] ?? [];
  const criticalOk = critical.every((l) => have.has(l));
  const base = { score: b.score, missing, variant: b.v.id };
  if (criticalOk && b.score >= cfg.matchMin) return { class: 'match', ...base };
  if (criticalOk && b.score >= cfg.partialMin) return { class: 'partial', ...base };
  // shell=false means the page did not load as a known app page: that is "unloaded", never drift.
  return { class: obs.shell ? 'drift' : 'unloaded', ...base };
}

function noteRun(v: Variant, runId: string | null): void {
  const id = runId !== null && RUN_ID_RE.test(runId) ? runId : ANON_RUN;
  if (!v.run_ids.includes(id)) v.runs = Math.min(v.runs + 1, MAX_COUNT); // runs evicted from the 5-id list can recount; acceptable
  v.run_ids = [...v.run_ids.filter((r) => r !== id), id].slice(-MAX_RUN_IDS);
  v.obs = Math.min(v.obs + 1, MAX_COUNT);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// Merge obs counts into a variant's observed [min,max]; null if any range would span more than one bucket.
function mergeCounts(v: Variant, counts: Record<string, number>): Record<string, [number, number]> | null {
  const out: Record<string, [number, number]> = {};
  for (const k of new Set([...Object.keys(v.counts), ...Object.keys(counts)])) {
    const n = counts[k] ?? 0;
    const [lo, hi] = v.counts[k] ?? [n, n];
    const r: [number, number] = [Math.min(lo, n), Math.max(hi, n)];
    if (r[1] - r[0] > 1) return null;
    out[k] = r;
  }
  return out;
}

function variantId(landmarks: readonly string[], counts: Record<string, number>, salt: number): string {
  const shape = Object.keys(counts).sort().map((k) => `${k}=${counts[k]}`).join(',');
  return createHash('sha256').update(`${landmarks.join(',')}|${shape}|${salt}`).digest('hex').slice(0, 12);
}

const stamp = (v: Variant): string => v.last_verified ?? v.first_seen;
function oldest(vs: Variant[]): Variant {
  return vs.reduce((a, b) => (stamp(b) < stamp(a) ? b : a));
}

type Ev = ApplyResult['events'];

// Accumulate a consistent observation into a learning variant and promote it when it has earned it.
function learn(km: KindMemory, obs: Observation, now: string, runId: string | null, cfg: LayoutConfig, events: Ev): void {
  const need = MIN_SET[obs.platform]?.[obs.kind];
  // No MIN_SET entry: nothing guards against a poisoned observation, so the kind is never learned.
  if (!need || !obs.shell) return;
  const have = new Set(obs.landmarks);
  if (!need.every((l) => have.has(l))) return;
  const landmarks: LandmarkId[] = [...obs.landmarks].sort().slice(0, MAX_LANDMARKS);

  let cand: Variant | undefined;
  let merged: Record<string, [number, number]> | null = null;
  for (const v of km.variants) {
    if (v.promoted || !sameSet(v.landmarks, landmarks)) continue;
    merged = mergeCounts(v, obs.counts);
    if (merged) { cand = v; break; }
  }
  if (cand && merged) {
    cand.counts = merged;
    noteRun(cand, runId);
  } else {
    if (km.variants.length >= MAX_VARIANTS) {
      // A promoted variant is never evicted at seed time. With 3 promoted variants stored nothing new
      // can be learned until the owner resets the layout; drift counters still advance.
      const learning = km.variants.filter((v) => !v.promoted);
      if (learning.length === 0) return;
      const drop = learning.reduce((a, b) => (b.first_seen < a.first_seen ? b : a));
      km.variants = km.variants.filter((v) => v !== drop);
    }
    const counts: Record<string, [number, number]> = {};
    for (const [k, n] of Object.entries(obs.counts)) counts[k] = [n, n];
    let salt = 0;
    while (km.variants.some((v) => v.id === variantId(landmarks, obs.counts, salt))) salt += 1;
    cand = {
      id: variantId(landmarks, obs.counts, salt), landmarks, counts, recipes: [],
      first_seen: now, last_verified: null, obs: 0, runs: 0, run_ids: [],
      promoted: false, ok: 0, fail: 0,
    };
    noteRun(cand, runId);
    km.variants.push(cand);
  }
  if (cand.obs >= cfg.promoteN && cand.runs >= cfg.promoteRuns) {
    cand.promoted = true;
    cand.last_verified = now;
    km.state = 'stable';
    events.push('promoted');
    // Defensive: seeding already keeps the total within the cap, so this only trims if that changes.
    while (km.variants.length > MAX_VARIANTS) {
      const drop = oldest(km.variants.filter((v) => v !== cand));
      if (drop.promoted) events.push('variant_replaced');
      km.variants = km.variants.filter((v) => v !== drop);
    }
  }
}

export function applyObservation(
  file: LayoutFile, obs: Observation, ctx: { now: Date; runId: string | null }, cfg: LayoutConfig,
): ApplyResult {
  const out: LayoutFile = structuredClone(file);
  const events: Ev = [];
  if (obs.nonDrift) return { file: out, verdict: { class: obs.nonDrift }, events };
  const verdict = classify(out, obs, cfg);
  // Not a loaded app page: no variant, counter or streak changes.
  if (verdict.class === 'unloaded' || obs.platform !== file.platform) return { file: out, verdict, events };

  const now = ctx.now.toISOString();
  const existed = obs.kind in out.kinds;
  const km: KindMemory = out.kinds[obs.kind] ?? {
    state: 'learning', variants: [], counters: { match: 0, partial: 0, drift: 0 },
    drift_streak: 0, drift_window_start: null, last_drift_at: null, drift_run_ids: [],
  };
  out.kinds[obs.kind] = km;
  out.updated_at = now;

  // Staleness: checked against the clock before this observation is applied.
  const promoted = km.variants.filter((v) => v.promoted);
  if (km.state === 'stable' && promoted.length > 0) {
    const newest = promoted.map(stamp).sort().at(-1)!;
    if (ctx.now.getTime() - Date.parse(newest) > cfg.staleDays * 86_400_000) {
      km.state = 'stale';
      events.push('went_stale');
    }
  }

  if (verdict.class === 'match' || verdict.class === 'partial') {
    km.drift_streak = 0;
    km.drift_window_start = null;
    km.drift_run_ids = [];
    if (verdict.class === 'match') {
      km.counters.match = Math.min(km.counters.match + 1, MAX_COUNT);
      const v = km.variants.find((x) => x.id === verdict.variant);
      if (v) { v.last_verified = now; noteRun(v, ctx.runId); }
      km.state = 'stable';
    } else {
      km.counters.partial = Math.min(km.counters.partial + 1, MAX_COUNT);
      if (km.state === 'drifted') km.state = 'stable';
    }
  } else if (verdict.class === 'drift') {
    if (km.drift_window_start !== null
      && ctx.now.getTime() - Date.parse(km.drift_window_start) > cfg.driftWindowHours * 3_600_000) {
      km.drift_streak = 0;
      km.drift_window_start = null;
      km.drift_run_ids = [];
    }
    if (km.drift_window_start === null) km.drift_window_start = now;
    km.counters.drift = Math.min(km.counters.drift + 1, MAX_COUNT);
    km.drift_streak = Math.min(km.drift_streak + 1, MAX_COUNT);
    km.last_drift_at = now;
    const rid = ctx.runId !== null && RUN_ID_RE.test(ctx.runId) ? ctx.runId : ANON_RUN;
    const ids = km.drift_run_ids ?? [];
    if (!ids.includes(rid) && ids.length < MAX_RUN_IDS) ids.push(rid);
    km.drift_run_ids = ids;
    km.state = 'drifted';
    // Escalate once per streak (on crossing); halt stays asserted while the streak is at or past the limit.
    if (km.drift_streak === cfg.driftEscalateN) events.push('drift_escalate');
    // Halt needs the streak AND at least two distinct runs: one run alone (a slow load) never halts.
    if (km.drift_streak >= cfg.driftHaltN && ids.length >= Math.min(2, MAX_RUN_IDS)) events.push('drift_halt');
    learn(km, obs, now, ctx.runId, cfg, events);
  } else {
    learn(km, obs, now, ctx.runId, cfg, events);
    if (km.variants.length === 0) km.state = 'learning';
  }
  // An unknown observation that was not learned leaves no empty kind entry behind.
  if (!existed && km.variants.length === 0) { delete out.kinds[obs.kind]; out.updated_at = file.updated_at; }
  return { file: out, verdict, events };
}
