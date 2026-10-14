// Adapted from career-ops-hq/career-ops providers/recruitee.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama). See that repo's LICENSE.
// Public per-tenant offers API: GET https://<slug>.recruitee.com/api/offers/
//   -> { offers: [{ title, careers_url, url, city, country, remote, location, locations: [{ name, city, country }], description }] }
// career-ops reads exactly those fields (description is inline in the list). `id`, `slug`, `requirements` and `published_at` are NOT read by
// career-ops: they are used here when present and every one of them has a fallback (see "Unverified assumptions" in plan 5).
// Discover-only: Recruitee apply support is future work (see src/lib/discoverOnly.ts).
import { toIsoDay } from '../../db.js';
import { assertVendorSlug, htmlToPlain, type TrackedCompany } from './filters.js';
import { boardUrl, capDescription, clip, MAX_ID_CHARS, MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { apexHosts, getJson } from './transport.js';
import { hasPlainAuthority, shortHash } from './util.js';

const HOSTS = apexHosts('recruitee.com');
const OFFER_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
// Recruitee seeds demo tenants with a shared posting whose title carries its own "(Sample)" marker.
const SAMPLE_RE = /\(sample\)/i;

const str = (x: unknown): string => (typeof x === 'string' ? x.trim() : '');

function placesOf(j: any): string[] {
  const named = (Array.isArray(j.locations) ? j.locations : [])
    .map((l: any) => [str(l?.name), str(l?.city), str(l?.country)].filter(Boolean))
    .map((parts: string[]) => [...new Set(parts)].join(', '))
    .filter(Boolean);
  if (named.length) return [...new Set<string>(named)].map(clip);
  const flat = [str(j.location) || str(j.city), str(j.country)].filter(Boolean);
  const one = [...new Set(flat)].join(', ');
  return one ? [clip(one)] : [];
}

export function normalizeRecruitee(raw: any, c: TrackedCompany, ctx: FetchCtx = {}): BoardJob[] {
  assertVendorSlug(c);
  const offers = (Array.isArray(raw?.offers) ? raw.offers : []).slice(0, MAX_JOBS_PER_BOARD);
  const out: BoardJob[] = [];
  let noDescription = 0;
  for (const j of offers) {
    if (!j || typeof j !== 'object') continue;
    const title = str(j.title);
    if (!title || SAMPLE_RE.test(title)) continue;
    const offerSlug = typeof j.slug === 'string' && OFFER_SLUG_RE.test(j.slug) ? j.slug : '';
    const key = Number.isSafeInteger(j.id) && j.id > 0 ? String(j.id) : shortHash(`${str(j.careers_url)}|${str(j.url)}|${offerSlug}|${title}`);
    const id = `rc:${c.slug}:${key}`;
    if (id.length > MAX_ID_CHARS) continue;
    const canonical = offerSlug ? `https://${c.slug}.recruitee.com/o/${offerSlug}` : `https://${c.slug}.recruitee.com/`;
    // careers_url or url, each only when https on recruitee.com (tenants on their own domain fall back to the canonical URL).
    let url = boardUrl(hasPlainAuthority(j.careers_url) ? j.careers_url : undefined, 'recruitee.com', canonical);
    if (url === canonical) url = boardUrl(hasPlainAuthority(j.url) ? j.url : undefined, 'recruitee.com', canonical);
    const places = placesOf(j);
    // Recruitee writes dates like "2026-10-02 08:00:00 UTC" (unverified): turn the "UTC" suffix into "Z" so toIsoDay can read it.
    const rawDate = j.published_at ?? j.created_at;
    const posted = toIsoDay(typeof rawDate === 'string' ? rawDate.replace(/\s+UTC$/i, 'Z') : rawDate);
    const description = [j.description, j.requirements].filter((x): x is string => typeof x === 'string' && !!x.trim()).join('\n');
    const plain = capDescription(htmlToPlain(description));
    if (!plain) noDescription++;
    out.push({
      id,
      source: 'recruitee',
      title: clip(title),
      company: c.name,
      url,
      apply_url: url,
      description: plain,
      ...(posted ? { posted_at: posted } : {}),
      locations: places,
      remote: j.remote === true || places.some((p) => /remote/i.test(p)),
    });
  }
  if (noDescription) ctx.warn?.(`${noDescription} of ${out.length} postings had no description (offer fields changed?)`);
  return out;
}

export async function fetchRecruitee(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const label = `recruitee ${c.slug}`;
  const raw = await getJson(`https://${c.slug}.recruitee.com/api/offers/`, label, { hosts: HOSTS });
  if (!raw || !Array.isArray(raw.offers)) throw new Error(`${label}: unexpected response shape (no offers array)`);
  return normalizeRecruitee(raw, c, ctx);
}
