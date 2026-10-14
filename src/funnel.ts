// Adapted from MadsLorentzen/ai-job-search /html-report (MIT, (c) 2026 Mads Lorentzen): stage-history funnel, with benchmark
// context from career-ops-hq/career-ops templates/benchmarks.yml (MIT, (c) 2026 Santiago Fernandez de Valderrama).
import type BetterSqlite3 from 'better-sqlite3';

export const BENCHMARKS = {
  response_rate: { typical: 0.03, low: 0.02, high: 0.13 },
  interview_rate: { typical: 0.03, low: 0.02, high: 0.04 },
  first_response_days: { typical: 7, low: 5, high: 14 },
  source: 'career-ops templates/benchmarks.yml (industry context only, not a target)',
};

export interface Funnel {
  threshold: number; discovered: number; matched: number; contacted: number; replied: number; interview: number; offer: number;
  rates: { match: number | null; reply: number | null; interview: number | null; rejection: number | null };
  first_response_days_median: number | null;
  benchmarks: typeof BENCHMARKS;
}

const CONTACTED = `
  SELECT job_id FROM outreach_queue WHERE email_status = 'sent' OR connect_status = 'sent'
  UNION SELECT job_id FROM applications WHERE status = 'submitted'
  UNION SELECT job_id FROM outreach WHERE status = 'sent'`;
const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);
const count = (db: BetterSqlite3.Database, sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;

const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = (x: number | null) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const p100 = (x: number) => Math.round(x * 100); // 0.13 * 100 is 13.000000000000002 in floating point

export function renderFunnelHtml(f: Funnel, generatedAt: string): string {
  const stages: Array<[string, number, string]> = [
    ['Discovered', f.discovered, ''],
    ['Matched', f.matched, ` (score >= ${f.threshold}; ${pct(f.rates.match)} of discovered)`],
    ['Contacted', f.contacted, ''],
    ['Replied', f.replied, ` (${pct(f.rates.reply)} of contacted; typical ${p100(f.benchmarks.response_rate.typical)}%, range ${p100(f.benchmarks.response_rate.low)}-${p100(f.benchmarks.response_rate.high)}%)`],
    ['Interview', f.interview, ` (${pct(f.rates.interview)} of contacted; typical ${p100(f.benchmarks.interview_rate.typical)}%)`],
    ['Offer', f.offer, ''],
  ];
  const max = Math.max(1, ...stages.map((s) => s[1]));
  const bars = stages.map(([label, n, note], i) => {
    const w = Math.round((n / max) * 560);
    return `<g transform="translate(0,${i * 44})"><rect x="0" y="0" width="${Math.max(w, 2)}" height="28" rx="4" fill="#4c6ef5"></rect>` +
      `<text x="${Math.max(w, 2) + 8}" y="19" font-size="14">${esc(`${label}: ${n}${note}`)}</text></g>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Jobber funnel</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;color:#222;background:#fff}svg{max-width:100%;height:auto}p{color:#555}</style></head><body>
<h1>Jobber funnel</h1><p>Generated ${esc(generatedAt)}. Counts are per job; a stage counts if the job ever reached it.</p>
<svg viewBox="0 0 1100 ${stages.length * 44}" role="img" aria-label="funnel">${bars}</svg>
<p>Rejection rate (rejected + no response, of finished jobs): ${esc(pct(f.rates.rejection))}. Median days to first response: ${esc(f.first_response_days_median ?? 'n/a')} (typical ${f.benchmarks.first_response_days.typical}).</p>
<p>Benchmarks: ${esc(f.benchmarks.source)}.</p></body></html>`;
}

export function funnelStats(db: BetterSqlite3.Database, threshold = 60): Funnel {
  const discovered = count(db, 'SELECT COUNT(*) AS n FROM jobs');
  // Plan 2: an excluded job (veto, deadline, hard stop) never proceeded, so it is not "matched", unless we already contacted it
  // (an emailed job keeps counting, otherwise `contacted` could exceed `matched`).
  const matched = count(db, `SELECT COUNT(*) AS n FROM jobs WHERE score >= ? AND (excluded_reason IS NULL OR id IN (${CONTACTED}))`, threshold);
  const contacted = count(db, `SELECT COUNT(*) AS n FROM (${CONTACTED})`);
  // Only contacted jobs count as replied/interview/offer (an outcome typed for a never-contacted job id must not push a rate above 1).
  const ever = (outcomes: string[]) => count(db, `SELECT COUNT(DISTINCT job_id) AS n FROM job_outcomes WHERE outcome IN (${outcomes.map(() => '?').join(',')}) AND job_id IN (${CONTACTED})`, ...outcomes);
  const replied = ever(['replied', 'interview', 'offer', 'hired', 'rejected']);
  const interview = ever(['interview', 'offer', 'hired']);
  const offer = ever(['offer', 'hired']);
  const latest = db.prepare(`SELECT o.outcome FROM job_outcomes o WHERE o.id = (SELECT MAX(id) FROM job_outcomes WHERE job_id = o.job_id)`).all() as { outcome: string }[];
  const finals = latest.filter((r) => ['hired', 'rejected', 'no_response'].includes(r.outcome)).length;
  const rejections = latest.filter((r) => ['rejected', 'no_response'].includes(r.outcome)).length;
  // First response time: the stored REPLY date of an approved or auto-recorded reply when we have it (so it does not depend on how
  // often /checkreplies runs), else the time the outcome was recorded. Actions verified against src/replyTriage.ts: 'recorded'
  // (auto-recorded) and 'approved' (user-approved proposal).
  const gaps = (db.prepare(`
    WITH resp AS (SELECT job_id, MIN(reply_date) AS t FROM processed_messages WHERE reply_date IS NOT NULL AND action IN ('recorded', 'approved') GROUP BY job_id),
         fallback AS (SELECT job_id, MIN(created_at) AS t FROM job_outcomes WHERE outcome IN ('replied', 'interview', 'offer', 'hired', 'rejected') GROUP BY job_id),
         sent AS (SELECT job_id, MIN(email_sent_at) AS t FROM outreach_queue WHERE email_sent_at IS NOT NULL GROUP BY job_id)
    SELECT julianday(coalesce(r.t, f.t)) - julianday(s.t) AS d
    FROM fallback f LEFT JOIN resp r ON r.job_id = f.job_id JOIN sent s ON s.job_id = f.job_id`).all() as { d: number }[]).map((r) => r.d).filter((d) => d >= 0).sort((a, b) => a - b);
  const median = gaps.length ? Math.round(gaps.length % 2 ? gaps[(gaps.length - 1) / 2] : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2) : null;
  return {
    threshold, discovered, matched, contacted, replied, interview, offer,
    rates: { match: rate(matched, discovered), reply: rate(replied, contacted), interview: rate(interview, contacted), rejection: rate(rejections, finals) },
    first_response_days_median: median,
    benchmarks: BENCHMARKS,
  };
}
