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
import { markSearchTried } from './discoverRotation.js';
import { layoutGate } from './layoutGuard.js';
import { telegramNotifier } from '../platform/notify.js';
import { writeDiscoverDiag, writeDiscoverSummary } from './discoverDiag.js';
import { BROKEN_CODE, bumpStreak, classifyZeroCards, clearStreak, criticalAlert, maybeAlert, pageSummary, sessionAlertHtml, type PageSummary } from './discoverHealth.js';
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
  /** Which parser built the cards: the class-based one, the href-based fallback, or the card-as-button reader (jobs without job links). */
  parser?: 'primary' | 'semantic' | 'button';
  /** Path of the evidence file under .jobber/diag: a broken parse (no cards), or a read that found cards and saved nothing or lost some ids. */
  diag?: string;
  /** Cards or posts dropped, COUNTED BY REASON (seeker, aggregator, no_company, no_profile, injection, not_hiring, duplicate, ...). Absent when none. */
  rejected?: Record<string, number>;
  /** Jobs tool, card-as-button layout: cards for which no job id could be had (never silently dropped). */
  no_id?: number;
  /** Why those cards have no id (click_limit, click_failed, no_current_job_id, login_wall, halted, dry_run_no_click ...). */
  no_id_reasons?: Record<string, number>;
  /** Jobs tool: where the ids came from: link (a job link), attr (a DOM attribute), click (the page URL after a card click). */
  id_from?: Record<string, number>;
  /** Jobs tool: card clicks made to read an id (at most 10 per search). */
  clicks?: number;
  /** Jobs tool: cards skipped before any click because a job with the same company and title is already stored. */
  known?: number;
  /** Broken parse only: consecutive broken parses of this search (including this one). */
  streak?: number;
  /** Broken parse only: compact page summary (headings, link counts, dialog, notices, guest-wall hint) for the operator to read. */
  summary?: PageSummary;
}

/** A card of the card-as-button layout that has no id yet: the click resolver may still get one. */
export interface PendingCard { cardIdx: number; title: string; company: string; description: string }
/** What the id resolution of the jobs tool returns (jobs are new Job rows with a code-built url). */
export interface EnrichOut {
  jobs: Job[];
  known: number;
  no_id: number;
  no_id_reasons: Record<string, number>;
  id_from: Record<string, number>;
  clicks: number;
}

export interface ParsedAuthor { profileKey: string; name: string; headline?: string; company?: string }
export interface Parsed {
  jobs: Job[];
  /** Verified authors to register, parallel to nothing: independent of `jobs`. */
  authors: ParsedAuthor[];
  fetched: number;
  skipped: number;
  injection: boolean;
  /** Concatenated gated card text, given to the classifier. */
  screenText: string;
  /** `skipped` broken down by reason. */
  rejected?: Record<string, number>;
  /** Cards that still need an id (card-as-button layout). */
  pending?: PendingCard[];
  /** Ids already read from the page (link or attribute), by source. */
  idFrom?: Record<string, number>;
}

