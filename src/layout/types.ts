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
  shell: boolean;                         // global shell landmarks present (nav and search box)
  nonDrift: null | 'blocked' | 'logged_out' | 'unloaded';
}

// Outcome of comparing an Observation with remembered layout (used by later tasks).
export type Verdict = 'ok' | 'drift' | 'unknown' | 'non_drift';
