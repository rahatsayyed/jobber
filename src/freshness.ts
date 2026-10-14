// Staleness and deadline handling, adapted from MadsLorentzen/ai-job-search tools/rank_state.py `sweep` (MIT, (c) 2026 Mads Lorentzen).
const DAY = 86_400_000;

export function parseIsoDay(s: string | null | undefined): number | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(s.trim());
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(t);
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t : null;
}

const today = (now: Date) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

export function ageDays(postedAt: string | null | undefined, now: Date): number | null {
  const p = parseIsoDay(postedAt);
  return p == null ? null : Math.floor((today(now) - p) / DAY);
}

/** Warning only, never a veto: a 27-month-old posting can still be live. */
export function staleFlag(postedAt: string | null | undefined, now: Date, thresholdDays = 30): string | null {
  const a = ageDays(postedAt, now);
  return a != null && a > thresholdDays ? `stale: posted ${a} days ago` : null;
}

export interface DeadlineSweep {
  expired: Array<{ job_id: string; deadline: string }>;
  closingSoon: Array<{ job_id: string; deadline: string; days_left: number }>;
  unparseable: Array<{ job_id: string; deadline: string; source: string | null }>;
}

/** True only for a plain ISO-day deadline strictly before today (UTC day); same parsing rule as classifyDeadlines. */
export function deadlinePassed(deadline: string | null | undefined, now: Date): boolean {
  if (typeof deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(deadline.trim())) return false;
  const d = parseIsoDay(deadline);
  return d != null && d < today(now);
}

export function classifyDeadlines(rows: Array<{ id: string; deadline: string; source: string | null }>, now: Date): DeadlineSweep {
  const out: DeadlineSweep = { expired: [], closingSoon: [], unparseable: [] };
  for (const r of rows) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(r.deadline.trim()) ? parseIsoDay(r.deadline) : null;
    if (d == null) { out.unparseable.push({ job_id: r.id, deadline: r.deadline, source: r.source }); continue; }
    const left = Math.round((d - today(now)) / DAY);
    if (left < 0) out.expired.push({ job_id: r.id, deadline: r.deadline });
    else if (left <= 7) out.closingSoon.push({ job_id: r.id, deadline: r.deadline, days_left: left });
  }
  return out;
}
