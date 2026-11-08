// Adapted from career-ops-hq/career-ops providers/eploy.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama)
// Public per-tenant sitemap: GET https://<slug>.eploy.net/live-jobs.xml   <urlset><url><loc>https://<host>/vacancies/<id>/<title-slug>.html</loc>...
// The sitemap has only URLs, so the title is rebuilt from the URL slug ("senior-react-developer" -> "Senior React Developer", "--" separates parts) and there is
// no location, date or description (career-ops can read ld+json from each detail page behind an opt-in; not ported, one request per job). career-ops also accepts
// any branded careers host; here the host is pinned to <slug>.eploy.net, so a tenant on its own domain is not supported. Discover-only.
import { assertVendorSlug, type TrackedCompany } from './filters.js';
import { MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, getText } from './transport.js';
import { childOf, childrenOf, parseXml, textOf } from './xml.js';
import { makeJob, sameHostUrl } from './htmlList.js';
import { z } from 'zod';
import { makeBoardProvider } from './provider.js';

const hostOf = (c: TrackedCompany): string => `${c.slug}.eploy.net`;
const JOB_PATH = /^\/vacancies\/(\d{1,12})\/([^/?#]+)\.html\/?$/i;
const ACRONYMS = new Map([['ai', 'AI'], ['api', 'API'], ['cio', 'CIO'], ['cto', 'CTO'], ['eu', 'EU'], ['hr', 'HR'], ['it', 'IT'], ['ml', 'ML'], ['qa', 'QA'], ['uk', 'UK'], ['ui', 'UI'], ['ux', 'UX']]);

export function eployTitle(slug: string): string {
  let s = slug;
  try { s = decodeURIComponent(slug); } catch { /* keep raw */ }
  return s.split(/--+/).map((seg) => seg.replace(/[-_]+/g, ' ').trim().split(/\s+/).filter(Boolean)
    .map((w) => ACRONYMS.get(w.toLowerCase()) ?? w[0].toUpperCase() + w.slice(1)).join(' ')).filter(Boolean).join(' - ');
}

export interface EployRow { id: string; title: string; url: string }
export function parseEploySitemap(xml: string, host: string): EployRow[] {
  const set = childOf(parseXml(xml), 'urlset');
  if (!set) throw new Error('unexpected response shape (no urlset element)');
  const rows: EployRow[] = [];
  const seen = new Set<string>();
  for (const u of childrenOf(set, 'url').slice(0, MAX_JOBS_PER_BOARD)) {
    const url = sameHostUrl(textOf(u, 'loc'), `https://${host}/`, host);
    const m = url ? JOB_PATH.exec(new URL(url).pathname) : null;
    if (!url || !m || seen.has(m[1])) continue;
    const title = eployTitle(m[2]);
    if (!title) continue;
    seen.add(m[1]);
    rows.push({ id: m[1], title, url });
  }
  return rows;
}

export async function fetchEploy(c: TrackedCompany, _ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const host = hostOf(c);
  const label = `eploy ${c.slug}`;
  const xml = await getText(`https://${host}/live-jobs.xml`, label, { hosts: exactHosts(host) });
  let rows: EployRow[];
  try { rows = parseEploySitemap(xml, host); } catch (e: any) { throw new Error(`${label}: ${String(e?.message ?? e)}`); }
  return rows.flatMap((r) => makeJob({ prefix: 'ep', source: 'eploy', c, key: r.id, title: r.title, url: r.url }) ?? []);
}

export const shapeSpec = z.object({ id: z.string().min(1), title: z.string().min(1) }).passthrough();
export const provider = makeBoardProvider('eploy', fetchEploy, shapeSpec, (r) => {
  const host = /https:\/\/([a-z0-9-]+\.eploy\.net)\//i.exec(String(r[0]))?.[1]?.toLowerCase() ?? 'x.eploy.net';
  return parseEploySitemap(String(r[0]), host).slice(0, 5);
});
