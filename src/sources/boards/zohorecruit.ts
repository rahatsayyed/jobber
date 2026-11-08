// Adapted from career-ops-hq/career-ops providers/zoho-recruit.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama). See that repo's LICENSE.
// Zoho Recruit career site, one tenant per company at https://<slug>.zohorecruit.<tld> (tld: config `tld`, default "com"; "in" for Indian data centres).
// The board is always read from /jobs/Careers. The page is server-rendered and carries the whole board as
//   <input type="hidden" id="jobs" value="[...]">   (a JSON array, quotes HTML-entity escaped), one request, no login.
// A page without that input (unknown tenant, legacy career site) is an error; id="jobs" with [] is an empty board.
// Rows with Is_Locked true or Publish false are shown as filled and are skipped. The description comes from the list row (the upstream opt-in
// per-posting detail fetch is not ported). Posting URL: https://<slug>.zohorecruit.<tld>/jobs/Careers/<id> (built here).
// Live-unverified (shape read from career-ops code). Discover-only (see src/lib/discoverOnly.ts).
import { toIsoDay } from '../../db.js';
import { assertVendorSlug, decodeOnce, htmlToPlain, ZOHO_TLDS, type TrackedCompany } from './filters.js';
import { capDescription, clip, MAX_ID_CHARS, MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, getText } from './transport.js';
import { shortHash } from './util.js';
import { z } from 'zod';
import { makeBoardProvider } from './provider.js';

const KEY_RE = /^[A-Za-z0-9_-]{1,60}$/;
const str = (x: unknown): string => (typeof x === 'string' ? x.trim() : '');
// A tag ends at an unquoted ">" (a JSON value inside an attribute may hold a literal ">").
const INPUT_TAG_RE = /<input\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

/** The raw records of the list page's id="jobs" input. Throws when the input is missing or not a JSON array. */
export function extractZohoRecords(html: unknown): any[] {
  if (typeof html !== 'string' || !html.trim()) throw new Error('empty careers page');
  let value: string | null = null;
  for (const [tag] of html.matchAll(INPUT_TAG_RE)) {
    if (!/\sid\s*=\s*["']?jobs["'\s/>]/i.test(tag)) continue;
    const attr = /\svalue\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    value = attr ? (attr[1] ?? attr[2] ?? '') : '';
    break;
  }
  if (value === null) throw new Error('no id="jobs" input on /jobs/Careers (unknown tenant, or only the legacy career site)');
  let records: unknown;
  try { records = JSON.parse(decodeOnce(value)); } catch { throw new Error('id="jobs" value is not JSON'); }
  if (!Array.isArray(records)) throw new Error('id="jobs" value is not an array');
  return records;
}

const hostOf = (c: TrackedCompany): string => `${c.slug}.zohorecruit.${c.tld ?? 'com'}`;

export function normalizeZohoRecruit(html: unknown, c: TrackedCompany, ctx: FetchCtx = {}): BoardJob[] {
  assertVendorSlug(c);
  if (c.tld !== undefined && !ZOHO_TLDS.includes(c.tld)) throw new Error(`zohorecruit ${c.slug}: invalid tld`);
  let records: any[];
  try { records = extractZohoRecords(html); } catch (e: any) { throw new Error(`zohorecruit ${c.slug}: ${e.message}`); }
  const host = hostOf(c);
  const out: BoardJob[] = [];
  const seen = new Set<string>();
  let noDescription = 0;
  for (const r of records.slice(0, MAX_JOBS_PER_BOARD)) {
    if (!r || typeof r !== 'object' || r.Is_Locked === true || r.Publish === false) continue;
    const title = str(r.Posting_Title) || str(r.Job_Opening_Name);
    const rawId = typeof r.id === 'number' && Number.isSafeInteger(r.id) ? String(r.id) : str(r.id);
    if (!title || !rawId) continue;
    const key = KEY_RE.test(rawId) ? rawId : shortHash(rawId);
    const id = `zr:${c.slug}:${key}`;
    if (id.length > MAX_ID_CHARS || seen.has(id)) continue;
    seen.add(id);
    const url = `https://${host}/jobs/Careers/${key}`;
    const parts = [...new Set([str(r.City), str(r.State), str(r.Country)].filter(Boolean))];
    if (r.Remote_Job === true) parts.push('Remote');
    const place = clip(parts.join(', '));
    const posted = toIsoDay(str(r.Date_Opened));
    const plain = capDescription(htmlToPlain(str(r.Job_Description)));
    if (!plain) noDescription++;
    out.push({
      id, source: 'zohorecruit', title: clip(title), company: c.name, url, apply_url: url, description: plain,
      ...(posted ? { posted_at: posted } : {}), locations: place ? [place] : [], remote: r.Remote_Job === true,
    });
  }
  if (noDescription) ctx.warn?.(`${noDescription} of ${out.length} postings had no description`);
  return out;
}

export async function fetchZohoRecruit(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const label = `zohorecruit ${c.slug}`;
  if (c.tld !== undefined && !ZOHO_TLDS.includes(c.tld)) throw new Error(`${label}: invalid tld`);
  const host = hostOf(c);
  const html = await getText(`https://${host}/jobs/Careers`, label, { hosts: exactHosts(host), accept: 'text/html,*/*;q=0.5' });
  return normalizeZohoRecruit(html, c, ctx);
}

// The only raw payload is the HTML page; the sample is the records parsed out of it.
export const shapeSpec = z.object({ id: z.union([z.string(), z.number()]) }).passthrough();
export const provider = makeBoardProvider('zohorecruit', fetchZohoRecruit, shapeSpec, (r) => extractZohoRecords(r[0]));
