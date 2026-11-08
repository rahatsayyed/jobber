// Adapted from career-ops-hq/career-ops providers/taleo.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama)
// Taleo Enterprise career section on https://<slug>.taleo.net (slug = the tenant label, params.section = the careersection name, params.lang default "en"):
//   shell:  GET  /careersection/<section>/jobsearch.ftl                      -> HTML carrying the portal id ("portal=<n>", a portal/portalId pair or a hidden portal input)
//   search: POST /careersection/rest/jobboard/searchjobs?lang=<lang>&portal=<portal>   body { multilineEnabled:false, sortingSelection, fieldData, filter..., pageNo }
//   -> { pagingData: { totalCount }, requisitionList: [{ contestNo|jobId, column: [title, location, posted date, ...] }] }
// Columns are read by position (title 0, location 1, date 2): career-ops also matches column headings, that part is NOT ported (UNVERIFIED). Business Edition
// hosts (tre.taleo.net) are refused. Page cap: max_pages (default 20), 200 ms pause between pages. No detail pages, so no description. Job URL:
// https://<slug>.taleo.net/careersection/<section>/jobdetail.ftl?job=<id>&lang=<lang>. Discover-only.
import { assertVendorSlug, type TrackedCompany } from './filters.js';
import { boardUrl, MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, getText, postJson } from './transport.js';
import { pastDeadline } from './util.js';
import { arr, buildJob, str } from './common.js';
import { paramsOf } from './vendorParams.js';
import { z } from 'zod';
import { makeBoardProvider } from './provider.js';

export const TALEO_DEFAULT_PAGES = 20;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function portalIdOf(html: string): string | null {
  const m = /[?&;]portal=(\d{1,20})/.exec(html)
    ?? /["']?portal(?:Id)?["']?\s*[:=]\s*["']?(\d{1,20})/i.exec(html)
    ?? /<input[^>]+name=["']portal["'][^>]*value=["'](\d{1,20})["']/i.exec(html)
    ?? /<input[^>]+value=["'](\d{1,20})["'][^>]*name=["']portal["']/i.exec(html);
  return m ? m[1] : null;
}

function cell(v: unknown): string {
  const s = str(v);
  if (s.startsWith('[')) { try { const a = JSON.parse(s); if (Array.isArray(a)) return a.map(str).filter(Boolean).join('; '); } catch { /* plain text */ } }
  return s;
}

export function normalizeTaleo(rows: unknown[], c: TrackedCompany, ctx: FetchCtx = {}): BoardJob[] {
  assertVendorSlug(c);
  const { section = '', lang = 'en' } = paramsOf(c);
  const out: BoardJob[] = [];
  const seen = new Set<string>();
  for (const r of rows.slice(0, MAX_JOBS_PER_BOARD) as any[]) {
    if (!r || typeof r !== 'object') continue;
    const id = String(r.contestNo ?? r.jobId ?? '').trim();
    const col = arr(r.column);
    const title = cell(col[0]) || str(r.title) || str(r.jobTitle);
    if (!title || !ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const loc = cell(col[1]);
    const when = cell(col[2]);
    const canonical = `https://${c.slug}.taleo.net/careersection/${section}/jobdetail.ftl?job=${encodeURIComponent(id)}&lang=${encodeURIComponent(lang)}`;
    const posted = Number.isNaN(Date.parse(when)) ? undefined : new Date(Date.parse(when)).toISOString();
    const job = buildJob({ prefix: 'tl', source: 'taleo', c, key: id, title, url: boardUrl(canonical, 'taleo.net', canonical), posted, locations: loc ? [loc] : [] });
    if (job) out.push(job);
  }
  if (out.length) ctx.warn?.(`${out.length} postings have no description (the Taleo list carries none)`);
  return out;
}

export async function fetchTaleo(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const label = `taleo ${c.slug}`;
  const { section, lang = 'en' } = paramsOf(c);
  if (!section) throw new Error(`${label}: needs params.section`);
  if (c.slug === 'tre') throw new Error(`${label}: Taleo Business Edition (tre.taleo.net) is not supported`);
  const host = `${c.slug}.taleo.net`;
  const opts = { hosts: exactHosts(host), headers: { 'X-Requested-With': 'XMLHttpRequest' } };
  const shell = await getText(`https://${host}/careersection/${section}/jobsearch.ftl`, label, { hosts: exactHosts(host), accept: 'text/html' });
  const portal = portalIdOf(shell);
  if (!portal) throw new Error(`${label}: portal id not found on the career section page`);
  const maxPages = c.max_pages ?? TALEO_DEFAULT_PAGES;
  const rows: unknown[] = [];
  let note = '';
  for (let page = 1; page <= maxPages; page++) {
    if (page > 1) { if (pastDeadline(ctx.deadlineAt)) { note = `list stopped at page ${page} (time budget)`; break; } await sleep(200); }
    const body = {
      multilineEnabled: false, sortingSelection: { sortBySelectionParam: '5', ascendingSortingOrder: 'true' },
      fieldData: { fields: { KEYWORD: '', LOCATION: '' }, valid: true },
      filterSelectionParam: { searchFilterSelections: [] }, advancedSearchFiltersSelectionParam: { searchFilterSelections: [] }, pageNo: page,
    };
    let raw: any;
    try { raw = await postJson(`https://${host}/careersection/rest/jobboard/searchjobs?lang=${encodeURIComponent(lang)}&portal=${portal}`, body, label, opts); } catch (e) {
      if (page === 1) throw e;
      note = `list stopped at page ${page}: ${String((e as Error)?.message ?? e).replace(`${label}: `, '')}`;
      break;
    }
    if (!raw || !Array.isArray(raw.requisitionList)) {
      if (page === 1) throw new Error(`${label}: unexpected response shape (no requisitionList array)`);
      note = `list stopped at page ${page}: unexpected response shape`;
      break;
    }
    rows.push(...raw.requisitionList);
    const total = Number(raw.pagingData?.totalCount);
    if (!raw.requisitionList.length || (Number.isFinite(total) && rows.length >= total) || rows.length >= MAX_JOBS_PER_BOARD) break;
    if (page === maxPages) note = `list stopped at the page cap (${maxPages})`;
  }
  if (note) ctx.warn?.(`partial: ${rows.length} listed; ${note}`);
  return normalizeTaleo(rows, c, ctx);
}

export const shapeSpec = z.object({ column: z.array(z.unknown()) }).passthrough();
export const provider = makeBoardProvider('taleo', fetchTaleo, shapeSpec, (r) => {
  const list = (r.find((x) => Array.isArray((x as any)?.requisitionList)) as any)?.requisitionList;
  return Array.isArray(list) ? list : [r[0]];
});