/** Add one to a reason counter. */
export const bump = (m: Record<string, number>, k: string): void => { m[k] = (m[k] ?? 0) + 1; };

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
  /** Live runs only, after the ceilings were consumed and before the save: resolves the ids of cards that have none (may click, max 10). */
  enrich?: (p: Parsed) => Promise<EnrichOut>;
}): Promise<DiscoverResult> {
  const { deps, tool } = o;
  const { db, now, env } = deps;
  if (haltReason(db, 'linkedin')) return empty('halted', 'halted');

  // Ceilings are checked first and consumed later, so a refusal or a screen block costs nothing.
  if (searchesUsedToday(deps) >= deps.cfg.maxSearchesPerDay) return empty('rate_limited', 'search_limit');
  if (!ceilings(db, loadOutreachConfig(env), now()).linkedin_discover.ok) return empty('rate_limited', 'discover_limit');

  markSearchTried(db, tool, o.searchName, now());
  const r = await deps.rt.open(o.url);
  if (!r.ok) return r.code === 'halted' ? empty('halted', 'halted') : empty('failed', r.code);
  const snap = r.snapshot;
  if (classifyUrl(snap.url) !== o.expectKind) return empty('failed', 'not_search_page');

  const lay = layoutGate(tool, deps);
  if (!lay.ok) return empty('refused', lay.code);
  const layout = lay.note ? { layout: lay.note.replace(/^layout=/, '') } : { layout: 'match' };

  const parsed = o.parse(snap);
  const base = {
    fetched: parsed.fetched, skipped: parsed.skipped, ...layout, parser: snap.cardParser ?? ('primary' as const),
    ...(parsed.injection ? { injection_suspected: true } : {}),
    ...(parsed.rejected && Object.keys(parsed.rejected).length ? { rejected: parsed.rejected } : {}),
  };

  // A search page with results can never legitimately give 0 cards: tell a real empty page from a broken parse.
  if (parsed.fetched === 0) {
    if (classifyZeroCards(snap) === 'broken') {
      const diag = await writeDiscoverDiag(
        { now, page: deps.rt.page(), ...(deps.diagDir ? { diagDir: deps.diagDir } : {}) },
        { tool, search: o.searchName, url: snap.url, snapshot: snap, layout: layout.layout, reason: BROKEN_CODE },
      );
      const streak = bumpStreak(db, tool, o.searchName, now(), diag);
      const notify = deps.notify ?? (process.env.VITEST ? undefined : telegramNotifier(env));
      // Summary for the operator (a model) to diagnose and heal first. Every text passes the input gate; a blocked one is dropped.
      const summary = pageSummary(snap, (s, max) => { const g = gateCardField(s, max); return g.blocked ? '' : g.text; });
      // Alerts only for CRITICAL: a guest or logged-out page at once, a streak that stayed broken for 24h. Plain drift heals first.
      if (summary.login_wall) {
        await criticalAlert(db, notify, 'session:guest_page', sessionAlertHtml(`guest or logged-out page (${summary.guest_hint})`, new URL(snap.url).pathname), now());
      } else {
        await maybeAlert(db, notify, tool, streak, layout.layout, now());
      }
      return empty('failed', BROKEN_CODE, { ...base, streak: streak.count, summary, ...(streak.diag ? { diag: streak.diag } : {}) });
    }
  }
  clearStreak(db, tool, o.searchName);

  let unscreened = false;
  if (parsed.screenText) {
    const v = await deps.screen(parsed.screenText, 'read');
    if (v.blocked) return empty('failed', v.code, { ...base, injection_suspected: true });
    unscreened = v.unscreened;
  }

  const fresh = parsed.jobs.filter((j) => !isSeen(db, j.id));
  let seen = parsed.jobs.length - fresh.length;
  const pending = parsed.pending ?? [];

  if (deps.cfg.dryRun) {
    recordDryRun(db, {
      runId: null, action: `linkedin_${tool}`, platform: 'linkedin',
      payload: { search: o.searchName, fetched: parsed.fetched, would_save: fresh.length, authors: parsed.authors.length, unscreened, pending_ids: pending.length },
    }, now(), env);
    setState(db, LAST_RUN_KEY, now().toISOString(), now());
    // A dry run never clicks a card, so the cards without an id are reported as such.
    return empty('dry_run', 'dry_run', {
      ...base, seen, ...(pending.length ? { no_id: pending.length, no_id_reasons: { dry_run_no_click: pending.length } } : {}),
    });
  }
  // A page that cleared only as "unscreened" never reaches a live save (screenUntrusted already blocks live).
  if (!checkAndIncrement(db, 'linkedin_search', deps.cfg.maxSearchesPerDay)) return empty('rate_limited', 'search_limit');
  if (!tryConsume(db, 'linkedin_discover', loadOutreachConfig(env), now())) {
    // Refund the search slot just taken, so a refusal costs nothing.
    db.prepare("UPDATE daily_counters SET count = count - 1 WHERE day = date('now') AND key = 'linkedin_search' AND count > 0").run();
    return empty('rate_limited', 'discover_limit');
  }

  // Cards without an id: code reads it from the page (a card click) now that the ceilings are consumed; failures are counted, never dropped.
  let enr: EnrichOut | null = null;
  if (o.enrich && pending.length) enr = await o.enrich(parsed);
  const toSave = [...fresh];
  if (enr) {
    const have = new Set(toSave.map((j) => j.id));
    for (const j of enr.jobs) {
      if (have.has(j.id)) continue;
      have.add(j.id);
      if (isSeen(db, j.id)) seen++; else toSave.push(j);
    }
    seen += enr.known;
  }
  const ids: string[] = [];
  for (const j of toSave) {
    saveJob(db, j);
    ids.push(j.id);
  }
  const people = o.afterSave ? o.afterSave(parsed) : undefined;
  setState(db, LAST_RUN_KEY, now().toISOString(), now());
  const idFrom: Record<string, number> = { ...(parsed.idFrom ?? {}) };
  for (const [k, n] of Object.entries(enr?.id_from ?? {})) idFrom[k] = (idFrom[k] ?? 0) + n;
  const result: DiscoverResult = {
    status: 'ok', code: ids.length ? 'saved' : parsed.fetched === 0 ? 'no_results' : 'no_new', ...base, new: ids.length, seen, job_ids: ids,
    ...(people !== undefined ? { people } : {}),
    ...(Object.keys(idFrom).length ? { id_from: idFrom } : {}),
    ...(enr ? { clicks: enr.clicks, known: enr.known, ...(enr.no_id ? { no_id: enr.no_id, no_id_reasons: enr.no_id_reasons } : {}) } : {}),
  };
  // Cards were read but nothing came of them (or some had no id): a counts-only file shows the owner why.
  const lost = result.no_id || (ids.length === 0 && parsed.skipped > 0);
  if (parsed.fetched > 0 && lost && (deps.diagDir || !process.env.VITEST)) {
    const d = await writeDiscoverSummary({ now, ...(deps.diagDir ? { diagDir: deps.diagDir } : {}) }, { tool, search: o.searchName, result });
    if (d) result.diag = d;
  }
  return result;
}
