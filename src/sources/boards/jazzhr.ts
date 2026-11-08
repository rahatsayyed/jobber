// Adapted from career-ops-hq/career-ops providers/jazzhr.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama)
// Public per-tenant ApplyToJob board: GET https://<slug>.applytojob.com/apply
//   <li class="list-group-item"><a href="/apply/<id>/<title-slug>">Title</a> ... <i class="fa-map-marker"></i> City, ST
// The list has no description and no date (career-ops can read each detail page's ld+json behind an opt-in; not ported, one request per job).
// A page with posting-looking links that yields no job is reported as a markup change, never as an empty board. Discover-only.
import { assertVendorSlug, type TrackedCompany } from './filters.js';
import { MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts } from './transport.js';
import { anchorsOf, getHtml, makeJob, plain, sameHostUrl } from './htmlList.js';
import { z } from 'zod';
import { makeBoardProvider } from './provider.js';

const hostOf = (c: TrackedCompany): string => `${c.slug}.applytojob.com`;
const POSTING_PATH = /^\/apply\/([A-Za-z0-9]{6,20})(?:\/|$)/;

export interface JazzRow { id: string; title: string; url: string; location: string }
export function parseJazzhrList(html: string, host: string): JazzRow[] {
  const rows: JazzRow[] = [];
  const seen = new Set<string>();
  let looked = 0;
  for (const a of anchorsOf(html)) {
    const url = sameHostUrl(plain(a.href), `https://${host}/apply`, host);
    const id = url ? POSTING_PATH.exec(new URL(url).pathname)?.[1] : undefined;
    if (!url || !id) continue;
    looked++;
    const title = plain(a.inner);
    if (!title || seen.has(id)) continue;
    seen.add(id);
    const after = html.slice(a.end, a.end + 800);
    const loc = /fa-map-marker[^<]*<\/i>\s*([^<]{1,200})/i.exec(after.split('list-group-item')[0]);
    rows.push({ id, title, url, location: loc ? plain(loc[1]) : '' });
    if (rows.length >= MAX_JOBS_PER_BOARD) break;
  }
  if (!rows.length && looked > 0) throw new Error('found ApplyToJob links but could not read any posting title (markup changed?)');
  return rows;
}

export async function fetchJazzhr(c: TrackedCompany, _ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const host = hostOf(c);
  const label = `jazzhr ${c.slug}`;
  const html = await getHtml(`https://${host}/apply`, label, exactHosts(host));
  let rows: JazzRow[];
  try { rows = parseJazzhrList(html, host); } catch (e: any) { throw new Error(`${label}: ${String(e?.message ?? e)}`); }
  return rows.flatMap((r) => makeJob({ prefix: 'jh', source: 'jazzhr', c, key: r.id, title: r.title, url: r.url, locations: r.location ? [r.location] : [] }) ?? []);
}

export const shapeSpec = z.object({ title: z.string().min(1), url: z.string().min(1) }).passthrough();
export const provider = makeBoardProvider('jazzhr', fetchJazzhr, shapeSpec, (r) => {
  const text = String(r[0]);
  const host = /https:\/\/([a-z0-9-]+\.applytojob\.com)\//i.exec(text)?.[1]?.toLowerCase() ?? 'x.applytojob.com';
  return parseJazzhrList(text, host).slice(0, 5);
});
