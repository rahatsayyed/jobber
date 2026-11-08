// Adapted from career-ops-hq/career-ops providers/hibob.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama). See that repo's LICENSE.
// HiBob "Bob" hiring module, one tenant per company at https://<slug>.careers.hibob.com. One request for the whole board, no login:
//   GET https://<slug>.careers.hibob.com/api/job-ad   with the header  companyidentifier: <slug>
//   -> { jobAdDetails: [{ id, title, site, country, workspaceTypeId, publishedAt, description, responsibilities, requirements, benefits }] }
// The description is inline. A label that is not a tenant answers 401 (reported as "no such careers site"). Any envelope without
// jobAdDetails[] is an error, never an empty board. Posting URL: https://<slug>.careers.hibob.com/jobs/<id>. Salary is not carried over.
// Live-unverified (shape read from career-ops code). Discover-only (see src/lib/discoverOnly.ts).
import { toIsoDay } from '../../db.js';
import { assertVendorSlug, htmlToPlain, type TrackedCompany } from './filters.js';
import { capDescription, clip, MAX_ID_CHARS, MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, getJson } from './transport.js';
import { shortHash } from './util.js';
import { z } from 'zod';
import { listAt, makeBoardProvider } from './provider.js';

const KEY_RE = /^[A-Za-z0-9_-]{1,60}$/;
const str = (x: unknown): string => (typeof x === 'string' ? x.trim() : '');

function placeOf(j: any): string {
  const site = str(j.site);
  const country = str(j.country);
  const parts = [site];
  if (country && !site.toLowerCase().includes(country.toLowerCase())) parts.push(country);
  if (str(j.workspaceTypeId) === 'remote' && !/\bremote\b/i.test(site)) parts.push('Remote');
  return clip(parts.filter(Boolean).join(', '));
}

export function normalizeHibob(raw: any, c: TrackedCompany, ctx: FetchCtx = {}): BoardJob[] {
  assertVendorSlug(c);
  if (!raw || !Array.isArray(raw.jobAdDetails)) throw new Error(`hibob ${c.slug}: unexpected response shape (no jobAdDetails array)`);
  const out: BoardJob[] = [];
  let noDescription = 0;
  for (const j of raw.jobAdDetails.slice(0, MAX_JOBS_PER_BOARD) as any[]) {
    if (!j || typeof j !== 'object') continue;
    const title = str(j.title);
    const rawId = str(j.id);
    if (!title || !rawId) continue;
    const key = KEY_RE.test(rawId) ? rawId : shortHash(rawId);
    const id = `hb:${c.slug}:${key}`;
    if (id.length > MAX_ID_CHARS) continue;
    const url = `https://${c.slug}.careers.hibob.com/jobs/${key}`;
    const place = placeOf(j);
    const posted = toIsoDay(j.publishedAt);
    const body = ['description', 'responsibilities', 'requirements', 'benefits'].map((k) => str(j[k])).filter(Boolean).join('\n');
    const plain = capDescription(htmlToPlain(body));
    if (!plain) noDescription++;
    out.push({
      id, source: 'hibob', title: clip(title), company: c.name, url, apply_url: url, description: plain,
      ...(posted ? { posted_at: posted } : {}), locations: place ? [place] : [], remote: /remote/i.test(place),
    });
  }
  if (noDescription) ctx.warn?.(`${noDescription} of ${out.length} postings had no description (job-ad fields changed?)`);
  return out;
}

export async function fetchHibob(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const label = `hibob ${c.slug}`;
  let raw: any;
  try {
    raw = await getJson(`https://${c.slug}.careers.hibob.com/api/job-ad`, label, { hosts: exactHosts(`${c.slug}.careers.hibob.com`), headers: { companyidentifier: c.slug } });
  } catch (e: any) {
    if (/HTTP 401$/.test(String(e?.message))) throw new Error(`${label}: no such careers site (HTTP 401)`);
    throw e;
  }
  if (!raw || !Array.isArray(raw.jobAdDetails)) throw new Error(`${label}: unexpected response shape (no jobAdDetails array)`);
  return normalizeHibob(raw, c, ctx);
}

export const shapeSpec = z.object({ title: z.string() }).passthrough();
export const provider = makeBoardProvider('hibob', fetchHibob, shapeSpec, (r) => listAt(r[0], 'jobAdDetails'));
