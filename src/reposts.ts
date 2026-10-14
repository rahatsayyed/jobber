// file: src/reposts.ts
// Adapted from career-ops-hq/career-ops detect-reposts.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama). See that repo's LICENSE.
// Change: we count only same-source re-listings (all our sources are aggregators; cross-board copies are not reposts).
const LEGAL = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'pvt', 'private', 'plc', 'gmbh', 'corp', 'corporation', 'co', 'company', 'llp', 'ag', 'sa', 'bv']);
const STOP = new Set(['the', 'a', 'an']);
const DAY = 86_400_000;

const fold = (s: string | null | undefined) => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** Legal words are stripped only as TRAILING suffix tokens ("Acme Pvt Ltd" -> "acme"); "SA Power Networks" and "The Company" keep theirs. */
export function companyKey(name: string | null | undefined): string {
  const tokens = fold(name).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (tokens.length > 1 && LEGAL.has(tokens[tokens.length - 1]) && !tokens.slice(0, -1).every((t) => STOP.has(t))) tokens.pop();
  return tokens.join(' ');
}

export function titleIdentityKey(title: string | null | undefined): string {
  return [...new Set(fold(title).replace(/[^a-z0-9+#]+/g, ' ').split(' ').filter(Boolean))].sort().join(' ');
}

export interface PostingRow { id: string; source: string | null; company: string | null; title: string | null; url: string | null; first_seen: string }

/** UTC ms at day start for 'YYYY-MM-DD[ T]...'; null for invalid calendar dates. */
function dayOf(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? ''));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(t);
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t : null;
}

/** Distinct other URLs for the same source+company+title first seen 1..90 days away from the target. */
export function repostCount(target: PostingRow, others: PostingRow[], windowDays = 90, minSpanDays = 1): number {
  const t = dayOf(target.first_seen);
  const ck = companyKey(target.company);
  const tk = titleIdentityKey(target.title);
  if (t == null || !ck || !tk) return 0;
  const urls = new Set<string>();
  for (const o of others) {
    if (o.id === target.id || o.source !== target.source) continue;
    if (companyKey(o.company) !== ck || titleIdentityKey(o.title) !== tk) continue;
    if (!o.url || o.url === target.url) continue;
    const d = dayOf(o.first_seen);
    if (d == null) continue;
    const span = Math.abs(t - d) / DAY;
    if (span < minSpanDays || span > windowDays) continue;
    urls.add(o.url);
  }
  return urls.size;
}
