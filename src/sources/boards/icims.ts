// Adapted from career-ops-hq/career-ops providers/icims.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama)
// Public per-tenant search pages (the iframe view): GET https://<slug>.icims.com/jobs/search?ss=1&pr=<page>&in_iframe=1
//   cards: `iCIMS_JobCardItem` ... <a href=".../jobs/<id>/<slug>/job"> <h3>Title</h3> ... <span class="field-label">Location</span><span>City</span>
// The list has no description and no date (career-ops reads the detail page's ld+json for the date; that second request per job is not ported).
// <slug> is the whole tenant host label (for example `careers-acme` for careers-acme.icims.com). Pages stop at an empty page, a repeated page or 30 pages.
// Discover-only (src/lib/discoverOnly.ts).
import { assertVendorSlug, type TrackedCompany } from './filters.js';
import { MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts } from './transport.js';
import { pastDeadline } from './util.js';
import { getHtml, makeJob, plain, sameHostUrl } from './htmlList.js';
import { z } from 'zod';
import { makeBoardProvider } from './provider.js';

const MAX_PAGES = 30;
const hostOf = (c: TrackedCompany): string => `${c.slug}.icims.com`;

export interface IcimsRow { title: string; url: string; id: string; location: string }
export function parseIcimsPage(html: string, host: string): IcimsRow[] {
  const rows: IcimsRow[] = [];
  for (const card of String(html).split('iCIMS_JobCardItem').slice(1, 400)) {
    const part = card.slice(0, 20_000);
    const href = /href="([^"]*\/jobs\/(\d{1,12})\/[^"/]+\/job[^"]*)"/.exec(part);
    const h3Start = part.indexOf('<h3');
    const h3End = h3Start === -1 ? -1 : part.indexOf('</h3>', h3Start);
    if (!href || h3End === -1) continue;
    const title = plain(part.slice(part.indexOf('>', h3Start) + 1, h3End));
    const url = sameHostUrl(plain(href[1]), `https://${host}/`, host);
    if (!title || !url) continue;
    const loc = /field-label[^>]*>\s*Location\b[^<]*<\/span>\s*<span\b[^>]*>([^<]{0,200})</.exec(part);
    rows.push({ title, url, id: href[2], location: loc ? plain(loc[1]) : '' });
  }
  return rows;
}

export async function fetchIcims(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const host = hostOf(c);
  const label = `icims ${c.slug}`;
  const out: BoardJob[] = [];
  const seen = new Set<string>();
  let prevFirst = '';
  let ended = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0 && pastDeadline(ctx.deadlineAt)) break;
    const html = await getHtml(`https://${host}/jobs/search?ss=1&pr=${page}&in_iframe=1`, label, exactHosts(host));
    const rows = parseIcimsPage(html, host);
    if (!rows.length || rows[0].url === prevFirst) { ended = true; break; }
    prevFirst = rows[0].url;
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const job = makeJob({ prefix: 'ic', source: 'icims', c, key: r.id, title: r.title, url: r.url, locations: r.location ? [r.location] : [] });
      if (job) out.push(job);
    }
    if (out.length >= MAX_JOBS_PER_BOARD) break;
  }
  if (!ended) ctx.warn?.(`stopped at ${MAX_PAGES} pages (${out.length} postings kept)`);
  return out;
}

export const shapeSpec = z.object({ title: z.string().min(1), url: z.string().min(1) }).passthrough();
export const provider = makeBoardProvider('icims', fetchIcims, shapeSpec, (r) => {
  const text = String(r[0]);
  const host = /https:\/\/([a-z0-9.-]+\.icims\.com)\//.exec(text)?.[1] ?? 'x.icims.com';
  return parseIcimsPage(text, host).slice(0, 5);
});
