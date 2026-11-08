// Adapted from career-ops-hq/career-ops providers/neogov.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama)
// Public NEOGOV agency job list (US public sector and schools): GET https://www.schooljobs.com/careers/home/index?agency=<slug>[&departmentFolder=<site>]&sort=PostingDate&isDescendingSort=true&page=<n>
//   (header X-Requested-With: XMLHttpRequest returns the list fragment)  <li class="list-item"> <a class="item-details-link" href="/careers/<agency>/jobs/<id>/...">Title</a>
//   <ul class="list-meta"><li>Location</li>...
// <slug> is the agency, the optional `site` the department folder. Only schooljobs.com is read here (governmentjobs.com agencies are not). 10 postings per page;
// pages stop at a page with nothing new or max_pages (default 30, at most 200). No description in the list. Discover-only.
import { assertVendorSlug, type TrackedCompany } from './filters.js';
import { MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, getText } from './transport.js';
import { pastDeadline } from './util.js';
import { anchorsOf, makeJob, plain, sameHostUrl } from './htmlList.js';
import { z } from 'zod';
import { makeBoardProvider } from './provider.js';

const HOST = 'www.schooljobs.com';
const DEFAULT_PAGES = 30;

export interface NeogovRow { id: string; title: string; url: string; location: string }
export function parseNeogovPage(html: string): NeogovRow[] {
  const items = String(html).split('<li class="list-item"').slice(1, 400);
  if (!items.length) {
    if (html.includes('jobs-not-found-container') || html.includes('search-results-listing-container')) return [];
    throw new Error('response is not a NEOGOV job list (no list items)');
  }
  const rows: NeogovRow[] = [];
  for (const item of items) {
    const part = item.slice(0, 20_000);
    const a = anchorsOf(part, 20).find((x) => x.open.includes('item-details-link'));
    if (!a) continue;
    const url = sameHostUrl(plain(a.href), `https://${HOST}/`, HOST);
    const m = url ? /^\/careers\/[^/]+\/(?:[^/]+\/)?jobs\/(\d{1,12})/.exec(new URL(url).pathname) : null;
    const title = plain(a.inner);
    if (!url || !m || !title) continue;
    const meta = /<ul class="list-meta">\s*<li>([^<]{0,200})</.exec(part);
    rows.push({ id: m[1], title, url, location: meta ? plain(meta[1]) : '' });
  }
  return rows;
}

export async function fetchNeogov(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const label = `neogov ${c.slug}`;
  const maxPages = Math.min(c.max_pages ?? DEFAULT_PAGES, 200);
  const out: BoardJob[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= maxPages; page++) {
    if (page > 1 && pastDeadline(ctx.deadlineAt)) { ctx.warn?.(`list stopped at page ${page} (time budget)`); break; }
    const q = new URLSearchParams({ agency: c.slug });
    if (c.site) q.set('departmentFolder', c.site);
    q.set('sort', 'PostingDate'); q.set('isDescendingSort', 'true'); q.set('page', String(page));
    const html = await getText(`https://${HOST}/careers/home/index?${q}`, label, { hosts: exactHosts(HOST), accept: 'text/html, */*;q=0.5', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    let rows: NeogovRow[];
    try { rows = parseNeogovPage(html); } catch (e: any) { throw new Error(`${label}: ${String(e?.message ?? e)}`); }
    let fresh = 0;
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      fresh++;
      const job = makeJob({ prefix: 'ng', source: 'neogov', c, key: r.id, title: r.title, url: r.url, locations: r.location ? [r.location] : [] });
      if (job) out.push(job);
    }
    if (fresh === 0 || out.length >= MAX_JOBS_PER_BOARD) break;
    if (page === maxPages) ctx.warn?.(`stopped at max_pages=${maxPages} (${out.length} postings kept)`);
  }
  return out;
}

export const shapeSpec = z.object({ title: z.string().min(1), url: z.string().min(1) }).passthrough();
export const provider = makeBoardProvider('neogov', fetchNeogov, shapeSpec, (r) => parseNeogovPage(String(r[0])).slice(0, 5));
