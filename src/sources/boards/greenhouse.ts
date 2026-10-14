// Adapted from career-ops-hq/career-ops providers/greenhouse.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama). See that repo's LICENSE.
import { toIsoDay, type Job } from '../../db.js';
import { assertSlug, htmlToPlain, MAX_DESCRIPTION_CHARS, safeVendorUrl, type TrackedCompany } from './filters.js';

// The hardened transport now lives in ./transport.ts; these re-exports keep every existing import working.
export { BOARD_HEADERS, BOARD_TIMEOUT_MS, MAX_BODY_BYTES, getJson, getText, postJson } from './transport.js';
import { getJson } from './transport.js';

export interface BoardJob extends Job { locations: string[]; remote: boolean }

/** What runBoards hands to a provider so it can spend its request budget wisely (all optional; simple providers ignore it). */
export interface FetchCtx {
  /** Title and location prefilter from config/portals.json: providers that pay one request per posting apply it BEFORE asking for details. */
  prefilter?: (title: string, locations: string[], remote: boolean) => boolean;
  /** Title-only half of the prefilter, for postings whose location is not known until the detail request. */
  titleOk?: (title: string) => boolean;
  /** True for a job id that is already stored, so no detail request is wasted on it. */
  isKnown?: (id: string) => boolean;
  /** Epoch ms after which a provider must stop starting requests and return what it has. */
  deadlineAt?: number;
  /** Non-fatal notes (partial results, skipped postings) that end up in board_status errors. */
  warn?: (message: string) => void;
}
export type BoardFetcher = (c: TrackedCompany, ctx?: FetchCtx) => Promise<BoardJob[]>;

export interface BoardResult { jobs: BoardJob[]; error: string | null; warnings?: string[] }
// Never-throwing wrapper over a provider fetch, so one bad board becomes a reportable error string (for board_status).
export async function settleBoard(fn: BoardFetcher, c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardResult> {
  const warnings: string[] = [];
  const warn = (m: string) => { if (warnings.length < 20) warnings.push(String(m).slice(0, 300)); ctx.warn?.(m); };
  try {
    const jobs = await fn(c, { ...ctx, warn });
    return { jobs, error: null, ...(warnings.length ? { warnings } : {}) };
  } catch (e: any) {
    return { jobs: [], error: String(e?.message ?? e).slice(0, 300), ...(warnings.length ? { warnings } : {}) };
  }
}

export const MAX_JOBS_PER_BOARD = 2000;
export const MAX_TEXT_CHARS = 300;
export const MAX_URL_CHARS = 2000;
export const MAX_ID_CHARS = 100;
export const clip = (s: string): string => s.slice(0, MAX_TEXT_CHARS);
// Vendor URL (https, vendor host) that is also not over-long; otherwise the canonical one.
export function boardUrl(candidate: unknown, apex: string, canonical: string): string {
  const u = safeVendorUrl(candidate, apex, canonical);
  return u.length > MAX_URL_CHARS ? canonical : u;
}
// Drop query and fragment so a suffix can be appended to a vendor URL.
export const stripQuery = (u: string): string => u.replace(/[?#][\s\S]*$/, '').replace(/\/$/, '');
export const capDescription = (s: string): string => s.slice(0, MAX_DESCRIPTION_CHARS);

// Throws on an invalid slug (settleBoard turns that into a labelled error).
export function normalizeGreenhouse(raw: any, c: TrackedCompany): BoardJob[] {
  assertSlug(c.slug);
  const jobs = (Array.isArray(raw?.jobs) ? raw.jobs : []).slice(0, MAX_JOBS_PER_BOARD);
  const out: BoardJob[] = [];
  for (const j of jobs) {
    if (!j || j.id == null || !/^\d+$/.test(String(j.id)) || typeof j.title !== 'string') continue;
    if (`gh:${c.slug}:${j.id}`.length > MAX_ID_CHARS) continue;
    const loc = clip(typeof j.location?.name === 'string' ? j.location.name : '');
    const posted = toIsoDay(j.first_published ?? j.updated_at);
    const canonical = `https://boards.greenhouse.io/${c.slug}/jobs/${j.id}`;
    out.push({
      id: `gh:${c.slug}:${j.id}`,
      source: 'greenhouse',
      title: clip(j.title),
      company: c.name,
      url: boardUrl(j.absolute_url, 'greenhouse.io', canonical),
      apply_url: canonical,
      description: capDescription(htmlToPlain(typeof j.content === 'string' ? j.content : '')),
      ...(posted ? { posted_at: posted } : {}),
      locations: [loc],
      remote: /remote/i.test(loc),
    });
  }
  return out;
}

export async function fetchGreenhouse(c: TrackedCompany): Promise<BoardJob[]> {
  assertSlug(c.slug);
  const raw = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(c.slug)}/jobs?content=true`, `greenhouse ${c.slug}`);
  return normalizeGreenhouse(raw, c);
}
