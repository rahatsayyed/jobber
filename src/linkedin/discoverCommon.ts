// Shared flow of the typed discovery tools (linkedin_search_jobs, linkedin_search_posts): halt,
// ceilings (checked before the page is opened, consumed only after the text cleared the screen),
// layout precondition, classifier screen, dry run, then persistence in code. Page text never
// reaches the result: only counts and the ids of newly saved jobs.
import { isSeen, saveJob, type Job } from '../db.js';
import { loadOutreachConfig } from '../outreach/config.js';
import { ceilings, haltReason, tryConsume } from '../outreach/limits.js';
import { checkAndIncrement } from '../lib/rateLimit.js';
import { recordDryRun } from '../safety/dryRun.js';
import { gateField } from '../safety/fieldGate.js';
import { setState } from '../scheduler/runLog.js';
import { layoutGate } from './layoutGuard.js';
import { classifyUrl } from './urls.js';
import type { PageKind, RawSnapshot } from './types.js';
import type { ToolDeps } from './toolDeps.js';

export type DiscoverStatus = 'ok' | 'dry_run' | 'rate_limited' | 'halted' | 'refused' | 'failed';
export interface DiscoverResult {
  status: DiscoverStatus;
  code: string;
  /** Cards read from the page (capped by the definition's limit). */
  fetched: number;
  /** Jobs saved by this call. */
  new: number;
  /** Cards dropped as malformed, unsafe or off-topic. */
  skipped: number;
  /** Cards whose job was already stored. */
  seen: number;
  job_ids: string[];
  /** Hiring-post authors registered in `people` (posts tool only). */
  people?: number;
  injection_suspected?: boolean;
  layout?: string;
}

export interface ParsedAuthor { profileKey: string; name: string }
export interface Parsed {
  jobs: Job[];
  /** Verified authors to register, parallel to nothing: independent of `jobs`. */
  authors: ParsedAuthor[];
  fetched: number;
  skipped: number;
  injection: boolean;
  /** Concatenated gated card text, given to the classifier. */
  screenText: string;
}

/**
 * Input-gate one untrusted card field. It lives in this file because this file is the screened
 * surface (the surfaces lint allows the field gate only in screened files).
 */
export function gateCardField(s: unknown, max: number): { text: string; blocked: boolean } {
  const g = gateField(String(s ?? ''), max);
  return { text: g.text, blocked: g.blocked };
}

export const LAST_RUN_KEY = 'linkedin_discover_last_at';
const empty = (status: DiscoverStatus, code: string, extra: Partial<DiscoverResult> = {}): DiscoverResult =>
  ({ status, code, fetched: 0, new: 0, skipped: 0, seen: 0, job_ids: [], ...extra });

/** Daily counter read without consuming it. */
function searchesUsedToday(deps: ToolDeps): number {
  const row = deps.db
    .prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = 'linkedin_search'")
    .get() as { count: number } | undefined;
  return row?.count ?? 0;
}

export async function runDiscovery(o: {
  tool: 'search_jobs' | 'search_posts';
  deps: ToolDeps;
  url: string;
  expectKind: PageKind;
  searchName: string;
  parse: (snap: RawSnapshot) => Parsed;
  /** Live runs only, after the jobs are saved: registers verified authors and returns how many. */
  afterSave?: (p: Parsed) => number;
}): Promise<DiscoverResult> {
  const { deps, tool } = o;
  const { db, now, env } = deps;
  if (haltReason(db, 'linkedin')) return empty('halted', 'halted');

  // Ceilings are checked first and consumed later, so a refusal or a screen block costs nothing.
  if (searchesUsedToday(deps) >= deps.cfg.maxSearchesPerDay) return empty('rate_limited', 'search_limit');
  if (!ceilings(db, loadOutreachConfig(env), now()).linkedin_discover.ok) return empty('rate_limited', 'discover_limit');

  const r = await deps.rt.open(o.url);
  if (!r.ok) return r.code === 'halted' ? empty('halted', 'halted') : empty('failed', r.code);
  const snap = r.snapshot;
  if (classifyUrl(snap.url) !== o.expectKind) return empty('failed', 'not_search_page');

  const lay = layoutGate(tool, deps);
  if (!lay.ok) return empty('refused', lay.code);
  const layout = lay.note ? { layout: lay.note.replace(/^layout=/, '') } : { layout: 'match' };

  const parsed = o.parse(snap);
  const base = { fetched: parsed.fetched, skipped: parsed.skipped, ...layout, ...(parsed.injection ? { injection_suspected: true } : {}) };

  let unscreened = false;
  if (parsed.screenText) {
    const v = await deps.screen(parsed.screenText, 'read');
    if (v.blocked) return empty('failed', v.code, { ...base, injection_suspected: true });
    unscreened = v.unscreened;
  }

  const fresh = parsed.jobs.filter((j) => !isSeen(db, j.id));
  const seen = parsed.jobs.length - fresh.length;

  if (deps.cfg.dryRun) {
    recordDryRun(db, {
      runId: null, action: `linkedin_${tool}`, platform: 'linkedin',
      payload: { search: o.searchName, fetched: parsed.fetched, would_save: fresh.length, authors: parsed.authors.length, unscreened },
    }, now(), env);
    setState(db, LAST_RUN_KEY, now().toISOString(), now());
    return empty('dry_run', 'dry_run', { ...base, seen });
  }
  // A page that cleared only as "unscreened" never reaches a live save (screenUntrusted already blocks live).
  if (!tryConsume(db, 'linkedin_discover', loadOutreachConfig(env), now())) return empty('rate_limited', 'discover_limit');
  if (!checkAndIncrement(db, 'linkedin_search', deps.cfg.maxSearchesPerDay)) return empty('rate_limited', 'search_limit');

  const ids: string[] = [];
  for (const j of fresh) {
    saveJob(db, j);
    ids.push(j.id);
  }
  const people = o.afterSave ? o.afterSave(parsed) : undefined;
  setState(db, LAST_RUN_KEY, now().toISOString(), now());
  return {
    status: 'ok', code: ids.length ? 'saved' : 'no_new', ...base, new: ids.length, seen, job_ids: ids,
    ...(people !== undefined ? { people } : {}),
  };
}
