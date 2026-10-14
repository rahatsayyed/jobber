// file: src/patterns.ts
// Outcome breakdowns adapted from career-ops-hq/career-ops analyze-patterns.mjs (MIT, (c) 2026 Santiago Fernandez de
// Valderrama): minimum 5 contacted before any analysis, sufficientSample n >= 8, "avoid" needs 0 positives over >= 2 decided.
import type BetterSqlite3 from 'better-sqlite3';
import { detect as greenhouse } from './ats/greenhouse.js';
import { detect as lever } from './ats/lever.js';
import { detect as workday } from './ats/workday.js';
import { detect as ashby } from './ats/ashby.js';

export interface Bucket { key: string; n: number; positive: number; negative: number; pending: number; conversion: number | null; decided: number | null; sufficient: boolean; note: string | null }
type Dim = 'score_band' | 'ats_vendor' | 'remote' | 'seniority' | 'source';
export interface Patterns { contacted: number; insufficient: boolean; message: string | null; by: Record<Dim, Bucket[]> }

export function scoreBand(score: number | null): string {
  if (score == null) return 'unscored';
  if (score < 60) return '<60';
  if (score < 70) return '60-69';
  if (score < 80) return '70-79';
  return '80+';
}

export function atsVendor(applyUrl: string | null): string {
  if (!applyUrl) return 'none';
  for (const d of [greenhouse, lever, workday, ashby]) {
    const p = d(applyUrl);
    if (p) return p;
  }
  try {
    const h = new URL(applyUrl).hostname.toLowerCase();
    if (h === 'linkedin.com' || h.endsWith('.linkedin.com')) return 'linkedin';
    if (h === 'naukri.com' || h.endsWith('.naukri.com')) return 'naukri';
  } catch { return 'other'; }
  return 'other';
}

export function remoteBucket(text: string): 'remote-global' | 'remote-restricted' | 'hybrid' | 'onsite' | 'unknown' {
  const t = String(text ?? '');
  if (/\bhybrid\b|\b\d\s*days? (?:a week )?in (?:the |our )?office\b/i.test(t)) return 'hybrid';
  if (/\bremote\b[^.]{0,40}\b(?:us|usa|uk|eu|europe|emea|canada|americas)\s*(?:only|based)\b|\bmust (?:reside|be located|live) in\b/i.test(t)) return 'remote-restricted';
  if (/\bremote\b|\bwork from (?:anywhere|home)\b|\bdistributed team\b/i.test(t)) return 'remote-global';
  if (/\bon[\s-]?site\b|\bin[\s-]office\b|\boffice[\s-]based\b/i.test(t)) return 'onsite';
  return 'unknown';
}

export function seniority(title: string): 'junior' | 'mid' | 'senior' | 'lead+' {
  const t = String(title ?? '').toLowerCase();
  if (/\b(?:lead|staff|principal|architect|head|manager|director)\b/.test(t)) return 'lead+';
  if (/\b(?:senior|sr)\b\.?/.test(t)) return 'senior';
  if (/\b(?:junior|jr|intern|trainee|graduate|fresher)\b\.?/.test(t)) return 'junior';
  return 'mid';
}

const POS = ['replied', 'interview', 'offer', 'hired'];
const NEG = ['rejected', 'no_response'];
const r3 = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);

export function patternStats(db: BetterSqlite3.Database, opts: { minContacted?: number; minBucket?: number } = {}): Patterns {
  const minContacted = opts.minContacted ?? 5;
  const minBucket = opts.minBucket ?? 8;
  const rows = db.prepare(`
    WITH contacted AS (
      SELECT job_id FROM outreach_queue WHERE email_status = 'sent' OR connect_status = 'sent'
      UNION SELECT job_id FROM applications WHERE status = 'submitted'
      UNION SELECT job_id FROM outreach WHERE status = 'sent'
    )
    SELECT c.job_id AS id, j.id IS NOT NULL AS known, j.score, j.apply_url, j.source, coalesce(j.title, '') AS title, coalesce(j.description, '') AS description,
           (SELECT o.outcome FROM job_outcomes o WHERE o.job_id = c.job_id ORDER BY o.id DESC LIMIT 1) AS outcome
    FROM contacted c LEFT JOIN jobs j ON j.id = c.job_id`).all() as Array<{ id: string; known: number; score: number | null; apply_url: string | null; source: string | null; title: string; description: string; outcome: string | null }>;
  const empty = { score_band: [], ats_vendor: [], remote: [], seniority: [], source: [] } as Record<Dim, Bucket[]>;
  if (rows.length < minContacted) {
    return { contacted: rows.length, insufficient: true, message: `Need at least ${minContacted} contacted jobs before patterns mean anything (have ${rows.length}).`, by: empty };
  }
  const keyOf: Record<Dim, (r: (typeof rows)[number]) => string> = {
    score_band: (r) => scoreBand(r.score),
    ats_vendor: (r) => atsVendor(r.apply_url),
    remote: (r) => remoteBucket(`${r.title}\n${r.description}`),
    seniority: (r) => seniority(r.title),
    source: (r) => r.source ?? 'unknown',
  };
  const by = {} as Record<Dim, Bucket[]>;
  for (const dim of Object.keys(keyOf) as Dim[]) {
    const m = new Map<string, Bucket>();
    for (const r of rows) {
      // A contacted job without a jobs row is still counted (same contacted set as the funnel), in an 'unknown' bucket on every dimension.
      const k = r.known ? keyOf[dim](r) : 'unknown';
      const b = m.get(k) ?? { key: k, n: 0, positive: 0, negative: 0, pending: 0, conversion: null, decided: null, sufficient: false, note: null };
      b.n++;
      if (r.outcome && POS.includes(r.outcome)) b.positive++;
      else if (r.outcome && NEG.includes(r.outcome)) b.negative++;
      else b.pending++;
      m.set(k, b);
    }
    const buckets = [...m.values()].map((b) => ({ ...b, conversion: r3(b.positive, b.n), decided: r3(b.positive, b.positive + b.negative), sufficient: b.n >= minBucket }));
    const best = Math.max(-1, ...buckets.filter((b) => b.sufficient && b.decided != null).map((b) => b.decided as number));
    for (const b of buckets) {
      if (b.sufficient && b.positive + b.negative >= 2 && b.positive === 0) b.note = 'avoid?';
      else if (b.sufficient && b.positive >= 2 && b.decided === best) b.note = 'strong';
    }
    by[dim] = buckets.sort((a, b) => a.key.localeCompare(b.key));
  }
  return { contacted: rows.length, insufficient: false, message: null, by };
}
