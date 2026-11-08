// Adapted from career-ops-hq/career-ops providers/keka.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama). See that repo's LICENSE.
// Keka (Indian HR/ATS), one tenant per company at https://<slug>.keka.com. Two requests, no JavaScript, no login:
//   1. GET https://<slug>.keka.com/careers -> a shell page whose fragment path holds the tenant UUID: /ats/documents/<uuid>/careerportal/<hash>.html
//   2. GET https://<slug>.keka.com/careers/api/embedjobs/default/active/<uuid>
//      -> [{ id, title, description (HTML), jobLocations: [{ name, city, state, countryName }], publishedOn }]   (top-level array, not paginated)
// An unknown tenant answers step 1 with a 302 (our transport refuses every redirect, so it shows up as a labelled error). A missing UUID or a
// non-array answer is an error, never an empty board. Posting URL: https://<slug>.keka.com/careers/jobdetails/<id> (built here, not read).
// Live-unverified (shape read from career-ops code). Discover-only (see src/lib/discoverOnly.ts).
import { toIsoDay } from '../../db.js';
import { assertVendorSlug, htmlToPlain, type TrackedCompany } from './filters.js';
import { capDescription, clip, MAX_ID_CHARS, MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, getJson, getText } from './transport.js';
import { shortHash } from './util.js';
import { z } from 'zod';
import { makeBoardProvider } from './provider.js';

const IDENTIFIER_RE = /\/ats\/documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/careerportal\//i;
// Hosts Keka runs itself; none of them is a customer tenant.
const RESERVED = new Set(['www', 'app', 'api', 'help', 'support', 'blog', 'docs', 'status', 'mail', 'developers']);
const JOB_KEY_RE = /^[A-Za-z0-9_-]{1,60}$/;

const str = (x: unknown): string => (typeof x === 'string' ? x.trim() : '');

export function extractKekaIdentifier(html: unknown): string | null {
  const m = typeof html === 'string' ? IDENTIFIER_RE.exec(html) : null;
  return m ? m[1].toLowerCase() : null;
}

/** "City, Country" per location, joined; the office label (`name`) is only the fallback. */
function placesOf(j: any): string[] {
  const out: string[] = [];
  for (const l of Array.isArray(j.jobLocations) ? j.jobLocations : []) {
    if (!l || typeof l !== 'object') continue;
    const place = [str(l.city), str(l.countryName)].filter(Boolean).join(', ') || str(l.name);
    if (place && !out.includes(place)) out.push(clip(place));
  }
  return out;
}

export function normalizeKeka(raw: unknown, c: TrackedCompany, ctx: FetchCtx = {}): BoardJob[] {
  assertVendorSlug(c);
  if (!Array.isArray(raw)) throw new Error(`keka ${c.slug}: unexpected response shape (no jobs array)`);
  const out: BoardJob[] = [];
  let noDescription = 0;
  for (const j of raw.slice(0, MAX_JOBS_PER_BOARD) as any[]) {
    if (!j || typeof j !== 'object') continue;
    const title = str(j.title).replace(/\s+/g, ' ');
    const rawId = typeof j.id === 'number' && Number.isSafeInteger(j.id) ? String(j.id) : str(j.id);
    if (!title || !rawId) continue;
    const key = JOB_KEY_RE.test(rawId) ? rawId : shortHash(rawId);
    const id = `ke:${c.slug}:${key}`;
    if (id.length > MAX_ID_CHARS) continue;
    const url = `https://${c.slug}.keka.com/careers/jobdetails/${key}`;
    const places = placesOf(j);
    const posted = toIsoDay(j.publishedOn);
    const plain = capDescription(htmlToPlain(str(j.description)));
    if (!plain) noDescription++;
    out.push({
      id, source: 'keka', title: clip(title), company: c.name, url, apply_url: url, description: plain,
      ...(posted ? { posted_at: posted } : {}), locations: places, remote: places.some((p) => /remote/i.test(p)) || /\bremote\b/i.test(title),
    });
  }
  if (noDescription) ctx.warn?.(`${noDescription} of ${out.length} postings had no description (embedjobs fields changed?)`);
  return out;
}

export async function fetchKeka(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const label = `keka ${c.slug}`;
  if (RESERVED.has(c.slug)) throw new Error(`${label}: not a customer tenant`);
  const origin = `https://${c.slug}.keka.com`;
  const opts = { hosts: exactHosts(`${c.slug}.keka.com`) };
  let shell: string;
  try { shell = await getText(`${origin}/careers`, label, { ...opts, accept: 'text/html,*/*;q=0.5' }); } catch (e: any) {
    // A 302 (unknown tenant) is refused by the transport and arrives as "request failed".
    throw new Error(/request failed/.test(String(e?.message)) ? `${label}: careers page did not load (unknown tenant or redirect)` : String(e?.message ?? e));
  }
  const identifier = extractKekaIdentifier(shell);
  if (!identifier) throw new Error(`${label}: careers page has no embedjobs identifier (structure changed?)`);
  const raw = await getJson(`${origin}/careers/api/embedjobs/default/active/${identifier}`, label, opts);
  if (!Array.isArray(raw)) throw new Error(`${label}: unexpected response shape (no jobs array)`);
  return normalizeKeka(raw, c, ctx);
}

// The first raw payload is the HTML shell; the sample is the jobs array that follows it.
export const shapeSpec = z.object({ title: z.string() }).passthrough();
export const provider = makeBoardProvider('keka', fetchKeka, shapeSpec, (r) => {
  const arr = r.find((x) => Array.isArray(x));
  return Array.isArray(arr) ? arr : [r[r.length - 1]];
});
