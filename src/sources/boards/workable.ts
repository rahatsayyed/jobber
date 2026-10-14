// Adapted from career-ops-hq/career-ops providers/workable.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama). See that repo's LICENSE.
// Public account widget API, one request returns the whole posting list with descriptions and dates:
//   GET https://apply.workable.com/api/v1/widget/accounts/<slug>?details=true
//   -> { name, description, jobs: [{ title, shortcode, shortlink, url, department, city, state, country, telecommuting, published_on, description }] }
// Cloudflare fronts every tenant on the single host apply.workable.com, so requests to it are serialized process-wide.
// Discover-only: there is no Workable apply module (see src/lib/discoverOnly.ts).
import { toIsoDay } from '../../db.js';
import { assertVendorSlug, htmlToPlain, type TrackedCompany } from './filters.js';
import { boardUrl, capDescription, clip, MAX_ID_CHARS, MAX_JOBS_PER_BOARD, type BoardJob } from './greenhouse.js';
import { exactHosts, getJson } from './transport.js';
import { hasPlainAuthority } from './util.js';

const HOSTS = exactHosts('apply.workable.com');
const SHORTCODE_RE = /^[A-Za-z0-9]{1,40}$/;

let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

// Same "2026-10-02 08:00:00 UTC" style as Recruitee: read the UTC suffix as Z so toIsoDay accepts it.
const isoInput = (v: unknown): unknown => (typeof v === 'string' ? v.replace(/\s+UTC$/i, 'Z') : v);

export function normalizeWorkable(raw: any, c: TrackedCompany): BoardJob[] {
  assertVendorSlug(c);
  const list = (Array.isArray(raw?.jobs) ? raw.jobs : []).slice(0, MAX_JOBS_PER_BOARD);
  const out: BoardJob[] = [];
  for (const j of list) {
    if (!j || typeof j.title !== 'string' || typeof j.shortcode !== 'string' || !SHORTCODE_RE.test(j.shortcode)) continue;
    const id = `wk:${c.slug}:${j.shortcode}`;
    if (id.length > MAX_ID_CHARS) continue;
    const canonical = `https://apply.workable.com/${c.slug}/j/${j.shortcode}/`;
    // shortlink first, then url; each must be https on apply.workable.com, otherwise the canonical URL built from the shortcode.
    let url = boardUrl(hasPlainAuthority(j.shortlink) ? j.shortlink : undefined, 'apply.workable.com', canonical);
    if (url === canonical) url = boardUrl(hasPlainAuthority(j.url) ? j.url : undefined, 'apply.workable.com', canonical);
    const place = [j.city, j.country].filter((x: unknown): x is string => typeof x === 'string' && !!x.trim()).map((x: string) => x.trim()).join(', ');
    const remote = j.telecommuting === true;
    const posted = toIsoDay(isoInput(j.published_on ?? j.created_at));
    out.push({
      id,
      source: 'workable',
      title: clip(j.title),
      company: c.name,
      url,
      apply_url: url,
      description: capDescription(htmlToPlain(typeof j.description === 'string' ? j.description : '')),
      ...(posted ? { posted_at: posted } : {}),
      locations: (place || remote) ? [clip(place || 'Remote')] : [],
      remote,
    });
  }
  return out;
}

export async function fetchWorkable(c: TrackedCompany): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const label = `workable ${c.slug}`;
  const raw = await serialized(() => getJson(
    `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(c.slug)}?details=true`,
    label,
    { hosts: HOSTS, headers: { Origin: 'https://apply.workable.com', Referer: `https://apply.workable.com/${c.slug}/` } },
  ));
  if (!raw || !Array.isArray(raw.jobs)) throw new Error(`${label}: unexpected response shape (no jobs array)`);
  return normalizeWorkable(raw, c);
}
