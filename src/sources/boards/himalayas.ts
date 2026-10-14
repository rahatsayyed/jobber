// Adapted from career-ops-hq/career-ops providers/himalayas.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama). See that repo's LICENSE.
// Board-wide remote jobs feed: GET https://himalayas.app/jobs/api?limit=50
//   -> { jobs: [{ title, companyName, companySlug, locationRestrictions: [string], applicationLink, guid, pubDate (epoch seconds) }] }
// career-ops makes ONE request. Not confirmed from career-ops code (see "Unverified assumptions" in plan 5): the `offset` parameter used for
// pages 2..max_pages (default 3), and the `description` / `excerpt` fields. Both fail soft: a page that repeats stops the paging with a warning,
// and a posting without a description is skipped (it would be saved description-less) and counted in a warning.
// A job's url and apply_url are the himalayas.app page (applicationLink or guid), https on himalayas.app only; discover-only (src/lib/discoverOnly.ts).
// An empty locationRestrictions ARRAY means "no restriction" and is kept as a bare remote role. A locationRestrictions that is not an array of
// strings (a string, null, missing, mixed entries) is unknown, never "unrestricted": the posting is skipped and counted in a warning.
// "Page repeated" is judged on the raw feed identities (guid, link, title+company), not on the postings kept, so a page skipped for bad URLs is no repeat.
// UNREVIEWED: Himalayas' API terms and attribution requirements (a link back to himalayas.app) have not been reviewed by the maintainer; check them before relying on this feed.
import { toIsoDay } from '../../db.js';
import { hostMatches } from '../../lib/hostClass.js';
import { htmlToPlain, type TrackedCompany } from './filters.js';
import { capDescription, clip, MAX_JOBS_PER_BOARD, MAX_URL_CHARS, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, getJson } from './transport.js';
import { hasPlainAuthority, pastDeadline, shortHash } from './util.js';

const HOSTS = exactHosts('himalayas.app');
export const HIMALAYAS_PAGE_SIZE = 50;
export const HIMALAYAS_DEFAULT_PAGES = 3;

const himalayasUrl = (u: unknown): string =>
  typeof u === 'string' && u.length <= MAX_URL_CHARS && hasPlainAuthority(u) && hostMatches(u, 'himalayas.app') ? u : '';

/** Stable identity of a raw feed entry, used only to detect a repeated page. */
export const rawKey = (j: any): string => (j && typeof j === 'object' ? String(j.guid ?? j.applicationLink ?? `${j.title}|${j.companyName}`) : '');

export function normalizeHimalayas(raw: any, c: TrackedCompany): { jobs: BoardJob[]; noDescription: number; badRestrictions: number } {
  const list = (Array.isArray(raw?.jobs) ? raw.jobs : []).slice(0, MAX_JOBS_PER_BOARD);
  const jobs: BoardJob[] = [];
  let noDescription = 0;
  let badRestrictions = 0;
  for (const j of list) {
    if (!j || typeof j.title !== 'string' || !j.title.trim() || typeof j.companyName !== 'string' || !j.companyName.trim()) continue;
    const url = himalayasUrl(j.applicationLink) || himalayasUrl(j.guid);
    if (!url) continue;
    const description = capDescription(htmlToPlain(typeof j.description === 'string' ? j.description : typeof j.excerpt === 'string' ? j.excerpt : ''));
    if (!description) { noDescription++; continue; }
    if (!Array.isArray(j.locationRestrictions) || j.locationRestrictions.some((x: unknown) => typeof x !== 'string')) { badRestrictions++; continue; }
    const restrictions = j.locationRestrictions
      .filter((x: string) => !!x.trim()).map((x: string) => clip(x.trim())).slice(0, 30);
    const posted = toIsoDay(j.pubDate);
    jobs.push({
      id: `himalayas:${shortHash(url, 16)}`,
      source: 'himalayas',
      title: clip(j.title.trim()),
      company: clip(j.companyName.trim()),
      url,
      apply_url: url,
      description,
      ...(posted ? { posted_at: posted } : {}),
      // every entry is a place the work is restricted to: "<region> only" so the shared "only" marker refuses it unless it is allow-listed (India passes first)
      locations: restrictions.length ? restrictions.map((r: string) => (/^(?:worldwide|anywhere|global)$/i.test(r) ? r : clip(`${r} only`))) : [''],
      remote: true,
    });
  }
  return { jobs, noDescription, badRestrictions };
}

export async function fetchHimalayas(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  const label = `himalayas ${c.slug}`;
  const pages = c.max_pages ?? HIMALAYAS_DEFAULT_PAGES;
  const out: BoardJob[] = [];
  const seen = new Set<string>();
  const rawSeen = new Set<string>();
  let noDescription = 0;
  let badRestrictions = 0;
  const notes: string[] = [];
  for (let page = 0; page < pages; page++) {
    if (page > 0 && pastDeadline(ctx.deadlineAt)) { notes.push(`paging stopped at page ${page} (time budget)`); break; }
    const url = `https://himalayas.app/jobs/api?limit=${HIMALAYAS_PAGE_SIZE}${page ? `&offset=${page * HIMALAYAS_PAGE_SIZE}` : ''}`;
    let raw: any;
    try {
      raw = await getJson(url, label, { hosts: HOSTS });
    } catch (e) {
      if (page === 0) throw e;
      notes.push(`paging stopped at page ${page}: ${String((e as Error)?.message ?? e).replace(`${label}: `, '')}`);
      break;
    }
    if (!raw || !Array.isArray(raw.jobs)) {
      if (page === 0) throw new Error(`${label}: unexpected response shape (no jobs array)`);
      notes.push(`paging stopped at page ${page}: unexpected response shape`);
      break;
    }
    const r = normalizeHimalayas(raw, c);
    noDescription += r.noDescription;
    badRestrictions += r.badRestrictions;
    for (const j of r.jobs) if (!seen.has(j.id)) { seen.add(j.id); out.push(j); }
    let newRaw = 0;
    for (const j of raw.jobs.slice(0, MAX_JOBS_PER_BOARD)) { const k = rawKey(j); if (!rawSeen.has(k)) { rawSeen.add(k); newRaw++; } }
    if (raw.jobs.length < HIMALAYAS_PAGE_SIZE) break;
    if (newRaw === 0) { notes.push(`paging stopped at page ${page} (page repeated: offset not honoured?)`); break; }
  }
  if (noDescription) notes.push(`${noDescription} posting(s) skipped: no description in the feed`);
  if (badRestrictions) notes.push(`${badRestrictions} posting(s) skipped: locationRestrictions missing or malformed (location unknown)`);
  if (notes.length) ctx.warn?.(notes.join('; '));
  return out;
}
