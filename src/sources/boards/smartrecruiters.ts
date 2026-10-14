// Adapted from career-ops-hq/career-ops providers/smartrecruiters.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama). See that repo's LICENSE.
//   list:   GET https://api.smartrecruiters.com/v1/companies/<slug>/postings?limit=100&offset=<n>&status=PUBLIC
//           -> { content: [{ id, name, ref, refNumber, language: { code }, location: { fullLocation, city, region, country, remote } }] }   (no description)
//   detail: GET https://api.smartrecruiters.com/v1/companies/<slug>/postings/<id>
//           -> { jobAd: { sections: { companyDescription, jobDescription, qualifications, additionalInformation: { text (HTML) } } } }
// Same request budget as workday.ts: filter first (title and location from portals.json), skip stored ids, detail at most `max_detail`
// (default 25, batches of 5) inside the board deadline, and never return a posting without its detail (it would be saved description-less and never
// re-fetched). The public URL is https://jobs.smartrecruiters.com/<slug>/<id>-<title-slug> (the API "ref" with a /postings/ segment 404s on the public site).
// Discover-only (see src/lib/discoverOnly.ts).
import { toIsoDay } from '../../db.js';
import { assertVendorSlug, htmlToPlain, type TrackedCompany } from './filters.js';
import { boardUrl, capDescription, clip, MAX_ID_CHARS, MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, getJson } from './transport.js';
import { pastDeadline } from './util.js';

const HOSTS = exactHosts('api.smartrecruiters.com');
export const SR_PAGE_SIZE = 100;
export const SR_MAX_PAGES = 50;
export const SR_DEFAULT_MAX_DETAIL = 25;
const SR_DETAIL_BATCH = 5;
const POSTING_ID_RE = /^[A-Za-z0-9-]{1,60}$/;
const SECTIONS = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation'] as const;

const str = (x: unknown): string => (typeof x === 'string' ? x.trim() : '');
const titleSlug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/g, '');

interface Candidate { id: string; jobId: string; title: string; location: string; remote: boolean }

export function descriptionFromDetail(detail: any): string {
  const sections = detail?.jobAd?.sections;
  if (!sections || typeof sections !== 'object') return '';
  return SECTIONS.map((k) => htmlToPlain(typeof sections[k]?.text === 'string' ? sections[k].text : '')).filter(Boolean).join('\n\n');
}

export async function fetchSmartRecruiters(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const label = `smartrecruiters ${c.slug}`;
  const root = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(c.slug)}/postings`;
  const maxDetail = c.max_detail ?? SR_DEFAULT_MAX_DETAIL;
  const notes: string[] = [];

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let idTooLong = 0;
  for (let page = 0; page < SR_MAX_PAGES; page++) {
    if (page > 0 && pastDeadline(ctx.deadlineAt)) { notes.push(`list stopped at page ${page} (time budget)`); break; }
    let json: any;
    try {
      json = await getJson(`${root}?limit=${SR_PAGE_SIZE}&offset=${page * SR_PAGE_SIZE}&status=PUBLIC`, label, { hosts: HOSTS });
    } catch (e) {
      if (page === 0) throw e;
      notes.push(`list stopped at page ${page}: ${String((e as Error)?.message ?? e).replace(`${label}: `, '')}`);
      break;
    }
    if (!json || !Array.isArray(json.content)) {
      if (page === 0) throw new Error(`${label}: unexpected response shape (no content array)`);
      notes.push(`list stopped at page ${page}: unexpected response shape`);
      break;
    }
    let fresh = 0;
    for (const p of json.content) {
      if (!p || typeof p.id !== 'string' || !POSTING_ID_RE.test(p.id) || !str(p.name) || seen.has(p.id)) continue;
      const jobId = `sr:${c.slug}:${p.id}`;
      if (jobId.length > MAX_ID_CHARS) { idTooLong++; continue; }
      seen.add(p.id);
      fresh++;
      const loc = p.location ?? {};
      const place = str(loc.fullLocation) || [str(loc.city), str(loc.region), str(loc.country)].filter(Boolean).join(', ');
      const remote = loc.remote === true;
      candidates.push({ id: p.id, jobId, title: clip(str(p.name)), location: clip([place, remote && !/remote/i.test(place) ? 'Remote' : ''].filter(Boolean).join(', ')), remote });
    }
    if (json.content.length < SR_PAGE_SIZE || fresh === 0 || candidates.length >= MAX_JOBS_PER_BOARD) break;
  }

  const titleOk = ctx.titleOk ?? (() => true);
  const prefilter = ctx.prefilter ?? (() => true);
  const wanted = candidates.filter((k) => titleOk(k.title) && prefilter(k.title, [k.location], k.remote) && !ctx.isKnown?.(k.jobId));

  const out: BoardJob[] = [];
  const queue = wanted.slice(0, maxDetail);
  let failed = 0;
  let skippedForTime = 0;
  for (let i = 0; i < queue.length; i += SR_DETAIL_BATCH) {
    if (pastDeadline(ctx.deadlineAt)) { skippedForTime = queue.length - i; break; }
    const results = await Promise.all(queue.slice(i, i + SR_DETAIL_BATCH).map(async (k) => {
      try {
        const detail = await getJson(`${root}/${k.id}`, label, { hosts: HOSTS });
        const description = descriptionFromDetail(detail);
        return description ? { k, description, released: detail?.releasedDate } : null;
      } catch { return null; }
    }));
    for (const r of results) {
      if (!r) { failed++; continue; }
      const { k } = r;
      const slug = titleSlug(k.title);
      const canonical = `https://jobs.smartrecruiters.com/${c.slug}/${k.id}`;
      const url = boardUrl(`${canonical}${slug ? `-${slug}` : ''}`, 'smartrecruiters.com', canonical);
      const posted = toIsoDay(r.released);
      out.push({
        id: k.jobId,
        source: 'smartrecruiters',
        title: k.title,
        company: c.name,
        url,
        apply_url: url,
        description: capDescription(r.description),
        ...(posted ? { posted_at: posted } : {}),
        locations: [k.location],
        remote: k.remote || /remote/i.test(k.location),
      });
    }
  }

  const deferred = Math.max(0, wanted.length - queue.length) + skippedForTime;
  if (idTooLong) notes.push(`${idTooLong} posting(s) dropped: id "sr:<slug>:<id>" exceeds ${MAX_ID_CHARS} characters (slug too long)`);
  if (failed) notes.push(`${failed} detail request(s) failed or had no description (not stored, so they are retried next run and use up max_detail again)`);
  if (deferred) notes.push(`${deferred} posting(s) deferred to the next run (max_detail ${maxDetail} or time budget)`);
  if (notes.length) ctx.warn?.(`partial: listed ${candidates.length}, ${wanted.length} passed the prefilter, ${out.length} returned; ${notes.join('; ')}`);
  return out;
}
