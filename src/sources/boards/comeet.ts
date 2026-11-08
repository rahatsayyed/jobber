// Adapted from career-ops-hq/career-ops providers/comeet.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama)
// Public careers API: GET https://www.comeet.co/careers-api/2.0/company/<uid>/positions?token=<token>
//   -> [{ uid, name, location: { name, is_remote }, url_active_page, url_comeet_hosted_page, time_updated, details: [{ value }] }]
// <uid> and <token> are per tenant and cannot be derived from a careers URL: they go in the entry's params ({ uid, token }), copied from the
// company's public careers page. The token is never logged (labels carry only the slug). `details[].value` as the description is an UNVERIFIED
// assumption (career-ops reads no description). The job URL is kept only on comeet.co (Safety rule 8): the company-domain careers page of
// url_active_page is not used, the Comeet-hosted page is. Discover-only.
import { assertVendorSlug, type TrackedCompany } from './filters.js';
import { boardUrl, MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, getJson } from './transport.js';
import { hasPlainAuthority, shortHash } from './util.js';
import { arr, buildJob, str } from './common.js';
import { paramsOf } from './vendorParams.js';
import { z } from 'zod';
import { makeBoardProvider } from './provider.js';

export function normalizeComeet(raw: any, c: TrackedCompany, ctx: FetchCtx = {}): BoardJob[] {
  assertVendorSlug(c);
  const out: BoardJob[] = [];
  const canonical = `https://www.comeet.co/jobs/${encodeURIComponent(c.slug)}/${encodeURIComponent(paramsOf(c).uid ?? '')}`;
  let noDescription = 0;
  for (const j of arr(raw).slice(0, MAX_JOBS_PER_BOARD)) {
    if (!j || typeof j !== 'object') continue;
    const title = str(j.name);
    if (!title) continue;
    let url = boardUrl(hasPlainAuthority(j.url_comeet_hosted_page) ? j.url_comeet_hosted_page : undefined, 'comeet.co', canonical);
    if (url === canonical) url = boardUrl(hasPlainAuthority(j.url_active_page) ? j.url_active_page : undefined, 'comeet.co', canonical);
    const rawKey = str(j.uid) || shortHash(`${str(j.url_active_page)}|${str(j.url_comeet_hosted_page)}|${title}`);
    const loc = str(j.location?.name);
    const description = arr(j.details).map((d: any) => (typeof d?.value === 'string' ? d.value : '')).filter(Boolean).join('\n');
    const job = buildJob({
      prefix: 'cm', source: 'comeet', c, key: rawKey.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || shortHash(title), title, url, description,
      posted: typeof j.time_updated === 'string' ? j.time_updated : undefined, locations: loc ? [loc] : [], remote: j.location?.is_remote === true,
    });
    if (job) { out.push(job); if (!job.description) noDescription++; }
  }
  if (noDescription) ctx.warn?.(`${noDescription} of ${out.length} postings had no description (positions fields changed?)`);
  return out;
}

export async function fetchComeet(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const { uid, token } = paramsOf(c);
  const label = `comeet ${c.slug}`;
  if (!uid || !token) throw new Error(`${label}: needs params.uid and params.token`);
  const raw = await getJson(`https://www.comeet.co/careers-api/2.0/company/${encodeURIComponent(uid)}/positions?token=${encodeURIComponent(token)}`, label, { hosts: exactHosts('www.comeet.co') });
  if (!Array.isArray(raw)) throw new Error(`${label}: unexpected response shape (not an array)`);
  return normalizeComeet(raw, c, ctx);
}

export const shapeSpec = z.object({ name: z.string() }).passthrough();
export const provider = makeBoardProvider('comeet', fetchComeet, shapeSpec, (r) => (Array.isArray(r[0]) ? r[0] : [r[0]]));
