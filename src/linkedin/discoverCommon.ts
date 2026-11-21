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
import { savePaneJd } from '../jdFetch.js';
import { recordDiscoverRun } from '../scheduler/discoverNext.js';
import { markSearchTried } from './discoverRotation.js';
import { layoutGate } from './layoutGuard.js';
import { telegramNotifier } from '../platform/notify.js';
import { writeDiscoverDiag, writeDiscoverSummary } from './discoverDiag.js';
import { BROKEN_CODE, bumpStreak, classifyZeroCards, clearStreak, criticalAlert, guestHint, maybeAlert, pageSummary, sessionAlertHtml, type PageSummary } from './discoverHealth.js';
import { classifyUrl } from './urls.js';
import { extractLinkedInJobId } from './jobIds.js';
import type { PageKind, RawJobCard, RawSnapshot } from './types.js';
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
  /** Jobs tool: card clicks made to read an id and the description pane (at most LINKEDIN_JOB_CLICKS_PER_SEARCH per search). */
  clicks?: number;
  /** Jobs tool: clicks that failed (the card could not be clicked). */
  click_failed?: number;
  /** Jobs tool: job descriptions read from the right-hand pane at click time and saved (those jobs are not jd_pending any more). */
  jd_from_pane?: number;
  /** Jobs tool: wanted descriptions the pane did not give (any reason, see jd_pane_reasons). */
  jd_pane_incomplete?: number;
  /** Jobs tool: why a wanted pane description was not saved (click_limit, pane_not_found, clamped_no_more, pane_title_mismatch, blocked, ...). */
  jd_pane_reasons?: Record<string, number>;
  /** Jobs tool: cards not clicked because their job already has a full description. */
  jd_known_skipped?: number;
  /** Jobs tool: why the click loop stopped early (login_wall, rate_limit, left_search_page, halted, killed, card_click_limit). */
  stopped?: string;
  /** Jobs tool: structure diag of the pane (written once when clicks never showed an "About the job" section). */
  pane_diag?: string;
  /** Jobs tool: cards skipped before any click because a job with the same company and title is already stored. */
  known?: number;
  /** Broken parse only: consecutive broken parses of this search (including this one). */
  streak?: number;
  /** Broken parse only: compact page summary (headings, link counts, dialog, notices, guest-wall hint) for the operator to read. */
  summary?: PageSummary;
}

