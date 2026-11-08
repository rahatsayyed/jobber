// Adapted from career-ops-hq/career-ops providers/eightfold.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama)
// Public per-tenant API on https://<slug>.eightfold.ai (the company domain goes in params.domain):
//   v2:   GET /api/apply/v2/jobs?domain=<domain>&start=<n>&num=10 -> { positions: [...], count }   (the server caps a page at 10 rows)
//   pcsx: GET /api/pcsx/search?domain=<domain>&start=<n>          -> { data: { count, positions: [...] } }   (probed once, only when v2 answers HTTP 403)
//   position: { id|position_id, name|posting_name, location, locations[], canonicalPositionUrl, t_create|t_update (epoch seconds) }  (pcsx: postedTs|creationTs)
// No description in the list and no detail request (as in career-ops). Page cap: max_pages (default 30 = 300 postings) and the board deadline.
// The URL is kept only on eightfold.ai; a tenant on its own domain falls back to <slug>.eightfold.ai/careers?pid=<id>&domain=<domain>. Discover-only.
import { assertVendorSlug, type TrackedCompany } from './filters.js';
import { boardUrl, MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, getJson } from './transport.js';
import { hasPlainAuthority, pastDeadline } from './util.js';
import { arr, buildJob, str } from './common.js';
import { paramsOf } from './vendorParams.js';
import { z } from 'zod';
import { makeBoardProvider } from './provider.js';

export const EIGHTFOLD_PAGE = 10;
export const EIGHTFOLD_DEFAULT_PAGES = 30;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** pcsx names its fields differently: fold them onto the v2 names. */
function foldPcsx(p: any): any {
  return { ...p, t_create: p.t_create ?? p.postedTs ?? p.creationTs, ats_job_id: p.ats_job_id ?? p.atsJobId ?? p.displayJobId };
}

export function normalizeEightfold(positions: unknown[], c: TrackedCompany, ctx: FetchCtx = {}): BoardJob[] {
  assertVendorSlug(c);
  const domain = paramsOf(c).domain ?? '';
  const out: BoardJob[] = [];
  const seen = new Set<string>();
  for (const p of positions.slice(0, MAX_JOBS_PER_BOARD) as any[]) {
    if (!p || typeof p !== 'object') continue;
    const title = str(p.name) || str(p.posting_name);
    const rawId = p.id ?? p.position_id;
    const id = typeof rawId === 'number' || typeof rawId === 'string' ? String(rawId).trim() : '';
    if (!title || !ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const canonical = `https://${c.slug}.eightfold.ai/careers?pid=${encodeURIComponent(id)}&domain=${encodeURIComponent(domain)}`;
    const url = boardUrl(hasPlainAuthority(p.canonicalPositionUrl) ? p.canonicalPositionUrl : undefined, 'eightfold.ai', canonical);
    const places = [str(p.location), ...arr(p.locations).map(str)].filter(Boolean);
    const job = buildJob({ prefix: 'ef', source: 'eightfold', c, key: id, title, url, posted: p.t_create ?? p.t_update, locations: places });
    if (job) out.push(job);
  }
  if (out.length) ctx.warn?.(`${out.length} postings have no description (the Eightfold list carries none)`);
  return out;
}

export async function fetchEightfold(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const label = `eightfold ${c.slug}`;
  const domain = paramsOf(c).domain;
  if (!domain) throw new Error(`${label}: needs params.domain`);
  const host = `${c.slug}.eightfold.ai`;
  const opts = { hosts: exactHosts(host) };
  const q = `domain=${encodeURIComponent(domain)}`;
  const maxPages = c.max_pages ?? EIGHTFOLD_DEFAULT_PAGES;
  const all: unknown[] = [];
  let pcsx = false;
  let note = '';
  for (let page = 0; page < maxPages; page++) {
    if (page > 0 && pastDeadline(ctx.deadlineAt)) { note = `list stopped at page ${page} (time budget)`; break; }
    const start = page * EIGHTFOLD_PAGE;
    let rows: unknown[]; let count: number | undefined;
    try {
      let raw: any;
      if (!pcsx) {
        try { raw = await getJson(`https://${host}/api/apply/v2/jobs?${q}&start=${start}&num=${EIGHTFOLD_PAGE}`, label, opts); }
        catch (e) {
          if (page === 0 && /HTTP 403/.test(String((e as Error)?.message))) { pcsx = true; } else throw e;
        }
      }
      if (pcsx) {
        raw = await getJson(`https://${host}/api/pcsx/search?${q}&start=${start}`, label, opts);
        const d = raw?.data;
        if (!d || !Array.isArray(d.positions)) throw new Error(`${label}: unexpected response shape (no data.positions array)`);
        rows = d.positions.map(foldPcsx); count = Number.isFinite(d.count) ? d.count : undefined;
      } else {
        if (!raw || !Array.isArray(raw.positions)) throw new Error(`${label}: unexpected response shape (no positions array)`);
        rows = raw.positions; count = Number.isFinite(raw.count) ? raw.count : undefined;
      }
    } catch (e) {
      if (page === 0) throw e;
      note = `list stopped at page ${page}: ${String((e as Error)?.message ?? e).replace(`${label}: `, '')}`;
      break;
    }
    all.push(...rows);
    if (rows.length < EIGHTFOLD_PAGE || (count !== undefined && start + EIGHTFOLD_PAGE >= count) || all.length >= MAX_JOBS_PER_BOARD) break;
    if (page === maxPages - 1) note = `list stopped at the page cap (${maxPages})`;
  }
  if (note) ctx.warn?.(`partial: ${all.length} listed; ${note}`);
  return normalizeEightfold(all, c, ctx);
}

export const shapeSpec = z.object({ name: z.string().optional(), posting_name: z.string().optional() }).passthrough()
  .refine((p) => typeof p.name === 'string' || typeof p.posting_name === 'string', { message: 'name or posting_name required' });
export const provider = makeBoardProvider('eightfold', fetchEightfold, shapeSpec, (r) => {
  const v = r[0] as any;
  return Array.isArray(v?.positions) ? v.positions : Array.isArray(v?.data?.positions) ? v.data.positions : [v];
});
