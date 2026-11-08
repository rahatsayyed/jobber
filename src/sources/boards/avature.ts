// Adapted from career-ops-hq/career-ops providers/avature.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama)
// Public per-tenant search list: GET https://<slug>.avature.net/<site>/SearchJobs?jobOffset=<0,6,12,...>   (<site> = the entry's `site`, default "careers")
//   <article class="article article--result ..."> <a href=".../JobDetail/<name>/<id>">Title</a> ... list-item-location ... Posted 05-Oct-2026
// Avature serves exactly 6 postings per page; pages stop at a short or repeated page, or at max_pages (default 50, at most 200). When page 2 adds nothing the
// older `offset` parameter is tried once (as career-ops does). Tenants on a branded domain are not supported (host pinned to <slug>.avature.net).
// The list has no description. Discover-only.
import { assertVendorSlug, type TrackedCompany } from './filters.js';
import { MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts } from './transport.js';
import { pastDeadline } from './util.js';
import { toIsoDay } from '../../db.js';
import { anchorsOf, blocksBetween, getHtml, makeJob, plain, sameHostUrl } from './htmlList.js';
import { z } from 'zod';
import { makeBoardProvider } from './provider.js';

const PAGE_SIZE = 6;
const DEFAULT_PAGES = 50;
const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const hostOf = (c: TrackedCompany): string => `${c.slug}.avature.net`;

export interface AvatureRow { id: string; title: string; url: string; location: string; posted?: string | undefined }
export function parseAvatureArticles(html: string, host: string, base: string): { rows: AvatureRow[]; cards: number } {
  const rows: AvatureRow[] = [];
  const cards = blocksBetween(String(html), '<article class="', '</article>', 200).filter((b) => /article--(?:result|jobs)\b/.test(b.slice(0, 200)));
  for (const block of cards) {
    const a = anchorsOf(block, 30).find((x) => /\/JobDetail[/?]/.test(x.href));
    if (!a) continue;
    const url = sameHostUrl(plain(a.href), base, host);
    const id = /\/JobDetail\/[^/]*\/(\d{1,12})/.exec(a.href)?.[1] ?? /[?&]jobId=(\d{1,12})/i.exec(a.href)?.[1];
    const title = plain(a.inner);
    if (!url || !id || !title) continue;
    const loc = /list-item-location[^>]*>([^<]{1,200})</i.exec(block);
    const d = /Posted\s+(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(block);
    const mon = d ? MONTHS[d[2].toLowerCase()] : undefined;
    rows.push({ id, title, url, location: loc ? plain(loc[1]) : '', posted: d && mon !== undefined ? toIsoDay(Date.UTC(Number(d[3]), mon, Number(d[1]))) : undefined });
  }
  return { rows, cards: cards.length };
}

export async function fetchAvature(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const host = hostOf(c);
  const label = `avature ${c.slug}`;
  const base = `https://${host}/${c.site ?? 'careers'}/SearchJobs`;
  const maxPages = Math.min(c.max_pages ?? DEFAULT_PAGES, 200);
  const out: BoardJob[] = [];
  const seen = new Set<string>();
  let param = 'jobOffset';
  let canSwitch = true;
  const load = async (p: string, page: number) => parseAvatureArticles(await getHtml(`${base}?${p}=${page * PAGE_SIZE}`, label, exactHosts(host)), host, base);
  const absorb = (rows: AvatureRow[]): number => {
    let fresh = 0;
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      fresh++;
      const job = makeJob({ prefix: 'av', source: 'avature', c, key: r.id, title: r.title, url: r.url, locations: r.location ? [r.location] : [], posted: r.posted });
      if (job) out.push(job);
    }
    return fresh;
  };
  for (let page = 0; page < maxPages; page++) {
    if (page > 0 && pastDeadline(ctx.deadlineAt)) { ctx.warn?.(`list stopped at page ${page} (time budget)`); break; }
    let res = await load(param, page);
    let fresh = absorb(res.rows);
    if (fresh === 0 && canSwitch && page === 1) {
      canSwitch = false;
      const alt = await load('offset', page);
      const altFresh = absorb(alt.rows);
      if (altFresh > 0) { param = 'offset'; res = alt; fresh = altFresh; }
    }
    if (fresh === 0 || res.cards < PAGE_SIZE || out.length >= MAX_JOBS_PER_BOARD) break;
    if (page === maxPages - 1) ctx.warn?.(`stopped at max_pages=${maxPages} (${out.length} postings kept)`);
  }
  return out;
}

export const shapeSpec = z.object({ title: z.string().min(1), url: z.string().min(1) }).passthrough();
export const provider = makeBoardProvider('avature', fetchAvature, shapeSpec, (r) => {
  const text = String(r[0]);
  const host = /https:\/\/([a-z0-9-]+\.avature\.net)\//i.exec(text)?.[1]?.toLowerCase() ?? 'x.avature.net';
  return parseAvatureArticles(text, host, `https://${host}/careers/SearchJobs`).rows.slice(0, 5);
});
