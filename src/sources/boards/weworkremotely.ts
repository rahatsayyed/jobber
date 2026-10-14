// Adapted from career-ops-hq/career-ops providers/weworkremotely.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama). See that repo's LICENSE.
// Board-wide RSS feed: GET https://weworkremotely.com/remote-jobs.rss
//   <rss><channel><item><title>Company: Role</title><link/><pubDate/><region/><category/>[<description/>]</item>...
// career-ops reads title, link, pubDate, region and category. The <description> element (HTML body) is NOT confirmed from career-ops code:
// an item without one is skipped and counted in a warning (it would be saved description-less). An item whose title has no "Company: " prefix is
// skipped too (no company means no contact search). url and apply_url are the weworkremotely.com page; discover-only (src/lib/discoverOnly.ts).
// Every posting here is remote; the region decides the location filter ("Anywhere in the World" is worldwide, "USA Only" is not).
// A region with exclusion wording ("Worldwide (excl. India)", "Anywhere (but not India)") is never mapped to bare Worldwide: the raw text is
// kept (negations rewritten to "excluding") so the location filter fails it.
// UNREVIEWED: We Work Remotely's terms of use and RSS usage policy have not been reviewed by the maintainer; read them before relying on this feed.
// pubDate is accepted only when the parsed UTC day equals the day-of-month written in the text (no 31 Feb rollover, no zone shift).
import { toIsoDay } from '../../db.js';
import { hostMatches } from '../../lib/hostClass.js';
import { htmlToPlain, type TrackedCompany } from './filters.js';
import { capDescription, clip, MAX_JOBS_PER_BOARD, MAX_URL_CHARS, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, getText } from './transport.js';
import { hasPlainAuthority, shortHash } from './util.js';
import { childOf, childrenOf, parseXml, textOf } from './xml.js';

const HOSTS = exactHosts('weworkremotely.com');
const FEED = 'https://weworkremotely.com/remote-jobs.rss';

const EXCLUSION = /(?<![a-z])(?:excl|excluding|except|outside|but\s+not|not|without)(?![a-z])/i;

/** Worldwide only for an unqualified worldwide region; exclusion text is kept (negations as "excluding") so locationAllowed rejects it. */
export function wwrLocation(region: string): string {
  const r = region.trim();
  if (EXCLUSION.test(r)) return clip(r.replace(/(?<![a-z])(?:but\s+not|not|without)(?![a-z])/gi, 'excluding'));
  return /anywhere in the world|worldwide/i.test(r) ? 'Worldwide' : clip(r || 'Unknown region');
}

/** ISO day from an RSS date, or undefined when unparseable, no readable day-of-month, or the UTC day differs from the written one. */
export function wwrDate(text: string): string | undefined {
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return undefined;
  const m = /(?:^|[^0-9])(\d{1,2})\s+[A-Za-z]{3}/.exec(text) ?? /\d{4}-\d{2}-(\d{2})/.exec(text);
  if (!m || new Date(ms).getUTCDate() !== Number(m[1])) return undefined;
  return toIsoDay(ms);
}

const wwrUrl = (u: string): string => (hasPlainAuthority(u) && u.length <= MAX_URL_CHARS && /^https:\/\//i.test(u) && hostMatches(u, 'weworkremotely.com') ? u : '');

export function normalizeWwr(xml: string, c: TrackedCompany): { jobs: BoardJob[]; noDescription: number } {
  const channel = childOf(childOf(parseXml(xml), 'rss'), 'channel');
  if (!channel) throw new Error(`weworkremotely ${c.slug}: unexpected response shape (no rss channel)`);
  const jobs: BoardJob[] = [];
  let noDescription = 0;
  for (const it of childrenOf(channel, 'item').slice(0, MAX_JOBS_PER_BOARD)) {
    const url = wwrUrl(textOf(it, 'link'));
    const raw = textOf(it, 'title');
    const colon = raw.indexOf(':');
    const company = colon > 0 ? raw.slice(0, colon).trim() : '';
    const title = colon > 0 ? raw.slice(colon + 1).trim() : '';
    if (!url || !company || !title) continue;
    const description = capDescription(htmlToPlain(textOf(it, 'description')));
    if (!description) { noDescription++; continue; }
    const region = textOf(it, 'region');
    const posted = wwrDate(textOf(it, 'pubDate'));
    jobs.push({
      id: `wwr:${shortHash(url, 16)}`,
      source: 'weworkremotely',
      title: clip(title),
      company: clip(company),
      url,
      apply_url: url,
      description,
      ...(posted ? { posted_at: posted } : {}),
      locations: [wwrLocation(region)],
      remote: true,
    });
  }
  return { jobs, noDescription };
}

export async function fetchWeWorkRemotely(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  const label = `weworkremotely ${c.slug}`;
  const xml = await getText(FEED, label, { hosts: HOSTS });
  let r: { jobs: BoardJob[]; noDescription: number };
  try {
    r = normalizeWwr(xml, c);
  } catch (e: any) {
    const m = String(e?.message ?? e);
    throw new Error(m.startsWith('weworkremotely ') ? m : `${label}: ${m}`);
  }
  if (r.noDescription) ctx.warn?.(`${r.noDescription} posting(s) skipped: no description in the feed`);
  return r.jobs;
}