/** A card of the card-as-button layout that has no id yet: the click resolver may still get one. */
export interface PendingCard { cardIdx: number; title: string; company: string; description: string; pos?: number }
/** A card whose job id is already known (link or attribute): clickable only to read the description pane. */
export interface IdCard { id: string; num: string; cardIdx?: number; title: string; pos: number }
/** What the id resolution of the jobs tool returns (jobs are new Job rows with a code-built url). */
export interface EnrichOut {
  jobs: Job[];
  known: number;
  no_id: number;
  no_id_reasons: Record<string, number>;
  id_from: Record<string, number>;
  clicks: number;
  /** Pane mode: counts and the raw pane texts to save once the jobs exist. Absent counters are 0. */
  click_failed?: number;
  jd_known_skipped?: number;
  jd_pane_reasons?: Record<string, number>;
  panes?: Array<{ id: string; text: string; signals: unknown }>;
  stopped?: string;
  pane_diag?: string;
  /** True when this enrich did anything worth reporting (a click, a skip). */
  active?: boolean;
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
  /** Cards that have an id already (jobs tool): candidates for the description pane read. */
  idCards?: IdCard[];
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

/** Scroll rounds for a lazy-loading result page. Posts: `LINKEDIN_POST_SCROLL_ROUNDS`; jobs: `LINKEDIN_JOB_SCROLL_ROUNDS`. Default 6, clamp 0 to 12; 0 turns it off. */
export function scrollRoundsFor(env: NodeJS.ProcessEnv, key: 'LINKEDIN_POST_SCROLL_ROUNDS' | 'LINKEDIN_JOB_SCROLL_ROUNDS' = 'LINKEDIN_POST_SCROLL_ROUNDS'): number {
  const raw = env[key];
  const n = Number(raw);
  return Number.isFinite(n) && raw !== '' && raw !== undefined ? Math.max(0, Math.min(12, Math.trunc(n))) : 6;
}

const SCROLL_SRC = `(function(){var h=window.innerHeight||800,d=Math.round(h*0.85);window.scrollBy(0,d);
var els=document.querySelectorAll('main,div,section'),n=0;for(var i=0;i<els.length&&n<4;i++){var e=els[i];
if(e.scrollHeight>e.clientHeight+300&&/(auto|scroll)/.test(getComputedStyle(e).overflowY)){e.scrollTop+=d;n++;}}return n;})()`;

const cardKey = (c: { urn?: string; permalinkHref?: string; profileHref?: string; text?: string }): string =>
  c.urn || c.permalinkHref || `${c.profileHref ?? ''}|${(c.text ?? '').slice(0, 80)}`;

/** Identity of a job card across snapshots: the job id when the card has one, else its accessible name or title with the company. */
const jobCardKey = (c: RawJobCard): string => {
  const id = extractLinkedInJobId(String(c.href ?? '')) ?? (/^\d{6,25}$/.test(String(c.idHint ?? '')) ? String(c.idHint) : '');
  return id ? `id:${id}` : `${String(c.cardName ?? c.title ?? '').slice(0, 160)}|${String(c.company ?? '').slice(0, 80)}`;
};

/**
 * A search page can be "open" (title, nav, filters: a few hundred characters) before its results rendered, most of all on a slow link
 * (diag: `no_cards_parse_drift` with 309 body chars and no result links). When the first snapshot holds no card at all, wait a little and
 * read again, up to `tries` times, and keep the first snapshot that has cards. Never clicks. A fake runtime or an error keeps what it has.
 */
export async function settleForCards(deps: ToolDeps, first: RawSnapshot, tool: 'search_jobs' | 'search_posts', tries = 4): Promise<RawSnapshot> {
  const count = (s: RawSnapshot): number => (tool === 'search_posts' ? s.postCards?.length : s.jobCards?.length) ?? 0;
  const page = deps.rt.page?.() ?? null;
  if (!page || count(first) > 0) return first;
  let best = first;
  try {
    for (let i = 0; i < tries; i++) {
      await page.waitForTimeout(2500 + Math.floor(Math.random() * 1500));
      const s = await deps.rt.snapshot();
      if (!s) break;
      best = s;
      if (count(s) > 0) break;
    }
  } catch { /* keep what was read */ }
  return best;
}

/**
 * A search page loads a few cards per screen (posts) or a page of cards in an inner scrolling list (jobs). One snapshot of the first screen gave
 * 1 to 3 posts where a person scrolling sees 10 and more. Scroll like a person (a random 1.2 to 2.8 s between steps; the script scrolls the window
 * and up to 4 inner scrollable elements, so the left job list moves), snapshot again, merge the cards by identity, stop when two rounds add nothing
 * or `limit` cards are in. Never clicks. A fake runtime without a page, or any error, returns what was collected.
 * Jobs: a card seen again takes the NEWEST snapshot's marker (`cardIdx` is rewritten on every snapshot); a card missing from the last snapshot
 * loses its marker (it can no longer be clicked) but keeps its link or id attribute.
 */
export async function collectByScrolling(deps: ToolDeps, first: RawSnapshot, rounds: number, limit: number): Promise<RawSnapshot> {
  const page = deps.rt.page?.() ?? null;
  const jobs = !first.postCards && !!first.jobCards;
  if (!page || rounds <= 0 || (!first.postCards && !first.jobCards)) return first;
  type Card = NonNullable<RawSnapshot['postCards']>[number] & RawJobCard;
  const cardsOf = (sn: RawSnapshot): Card[] => ((jobs ? sn.jobCards : sn.postCards) ?? []) as unknown as Card[];
  const keyOf = (c: Card): string => (jobs ? jobCardKey(c) : cardKey(c));
  const seen = new Map<string, Card>();
  for (const c of cardsOf(first)) seen.set(keyOf(c), c);
  const firstUnique = seen.size;
  let last = first;
  let idle = 0;
  try {
    for (let i = 0; i < rounds && seen.size < limit && idle < 2; i++) {
      await page.evaluate(SCROLL_SRC);
      await page.waitForTimeout(1200 + Math.floor(Math.random() * 1600));
      const s = await deps.rt.snapshot();
      if (!s || !(jobs ? s.jobCards : s.postCards)) break;
      last = s;
      const before = seen.size;
      for (const c of cardsOf(s)) {
        const k = keyOf(c);
        if (!seen.has(k) || jobs) seen.set(k, c);
      }
      idle = seen.size === before ? idle + 1 : 0;
    }
  } catch { /* keep what was collected */ }
  if (!jobs) return { ...last, postCards: Array.from(seen.values()).slice(0, 50) };
  // Nothing new came in: the last snapshot as it is (same cards, same markers, a same-key twin inside it stays for the parser to count).
  if (seen.size === firstUnique) return last;
  const inLast = new Set(cardsOf(last).map(keyOf));
  const merged = Array.from(seen.entries()).slice(0, 50).map(([k, c]) => {
    if (inLast.has(k) || c.cardIdx === undefined) return c;
    const { cardIdx: _gone, ...rest } = c;
    return rest as Card;
  });
  return { ...last, jobCards: merged as RawJobCard[] };
}

export async function runDiscovery(o: {
  tool: 'search_jobs' | 'search_posts';
  /** Posts: scroll this many times to load more cards before parsing (default 0 = one snapshot). */
  scrollRounds?: number;
  scrollLimit?: number;
  deps: ToolDeps;
  url: string;
  expectKind: PageKind;
  searchName: string;
  parse: (snap: RawSnapshot) => Parsed;
  /** Posts: true only for a deliberately narrow query; a broad query with 0 cards is never a real empty page. Default true (jobs). */
  narrow?: boolean;
  /** Live runs only, after the jobs are saved: registers verified authors and returns how many. */
  afterSave?: (p: Parsed) => number;
  /** Live runs only, after the ceilings were consumed and before the save: resolves the ids of cards that have none and reads the description pane (may click, see jobIdResolve). */
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
  if (classifyUrl(r.snapshot.url) !== o.expectKind) return empty('failed', 'not_search_page');
  const settled = await settleForCards(deps, r.snapshot, o.tool);
  const snap = o.scrollRounds ? await collectByScrolling(deps, settled, o.scrollRounds, o.scrollLimit ?? 50) : settled;

  const lay = layoutGate(tool, deps);
  if (!lay.ok) return empty('refused', lay.code);
  const layout = lay.note ? { layout: lay.note.replace(/^layout=/, '') } : { layout: 'match' };

  const parsed = o.parse(snap);
  const base = {
    fetched: parsed.fetched, skipped: parsed.skipped, ...layout, parser: snap.cardParser ?? ('primary' as const),
    ...(parsed.injection ? { injection_suspected: true } : {}),
    ...(parsed.rejected && Object.keys(parsed.rejected).length ? { rejected: parsed.rejected } : {}),
  };

  // Logged-in check FIRST: a logged-out or guest page (password field, sign-in wall) is never "no results".
  const hint = guestHint(snap);
  if (snap.hasPasswordInput || (parsed.fetched === 0 && hint)) {
    const notify = deps.notify ?? (process.env.VITEST ? undefined : telegramNotifier(env));
    await criticalAlert(db, notify, 'session:guest_page', sessionAlertHtml(`guest or logged-out page (${hint ?? 'password field'})`, new URL(snap.url).pathname), now());
    return empty('failed', 'logged_out', { ...base, summary: pageSummary(snap, (s, max) => { const g = gateCardField(s, max); return g.blocked ? '' : g.text; }) });
  }

  // A search page with results can never legitimately give 0 cards: tell a real empty page from a broken parse.
  if (parsed.fetched === 0) {
    if (classifyZeroCards(snap, { narrow: o.narrow ?? true }) === 'broken') {
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
    recordDiscoverRun(db, now());
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
  if (o.enrich && (pending.length || parsed.idCards?.length)) enr = await o.enrich(parsed);
  // Nothing to report from an enrich that had no card without an id and read no pane (the old id-only mode with only id'd cards).
  if (enr && !enr.active && !pending.length) enr = null;
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
  // Descriptions read from the detail pane: same gate, screen and save function as linkedin_fetch_jd; a job saved here is not jd_pending any more.
  let jdSaved = 0;
  const paneReasons: Record<string, number> = { ...(enr?.jd_pane_reasons ?? {}) };
  for (const pn of enr?.panes ?? []) {
    const r = await savePaneJd({ db, now, screen: deps.screen }, pn.id, pn.text, pn.signals);
    if (r.code === 'saved') jdSaved++; else bump(paneReasons, r.code === 'blocked' ? 'blocked' : `save_${r.code}`);
  }
  const people = o.afterSave ? o.afterSave(parsed) : undefined;
  recordDiscoverRun(db, now());
  const idFrom: Record<string, number> = { ...(parsed.idFrom ?? {}) };
  for (const [k, n] of Object.entries(enr?.id_from ?? {})) idFrom[k] = (idFrom[k] ?? 0) + n;
  const result: DiscoverResult = {
    status: 'ok', code: ids.length ? 'saved' : parsed.fetched === 0 ? 'no_results' : 'no_new', ...base, new: ids.length, seen, job_ids: ids,
    ...(people !== undefined ? { people } : {}),
    ...(Object.keys(idFrom).length ? { id_from: idFrom } : {}),
    ...(enr ? { clicks: enr.clicks, known: enr.known, ...(enr.no_id ? { no_id: enr.no_id, no_id_reasons: enr.no_id_reasons } : {}) } : {}),
    ...(enr?.active ? {
      click_failed: enr.click_failed ?? 0, jd_from_pane: jdSaved, jd_known_skipped: enr.jd_known_skipped ?? 0,
      jd_pane_incomplete: Object.values(paneReasons).reduce((a, b) => a + b, 0),
      ...(Object.keys(paneReasons).length ? { jd_pane_reasons: paneReasons } : {}),
      ...(enr.stopped ? { stopped: enr.stopped } : {}),
      ...(enr.pane_diag ? { pane_diag: enr.pane_diag } : {}),
    } : {}),
  };
  // Trouble seen while clicking ends the search early: what was read stays saved, the status and code say why (a 429 or warning page is
  // rate_limited, a login wall failed, a halt or the kill switch halted). Never retried here.
  if (enr?.stopped === 'rate_limit') { result.status = 'rate_limited'; result.code = 'page_rate_limit'; }
  else if (enr?.stopped === 'login_wall') { result.status = 'failed'; result.code = 'login_wall'; }
  else if (enr?.stopped === 'halted' || enr?.stopped === 'killed') { result.status = 'halted'; result.code = enr.stopped; }
  else if (enr?.stopped === 'left_search_page') { result.status = 'failed'; result.code = 'left_search_page'; }
  // Cards were read but nothing came of them (or some had no id): a counts-only file shows the owner why.
  const lost = result.no_id || (ids.length === 0 && parsed.skipped > 0) || result.jd_pane_incomplete || result.stopped;
  if (parsed.fetched > 0 && lost && (deps.diagDir || !process.env.VITEST)) {
    const d = await writeDiscoverSummary({ now, ...(deps.diagDir ? { diagDir: deps.diagDir } : {}) }, { tool, search: o.searchName, result });
    if (d) result.diag = d;
  }
  return result;
}
