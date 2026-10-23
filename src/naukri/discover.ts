// Typed Naukri discovery: one NAMED search from config/naukri-discovery.json. The model supplies only
// the name; the URL is built in code. New jobs are persisted in code (source `naukri`, ids
// `naukri:<id>` exactly as the script provider writes them, so the two dedupe against each other).
// Flow: halt, page read, classifier screen of the card text, dry run, then optional detail pages
// (capped by the quota) for cards without a description, screened one by one, then saveJob.
// The result carries counts and new job ids, never page text.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { isSeen, saveJob, type Job } from '../db.js';
import { haltReason } from '../outreach/limits.js';
import { isDryRun, recordDryRun } from '../safety/dryRun.js';
import { gateField } from '../safety/fieldGate.js';
import type { ScreenPurpose, ScreenVerdict } from '../safety/screen.js';
import { setState } from '../scheduler/runLog.js';
import { extractNaukriJobId } from '../sources/naukri.js';
import { buildSearchUrl } from './url.js';
import { isNaukriPromoted } from './promoted.js';

export const SEARCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,48}$/;
const searchDef = z.object({
  name: z.string().regex(SEARCH_NAME_RE),
  query: z.string().min(1).max(100),
  location: z.string().max(60).optional(),
  limit: z.number().int().min(1).max(40).default(20),
});
const configSchema = z.object({ searches: z.array(searchDef).default([]) });
export type NaukriSearchDef = z.infer<typeof searchDef>;
export type NaukriDiscoveryConfig = z.infer<typeof configSchema>;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const NAUKRI_DISCOVERY_CONFIG_PATH = path.join(projectRoot, 'config', 'naukri-discovery.json');

