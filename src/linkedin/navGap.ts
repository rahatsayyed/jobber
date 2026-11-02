// Per-navigation pacing for the LinkedIn session: a random pause before every page navigation to linkedin.com after the
// first one of the process (LINKEDIN_NAV_GAP_MIN_SEC / LINKEDIN_NAV_GAP_MAX_SEC, default 4 and 9 seconds, 0 and 0 turn it
// off). One instance is shared by the runtime and the engine so both navigation paths count as one sequence. Clicks and
// scrolls on the same page are never delayed.
export const DEFAULT_NAV_GAP_MIN_SEC = 4;
export const DEFAULT_NAV_GAP_MAX_SEC = 9;

export interface NavGap { before(): Promise<void> }

function sec(raw: string | undefined, dflt: number): number {
  if (raw === undefined || raw.trim() === '') return dflt;
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return dflt;
  const n = Number(s);
  return n <= 600 ? n : dflt;
}

export function loadNavGapRange(env: NodeJS.ProcessEnv = process.env): { minMs: number; maxMs: number } {
  const lo = sec(env.LINKEDIN_NAV_GAP_MIN_SEC, DEFAULT_NAV_GAP_MIN_SEC);
  const hi = Math.max(lo, sec(env.LINKEDIN_NAV_GAP_MAX_SEC, DEFAULT_NAV_GAP_MAX_SEC));
  return { minMs: lo * 1000, maxMs: hi * 1000 };
}

export function createNavGap(o: {
  env?: NodeJS.ProcessEnv; sleep?: (ms: number) => Promise<void>; random?: () => number;
} = {}): NavGap {
  const env = o.env ?? process.env;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const random = o.random ?? Math.random;
  const { minMs, maxMs } = loadNavGapRange(env);
  // Under the test runner an env that does not name the knobs means no pause, so no test waits for real seconds.
  const off = maxMs === 0 || (process.env.VITEST !== undefined && !o.sleep
    && env.LINKEDIN_NAV_GAP_MIN_SEC === undefined && env.LINKEDIN_NAV_GAP_MAX_SEC === undefined);
  let navs = 0;
  return {
    async before() {
      const first = navs === 0;
      navs += 1;
      if (first || off) return;
      await sleep(minMs + Math.floor(random() * (maxMs - minMs + 1)));
    },
  };
}
