// Adapted from career-ops-hq/career-ops providers/breezy.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama)
// Public per-tenant feed: GET https://<slug>.breezy.hr/json -> [{ name, url, published_date, location: { name, city, state, country: { name }, is_remote } }]
// career-ops reads no description and no id; the id here is a hash of the posting URL. Discover-only.
import { assertVendorSlug, type TrackedCompany } from './filters.js';
import { boardUrl, MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, getJson } from './transport.js';
import { hasPlainAuthority, shortHash } from './util.js';
import { arr, buildJob, str } from './common.js';
import { z } from 'zod';
import { makeBoardProvider } from './provider.js';

export function locationOf(j: any): string {
  const l = j?.location;
  if (!l || typeof l !== 'object') return '';
  const country = str(l.country?.name);
  let base = str(l.name);
  if (base) { if (country && !base.toLowerCase().includes(country.toLowerCase())) base = `${base}, ${country}`; }
  else base = [str(l.city), str(l.state), country].filter(Boolean).join(', ');
  return l.is_remote && !/remote/i.test(base) ? [base, 'Remote'].filter(Boolean).join(', ') : base;
}

export function normalizeBreezy(raw: any, c: TrackedCompany, ctx: FetchCtx = {}): BoardJob[] {
  assertVendorSlug(c);
  const out: BoardJob[] = [];
  const seen = new Set<string>();
  for (const j of arr(raw).slice(0, MAX_JOBS_PER_BOARD)) {
    if (!j || typeof j !== 'object') continue;
    const title = str(j.name);
    const canonical = `https://${c.slug}.breezy.hr/`;
    if (!title || !hasPlainAuthority(j.url)) continue;
    const url = boardUrl(j.url, 'breezy.hr', canonical);
    if (url === canonical || seen.has(url)) continue;
    seen.add(url);
    const loc = locationOf(j);
    const job = buildJob({ prefix: 'bz', source: 'breezy', c, key: shortHash(url), title, url, posted: j.published_date, locations: loc ? [loc] : [], remote: j.location?.is_remote === true });
    if (job) out.push(job);
  }
  if (out.length) ctx.warn?.(`${out.length} postings have no description (the Breezy feed carries none)`);
  return out;
}

export async function fetchBreezy(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const label = `breezy ${c.slug}`;
  const raw = await getJson(`https://${c.slug}.breezy.hr/json`, label, { hosts: exactHosts(`${c.slug}.breezy.hr`) });
  if (!Array.isArray(raw)) throw new Error(`${label}: unexpected response shape (not an array)`);
  return normalizeBreezy(raw, c, ctx);
}

export const shapeSpec = z.object({ name: z.string(), url: z.string() }).passthrough();
export const provider = makeBoardProvider('breezy', fetchBreezy, shapeSpec, (r) => (Array.isArray(r[0]) ? r[0] : [r[0]]));
