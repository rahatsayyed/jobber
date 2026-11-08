// Adapted from career-ops-hq/career-ops providers/pinpoint.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama)
// Public per-tenant feed: GET https://<slug>.pinpointhq.com/postings.json -> { data: [{ id, title, url, location: { name, city, province }, description }] }
// Abandoned Pinpoint tenants return canned demo postings (a fixed YouTube embed in the description): those are dropped, so such a tenant reads as empty.
// Description (HTML) is used when present; career-ops reads it only for the demo check. Discover-only.
import { assertVendorSlug, type TrackedCompany } from './filters.js';
import { boardUrl, MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, getJson } from './transport.js';
import { hasPlainAuthority, shortHash } from './util.js';
import { arr, buildJob, str } from './common.js';
import { z } from 'zod';
import { listAt, makeBoardProvider } from './provider.js';

const DEMO_MARKER = 'youtube.com/embed/pFxm6fszrpw';

export function normalizePinpoint(raw: any, c: TrackedCompany, ctx: FetchCtx = {}): BoardJob[] {
  assertVendorSlug(c);
  const out: BoardJob[] = [];
  const canonical = `https://${c.slug}.pinpointhq.com/`;
  let noDescription = 0;
  for (const j of arr(raw?.data).slice(0, MAX_JOBS_PER_BOARD)) {
    if (!j || typeof j !== 'object') continue;
    const title = str(j.title);
    const description = typeof j.description === 'string' ? j.description : '';
    if (!title || !hasPlainAuthority(j.url) || description.includes(DEMO_MARKER)) continue;
    const url = boardUrl(j.url, 'pinpointhq.com', canonical);
    if (url === canonical) continue;
    const l = j.location ?? {};
    const loc = str(l.name) || [str(l.city), str(l.province)].filter(Boolean).join(', ');
    const key = typeof j.id === 'string' || Number.isSafeInteger(j.id) ? String(j.id) : shortHash(url);
    const job = buildJob({ prefix: 'pp', source: 'pinpoint', c, key: key.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || shortHash(url), title, url, description, locations: loc ? [loc] : [] });
    if (job) { out.push(job); if (!job.description) noDescription++; }
  }
  if (noDescription) ctx.warn?.(`${noDescription} of ${out.length} postings had no description (postings.json fields changed?)`);
  return out;
}

export async function fetchPinpoint(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const label = `pinpoint ${c.slug}`;
  const raw = await getJson(`https://${c.slug}.pinpointhq.com/postings.json`, label, { hosts: exactHosts(`${c.slug}.pinpointhq.com`) });
  if (!raw || !Array.isArray(raw.data)) throw new Error(`${label}: unexpected response shape (no data array)`);
  return normalizePinpoint(raw, c, ctx);
}

export const shapeSpec = z.object({ title: z.string() }).passthrough();
export const provider = makeBoardProvider('pinpoint', fetchPinpoint, shapeSpec, (r) => listAt(r[0], 'data'));
