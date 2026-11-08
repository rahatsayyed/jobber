// Adapted from career-ops-hq/career-ops providers/join.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama)
// Public candidate API of join.com (no login), two steps per fetch:
//   1. GET https://join.com/companies/<slug>  -> the Next.js page state (__NEXT_DATA__) carries the numeric company id
//   2. POST https://join.com/candidate-api/graphql  operation PublicJobsList (companyId, page, pageSize 100)
//      -> data.publicJobs.items[{ id, title, createdAt, descriptionHtml, workplaceType, remoteType, remoteRegion, city, country }], pageInfo.pageCount
// Job URL is built as https://join.com/companies/<slug>/<id>. Pages are capped by max_pages (default 10, at most 50). Rate-limit answers
// (GraphQL error TOO_MANY_REQUESTS) are reported as an error; career-ops retries with backoff, this provider does not. Discover-only.
import { toIsoDay } from '../../db.js';
import { assertVendorSlug, type TrackedCompany } from './filters.js';
import { MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, postJson } from './transport.js';
import { pastDeadline } from './util.js';
import { getHtml, makeJob } from './htmlList.js';
import { z } from 'zod';
import { makeBoardProvider } from './provider.js';

const HOST = 'join.com';
const PAGE_SIZE = 100;
const DEFAULT_PAGES = 10;
const QUERY = `query PublicJobsList($input: PublicJobsQueryInput!) { publicJobs(input: $input) { items { id title createdAt descriptionHtml language { iso6391 } workplaceType remoteType remoteRegion { name } city { cityName countryName } country { name } } pageInfo { pageCount } } }`;

const str = (x: unknown): string => (typeof x === 'string' ? x.trim() : '');

/** Company id from the page's __NEXT_DATA__ JSON (pageProps.pageData.company.id or pageProps.initialState.company.id). */
export function joinCompanyId(html: string): number | null {
  const open = html.search(/<script[^>]+__NEXT_DATA__[^>]*>/);
  if (open === -1) return null;
  const start = html.indexOf('>', open) + 1;
  const end = html.indexOf('</script>', start);
  if (end === -1 || end - start > 2_000_000) return null;
  try {
    const pp = JSON.parse(html.slice(start, end))?.props?.pageProps;
    const id = (pp?.pageData ?? pp?.initialState)?.company?.id;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch { return null; }
}

export function joinLocation(j: any): string {
  const city = str(j?.city?.cityName);
  const country = str(j?.country?.name) || str(j?.city?.countryName);
  if (j?.workplaceType === 'REMOTE') {
    const area = j.remoteType === 'ANYWHERE' ? 'worldwide' : j.remoteType === 'REGION' ? str(j.remoteRegion?.name) : country;
    return area ? `Remote (${area})` : 'Remote';
  }
  const place = [city, country].filter(Boolean).join(', ');
  return j?.workplaceType === 'HYBRID' ? (place ? `${place} (hybrid)` : 'Hybrid') : place;
}

export function normalizeJoin(items: unknown[], c: TrackedCompany): BoardJob[] {
  assertVendorSlug(c);
  const out: BoardJob[] = [];
  for (const j of items.slice(0, MAX_JOBS_PER_BOARD) as any[]) {
    if (!j || typeof j !== 'object' || !Number.isSafeInteger(j.id) || j.id <= 0) continue;
    const loc = joinLocation(j);
    const job = makeJob({
      prefix: 'jn', source: 'join', c, key: String(j.id), title: str(j.title), url: `https://${HOST}/companies/${c.slug}/${j.id}`,
      description: str(j.descriptionHtml), posted: toIsoDay(str(j.createdAt)), locations: loc ? [loc] : [],
      remote: j.workplaceType === 'REMOTE' || /remote/i.test(str(j.title)),
    });
    if (job) out.push(job);
  }
  return out;
}

export async function fetchJoin(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const label = `join ${c.slug}`;
  const hosts = exactHosts(HOST);
  const page0 = await getHtml(`https://${HOST}/companies/${encodeURIComponent(c.slug)}`, label, hosts);
  const companyId = joinCompanyId(page0);
  if (!companyId) throw new Error(`${label}: no company id on the company page (page state changed?)`);
  const maxPages = Math.min(c.max_pages ?? DEFAULT_PAGES, 50);
  const items: unknown[] = [];
  let pageCount = 1;
  let page = 1;
  for (; page <= Math.min(pageCount, maxPages); page++) {
    if (page > 1 && pastDeadline(ctx.deadlineAt)) { ctx.warn?.(`list stopped at page ${page} (time budget)`); break; }
    const json = await postJson(`https://${HOST}/candidate-api/graphql`, {
      operationName: 'PublicJobsList', query: QUERY, variables: { input: { companyId, paginationPage: { page, pageSize: PAGE_SIZE }, filters: {} } },
    }, label, { hosts });
    if (Array.isArray(json?.errors) && json.errors.length) throw new Error(`${label}: ${String(json.errors[0]?.message ?? 'GraphQL error').slice(0, 120)}`);
    const list = json?.data?.publicJobs?.items;
    if (!Array.isArray(list)) throw new Error(`${label}: unexpected response shape (no publicJobs items)`);
    items.push(...list);
    const pc = json.data.publicJobs.pageInfo?.pageCount;
    if (!Number.isInteger(pc) || pc < 0) throw new Error(`${label}: unexpected response shape (no pageCount)`);
    pageCount = pc;
    if (items.length >= MAX_JOBS_PER_BOARD) break;
  }
  if (pageCount > maxPages) ctx.warn?.(`truncated at max_pages=${maxPages} of ${pageCount} pages`);
  const out = normalizeJoin(items, c);
  const noDesc = out.filter((j) => !j.description).length;
  if (noDesc) ctx.warn?.(`${noDesc} of ${out.length} postings had no description (descriptionHtml changed?)`);
  return out;
}

export const shapeSpec = z.object({ id: z.number(), title: z.string().min(1) }).passthrough();
export const provider = makeBoardProvider('join', fetchJoin, shapeSpec, (r) => {
  const json = r.find((x) => x && typeof x === 'object') as any;
  const items = json?.data?.publicJobs?.items;
  return Array.isArray(items) ? items : [{ envelope: 'missing' }];
});
