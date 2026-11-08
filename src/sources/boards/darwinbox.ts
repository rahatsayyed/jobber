// Adapted from career-ops-hq/career-ops providers/darwinbox.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama). See that repo's LICENSE.
// Darwinbox (Indian HR/ATS), one tenant per company at https://<slug>.darwinbox.in. Public job-list API, no login:
//   POST https://<slug>.darwinbox.in/ms/candidateapi/job/alljobs?companyId=<company_id>   body { companyId, page, sort_option: "new", limit: 50 }
//   -> { status: "success", data: [{ id, title, locations, tool_tip_locations: [string], posted_on (epoch seconds), created_on, jd (HTML) }], job_counts }
// The tenant host label is the config `slug`; the id that appears in the careers path /ms/candidatev2/<company_id>/careers is the config `company_id`.
// Pages of 50, up to max_pages (default 20), stop on a short page; a later page failing keeps the earlier pages. Any other envelope is an error.
// Posting URL: https://<slug>.darwinbox.in/ms/candidatev2/<company_id>/careers/jobDetails/<id>. Salary is not carried over (unit unclear).
// Live-unverified (shape read from career-ops code). Discover-only (see src/lib/discoverOnly.ts).
import { toIsoDay } from '../../db.js';
import { assertVendorSlug, COMPANY_ID_RE, htmlToPlain, type TrackedCompany } from './filters.js';
import { capDescription, clip, MAX_ID_CHARS, MAX_JOBS_PER_BOARD, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, postJson } from './transport.js';
import { pastDeadline, shortHash } from './util.js';
import { z } from 'zod';
import { makeBoardProvider } from './provider.js';

export const DARWINBOX_PAGE_SIZE = 50;
export const DARWINBOX_DEFAULT_MAX_PAGES = 20;
const JOB_KEY_RE = /^[A-Za-z0-9_-]{1,60}$/;
const str = (x: unknown): string => (typeof x === 'string' ? x.trim() : '');

function placesOf(j: any): string[] {
  const tips = Array.isArray(j.tool_tip_locations) ? j.tool_tip_locations : [];
  const out: string[] = [];
  for (const l of tips.length ? tips : [j.locations]) {
    const s = htmlToPlain(str(l)).replace(/\s*,\s*/g, ', ');
    if (s && !out.includes(s)) out.push(clip(s));
  }
  return out;
}

export function normalizeDarwinbox(raw: any, c: TrackedCompany, ctx: FetchCtx = {}): BoardJob[] {
  assertVendorSlug(c);
  if (!c.company_id || !COMPANY_ID_RE.test(c.company_id)) throw new Error(`darwinbox ${c.slug}: config needs company_id`);
  if (raw?.status !== 'success' || !Array.isArray(raw.data)) throw new Error(`darwinbox ${c.slug}: unexpected response shape (no data array)`);
  const out: BoardJob[] = [];
  let noDescription = 0;
  for (const j of raw.data.slice(0, MAX_JOBS_PER_BOARD) as any[]) {
    if (!j || typeof j !== 'object') continue;
    const title = htmlToPlain(str(j.title));
    const rawId = typeof j.id === 'number' && Number.isSafeInteger(j.id) ? String(j.id) : str(j.id);
    if (!title || !rawId) continue;
    const key = JOB_KEY_RE.test(rawId) ? rawId : shortHash(rawId);
    const id = `dbx:${c.slug}:${key}`;
    if (id.length > MAX_ID_CHARS) continue;
    const url = `https://${c.slug}.darwinbox.in/ms/candidatev2/${c.company_id}/careers/jobDetails/${key}`;
    const places = placesOf(j);
    const posted = toIsoDay(Number.isFinite(j.posted_on) && j.posted_on > 0 ? j.posted_on : j.created_on);
    const plain = capDescription(htmlToPlain(str(j.jd)));
    if (!plain) noDescription++;
    out.push({
      id, source: 'darwinbox', title: clip(title), company: c.name, url, apply_url: url, description: plain,
      ...(posted ? { posted_at: posted } : {}), locations: places, remote: places.some((p) => /remote/i.test(p)) || /\bremote\b/i.test(title),
    });
  }
  if (noDescription) ctx.warn?.(`${noDescription} of ${out.length} postings had no description (alljobs fields changed?)`);
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function fetchDarwinbox(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  assertVendorSlug(c);
  const label = `darwinbox ${c.slug}`;
  if (!c.company_id || !COMPANY_ID_RE.test(c.company_id)) throw new Error(`${label}: config needs company_id`);
  const origin = `https://${c.slug}.darwinbox.in`;
  const endpoint = `${origin}/ms/candidateapi/job/alljobs?companyId=${encodeURIComponent(c.company_id)}`;
  const opts = { hosts: exactHosts(`${c.slug}.darwinbox.in`), headers: { Origin: origin, Referer: `${origin}/ms/candidatev2/${c.company_id}/careers/allJobs` } };
  const maxPages = c.max_pages ?? DARWINBOX_DEFAULT_MAX_PAGES;
  const jobs: BoardJob[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= maxPages; page++) {
    if (page > 1 && pastDeadline(ctx.deadlineAt)) { ctx.warn?.(`stopped at page ${page - 1} (time budget)`); break; }
    if (page > 1) await sleep(200);
    let json: any;
    let batch: BoardJob[];
    try {
      json = await postJson(endpoint, { companyId: c.company_id, page, sort_option: 'new', limit: DARWINBOX_PAGE_SIZE }, label, opts);
      batch = normalizeDarwinbox(json, c, ctx);
    } catch (e) {
      if (page === 1) throw e;
      ctx.warn?.(`stopped at page ${page}: ${String((e as Error)?.message ?? e).replace(`${label}: `, '')}`);
      break;
    }
    for (const j of batch) if (!seen.has(j.id)) { seen.add(j.id); jobs.push(j); }
    if (json.data.length < DARWINBOX_PAGE_SIZE) break;
    if (page === maxPages) ctx.warn?.(`truncated at max_pages=${maxPages}`);
  }
  return jobs;
}

export const shapeSpec = z.object({ title: z.string() }).passthrough();
export const provider = makeBoardProvider('darwinbox', fetchDarwinbox, shapeSpec, (r) => (r[0] && typeof r[0] === 'object' && Array.isArray((r[0] as any).data) ? (r[0] as any).data : [r[0]]));
