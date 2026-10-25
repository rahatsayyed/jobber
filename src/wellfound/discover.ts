// Typed Wellfound discovery: one NAMED search from config/wellfound-discovery.json. The model supplies only
// the name; the URL is built in code. New jobs are persisted in code (source `wellfound`, ids
// `wellfound:<id>`). Same flow as src/naukri/discover.ts: halt, daily ceiling, page read, classifier screen
// of the card text, dry run, then optional detail pages (capped by the quota) for cards without a
// description, screened one by one, then saveJob. The result carries counts and new job ids, never page text.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { isSeen, saveJob, type Job } from '../db.js';
import { companyKey, titleIdentityKey } from '../reposts.js';
import { pickCompany, type CompanyHints } from './company.js';
import { loadOutreachConfig } from '../outreach/config.js';
import { ceilings, haltReason, tryConsume } from '../outreach/limits.js';
import { isDryRun, recordDryRun } from '../safety/dryRun.js';
import { gateField } from '../safety/fieldGate.js';
import type { ScreenPurpose, ScreenVerdict } from '../safety/screen.js';
import { setState } from '../scheduler/runLog.js';
import { extractWellfoundJobId } from './page.js';
import { buildSearchUrl } from './url.js';
import { isWellfoundPromoted } from './promoted.js';

export const SEARCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,48}$/;
const searchDef = z.object({
  name: z.string().regex(SEARCH_NAME_RE),
  /** Role slug source (for example "full-stack-engineer"); slugified in code. */
  role: z.string().min(1).max(100),
  location: z.string().max(60).optional(),
  remote: z.boolean().default(false),
  limit: z.number().int().min(1).max(40).default(20),
});
const configSchema = z.object({ searches: z.array(searchDef).default([]) });
export type WellfoundSearchDef = z.infer<typeof searchDef>;
export type WellfoundDiscoveryConfig = z.infer<typeof configSchema>;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const WELLFOUND_DISCOVERY_CONFIG_PATH = path.join(projectRoot, 'config', 'wellfound-discovery.json');

