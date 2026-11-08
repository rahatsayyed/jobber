// Adapted from career-ops-hq/career-ops providers/ultipro.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama)
// UKG Pro (UltiPro) recruiting board: slug = the tenant (first path segment), params.board = the JobBoard id, params.host default recruiting.ultipro.com.
//   POST https://<host>/<tenant>/JobBoard/<board>/JobBoardView/LoadSearchResults
//        body { opportunitySearch: { Top:50, Skip:<n>, QueryString:"", OrderBy:[{ Value:"postedDateDesc", PropertyName:"PostedDate", Ascending:false }], Filters:[] }, matchCriteria: {...empty} }
//   -> { totalCount, opportunities: [{ Id, Title, PostedDate, BriefDescription, Locations: [{ LocalizedName, Address: { City, State: { Code } } }] }] }
// Page cap: max_pages (default 20 = 1000 postings). BriefDescription is the description (career-ops' optional OpportunityDetail page scrape is NOT ported).
// Job URL: https://<host>/<tenant>/JobBoard/<board>/OpportunityDetail?opportunityId=<Id>. Discover-only.
import { assertVendorSlug, type TrackedCompany } from './filters.js';
import { boardUrl, MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, postJson } from './transport.js';
import { pastDeadline } from './util.js';
import { arr, buildJob, str } from './common.js';
import { paramsOf } from './vendorParams.js';
import { z } from 'zod';
import { makeBoardProvider } from './provider.js';

export const ULTI_PAGE = 50;
export const ULTI_DEFAULT_PAGES = 20;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hostOf = (c: TrackedCompany): string => paramsOf(c).host ?? 'recruiting.ultipro.com';

export function placeOf(l: any): string {
  const a = l?.Address;
  const cityState = [str(a?.City), str(a?.State?.Code)].filter(Boolean).join(', ');
  return cityState || str(l?.LocalizedName);
}

export function normalizeUltipro(rows: unknown[], c: TrackedCompany, ctx: FetchCtx = {}): BoardJob[] {
  assertVendorSlug(c);
  const board = paramsOf(c).board ?? '';
  const host = hostOf(c);
  const out: BoardJob[] = [];
  const seen = new Set<string>();
  let noDescription = 0;
  for (const o of rows.slice(0, MAX_JOBS_PER_BOARD) as any[]) {
    if (!o || typeof o !== 'object') continue;
    const id = (typeof o.Id === 'number' ? String(o.Id) : str(o.Id));
    const title = str(o.Title);
    if (!title || !ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const canonical = `https://${host}/${encodeURIComponent(c.slug)}/JobBoard/${encodeURIComponent(board)}/OpportunityDetail?opportunityId=${encodeURIComponent(id)}`;
    const job = buildJob({
      prefix: 'up', source: 'ultipro', c, key: id, title, url: boardUrl(canonical, host, canonical),
      description: typeof o.BriefDescription === 'string' ? o.BriefDescription : '', posted: typeof o.PostedDate === 'string' ? o.PostedDate : undefined,
      locations: arr(o.Locations).map(placeOf),
    });
    if (job) { out.push(job); if (!job.description) noDescription++; }
  }
  if (noDescription) ctx.warn?.(`${noDescription} of ${out.length} postings had no description (BriefDescription changed?)`);
  return out;
}

export async function fetchUltipro(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const label = `ultipro ${c.slug}`;
  const board = paramsOf(c).board;
  if (!board) throw new Error(`${label}: needs params.board`);
  const host = hostOf(c);
  const opts = { hosts: exactHosts(host) };
  const maxPages = c.max_pages ?? ULTI_DEFAULT_PAGES;
  const rows: unknown[] = [];
  const ids = new Set<string>();
  let note = '';
  for (let page = 0; page < maxPages; page++) {
    if (page > 0) { if (pastDeadline(ctx.deadlineAt)) { note = `list stopped at page ${page} (time budget)`; break; } await sleep(250); }
    const body = {
      opportunitySearch: { Top: ULTI_PAGE, Skip: rows.length, QueryString: '', OrderBy: [{ Value: 'postedDateDesc', PropertyName: 'PostedDate', Ascending: false }], Filters: [] },
      matchCriteria: { PreferredJobs: [], Educations: [], LicenseAndCertifications: [], Skills: [], SkippedSkills: [], hasNoLicenses: false },
    };
    let raw: any;
    try { raw = await postJson(`https://${host}/${encodeURIComponent(c.slug)}/JobBoard/${encodeURIComponent(board)}/JobBoardView/LoadSearchResults`, body, label, opts); } catch (e) {
      if (page === 0) throw e;
      note = `list stopped at page ${page}: ${String((e as Error)?.message ?? e).replace(`${label}: `, '')}`;
      break;
    }
    if (!raw || !Array.isArray(raw.opportunities)) {
      if (page === 0) throw new Error(`${label}: unexpected response shape (no opportunities array)`);
      note = `list stopped at page ${page}: unexpected response shape`;
      break;
    }
    let fresh = 0;
    for (const o of raw.opportunities) {
      const k = String(o?.Id ?? '');
      if (k && !ids.has(k)) { ids.add(k); fresh++; }
    }
    rows.push(...raw.opportunities);
    if (raw.opportunities.length < ULTI_PAGE || fresh === 0 || rows.length >= MAX_JOBS_PER_BOARD) break;
    if (page === maxPages - 1) note = `list stopped at the page cap (${maxPages})`;
  }
  if (note) ctx.warn?.(`partial: ${rows.length} listed; ${note}`);
  return normalizeUltipro(rows, c, ctx);
}

export const shapeSpec = z.object({ Id: z.union([z.string(), z.number()]), Title: z.string() }).passthrough();
export const provider = makeBoardProvider('ultipro', fetchUltipro, shapeSpec, (r) => {
  const list = (r[0] as any)?.opportunities;
  return Array.isArray(list) ? list : [r[0]];
});
