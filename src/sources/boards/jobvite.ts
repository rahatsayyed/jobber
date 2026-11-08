// Adapted from career-ops-hq/career-ops providers/jobvite.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama)
// Two public calls per fetch (the JSON API career-ops replaced is retired):
//   1. GET https://jobs.jobvite.com/<slug>?fr=true&nl=1   -> the board page carries `companyEId: '<eid>'` in inline JS
//   2. GET https://app.jobvite.com/CompanyJobs/Xml.aspx?c=<eid> -> <result><job><id/><title/><location/><date>M/D/YYYY</date><detail-url/><apply-url/>...
// Rows that share a detail URL are one posting with several locations. career-ops ignores the description; it is read here when the feed has one.
// Tenants whose board page redirects to a branded site, and a board with no open jobs (the feed redirects to NoJobs.htm), fail with a labelled
// transport error because redirects are refused here (career-ops treats the NoJobs redirect as an empty board). Discover-only.
import { assertVendorSlug, type TrackedCompany } from './filters.js';
import { MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, getText } from './transport.js';
import { hasPlainAuthority, shortHash } from './util.js';
import { childOf, childrenOf, parseXml, textOf } from './xml.js';
import { getHtml, makeJob, mdyToIso, sameHostUrl } from './htmlList.js';
import { z } from 'zod';
import { makeBoardProvider } from './provider.js';

const BOARD_HOST = 'jobs.jobvite.com';
const FEED_HOST = 'app.jobvite.com';
const EID_RE = /companyEId\s*[:=]\s*['"]([A-Za-z0-9_-]{4,40})['"]/;

export const extractEid = (html: string): string | null => EID_RE.exec(html.slice(0, 2_000_000))?.[1] ?? null;

export function normalizeJobviteXml(xml: string, c: TrackedCompany, ctx: FetchCtx = {}): BoardJob[] {
  assertVendorSlug(c);
  const result = childOf(parseXml(xml), 'result');
  if (!result) throw new Error(`jobvite ${c.slug}: unexpected response shape (no result element)`);
  const canonical = `https://${BOARD_HOST}/${c.slug}`;
  const byUrl = new Map<string, { job: BoardJob; places: Set<string> }>();
  let noDescription = 0;
  for (const j of childrenOf(result, 'job').slice(0, MAX_JOBS_PER_BOARD * 4)) {
    const title = textOf(j, 'title');
    const detail = textOf(j, 'detail-url') || textOf(j, 'apply-url');
    if (!title || !detail) continue;
    const place = textOf(j, 'location');
    const seen = byUrl.get(detail);
    if (seen) { if (place) seen.places.add(place); continue; }
    const rawId = textOf(j, 'id');
    const onVendor = hasPlainAuthority(detail.replace(/^http:/i, 'https:')) ? sameHostUrl(detail.replace(/^http:/i, 'https:'), canonical, BOARD_HOST) : null;
    const job = makeJob({
      prefix: 'jv', source: 'jobvite', c, key: /^[A-Za-z0-9_-]{1,40}$/.test(rawId) ? rawId : shortHash(detail), title,
      url: onVendor ?? canonical, description: textOf(j, 'description'), posted: mdyToIso(textOf(j, 'date')), locations: place ? [place] : [],
    });
    if (!job) continue;
    if (!job.description) noDescription++;
    byUrl.set(detail, { job, places: new Set(place ? [place] : []) });
    if (byUrl.size >= MAX_JOBS_PER_BOARD) break;
  }
  const out = [...byUrl.values()].map(({ job, places }) => {
    job.locations = [...places];
    job.remote = job.remote || job.locations.some((l) => /remote/i.test(l));
    return job;
  });
  if (noDescription) ctx.warn?.(`${noDescription} of ${out.length} postings had no description (feed fields changed?)`);
  return out;
}

export async function fetchJobvite(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const label = `jobvite ${c.slug}`;
  const page = await getHtml(`https://${BOARD_HOST}/${encodeURIComponent(c.slug)}?fr=true&nl=1`, label, exactHosts(BOARD_HOST));
  const eid = extractEid(page);
  if (!eid) throw new Error(`${label}: no companyEId on the board page (branded or retired tenant?)`);
  const xml = await getText(`https://${FEED_HOST}/CompanyJobs/Xml.aspx?c=${encodeURIComponent(eid)}`, label, { hosts: exactHosts(FEED_HOST) });
  try {
    return normalizeJobviteXml(xml, c, ctx);
  } catch (e: any) {
    const m = String(e?.message ?? e);
    throw new Error(m.startsWith('jobvite ') ? m : `${label}: ${m}`);
  }
}

export const shapeSpec = z.object({ title: z.string().min(1), url: z.string().min(1) }).passthrough();
export const provider = makeBoardProvider('jobvite', fetchJobvite, shapeSpec, (r) => {
  // The sink holds the board page first and the feed second; the feed is the one that parses as <result>.
  for (const raw of r) {
    if (typeof raw !== 'string') continue;
    const result = childOf(parseXml(raw.includes('<result') ? raw : '<x/>'), 'result');
    if (result) return childrenOf(result, 'job').slice(0, 5).map((j) => ({ title: textOf(j, 'title'), url: textOf(j, 'detail-url') || textOf(j, 'apply-url') }));
  }
  return [{ envelope: 'missing' }];
});
