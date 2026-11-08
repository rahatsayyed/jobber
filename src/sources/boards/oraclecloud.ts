// Adapted from career-ops-hq/career-ops providers/oraclecloud.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama)
// Oracle Recruiting Cloud candidate-experience REST API (the tenant host goes in params.host, the career site in params.site, default CX_1):
//   GET https://<host>/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.workLocation,requisitionList.secondaryLocations
//       &finder=findReqs;siteNumber=<site>,facetsList=...,limit=200,sortBy=POSTING_DATES_DESC,offset=<n>&limit=200&offset=<n>
//   -> { items: [{ TotalJobsCount, requisitionList: [{ Id, Title, PostedDate, PrimaryLocation, WorkplaceTypeCode, ShortDescriptionStr, ExternalURL, workLocation: [...] }] }] }
// Page size 200, at most max_pages (default 5 = 1000 postings). The description is the short blurb of the list (HTML entities decoded). URL: ExternalURL when it is on
// the tenant host, else https://<host>/hcmUI/CandidateExperience/<lang>/sites/<site>/job/<Id>. The facetsList value is copied from career-ops as is (UNVERIFIED). Discover-only.
import { assertVendorSlug, type TrackedCompany } from './filters.js';
import { boardUrl, MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, getJson } from './transport.js';
import { hasPlainAuthority, pastDeadline } from './util.js';
import { arr, buildJob, str } from './common.js';
import { paramsOf } from './vendorParams.js';
import { z } from 'zod';
import { makeBoardProvider } from './provider.js';

export const ORACLE_PAGE = 200;
export const ORACLE_DEFAULT_PAGES = 5;
const FACETS = 'LOCATIONS%3BWORK_LOCATIONS%3BWORKPLACE_TYPES%3BTITLES%3BCATEGORIES%3BORGANIZATIONS%3BPOSTING_DATES%3BFLEX_FIELDS';
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function normalizeOracle(items: any, c: TrackedCompany, ctx: FetchCtx = {}): BoardJob[] {
  assertVendorSlug(c);
  const { host = '', site = 'CX_1', lang = 'en' } = paramsOf(c);
  const out: BoardJob[] = [];
  for (const r of arr(items).slice(0, MAX_JOBS_PER_BOARD)) {
    if (!r || typeof r !== 'object') continue;
    const id = String(r.Id ?? r.RequisitionNumber ?? '').trim();
    const title = str(r.Title);
    if (!title || !ID_RE.test(id)) continue;
    const canonical = `https://${host}/hcmUI/CandidateExperience/${encodeURIComponent(lang)}/sites/${encodeURIComponent(site)}/job/${encodeURIComponent(id)}`;
    const url = boardUrl(hasPlainAuthority(r.ExternalURL) ? r.ExternalURL : undefined, host, canonical);
    const wl = arr(r.workLocation)[0];
    const place = str(r.PrimaryLocation) || [str(wl?.TownOrCity), str(wl?.Region), str(wl?.Country)].filter(Boolean).join(', ');
    const wt = str(r.WorkplaceTypeCode);
    const mode = wt === 'ORA_REMOTE' ? 'Remote' : wt === 'ORA_HYBRID' ? 'Hybrid' : '';
    const loc = [place, mode && !new RegExp(mode, 'i').test(place) ? mode : ''].filter(Boolean).join(', ');
    const job = buildJob({ prefix: 'oc', source: 'oraclecloud', c, key: id, title, url, description: str(r.ShortDescriptionStr), posted: r.PostedDate, locations: loc ? [loc] : [], remote: wt === 'ORA_REMOTE' });
    if (job) out.push(job);
  }
  return out;
}

export async function fetchOracleCloud(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const label = `oraclecloud ${c.slug}`;
  const { host, site = 'CX_1' } = paramsOf(c);
  if (!host) throw new Error(`${label}: needs params.host`);
  const opts = { hosts: exactHosts(host) };
  const maxPages = c.max_pages ?? ORACLE_DEFAULT_PAGES;
  const rows: unknown[] = [];
  let note = '';
  for (let page = 0; page < maxPages; page++) {
    if (page > 0 && pastDeadline(ctx.deadlineAt)) { note = `list stopped at page ${page} (time budget)`; break; }
    const offset = page * ORACLE_PAGE;
    // site is checked against a strict token pattern (vendorParams.ts) and FACETS is already percent-encoded, so the finder is used as is.
    const finder = `findReqs;siteNumber=${site},facetsList=${FACETS},limit=${ORACLE_PAGE},sortBy=POSTING_DATES_DESC,offset=${offset}`;
    const url = `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=${encodeURIComponent('requisitionList.workLocation,requisitionList.secondaryLocations')}&finder=${finder}&limit=${ORACLE_PAGE}&offset=${offset}`;
    let raw: any;
    try { raw = await getJson(url, label, opts); } catch (e) {
      if (page === 0) throw e;
      note = `list stopped at page ${page}: ${String((e as Error)?.message ?? e).replace(`${label}: `, '')}`;
      break;
    }
    const first = raw?.items?.[0];
    if (!first || !Array.isArray(first.requisitionList)) {
      if (page === 0) throw new Error(`${label}: unexpected response shape (no items[0].requisitionList)`);
      note = `list stopped at page ${page}: unexpected response shape`;
      break;
    }
    rows.push(...first.requisitionList);
    const total = Number(first.TotalJobsCount);
    if (!first.requisitionList.length || (Number.isFinite(total) && offset + ORACLE_PAGE >= total) || (!Number.isFinite(total) && first.requisitionList.length < ORACLE_PAGE) || rows.length >= MAX_JOBS_PER_BOARD) break;
    if (page === maxPages - 1) note = `list stopped at the page cap (${maxPages})`;
  }
  if (note) ctx.warn?.(`partial: ${rows.length} listed; ${note}`);
  return normalizeOracle(rows, c, ctx);
}

export const shapeSpec = z.object({ Id: z.union([z.string(), z.number()]), Title: z.string() }).passthrough();
export const provider = makeBoardProvider('oraclecloud', fetchOracleCloud, shapeSpec, (r) => {
  const list = (r[0] as any)?.items?.[0]?.requisitionList;
  return Array.isArray(list) ? list : [r[0]];
});
