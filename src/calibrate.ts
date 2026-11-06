import type { Outcome } from './db.js';

const RESOLVED: Outcome[] = ['interview', 'offer', 'hired', 'rejected', 'no_response'];
const POSITIVE: Outcome[] = ['interview', 'offer', 'hired'];
// Half-open bands [lo, hi) on the stored 1..5 score, so the career-ops lines (3.5, 4.0, 4.5) start a band and one-decimal scores never fall in a gap.
export const SCORE_BANDS = [
  { label: '<3.0', lo: -Infinity, hi: 3.0 }, { label: '3.0-3.4', lo: 3.0, hi: 3.5 }, { label: '3.5-3.9', lo: 3.5, hi: 4.0 },
  { label: '4.0-4.4', lo: 4.0, hi: 4.5 }, { label: '4.5+', lo: 4.5, hi: Infinity },
];
const BANDS = SCORE_BANDS;

export function calibrate(rows: { score: number; outcome: Outcome }[], minN = 5) {
  const resolved = rows.filter(r => RESOLVED.includes(r.outcome));
  const bands = BANDS.map(b => {
    const inBand = resolved.filter(r => r.score >= b.lo && r.score < b.hi);
    const n = inBand.length;
    const rate = n >= minN ? Math.round((100 * inBand.filter(r => POSITIVE.includes(r.outcome)).length) / n) : null;
    return { label: b.label, n, interviewRate: rate };
  });
  const rated = bands.filter(b => b.interviewRate !== null);
  let verdict = `Not enough data: need at least ${minN} resolved jobs in two score bands.`;
  if (rated.length >= 2) {
    const gap = rated[rated.length - 1].interviewRate! - rated[0].interviewRate!;
    verdict = gap >= 10 ? `Scores predict outcomes (top band beats bottom by ${gap} points).` : `Scores do not clearly predict outcomes (gap ${gap} points). Review the match rubric.`;
  }
  return { bands, verdict };
}
