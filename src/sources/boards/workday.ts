// Adapted from career-ops-hq/career-ops providers/workday.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama). See that repo's LICENSE.
// Workday CXS, per tenant (host, wdN instance and site come from config, not one slug):
//   list:   POST https://<tenant>.<wdN>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/jobs   body { limit: 20, offset, searchText, appliedFacets: {} }
//           -> { total, jobPostings: [{ title, externalPath, locationsText, postedOn }] }   (no description, relative postedOn)
//   detail: GET  https://<tenant>.<wdN>.myworkdayjobs.com/wday/cxs/<tenant>/<site><externalPath>
//           -> { jobPostingInfo: { jobDescription (HTML), location, additionalLocations, startDate } }
// Request budget: the list is cheap (20 per page), the detail is one request per posting. So the provider FILTERS FIRST (title always, location
// when the list names one: "N Locations" placeholders pass), skips ids already stored, and details at most `max_detail` (default 40) of what is
// left, inside the board's own deadline. A posting without a detail document is NOT returned (it would be saved description-less and never
// re-fetched); it is retried on the next run. Returned jobs are discover-only (src/lib/discoverOnly.ts): Workday applications are account-gated.
import { toIsoDay } from '../../db.js';
import { assertVendorSlug, htmlToPlain, SITE_RE, WD_RE, type TrackedCompany } from './filters.js';
import { boardUrl, capDescription, clip, MAX_ID_CHARS, MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, getJson, postJson } from './transport.js';
import { pastDeadline, shortHash } from './util.js';

export const WORKDAY_PAGE_SIZE = 20;
export const DEFAULT_MAX_PAGES = 10;
export const DEFAULT_MAX_DETAIL = 40;
const DETAIL_BATCH = 3;
const PATH_RE = /^\/job\/[A-Za-z0-9_.~%()+,/-]{1,300}$/;
// Percent-encoded dot or slash (%2e, %2f in any case) could smuggle a traversal past the plain ".." and "//" checks.
const ENCODED_DOT_SLASH_RE = /%2[ef]/i;
const PLACEHOLDER_RE = /^\d+\s+locations?$/i;
const DAY = 86_400_000;

/** externalPath comes from the response and is appended to our own host: only a plain "/job/..." path is accepted. */
export function validExternalPath(p: unknown): p is string {
  return typeof p === 'string' && PATH_RE.test(p) && !ENCODED_DOT_SLASH_RE.test(p) && !p.includes('..') && !p.includes('//');
}

/** "Posted Today", "Posted Yesterday", "Posted 5 Days Ago" -> YYYY-MM-DD; "Posted 30+ Days Ago" and anything else -> undefined. */
export function parsePostedOn(label: unknown, now: number = Date.now()): string | undefined {
  if (typeof label !== 'string') return undefined;
  if (/posted\s+today/i.test(label)) return toIsoDay(now);
  if (/posted\s+yesterday/i.test(label)) return toIsoDay(now - DAY);
  const m = /posted\s+(\d{1,3})(\+?)\s*days?/i.exec(label);
  if (!m || m[2] === '+') return undefined;
  return toIsoDay(now - Number(m[1]) * DAY);
}

interface Candidate { title: string; externalPath: string; listLocation: string; postedOn: unknown; id: string }

