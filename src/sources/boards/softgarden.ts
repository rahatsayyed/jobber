// Adapted from career-ops-hq/career-ops providers/softgarden.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama)
// Public per-tenant widget page: GET https://<slug>.softgarden.io/<lang>/widgets/jobs   (<lang> = the entry's `site`, two letters, default "de")
//   <div class="matchElement" id="job_id_<n>"> <a href=".../job/<n>/Title">Title</a> <span class="location-view-item">City</span> <div class="matchValue date">D.M.YYYY</div>
// The widget has no description. The date is read as day.month.year or month/day/year exactly like career-ops. Discover-only.
import { assertVendorSlug, type TrackedCompany } from './filters.js';
import { MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts } from './transport.js';
import { anchorsOf, getHtml, makeJob, plain, sameHostUrl } from './htmlList.js';
import { toIsoDay } from '../../db.js';
import { z } from 'zod';
import { makeBoardProvider } from './provider.js';

const hostOf = (c: TrackedCompany): string => `${c.slug}.softgarden.io`;
const LANG_RE = /^[a-z]{2}$/;

/** ISO day from "D.M.YYYY" (dot, day first) or "M/D/YYYY" (slash, month first); undefined for anything else or a non-calendar day. */
export function softgardenDate(raw: string): string | undefined {
  const s = raw.trim();
  const dot = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/.exec(s);
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  const m = dot ?? slash;
  if (!m) return undefined;
  const [day, month] = dot ? [Number(m[1]), Number(m[2])] : [Number(m[2]), Number(m[1])];
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, month - 1, day));
  return month >= 1 && month <= 12 && dt.getUTCDate() === day ? toIsoDay(dt.getTime()) : undefined;
}

export interface SoftgardenRow { id: string; title: string; url: string; locations: string[]; posted?: string | undefined }
export function parseSoftgardenWidget(html: string, host: string, widgetUrl: string): SoftgardenRow[] {
  const rows: SoftgardenRow[] = [];
  const seen = new Set<string>();
  for (const block of String(html).split('<div class="matchElement" id="job_id_').slice(1, MAX_JOBS_PER_BOARD + 1)) {
    const part = block.slice(0, 20_000);
    const id = /^(\d{1,12})"/.exec(part)?.[1];
    if (!id || seen.has(id)) continue;
    const a = anchorsOf(part, 20).find((x) => /\/job\/[^/]/.test(x.href));
    const title = a ? plain(a.inner) : '';
    const url = a ? sameHostUrl(plain(a.href), widgetUrl, host) : null;
    if (!title || !url) continue;
    seen.add(id);
    const locations: string[] = [];
    for (const m of part.matchAll(/class="location-view-item"[^>]*>([^<]{1,200})</g)) { const l = plain(m[1]); if (l && !locations.includes(l)) locations.push(l); }
    const date = /class="matchValue date"[^>]*>([^<]{1,40})</.exec(part);
    rows.push({ id, title, url, locations, posted: date ? softgardenDate(plain(date[1])) : undefined });
  }
  return rows;
}

export async function fetchSoftgarden(c: TrackedCompany, _ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const lang = c.site ?? 'de';
  if (!LANG_RE.test(lang)) throw new Error(`softgarden ${c.slug}: site must be a two-letter language code like "de" or "en"`);
  const host = hostOf(c);
  const widgetUrl = `https://${host}/${lang}/widgets/jobs`;
  const html = await getHtml(widgetUrl, `softgarden ${c.slug}`, exactHosts(host));
  return parseSoftgardenWidget(html, host, widgetUrl).flatMap((r) => makeJob({ prefix: 'sg', source: 'softgarden', c, key: r.id, title: r.title, url: r.url, locations: r.locations, posted: r.posted }) ?? []);
}

export const shapeSpec = z.object({ title: z.string().min(1), url: z.string().min(1) }).passthrough();
export const provider = makeBoardProvider('softgarden', fetchSoftgarden, shapeSpec, (r) => {
  const text = String(r[0]);
  const host = /https:\/\/([a-z0-9-]+\.softgarden\.io)\//i.exec(text)?.[1]?.toLowerCase() ?? 'x.softgarden.io';
  return parseSoftgardenWidget(text, host, `https://${host}/de/widgets/jobs`).slice(0, 5);
});
