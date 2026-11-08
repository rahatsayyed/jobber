// Adapted from career-ops-hq/career-ops providers/pageup.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama)
// Public vendor-hosted listing (no login, plain GET): GET https://careers.pageuppeople.com/<tenant>/<site>/en/listing/?page=<n>&page-items=100
//   <tbody id="search-results-content"> ... <a class="job-link" href="/<tenant>/<site>/<lang>/job/<id>/<title-slug>">Title</a>
// <slug> is the numeric tenant id and the optional `site` the careers-site key (default "cw"). Tenants that moved to a branded domain redirect away and
// fail with a labelled transport error (redirects are refused). The list has no location and no date (its date column is the CLOSING date) and no description.
// Pages stop when nothing new, a short page without a "more" link, or max_pages (default 20, at most 200). Discover-only.
import { assertVendorSlug, type TrackedCompany } from './filters.js';
import { MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts } from './transport.js';
import { pastDeadline } from './util.js';
import { anchorsOf, attrOf, getHtml, makeJob, plain, sameHostUrl } from './htmlList.js';
import { z } from 'zod';
import { makeBoardProvider } from './provider.js';

const HOST = 'careers.pageuppeople.com';
const PAGE_ITEMS = 100;
const DEFAULT_PAGES = 20;

export interface PageupRow { id: string; title: string; url: string }
export function parsePageupListing(html: string, tenant: string, site: string): { rows: PageupRow[]; links: number; hasMore: boolean } {
  const doc = String(html);
  const open = doc.indexOf('id="search-results-content"');
  if (open === -1) throw new Error('listing page has no search-results table (login, error or challenge page, not zero postings)');
  const end = doc.indexOf('</tbody>', open);
  const body = doc.slice(open, end === -1 ? doc.length : end);
  const rows: PageupRow[] = [];
  let links = 0;
  for (const a of anchorsOf(body)) {
    if (!/(?:^|\s)job-link(?:\s|$)/.test(attrOf(a.open, 'class') ?? '')) continue;
    links++;
    const url = sameHostUrl(plain(a.href), `https://${HOST}/`, HOST);
    const m = url ? /^\/(\d+)\/([A-Za-z0-9_-]+)\/[^/]+\/job\/(\d{1,12})(?:\/|$)/.exec(new URL(url).pathname) : null;
    const title = plain(a.inner);
    if (!url || !m || m[1] !== tenant || m[2] !== site || !title) continue;
    rows.push({ id: m[3], title, url: `https://${HOST}/${tenant}/${site}/en/job/${m[3]}` });
  }
  if (!rows.length && links > 0) throw new Error('posting links found but none could be read (markup changed?)');
  return { rows, links, hasMore: doc.slice(end === -1 ? doc.length : end).includes('more-link') };
}

export async function fetchPageup(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const site = c.site ?? 'cw';
  const label = `pageup ${c.slug}`;
  const maxPages = Math.min(c.max_pages ?? DEFAULT_PAGES, 200);
  const out: BoardJob[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= maxPages; page++) {
    if (page > 1 && pastDeadline(ctx.deadlineAt)) { ctx.warn?.(`list stopped at page ${page} (time budget)`); break; }
    const html = await getHtml(`https://${HOST}/${c.slug}/${site}/en/listing/?page=${page}&page-items=${PAGE_ITEMS}`, label, exactHosts(HOST));
    let parsed: ReturnType<typeof parsePageupListing>;
    try { parsed = parsePageupListing(html, c.slug, site); } catch (e: any) { throw new Error(`${label}: ${String(e?.message ?? e)}`); }
    let fresh = 0;
    for (const r of parsed.rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      fresh++;
      const job = makeJob({ prefix: 'pu', source: 'pageup', c, key: r.id, title: r.title, url: r.url });
      if (job) out.push(job);
    }
    if (fresh === 0 || (!parsed.hasMore && parsed.links < PAGE_ITEMS) || out.length >= MAX_JOBS_PER_BOARD) break;
    if (page === maxPages) ctx.warn?.(`stopped at max_pages=${maxPages} (${out.length} postings kept)`);
  }
  return out;
}

export const shapeSpec = z.object({ title: z.string().min(1), url: z.string().min(1) }).passthrough();
export const provider = makeBoardProvider('pageup', fetchPageup, shapeSpec, (r) => {
  const text = String(r[0]);
  const m = /\/(\d+)\/([A-Za-z0-9_-]+)\/[^/"]+\/job\/\d/.exec(text);
  return m ? parsePageupListing(text, m[1], m[2]).rows.slice(0, 5) : [{ envelope: 'missing' }];
});
