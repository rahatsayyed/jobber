// Zero-LLM discovery from public ATS job boards listed in config/portals.json.
// Boards use ONLY the filters in config/portals.json; the role/location passed to fetchAllJobs / list_new_jobs do NOT apply here.
// This module never opens the database (src/mcp/job-fetch.ts does the db-side dedupe).
import type { Job } from '../../db.js';
import { companyKey, titleIdentityKey } from '../../reposts.js';
import { AGGREGATOR_ATS, COMPANY_ATS, loadPortals, locationAllowed, titlePasses, type Ats, type TrackedCompany } from './filters.js';
import { settleBoard, type BoardJob, type FetchCtx } from './greenhouse.js';
import { FETCHERS } from './registry.js';

export interface BoardsResult { jobs: Job[]; errors: string[]; stats: Array<{ company: string; ats: Ats; fetched: number; kept: number }> }

export const DESCRIPTION_CAP = 8000;
export const MAX_CONCURRENCY = 3;
export const DEFAULT_MAX_PER_COMPANY = 200;
export const DEFAULT_BOARD_TIMEOUT_MS = 30_000;
export const DEFAULT_BUDGET_MS = 120_000;
// Sources whose jobs belong to one company board (dedupe groups are vendor + tenant). Aggregators are never in here.
export const BOARD_SOURCES = new Set<string>(COMPANY_ATS);
// Board-wide feeds (Hacker News, Himalayas, We Work Remotely). Their jobs are droppable duplicates too, but with LOWER priority than a company board.
export const AGGREGATOR_SOURCES = new Set<string>(AGGREGATOR_ATS);
// The location is the only structured place information a board job has, and the matcher and the veto backstop (src/vetoes.ts) only see
// title and description, so it goes in as the first description line: "Location: <locations joined by '; '>[ (remote)]" and a blank line.
// The line is at most 300 characters; the 8000-character cap is applied after it. Nothing else passes a board job's location on.
export function locationLine(locations: string[] | undefined, remote: boolean | undefined): string {
  const locs = (locations ?? []).map((l) => String(l ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join('; ');
  const tail = remote ? ' (remote)' : '';
  if (!locs && !remote) return '';
  const room = 300 - 'Location: '.length - tail.length;
  const shown = locs.slice(0, Math.max(0, room)).trimEnd();
  return `Location:${shown ? ` ${shown}` : ''}${tail}\n\n`;
}
const capText =(s: string, n = DESCRIPTION_CAP) => (s.length > n ? s.slice(0, n).trimEnd() : s);

export interface FetchBoardsOptions {
  configPath?: string;
  /** Boards in flight at once (default and maximum 3). */
  concurrency?: number;
  /** Kept jobs per company AFTER the title/location filters (default 200). */
  maxPerCompany?: number;
  /** Hard wall-clock limit for one board (default 30 s). */
  boardTimeoutMs?: number;
  /** Wall-clock limit for the whole fetch (default 120 s); boards not started by then are reported as errors. */
  budgetMs?: number;
  /** True for a job id that is already stored; providers that pay one request per posting skip those before spending requests. */
  isKnown?: (id: string) => boolean;
}

let last: (BoardsResult & { at: string }) | null = null;
let lastNote: string | undefined;
let droppedDuplicates: { count: number; ids: string[] } | undefined;
/** The most recent fetchBoards() result in this process (read by the job-fetch `board_status` tool). */
export function getLastBoardsResult(): (BoardsResult & { at: string }) | null { return last; }

/** Payload of the read-only job-fetch `board_status` tool: the last result, or ran:false. Never triggers a fetch. */
export function boardStatusPayload(r: (BoardsResult & { at: string }) | null = last) {
  if (!r) return { ran: false as const, errors: [] as string[], stats: [] as BoardsResult['stats'], note: 'no board fetch has run in this session' };
  return {
    ran: true as const, at: r.at, errors: r.errors, stats: r.stats,
    ...(lastNote ? { note: lastNote } : {}),
    ...(droppedDuplicates ? { dropped_duplicates: droppedDuplicates } : {}),
  };
}

type Slot = { c: TrackedCompany; jobs?: BoardJob[]; error?: string; warnings?: string[] };

async function runBoards(opts: FetchBoardsOptions): Promise<BoardsResult> {
  lastNote = undefined;
  droppedDuplicates = undefined;
  const { config, error, warnings } = loadPortals(opts.configPath);
  if (error) return { jobs: [], errors: [error], stats: [] };
  if (!config) { lastNote = 'config/portals.json not found'; return { jobs: [], errors: [], stats: [] }; }
  const companies = config.tracked_companies.filter((c) => c.enabled);
  const max = opts.maxPerCompany ?? DEFAULT_MAX_PER_COMPANY;
  const boardTimeout = opts.boardTimeoutMs ?? DEFAULT_BOARD_TIMEOUT_MS;
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const slots: Slot[] = new Array(companies.length);
  let next = 0;
  const worker = async () => {
    while (next < companies.length) {
      const i = next++;
      const c = companies[i];
      const label = `${c.ats} ${c.slug}`;
      const remaining = deadline - Date.now();
      if (remaining <= 0) { slots[i] = { c, error: `${label}: skipped, time budget exhausted` }; continue; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const budget = Math.min(boardTimeout, remaining);
      const collected: string[] = [];
      const timeout = new Promise<{ jobs: BoardJob[]; error: string | null; warnings?: string[] }>((resolve) => {
        timer = setTimeout(() => resolve({ jobs: [], error: `${label}: timeout` }), budget);
      });
      // Providers that make several requests stop on their own 2 s before the hard per-board timeout and return what they have.
      const ctx: FetchCtx = {
        prefilter: (title, locations, remote) => titlePasses(title, config.title_filter) && locationAllowed(locations, remote, config.location_filter),
        titleOk: (title) => titlePasses(title, config.title_filter),
        isKnown: opts.isKnown,
        deadlineAt: Date.now() + Math.max(0, budget - 2000),
        // Collected here (not only inside settleBoard) so warnings survive a per-board timeout or a thrown error.
        warn: (m) => { if (collected.length < 20) collected.push(String(m).slice(0, 300)); },
      };
      try {
        const r = await Promise.race([settleBoard(FETCHERS[c.ats], c, ctx), timeout]);
        slots[i] = r.error ? { c, error: r.error.startsWith(`${label}:`) ? r.error : `${label}: ${r.error}`, warnings: collected } : { c, jobs: r.jobs, warnings: collected };
      } catch (e: any) {
        slots[i] = { c, error: `${label}: ${String(e?.message ?? e).slice(0, 300)}`, warnings: collected };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  };
  const n = Math.max(1, Math.min(Math.floor(opts.concurrency ?? MAX_CONCURRENCY) || 1, MAX_CONCURRENCY, companies.length));
  await Promise.all(Array.from({ length: companies.length ? n : 0 }, worker));

  const out: BoardsResult = { jobs: [], errors: [...(warnings ?? [])], stats: [] };
  const seen = new Set<string>();
  for (const s of slots) {
    for (const w of s.warnings ?? []) out.errors.push(`${s.c.ats} ${s.c.slug}: ${w}`);
    if (s.error) { out.errors.push(s.error); continue; }
    const fetched = s.jobs ?? [];
    const kept = fetched
      .filter((j) => titlePasses(j.title, config.title_filter) && locationAllowed(j.locations, j.remote, config.location_filter))
      .slice(0, max);
    for (const { locations, remote, ...job } of kept) {
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      out.jobs.push({ ...job, description: capText(`${locationLine(locations, remote)}${job.description}`) });
    }
    out.stats.push({ company: s.c.name, ats: s.c.ats, fetched: fetched.length, kept: kept.length });
  }
  for (const e of out.errors) console.error(`[boards] ${e}`);
  return out;
}

/** Never rejects for a board-level problem: failures are returned in `errors`. */
export async function fetchBoards(opts: FetchBoardsOptions = {}): Promise<BoardsResult> {
  const r = await runBoards(opts);
  last = { ...r, at: new Date().toISOString() };
  return r;
}

export interface SeenRow { id: string; source: string | null; company_key: string | null; title_key: string | null }

// "gh:acme:123" -> "gh:acme" (vendor + slug, one company board); an aggregator is one group per source ("agg:himalayas");
// any other source is the shared "*" group.
const boardGroup = (id: string, source: string | null | undefined): string => {
  if (source && BOARD_SOURCES.has(source)) return id.slice(0, Math.max(0, id.lastIndexOf(':'))) || source;
  if (source && AGGREGATOR_SOURCES.has(source)) return `agg:${source}`;
  return '*';
};

/**
 * Cross-source dedupe: the same posting often arrives via LinkedIn or Adzuna AND a company board under different ids.
 * A board job is dropped when its normalized company+title (Plan 2's companyKey/titleIdentityKey) already exists from a
 * DIFFERENT source or a different board (vendor+slug): in `recent` (rows saved lately) or elsewhere in this batch.
 * Two postings from the SAME board with the same title and different ids (one role in two cities) are both kept.
 * Aggregator jobs (Hacker News, Himalayas, We Work Remotely) are decided AFTER the company boards, so a canonical company-board posting
 * (which may be apply-capable) wins over an aggregator copy; an aggregator job is dropped when anything else already holds its key.
 * Other non-board jobs are never dropped.
 */
export function dropBoardDuplicatesDetailed(jobs: Job[], recent: SeenRow[]): { kept: Job[]; dropped: Job[] } {
  const keyOf = (j: Job) => { const c = companyKey(j.company); const t = titleIdentityKey(j.title); return c && t ? `${c}|${t}` : ''; };
  const groups = new Map<string, Set<string>>();
  const note = (k: string, g: string) => { let set = groups.get(k); if (!set) groups.set(k, (set = new Set())); set.add(g); };
  for (const r of recent) if (r.company_key && r.title_key) note(`${r.company_key}|${r.title_key}`, boardGroup(r.id, r.source));
  const isBoard = (j: Job) => BOARD_SOURCES.has(j.source);
  const isAggregator = (j: Job) => AGGREGATOR_SOURCES.has(j.source);
  for (const j of jobs) if (!isBoard(j) && !isAggregator(j)) { const k = keyOf(j); if (k) note(k, '*'); }
  const drop = new Set<Job>();
  const sweep = (pick: (j: Job) => boolean) => {
    for (const j of jobs) {
      if (!pick(j)) continue;
      const k = keyOf(j);
      if (!k) continue;
      const g = boardGroup(j.id, j.source);
      if ([...(groups.get(k) ?? [])].some((x) => x !== g)) { drop.add(j); continue; }
      note(k, g);
    }
  };
  sweep(isBoard);
  sweep(isAggregator);
  return { kept: jobs.filter((j) => !drop.has(j)), dropped: jobs.filter((j) => drop.has(j)) };
}

export function dropBoardDuplicates(jobs: Job[], recent: SeenRow[]): Job[] {
  return dropBoardDuplicatesDetailed(jobs, recent).kept;
}

/** Called by list_new_jobs after the dedupe so board_status can report what was dropped (count and the first 20 ids). */
export function recordDroppedDuplicates(dropped: Job[]): void {
  droppedDuplicates = { count: dropped.length, ids: dropped.slice(0, 20).map((j) => j.id) };
}
