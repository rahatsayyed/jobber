// Adapted from career-ops-hq/career-ops providers/bamboohr.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama)
// Public per-tenant list: GET https://<slug>.bamboohr.com/careers/list -> { result: [{ id, jobOpeningName, location: { city, state }, isRemote }] }
// Detail (date): GET https://<slug>.bamboohr.com/careers/<id>/detail -> { result: { jobOpening: { datePosted, description? } } }
// career-ops reads only datePosted from the detail; the description field is an UNVERIFIED assumption here (empty description when absent).
// The list has no dates or text, so like smartrecruiters.ts the detail runs only for postings that pass the title/location prefilter, are not
// stored yet, at most `max_detail` (default 25). Discover-only. Transport refuses redirects (career-ops probed them by hand to spot dead tenants).
import { assertVendorSlug, type TrackedCompany } from './filters.js';
import { boardUrl, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, getJson } from './transport.js';
import { pastDeadline } from './util.js';
import { arr, buildJob, str } from './common.js';
import { z } from 'zod';
import { listAt, makeBoardProvider } from './provider.js';

export const BAMBOO_DEFAULT_MAX_DETAIL = 25;
const ID_RE = /^[A-Za-z0-9_-]{1,20}$/;
const host = (c: TrackedCompany): string => `${c.slug}.bamboohr.com`;

export function locationOf(j: any): string {
  const place = [str(j?.location?.city), str(j?.location?.state)].filter(Boolean).join(', ');
  return [place, j?.isRemote && !/remote/i.test(place) ? 'Remote' : ''].filter(Boolean).join(', ');
}

export async function fetchBambooHr(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const label = `bamboohr ${c.slug}`;
  const hosts = exactHosts(host(c));
  const raw = await getJson(`https://${host(c)}/careers/list`, label, { hosts });
  if (!raw || !Array.isArray(raw.result)) throw new Error(`${label}: unexpected response shape (no result array)`);
  const titleOk = ctx.titleOk ?? (() => true);
  const prefilter = ctx.prefilter ?? (() => true);
  const wanted = arr(raw.result).slice(0, 2000)
    .filter((j) => j && ID_RE.test(String(j.id ?? '')) && str(j.jobOpeningName))
    .map((j) => ({ id: String(j.id), title: str(j.jobOpeningName), loc: locationOf(j), remote: j.isRemote === true }))
    .filter((k) => titleOk(k.title) && prefilter(k.title, [k.loc], k.remote) && !ctx.isKnown?.(`bh:${c.slug}:${k.id}`));
  const maxDetail = c.max_detail ?? BAMBOO_DEFAULT_MAX_DETAIL;
  const queue = wanted.slice(0, maxDetail);
  const out: BoardJob[] = [];
  let failed = 0, skippedForTime = 0;
  for (let i = 0; i < queue.length; i++) {
    if (pastDeadline(ctx.deadlineAt)) { skippedForTime = queue.length - i; break; }
    const k = queue[i];
    let opening: any = null;
    try { opening = (await getJson(`https://${host(c)}/careers/${k.id}/detail`, label, { hosts }))?.result?.jobOpening; } catch { failed++; }
    const canonical = `https://${host(c)}/careers/${k.id}`;
    const job = buildJob({
      prefix: 'bh', source: 'bamboohr', c, key: k.id, title: k.title, url: boardUrl(canonical, 'bamboohr.com', canonical),
      description: typeof opening?.description === 'string' ? opening.description : '', posted: opening?.datePosted, locations: k.loc ? [k.loc] : [], remote: k.remote,
    });
    if (job) out.push(job);
  }
  const notes: string[] = [];
  if (failed) notes.push(`${failed} detail request(s) failed (posted date and description missing)`);
  const deferred = Math.max(0, wanted.length - queue.length) + skippedForTime;
  if (deferred) notes.push(`${deferred} posting(s) deferred to the next run (max_detail ${maxDetail} or time budget)`);
  if (out.length && out.every((j) => !j.description)) notes.push('no posting had a description (detail fields changed?)');
  if (notes.length) ctx.warn?.(`partial: ${raw.result.length} listed, ${out.length} returned; ${notes.join('; ')}`);
  return out;
}

export const shapeSpec = z.object({ id: z.union([z.number(), z.string()]), jobOpeningName: z.string() }).passthrough();
export const provider = makeBoardProvider('bamboohr', fetchBambooHr, shapeSpec, (r) => listAt(r[0], 'result'));
