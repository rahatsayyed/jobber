// Adapted from career-ops-hq/career-ops providers/gem.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama)
// Gem boards (https://jobs.gem.com/<boardId>) are a single-page app on a public GraphQL batch endpoint:
//   POST https://jobs.gem.com/api/public/graphql/batch   (header "batch: true", body = array of operations, answer = array of results)
//   list:   JobBoardList($boardId)            -> [0].data.oatsExternalJobPostings.jobPostings[{ id, extId, title, locations[{ name, city, isoCountry, isRemote }], job }]
//   detail: ExternalJobPostingQuery($boardId, $extId) -> .data.oatsExternalJobPosting { extId, firstPublishedTsSec, descriptionHtml, jobPostSectionHtml { introHtml, outroHtml }, compensationHtml }
// The GraphQL query TEXT is rebuilt here from the field names career-ops reads (UNVERIFIED against the live API). The detail is one batched POST for the
// postings that pass the prefilter (at most `max_detail`, default 25); if it fails the listing is still returned without dates and text.
// The REST variant of career-ops (api.gem.com, pinned per entry) is not ported. The job URL is https://jobs.gem.com/<boardId>/<extId>. Discover-only.
import { assertVendorSlug, type TrackedCompany } from './filters.js';
import { boardUrl, MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, postJson } from './transport.js';
import { arr, buildJob, str } from './common.js';
import { z } from 'zod';
import { makeBoardProvider } from './provider.js';

const ENDPOINT = 'https://jobs.gem.com/api/public/graphql/batch';
const HOSTS = exactHosts('jobs.gem.com');
export const GEM_DEFAULT_MAX_DETAIL = 25;
const EXT_ID_RE = /^[A-Za-z0-9_=-]{1,100}$/;

export const LIST_QUERY = 'query JobBoardList($boardId: String!) { oatsExternalJobPostings(boardId: $boardId) { jobPostings { id extId title locations { id name city isoCountry isRemote extId } job { id locationType employmentType department { id name extId } } } } }';
export const DETAIL_QUERY = 'query ExternalJobPostingQuery($boardId: String!, $extId: String!) { oatsExternalJobPosting(boardId: $boardId, extId: $extId) { extId firstPublishedTsSec descriptionHtml jobPostSectionHtml { introHtml outroHtml } compensationHtml } }';

let regions: Intl.DisplayNames | null = null;
/** Gem gives ISO country codes only; expand so location filters can match ("IN" -> "India"). */
export function countryName(code: unknown): string {
  const k = str(code).toUpperCase();
  if (!/^[A-Z]{2}$/.test(k)) return '';
  try { regions ??= new Intl.DisplayNames(['en'], { type: 'region' }); return regions.of(k) ?? k; } catch { return k; }
}

export function placesOf(p: any): { places: string[]; remote: boolean } {
  const locs = arr(p?.locations);
  const places = locs.map((l: any) => {
    const named = str(l?.name);
    const country = countryName(l?.isoCountry);
    const base = named || [str(l?.city), country].filter(Boolean).join(', ');
    const full = country && base && !base.toLowerCase().includes(country.toLowerCase()) ? `${base}, ${country}` : base;
    return l?.isRemote && !/remote/i.test(full) ? [full, 'Remote'].filter(Boolean).join(', ') : full;
  }).filter(Boolean);
  const remote = locs.some((l: any) => l?.isRemote === true) || str(p?.job?.locationType).toLowerCase() === 'remote';
  return { places, remote };
}

export function descriptionOf(d: any): string {
  if (!d || typeof d !== 'object') return '';
  const parts = [d.jobPostSectionHtml?.introHtml, d.descriptionHtml, d.jobPostSectionHtml?.outroHtml].filter((x): x is string => typeof x === 'string' && !!x.trim());
  if (typeof d.compensationHtml === 'string' && d.compensationHtml.trim()) parts.push(`Compensation: ${d.compensationHtml}`);
  return parts.join('\n');
}

export async function fetchGem(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const label = `gem ${c.slug}`;
  const opts = { hosts: HOSTS, headers: { batch: 'true' } };
  const listed = await postJson(ENDPOINT, [{ operationName: 'JobBoardList', variables: { boardId: c.slug }, query: LIST_QUERY }], label, opts);
  const postings = listed?.[0]?.data?.oatsExternalJobPostings?.jobPostings;
  if (!Array.isArray(listed) || !Array.isArray(postings)) throw new Error(`${label}: unexpected response shape (no jobPostings array)`);
  const titleOk = ctx.titleOk ?? (() => true);
  const prefilter = ctx.prefilter ?? (() => true);
  const wanted = postings.slice(0, MAX_JOBS_PER_BOARD).flatMap((p: any) => {
    const extId = str(p?.extId);
    const title = str(p?.title);
    if (!EXT_ID_RE.test(extId) || !title) return [];
    const { places, remote } = placesOf(p);
    if (!titleOk(title) || !prefilter(title, places, remote) || ctx.isKnown?.(`gm:${c.slug}:${extId}`)) return [];
    return [{ extId, title, places, remote }];
  });
  const maxDetail = c.max_detail ?? GEM_DEFAULT_MAX_DETAIL;
  const queue = wanted.slice(0, maxDetail);
  const details = new Map<string, any>();
  let detailFailed = false;
  for (let i = 0; i < queue.length; i += 10) {
    const chunk = queue.slice(i, i + 10);
    try {
      const res = await postJson(ENDPOINT, chunk.map((k) => ({ operationName: 'ExternalJobPostingQuery', variables: { boardId: c.slug, extId: k.extId }, query: DETAIL_QUERY })), label, opts);
      chunk.forEach((k, n) => { const d = res?.[n]?.data?.oatsExternalJobPosting; if (d) details.set(k.extId, d); });
    } catch { detailFailed = true; }
  }
  const out: BoardJob[] = [];
  for (const k of queue) {
    const d = details.get(k.extId);
    const canonical = `https://jobs.gem.com/${c.slug}/${k.extId}`;
    const job = buildJob({
      prefix: 'gm', source: 'gem', c, key: k.extId, title: k.title, url: boardUrl(canonical, 'gem.com', canonical),
      description: descriptionOf(d), posted: typeof d?.firstPublishedTsSec === 'number' ? d.firstPublishedTsSec : undefined, locations: k.places, remote: k.remote,
    });
    if (job) out.push(job);
  }
  const notes: string[] = [];
  if (detailFailed) notes.push('a detail request failed (dates and text missing for some postings)');
  const deferred = Math.max(0, wanted.length - queue.length);
  if (deferred) notes.push(`${deferred} posting(s) deferred to the next run (max_detail ${maxDetail})`);
  if (notes.length) ctx.warn?.(`partial: ${postings.length} listed, ${out.length} returned; ${notes.join('; ')}`);
  return out;
}

export const shapeSpec = z.object({ extId: z.string(), title: z.string() }).passthrough();
export const provider = makeBoardProvider('gem', fetchGem, shapeSpec, (r) => {
  const list = (r[0] as any)?.[0]?.data?.oatsExternalJobPostings?.jobPostings;
  return Array.isArray(list) ? list : [r[0]];
});
