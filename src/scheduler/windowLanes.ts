// src/scheduler/windowLanes.ts
// WINDOW_LANES: comma list of scheduler lane names that go through a long-lived worker window (WindowDispatcher).
// Default empty = no lane: every lane stays on the old headless path. Nothing live consumes this yet (Phase 3 does).
const LANE_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export interface WindowLanes {
  lanes: string[];
  /** Entries that are not lane names; ignored, but the doctor can show them. */
  invalid: string[];
}

export function parseWindowLanes(env: NodeJS.ProcessEnv = process.env): WindowLanes {
  const raw = env.WINDOW_LANES ?? '';
  const lanes: string[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(',')) {
    const p = part.trim().toLowerCase();
    if (p === '') continue;
    if (!LANE_RE.test(p)) invalid.push(p.slice(0, 40));
    else if (!lanes.includes(p)) lanes.push(p);
  }
  return { lanes, invalid };
}

/** True only when the lane is listed in WINDOW_LANES. */
export function laneUsesWindow(lane: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return parseWindowLanes(env).lanes.includes(lane);
}