/** Parse and validate; a missing or invalid file yields no searches (the tool then reports unknown_search). */
export function loadWellfoundDiscoveryConfig(file: string = WELLFOUND_DISCOVERY_CONFIG_PATH): WellfoundDiscoveryConfig {
  try {
    return configSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (e) {
    console.error(`[wellfound] discovery config unusable: ${String((e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 160)}`);
    return { searches: [] };
  }
}

export const LAST_RUN_KEY = 'wellfound_discover_last_at';
export const MAX_DETAIL_PAGES = 10;
export const DEFAULT_DETAIL_PAGES = 5;
/** Saved description cap: the same 8000 characters the other sources use (only the detail page can fill it). */
const DESCRIPTION_MAX = 8000;
/** A results card only yields a snippet of this size (the old 1500-character descriptions came from here). */
const CARD_SNIPPET_MAX = 1500;
const BAD_STATUS = 'bad_extraction';

export type WellfoundDiscoverStatus = 'ok' | 'dry_run' | 'halted' | 'failed';
export interface WellfoundDiscoverResult {
  status: WellfoundDiscoverStatus;
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
  /** Saved jobs (this call) whose company could not be read: they get the `no company identified` gate flag. */
  company_missing: number;
  /** Stored bad_extraction rows repaired by this call (company now read). */
  repaired?: number;
  injection_suspected?: boolean;
}

export interface RawDiscoverCard {
  title?: unknown; company?: unknown; href?: unknown; snippet?: unknown;
  /** Short badge texts and class or aria attributes of the card (the promotion channels; never the snippet). */
  badges?: unknown; attrs?: unknown;
  /** Anchors to /company/<slug> in the card and the other company ingredients (see src/wellfound/company.ts). */
  links?: unknown; pageTitle?: unknown; jsonld?: unknown;
}

/** What the detail page script returns: the description plus company ingredients (a plain string is description only). */
export interface DetailRead extends CompanyHints { description?: unknown }

export interface ParsedCards {
  jobs: Job[];
  fetched: number;
  skipped: number;
  injection: boolean;
  /** Concatenated gated card text, given to the classifier. */
  screenText: string;
}

function safeWellfoundUrl(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  try {
    const u = new URL(href.trim());
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    if (host !== 'wellfound.com' && host !== 'www.wellfound.com') return null;
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
    const url = c && typeof c === 'object' ? safeWellfoundUrl(c.href) : null;
    const num = url ? extractWellfoundJobId(url) : null;
    if (!url || !num) { skipped++; continue; }
    const id = `wellfound:${num}`;
    if (ids.has(id)) { skipped++; continue; }
    const title = gateField(String(c.title ?? ''), 160);
    const company = gateField(pickCompany(c).name, 100);
    const snippet = gateField(String(c.snippet ?? ''), CARD_SNIPPET_MAX);
    if (title.blocked || company.blocked || snippet.blocked) { injection = true; skipped++; continue; }
    if (!title.text) { skipped++; continue; }
    ids.add(id);
    jobs.push({
      id, source: 'wellfound', title: title.text, company: company.text, url, apply_url: url, description: snippet.text,
      ...(isWellfoundPromoted({ badges: c.badges, attrs: c.attrs }) ? { promoted: true } : {}),
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
  detail(url: string): Promise<string | DetailRead | null>;
}

export interface DiscoverDeps {
  db: BetterSqlite3.Database;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  screen: (t: string, p: ScreenPurpose) => Promise<ScreenVerdict>;
}

const empty = (status: WellfoundDiscoverStatus, code: string, extra: Partial<WellfoundDiscoverResult> = {}): WellfoundDiscoverResult =>
  ({ status, code, fetched: 0, new: 0, skipped: 0, seen: 0, details: 0, job_ids: [], company_missing: 0, ...extra });

const wellfoundHalted = (db: BetterSqlite3.Database): boolean => !!(haltReason(db, 'wellfound') ?? haltReason(db, 'all'));

export async function runWellfoundDiscover(
  a: { search: string; detail_quota?: number },
  io: DiscoverIo,
  deps: DiscoverDeps,
  opts: { config?: WellfoundDiscoveryConfig } = {},
): Promise<WellfoundDiscoverResult> {
  const { db, env, now } = deps;
  try {
    if (wellfoundHalted(db)) return empty('halted', 'halted');
  } catch {
    return empty('failed', 'halt_state_unreadable');
  }
  const def = (opts.config ?? loadWellfoundDiscoveryConfig()).searches.find((s) => s.name === a?.search);
  if (!def) return empty('failed', 'unknown_search');
  const url = buildSearchUrl(def.role, def.location, def.remote);
  if (!url) return empty('failed', 'unknown_search');

  // Daily discover ceiling: read in a dry run (nothing is consumed), consumed before the page load when live.
  const dry = isDryRun(env);
  const ocfg = loadOutreachConfig(env);
  try {
    if (dry ? !ceilings(db, ocfg, now()).wellfound_discover.ok : !tryConsume(db, 'wellfound_discover', ocfg, now())) {
      return empty('failed', 'rate_limited');
    }
  } catch {
    return empty('failed', 'ceiling_unreadable');
  }

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
  // A stored `bad_extraction` row (scripts/fix-wellfound-jobs.ts) is worked again like a new job and repaired when a company is read.
  const badIds = new Set(
    parsed.jobs.filter((j) => (db.prepare('SELECT status FROM jobs WHERE id = ?').get(j.id) as { status: string | null } | undefined)?.status === BAD_STATUS).map((j) => j.id),
  );
  const fresh = parsed.jobs.filter((j) => !isSeen(db, j.id) || badIds.has(j.id)).sort((a, b) => Number(!!b.promoted) - Number(!!a.promoted));
  const seen = parsed.jobs.length - fresh.length;

  if (dry) {
    recordDryRun(db, {
      runId: null, action: 'wellfound_discover', platform: 'wellfound',
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
    // A card only ever carries a SNIPPET (CARD_SNIPPET_MAX), so every fresh job gets its detail page while the quota lasts
    // (promoted first): that page is the source of the description (up to DESCRIPTION_MAX) and a second chance at the company.
    if (details >= quota || stopDetails) { keep.push(job); continue; }
    try { if (wellfoundHalted(db)) { stopDetails = true; keep.push(job); continue; } } catch { stopDetails = true; keep.push(job); continue; }
    details++;
    let read: string | DetailRead | null = null;
    try { read = await io.detail(job.url); } catch { read = null; }
    const d: DetailRead | null = typeof read === 'string' ? { description: read } : read && typeof read === 'object' ? read : null;
    if (d && !job.company) {
      const c = gateField(pickCompany(d).name, 100);
      if (c.blocked) { injection = true; dropped++; continue; }
      job.company = c.text;
    }
    const text = typeof d?.description === 'string' ? d.description : null;
    if (text) {
      const g = gateField(text, DESCRIPTION_MAX);
      if (g.blocked) { injection = true; dropped++; continue; }
      if (g.text) {
        const v = await screenChunks(deps.screen, g.text);
        if (!v || v.blocked) { injection = injection || !!v; dropped++; continue; }
        if (g.text.length >= job.description.length) job.description = g.text;
      }
    }
    keep.push(job);
  }

  // An already stored job seen as promoted now is marked promoted (saveJob on an existing id only sets the flag, never clears it).
  for (const j of parsed.jobs) if (j.promoted && isSeen(db, j.id)) saveJob(db, j);
  const ids: string[] = [];
  let companyMissing = 0;
  let repaired = 0;
  const repair = db.prepare(
    'UPDATE jobs SET company = ?, company_key = ?, title = ?, title_key = ?, description = ?, status = NULL, excluded_reason = NULL WHERE id = ? AND status = ?',
  );
  for (const j of keep) {
    if (badIds.has(j.id)) {
      // Repair only when a company was read this time; otherwise the row stays bad_extraction.
      if (!j.company) continue;
      repair.run(j.company, companyKey(j.company), j.title, titleIdentityKey(j.title), j.description, j.id, BAD_STATUS);
      repaired++;
      ids.push(j.id);
      continue;
    }
    saveJob(db, j);
    ids.push(j.id);
    if (!j.company) companyMissing++;
  }
  setState(db, LAST_RUN_KEY, now().toISOString(), now());
  return {
    status: 'ok', code: ids.length ? 'saved' : 'no_new', ...base, skipped: parsed.skipped + dropped,
    ...(injection ? { injection_suspected: true } : {}), new: ids.length - repaired, seen, details, job_ids: ids,
    company_missing: companyMissing, ...(repaired ? { repaired } : {}),
  };
}

/** Classifier text window (src/safety/screen.ts maxChars is 6000): a longer description is screened chunk by chunk so no tail goes unscreened. */
const SCREEN_CHUNK = 5500;
async function screenChunks(screen: DiscoverDeps['screen'], text: string): Promise<ScreenVerdict | null> {
  let last: ScreenVerdict | null = null;
  try {
    for (let i = 0; i < text.length; i += SCREEN_CHUNK) {
      last = await screen(text.slice(i, i + SCREEN_CHUNK), 'read');
      if (last.blocked) return last;
    }
  } catch {
    return null;
  }
  return last;
}