/** Parse and validate; a missing or invalid file yields no searches (the tool then reports unknown_search). */
export function loadNaukriDiscoveryConfig(file: string = NAUKRI_DISCOVERY_CONFIG_PATH): NaukriDiscoveryConfig {
  try {
    return configSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (e) {
    console.error(`[naukri] discovery config unusable: ${String((e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 160)}`);
    return { searches: [] };
  }
}

/** Pause before every search after the first in one session, 2000 to 5000 ms, so the named searches are not fired back to back at Naukri. */
export function discoverGapMs(rng: () => number = Math.random): number {
  return 2000 + Math.floor(Math.min(0.999999, Math.max(0, rng())) * 3001);
}

export const LAST_RUN_KEY ='naukri_search_last_at';
export const MAX_DETAIL_PAGES = 10;
export const DEFAULT_DETAIL_PAGES = 5;
const DESCRIPTION_MAX = 8000;

export type NaukriDiscoverStatus = 'ok' | 'dry_run' | 'halted' | 'failed';
export interface NaukriDiscoverResult {
  status: NaukriDiscoverStatus;
  code: string;
  /** Cards read from the page (capped by the definition's limit). */
  fetched: number;
  /** Jobs saved by this call. */
  new: number;
  /** Cards dropped as malformed, unsafe or injection-suspect. */
  skipped: number;
  /** Cards whose job was already stored. */
  seen: number;
  /** Detail pages read for description-less cards. */
  details: number;
  job_ids: string[];
  injection_suspected?: boolean;
}

export interface RawDiscoverCard {
  title?: unknown; company?: unknown; href?: unknown; snippet?: unknown;
  /** Short badge texts and class or aria attributes of the card (the promotion channels; never the snippet). */
  badges?: unknown; attrs?: unknown;
}

export interface ParsedCards {
  jobs: Job[];
  fetched: number;
  skipped: number;
  injection: boolean;
  /** Concatenated gated card text, given to the classifier. */
  screenText: string;
}

function safeNaukriUrl(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  try {
    const u = new URL(href.trim());
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    if (host !== 'www.naukri.com' && host !== 'naukri.com') return null;
    u.hash = '';
    u.search = '';
    return u.toString();
  } catch {
    return null;
  }
}

/** Cards -> Job objects. Every free-text field passes the two-pass field gate; a blocked field drops the card. */
export function parseDiscoverCards(raw: unknown, limit: number): ParsedCards {
  const cards = (Array.isArray(raw) ? raw : []).slice(0, limit) as RawDiscoverCard[];
  const jobs: Job[] = [];
  const ids = new Set<string>();
  const text: string[] = [];
  let skipped = 0;
  let injection = false;
  for (const c of cards) {
    const url = c && typeof c === 'object' ? safeNaukriUrl(c.href) : null;
    const num = url ? extractNaukriJobId(url) : null;
    if (!url || !num) { skipped++; continue; }
    const id = `naukri:${num}`;
    if (ids.has(id)) { skipped++; continue; }
    const title = gateField(String(c.title ?? ''), 160);
    const company = gateField(String(c.company ?? ''), 100);
    const snippet = gateField(String(c.snippet ?? ''), 1500);
    if (title.blocked || company.blocked || snippet.blocked) { injection = true; skipped++; continue; }
    if (!title.text) { skipped++; continue; }
    ids.add(id);
    jobs.push({
      id, source: 'naukri', title: title.text, company: company.text, url, apply_url: url, description: snippet.text,
      ...(isNaukriPromoted({ badges: c.badges, attrs: c.attrs }) ? { promoted: true } : {}),
    });
    text.push(`${title.text}\n${company.text}\n${snippet.text}`);
  }
  return { jobs, fetched: cards.length, skipped, injection, screenText: text.join('\n') };
}

/** What the discovery flow needs from a live page; the MCP layer supplies it, tests fake it. */
export interface DiscoverIo {
  /** Navigate the session to a code-built URL. */
  load(url: string): Promise<'ok' | 'login_required' | 'failed'>;
  /** Raw cards of the results page just loaded. */
  cards(): Promise<unknown[]>;
  /** Load one job page and return its raw description text, or null when unreadable. */
  detail(url: string): Promise<string | null>;
}

export interface DiscoverDeps {
  db: BetterSqlite3.Database;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  screen: (t: string, p: ScreenPurpose) => Promise<ScreenVerdict>;
}

const empty = (status: NaukriDiscoverStatus, code: string, extra: Partial<NaukriDiscoverResult> = {}): NaukriDiscoverResult =>
  ({ status, code, fetched: 0, new: 0, skipped: 0, seen: 0, details: 0, job_ids: [], ...extra });

const naukriHalted = (db: BetterSqlite3.Database): boolean => !!(haltReason(db, 'naukri') ?? haltReason(db, 'all'));

export async function runNaukriDiscover(
  a: { search: string; detail_quota?: number },
  io: DiscoverIo,
  deps: DiscoverDeps,
  opts: { config?: NaukriDiscoveryConfig } = {},
): Promise<NaukriDiscoverResult> {
  const { db, env, now } = deps;
  try {
    if (naukriHalted(db)) return empty('halted', 'halted');
  } catch {
    return empty('failed', 'halt_state_unreadable');
  }
  const def = (opts.config ?? loadNaukriDiscoveryConfig()).searches.find((s) => s.name === a?.search);
  if (!def) return empty('failed', 'unknown_search');
  const url = buildSearchUrl(def.query, def.location, 1);
  if (!url) return empty('failed', 'unknown_search');

  const loaded = await io.load(url);
  if (loaded !== 'ok') return empty('failed', loaded);
  let raw: unknown[];
  try { raw = await io.cards(); } catch { return empty('failed', 'extract_error'); }

  const parsed = parseDiscoverCards(raw, def.limit);
  const base = { fetched: parsed.fetched, skipped: parsed.skipped, ...(parsed.injection ? { injection_suspected: true } : {}) };

  let unscreened = false;
  if (parsed.screenText) {
    let v: ScreenVerdict;
    try { v = await deps.screen(parsed.screenText, 'read'); } catch { return empty('failed', 'classifier_unavailable', base); }
    if (v.blocked) return empty('failed', v.code, { ...base, injection_suspected: true });
    unscreened = v.unscreened;
  }

  // Promoted cards first: they get the detail-page quota before the others (stable, so the order is otherwise unchanged).
  const fresh = parsed.jobs.filter((j) => !isSeen(db, j.id)).sort((a, b) => Number(!!b.promoted) - Number(!!a.promoted));
  const seen = parsed.jobs.length - fresh.length;

  if (isDryRun(env)) {
    recordDryRun(db, {
      runId: null, action: 'naukri_discover', platform: 'naukri',
      payload: { search: def.name, fetched: parsed.fetched, would_save: fresh.length, unscreened },
    }, now(), env);
    setState(db, LAST_RUN_KEY, now().toISOString(), now());
    return empty('dry_run', 'dry_run', { ...base, seen });
  }

  // Description-less cards get their detail page read, at most `quota` pages. Each description is
  // screened on its own; a blocked one drops that job (it is not saved), an unreadable one is saved without.
  const quota = Math.min(MAX_DETAIL_PAGES, Math.max(0, Math.trunc(Number.isFinite(a.detail_quota) ? (a.detail_quota as number) : DEFAULT_DETAIL_PAGES)));
  const keep: Job[] = [];
  let details = 0;
  let dropped = 0;
  let stopDetails = false;
  let injection = parsed.injection;
  for (const job of fresh) {
    if (job.description || details >= quota || stopDetails) { keep.push(job); continue; }
    try { if (naukriHalted(db)) { stopDetails = true; keep.push(job); continue; } } catch { stopDetails = true; keep.push(job); continue; }
    details++;
    let text: string | null = null;
    try { text = await io.detail(job.url); } catch { text = null; }
    if (text) {
      const g = gateField(text, DESCRIPTION_MAX);
      if (g.blocked) { injection = true; dropped++; continue; }
      if (g.text) {
        let v: ScreenVerdict | null = null;
        try { v = await deps.screen(g.text, 'read'); } catch { v = null; }
        if (!v || v.blocked) { injection = injection || !!v; dropped++; continue; }
        job.description = g.text;
      }
    }
    keep.push(job);
  }

  // An already stored job seen as promoted now is marked promoted (saveJob on an existing id only sets the flag, never clears it).
  for (const j of parsed.jobs) if (j.promoted && isSeen(db, j.id)) saveJob(db, j);
  const ids: string[] = [];
  for (const j of keep) {
    saveJob(db, j);
    ids.push(j.id);
  }
  setState(db, LAST_RUN_KEY, now().toISOString(), now());
  return {
    status: 'ok', code: ids.length ? 'saved' : 'no_new', ...base, skipped: parsed.skipped + dropped,
    ...(injection ? { injection_suspected: true } : {}), new: ids.length, seen, details, job_ids: ids,
  };
}
