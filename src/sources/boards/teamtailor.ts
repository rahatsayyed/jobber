// Adapted from career-ops-hq/career-ops providers/teamtailor.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama)
// Public per-tenant RSS feed: GET https://<slug>.teamtailor.com/jobs.rss
//   <rss><channel><item><title/><link/><pubDate/><description/><remoteStatus/><tt:locations><tt:location><tt:city/><tt:country/>...
// career-ops reads title, link, pubDate, remoteStatus and tt:city/tt:country. <description> is NOT read by career-ops: it is used here when present.
// Tenants that serve the feed on a branded domain are not supported (the host is pinned to <slug>.teamtailor.com); a job link on another
// host is replaced by the tenant jobs page (Safety rule 8). Discover-only (src/lib/discoverOnly.ts).
import { toIsoDay } from '../../db.js';
import { assertVendorSlug, type TrackedCompany } from './filters.js';
import { MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, getText } from './transport.js';
import { hasPlainAuthority, shortHash } from './util.js';
import { childOf, childrenOf, descendantsOf, parseXml, textOf } from './xml.js';
import { makeJob, sameHostUrl } from './htmlList.js';
import { z } from 'zod';
import { makeBoardProvider } from './provider.js';

const hostOf = (c: TrackedCompany): string => `${c.slug}.teamtailor.com`;
// RSS pubDate is RFC 822 ("Mon, 05 Oct 2026 09:30:00 +0000"); an unreadable date is left out.
const pubDay = (s: string): string | undefined => { const ms = Date.parse(s); return Number.isNaN(ms) ? undefined : toIsoDay(ms); };

export function normalizeTeamtailorRss(xml: string, c: TrackedCompany, ctx: FetchCtx = {}): BoardJob[] {
  assertVendorSlug(c);
  const channel = childOf(childOf(parseXml(xml), 'rss'), 'channel');
  if (!channel) throw new Error(`teamtailor ${c.slug}: unexpected response shape (no rss channel)`);
  const host = hostOf(c);
  const canonical = `https://${host}/jobs`;
  const out: BoardJob[] = [];
  let noDescription = 0;
  for (const item of childrenOf(channel, 'item').slice(0, MAX_JOBS_PER_BOARD)) {
    const title = textOf(item, 'title');
    const link = textOf(item, 'link');
    if (!title || !link) continue;
    const onVendor = hasPlainAuthority(link) ? sameHostUrl(link, canonical, host) : null;
    const url = onVendor ?? canonical;
    const num = /\/jobs\/(\d{1,12})(?:-|\/|$)/.exec(new URL(onVendor ?? canonical).pathname)?.[1];
    const places = descendantsOf(item, 'tt:location').map((l) => [textOf(l, 'tt:city'), textOf(l, 'tt:country')].filter(Boolean).join(', ')).filter(Boolean);
    const remoteStatus = textOf(item, 'remoteStatus').toLowerCase();
    const job = makeJob({
      prefix: 'tt', source: 'teamtailor', c, key: num ?? shortHash(`${link}|${title}`), title, url,
      description: textOf(item, 'description'), posted: pubDay(textOf(item, 'pubDate')),
      locations: places.length ? places : remoteStatus === 'fully' || remoteStatus === 'temporary' ? ['Remote'] : [],
      remote: remoteStatus === 'fully' || remoteStatus === 'temporary' || undefined,
    });
    if (!job) continue;
    if (!job.description) noDescription++;
    out.push(job);
  }
  if (noDescription) ctx.warn?.(`${noDescription} of ${out.length} postings had no description (feed fields changed?)`);
  return out;
}

export async function fetchTeamtailor(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const host = hostOf(c);
  const xml = await getText(`https://${host}/jobs.rss`, `teamtailor ${c.slug}`, { hosts: exactHosts(host) });
  try {
    return normalizeTeamtailorRss(xml, c, ctx);
  } catch (e: any) {
    const m = String(e?.message ?? e);
    throw new Error(m.startsWith('teamtailor ') ? m : `teamtailor ${c.slug}: ${m}`);
  }
}

export const shapeSpec = z.object({ title: z.string().min(1), link: z.string().min(1) }).passthrough();
export const provider = makeBoardProvider('teamtailor', fetchTeamtailor, shapeSpec, (r) => {
  const channel = childOf(childOf(parseXml(String(r[0])), 'rss'), 'channel');
  if (!channel) return [{ envelope: 'missing' }];
  return childrenOf(channel, 'item').slice(0, 5).map((i) => ({ title: textOf(i, 'title'), link: textOf(i, 'link') }));
});
