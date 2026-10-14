import type { Outcome } from './db.js';

const RESOLVED: Outcome[] = ['interview', 'offer', 'hired', 'rejected', 'no_response'];
const POSITIVE: Outcome[] = ['interview', 'offer', 'hired'];
// Half-open bands [lo, hi) so fractional scores (69.5) land in 60-69 rather than falling in a gap.
const BANDS = [{ label: '60-69', lo: 60, hi: 70 }, { label: '70-79', lo: 70, hi: 80 }, { label: '80+', lo: 80, hi: Infinity }];

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
