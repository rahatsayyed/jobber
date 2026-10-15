// Shared contracts for layout memory (plan 8B). Pure types, no I/O.
export type Platform = 'linkedin' | 'naukri';
export type KindId = string;      // member of KINDS[platform]
export type LandmarkId = string;  // member of LANDMARKS[platform]

// What a snapshot looks like, reduced to a closed vocabulary. It never carries page text.
export interface Observation {
  platform: Platform;
  kind: KindId;                           // from classifyUrl (LinkedIn) or url path (Naukri)
  landmarks: LandmarkId[];                // sorted, unique, closed vocabulary
  counts: Record<string, number>;         // bucketed (0,1,2-3,4-7,8+ => 0..4), keys from COUNT_KEYS
  shell: boolean;                         // page loaded as a known non-auth app kind (proxy; Task 5 may refine it with structure counts)
  nonDrift: null | 'blocked' | 'logged_out' | 'unloaded';
}

// Persisted layout memory. Every string is a vocabulary id, an ISO date or a run id.
export interface Recipe {
  action: 'click' | 'type' | 'scroll';
  label: string;            // ACTION_LABELS id, e.g. 'action:more'
  how: 'text' | 'role_name' | 'ordinal';
  ordinal?: number;         // 0..9
  region?: LandmarkId;
  v: number;                // recipe version, bumped when the variant is re-promoted
  ok: number; fail: number; last_ok: string | null;  // ISO
}
export interface Variant {
  id: string;               // sha256(sorted landmarks + counts shape).slice(0,12)
  landmarks: LandmarkId[];
  counts: Record<string, [number, number]>;  // observed bucket min,max
  recipes: Recipe[];
  first_seen: string; last_verified: string | null;
  obs: number; runs: number;                 // observations, distinct run ids
  run_ids: string[];                         // at most 5 most recent
  promoted: boolean;
  ok: number; fail: number;
}
export interface KindMemory {
  state: 'learning' | 'stable' | 'stale' | 'drifted';
  variants: Variant[];                       // max 3
  counters: { match: number; partial: number; drift: number };
  drift_streak: number; drift_window_start: string | null; last_drift_at: string | null;
}
// Result of comparing an Observation with stored layout memory (see classify.ts).
export type Verdict =
  | { class: 'match' | 'partial' | 'drift' | 'unknown'; score: number; missing: LandmarkId[]; variant: string | null }
  | { class: 'blocked' | 'logged_out' | 'unloaded' };
export interface LayoutFile { schema: 1; platform: Platform; updated_at: string; kinds: Record<KindId, KindMemory> }