export async function fetchWorkday(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const label = `workday ${c.slug}`;
  if (!c.wd || !c.site) throw new Error(`${label}: config needs wd and site`);
  if (!WD_RE.test(c.wd) || !SITE_RE.test(c.site)) throw new Error(`${label}: invalid wd or site`);
  const base = `https://${c.slug}.${c.wd}.myworkdayjobs.com`;
  const jobBase = `${base}/${c.site}`;
  const api = `${base}/wday/cxs/${c.slug}/${c.site}`;
  const opts = { hosts: exactHosts(`${c.slug}.${c.wd}.myworkdayjobs.com`), headers: { Origin: base, Referer: `${jobBase}/`, 'Accept-Language': 'en-US,en;q=0.9' } };
  const maxPages = c.max_pages ?? DEFAULT_MAX_PAGES;
  const maxDetail = c.max_detail ?? DEFAULT_MAX_DETAIL;
  const notes: string[] = [];

  // 1. List pages (the first page always runs; later pages stop at the deadline).
  const candidates: Candidate[] = [];
  const seenPaths = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    if (page > 0 && pastDeadline(ctx.deadlineAt)) { notes.push(`list stopped at page ${page} (time budget)`); break; }
    let json: any;
    try {
      json = await postJson(`${api}/jobs`, { limit: WORKDAY_PAGE_SIZE, offset: page * WORKDAY_PAGE_SIZE, searchText: c.search ?? '', appliedFacets: {} }, label, opts);
    } catch (e) {
      if (page === 0) throw e;
      notes.push(`list stopped at page ${page}: ${String((e as Error)?.message ?? e).replace(`${label}: `, '')}`);
      break;
    }
    if (!json || !Array.isArray(json.jobPostings)) {
      if (page === 0) throw new Error(`${label}: unexpected response shape (no jobPostings array)`);
      notes.push(`list stopped at page ${page}: unexpected response shape`);
      break;
    }
    const postings: any[] = json.jobPostings;
    if (!postings.length) break;
    let fresh = 0;
    for (const p of postings) {
      if (!p || typeof p.title !== 'string' || !p.title.trim() || !validExternalPath(p.externalPath) || seenPaths.has(p.externalPath)) continue;
      const id = `wd:${c.slug}:${c.site}:${shortHash(p.externalPath)}`;
      if (id.length > MAX_ID_CHARS) continue;
      seenPaths.add(p.externalPath);
      fresh++;
      candidates.push({ title: clip(p.title.trim()), externalPath: p.externalPath, listLocation: typeof p.locationsText === 'string' ? clip(p.locationsText.trim()) : '', postedOn: p.postedOn, id });
    }
    // Some tenants clamp the offset and serve the same page again: no new posting on a page means the list is exhausted.
    if (fresh === 0) { notes.push(`list stopped at page ${page} (page repeated, offset ceiling)`); break; }
    if (candidates.length >= MAX_JOBS_PER_BOARD || postings.length < WORKDAY_PAGE_SIZE) break;
    if (typeof json.total === 'number' && (page + 1) * WORKDAY_PAGE_SIZE >= json.total) break;
  }

  // 2. Filter first, then skip stored ids.
  const titleOk = ctx.titleOk ?? (() => true);
  const prefilter = ctx.prefilter ?? (() => true);
  const wanted = candidates.filter((k) => {
    if (!titleOk(k.title)) return false;
    // "3 Locations" or an empty text tells nothing: the detail document decides, the final filter runs again after it.
    if (k.listLocation && !PLACEHOLDER_RE.test(k.listLocation) && !prefilter(k.title, [k.listLocation], /remote/i.test(k.listLocation))) return false;
    return !ctx.isKnown?.(k.id);
  });

  // 3. Detail requests, capped and inside the deadline.
  const out: BoardJob[] = [];
  const queue = wanted.slice(0, maxDetail);
  let failed = 0;
  let skippedForTime = 0;
  for (let i = 0; i < queue.length; i += DETAIL_BATCH) {
    if (pastDeadline(ctx.deadlineAt)) { skippedForTime = queue.length - i; break; }
    const batch = queue.slice(i, i + DETAIL_BATCH);
    const results = await Promise.all(batch.map(async (k) => {
      try {
        const detail = await getJson(`${api}${k.externalPath}`, label, opts);
        const info = detail?.jobPostingInfo;
        if (!info || typeof info.jobDescription !== 'string') return null;
        return { k, info };
      } catch { return null; }
    }));
    for (const r of results) {
      if (!r) { failed++; continue; }
      const { k, info } = r;
      const places = [info.location, ...(Array.isArray(info.additionalLocations) ? info.additionalLocations : [])]
        .filter((x: unknown): x is string => typeof x === 'string' && !!x.trim()).map((x: string) => clip(x.trim())).slice(0, 20);
      const locations = places.length ? [...new Set(places)] : (k.listLocation ? [k.listLocation] : []);
      const posted = toIsoDay(info.startDate) ?? parsePostedOn(k.postedOn);
      const url = boardUrl(`${jobBase}${k.externalPath}`, 'myworkdayjobs.com', jobBase);
      out.push({
        id: k.id,
        source: 'workday',
        title: k.title,
        company: c.name,
        url,
        apply_url: url,
        description: capDescription(htmlToPlain(info.jobDescription)),
        ...(posted ? { posted_at: posted } : {}),
        locations,
        remote: locations.some((l) => /remote/i.test(l)) || /remote/i.test(k.title),
      });
    }
  }

  const deferred = Math.max(0, wanted.length - queue.length) + skippedForTime;
  if (failed) notes.push(`${failed} detail request(s) failed (retried next run)`);
  if (deferred) notes.push(`${deferred} posting(s) deferred to the next run (max_detail ${maxDetail} or time budget)`);
  if (notes.length) ctx.warn?.(`partial: listed ${candidates.length}, ${wanted.length} passed the prefilter, ${out.length} returned; ${notes.join('; ')}`);
  return out;
}
