// Adapted from career-ops-hq/career-ops providers/successfactors.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama)
// SuccessFactors career sites come in two flavours; only the JSON one ("CSB") is ported here:
//   POST https://<params.host>/services/recruiting/v1/jobs   body { keywords:"", locale, location:"", pageNumber (0-based), sortBy:"date" }
//   -> { totalJobs, jobSearchResult: [{ response: { id, unifiedStandardTitle|jobTitle, unifiedUrlTitle|urlTitle, jobLocationShort: [..], unifiedStandardStart } }] }
// Page size 10, at most max_pages (default 20 = 200 postings). The HTML "RMK" flavour (tile-search-results scraping, tried first by career-ops) is NOT ported:
// a tenant that only has RMK reads as an empty board with a warning. The host must be on successfactors.com, successfactors.eu or jobs2web.com
// (vendorParams.ts). Job URL: https://<host>/job/<slug>/<id>-<locale>. No description in the list. Discover-only.
import { assertVendorSlug, type TrackedCompany } from './filters.js';
import { boardUrl, MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, postJson } from './transport.js';
import { pastDeadline } from './util.js';
import { arr, buildJob, str } from './common.js';
import { paramsOf } from './vendorParams.js';
import { z } from 'zod';
import { makeBoardProvider } from './provider.js';

export const SF_PAGE = 10;
export const SF_DEFAULT_PAGES = 20;
const ID_RE = /^[0-9]{1,20}$/;
const titleSlug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/g, '') || 'job';

/** Dates come as "10/02/2026", "02.10.2026" or ISO in a locale-dependent order; only an ISO day or a 4-digit year with an unambiguous month is read. */
export function sfDate(v: unknown): string | undefined {
  const s = str(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
  const m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(s);
  if (!m) return undefined;
  const [a, b, y] = [Number(m[1]), Number(m[2]), m[3]];
  const [day, mon] = a > 12 ? [a, b] : b > 12 ? [b, a] : [NaN, NaN];
  if (!(mon >= 1 && mon <= 12 && day >= 1 && day <= 31)) return undefined;
  return `${y}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function normalizeSuccessFactors(rows: unknown[], c: TrackedCompany, ctx: FetchCtx = {}): BoardJob[] {
  assertVendorSlug(c);
  const { host = '', locale = 'en_US' } = paramsOf(c);
  const out: BoardJob[] = [];
  const seen = new Set<string>();
  for (const r of rows.slice(0, MAX_JOBS_PER_BOARD) as any[]) {
    const j = r?.response;
    if (!j || typeof j !== 'object') continue;
    const id = String(j.id ?? '').trim();
    const title = str(j.unifiedStandardTitle) || str(j.jobTitle);
    if (!title || !ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const canonical = `https://${host}/job/${titleSlug(str(j.unifiedUrlTitle) || str(j.urlTitle) || title)}/${id}-${locale}`;
    const job = buildJob({
      prefix: 'sf', source: 'successfactors', c, key: id, title, url: boardUrl(canonical, host, canonical),
      posted: sfDate(j.unifiedStandardStart), locations: [arr(j.jobLocationShort).map(str).filter(Boolean).join(' / ')],
    });
    if (job) out.push(job);
  }
  if (out.length) ctx.warn?.(`${out.length} postings have no description (the SuccessFactors list carries none)`);
  return out;
}

export async function fetchSuccessFactors(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const label = `successfactors ${c.slug}`;
  const { host, locale = 'en_US' } = paramsOf(c);
  if (!host) throw new Error(`${label}: needs params.host`);
  const opts = { hosts: exactHosts(host) };
  const maxPages = c.max_pages ?? SF_DEFAULT_PAGES;
  const rows: unknown[] = [];
  let note = '';
  for (let page = 0; page < maxPages; page++) {
    if (page > 0 && pastDeadline(ctx.deadlineAt)) { note = `list stopped at page ${page} (time budget)`; break; }
    let raw: any;
    try { raw = await postJson(`https://${host}/services/recruiting/v1/jobs`, { keywords: '', locale, location: '', pageNumber: page, sortBy: 'date' }, label, opts); } catch (e) {
      if (page === 0) throw e;
      note = `list stopped at page ${page}: ${String((e as Error)?.message ?? e).replace(`${label}: `, '')}`;
      break;
    }
    if (!raw || !Array.isArray(raw.jobSearchResult)) {
      if (page === 0) throw new Error(`${label}: unexpected response shape (no jobSearchResult array; an HTML-only career site is not supported)`);
      note = `list stopped at page ${page}: unexpected response shape`;
      break;
    }
    rows.push(...raw.jobSearchResult);
    const total = Number(raw.totalJobs);
    if (raw.jobSearchResult.length < SF_PAGE || (Number.isFinite(total) && (page + 1) * SF_PAGE >= total) || rows.length >= MAX_JOBS_PER_BOARD) break;
    if (page === maxPages - 1) note = `list stopped at the page cap (${maxPages})`;
  }
  if (note) ctx.warn?.(`partial: ${rows.length} listed; ${note}`);
  return normalizeSuccessFactors(rows, c, ctx);
}

export const shapeSpec = z.object({ response: z.object({ id: z.union([z.string(), z.number()]) }).passthrough() }).passthrough();
export const provider = makeBoardProvider('successfactors', fetchSuccessFactors, shapeSpec, (r) => {
  const list = (r[0] as any)?.jobSearchResult;
  return Array.isArray(list) ? list : [r[0]];
});
