// Card clicks of the LinkedIn jobs search. Two jobs in one ordinary click on a card:
//  (1) the job id of a card-as-button result, read in code from the real page URL after the click (`currentJobId=<digits>`);
//  (2) the full job description from the right-hand pane at that moment (src/linkedin/paneJd.ts), so no extra page load per job.
// Only digits ever leave this file as an id; the model never supplies an id, a selector or a URL.
// Budgets: `LINKEDIN_JOB_CLICKS_PER_SEARCH` clicks per search (0 = the old behaviour: id-only clicks, at most MAX_CLICKS, no pane read), the
// daily `linkedin_card_click` ceiling, a random pause between clicks. Stops at the first sign of trouble (halt, kill switch, login wall, a
// 429 or "unusual activity" page, leaving the search page). Every card without an id or a JD is counted with a reason, never silently dropped.
import { loadOutreachConfig } from '../outreach/config.js';
import { haltReason, tryConsume } from '../outreach/limits.js';
import { bump } from './discoverCommon.js';
import { jobIdFromUrl } from './buttonCard.js';
import { headingMatches, hasMoreTail, looksClamped, MORE_ATTR, paneJdText, paneReady, readPane, troubleOf, type PaneRead } from './paneJd.js';
import { classifyUrl } from './urls.js';
import type { ToolDeps } from './toolDeps.js';

export const MAX_CLICKS = 10;
export const PAUSE_MIN_MS = 1500;
export const PAUSE_MAX_MS = 4000;
/** Pause range between clicks when the pane is read (human-like: 1.5 to 3.5 s). */
export const PANE_PAUSE_MAX_MS = 3500;
const AFTER_CLICK_MS = 900;
const POLL_MS = 600;
const POLL_BUDGET_MS = 6000;
/** Consecutive clicks with no "About the job" section at all before pane reading is given up for this search. */
const DRIFT_AFTER = 3;

/** Clicks per search (`LINKEDIN_JOB_CLICKS_PER_SEARCH`, default 25, clamp 0 to 60; 0 = old id-only behaviour). */
export function jobClicksPerSearchFor(env: NodeJS.ProcessEnv): number {
  const raw = env.LINKEDIN_JOB_CLICKS_PER_SEARCH;
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) ? Math.max(0, Math.min(60, Math.trunc(n))) : 25;
}

export interface ClickTarget {
  /** Position in the result list (clicks go in list order). */
  pos?: number;
  /** Marker written by the snapshot script (data-jobber-card). Needed for a card without a known id. */
  cardIdx?: number;
  /** Digits of the job id when the card already gave one (link or attribute). */
  id?: string;
  /** Card title, to check that the pane shows this job. */
  title?: string;
}
export interface PaneJd { text: string; signals: unknown }
export interface ClickResolved {
  /** cardIdx -> job id digits (cards that had no id). */
  ids: Map<number, string>;
  /** cardIdx -> why no id (also for cards never clicked). */
  failed: Map<number, string>;
  clicks: number;
  /** Clicks that threw (counted again in `failed` or `paneReasons`). */
  clickFailed: number;
  /** job id digits -> complete JD text and raw signals read from the pane. */
  panes: Map<string, PaneJd>;
  /** Why a wanted pane JD was not taken, by reason. */
  paneReasons: Record<string, number>;
  /** Why the loop stopped early: halted | killed | login_wall | rate_limit | left_search_page | card_click_limit | no_page. */
  stopped?: string;
  /** True when clicks were made in pane mode and no read ever showed an "About the job" section (a diag is due). */
  noPaneEver: boolean;
}

/** Pause length in [PAUSE_MIN_MS, maxMs]; `rand` returns [0,1). */
export const pauseMs = (rand: () => number = Math.random, maxMs: number = PAUSE_MAX_MS): number => Math.round(PAUSE_MIN_MS + rand() * (maxMs - PAUSE_MIN_MS));

export interface ClickOpts {
  /** Read the pane after each click (new behaviour). False: id-only clicks (old behaviour). */
  paneReads: boolean;
  maxClicks: number;
  /** Charge the daily `linkedin_card_click` ceiling per click. */
  ceiling: boolean;
}

const onSearchPage = (url: string): boolean => {
  try { return classifyUrl(url) === 'jobs' && /^\/jobs\/search/.test(new URL(url).pathname); } catch { return false; }
};

/** Old entry point: id-only clicks, at most MAX_CLICKS. */
export function resolveIdsByClick(deps: ToolDeps, targets: ClickTarget[], rand: () => number = Math.random): Promise<ClickResolved> {
  return clickCards(deps, targets, { paneReads: false, maxClicks: MAX_CLICKS, ceiling: false }, rand);
}

export async function clickCards(deps: ToolDeps, targets: ClickTarget[], opts: ClickOpts, rand: () => number = Math.random): Promise<ClickResolved> {
  const out: ClickResolved = { ids: new Map(), failed: new Map(), clicks: 0, clickFailed: 0, panes: new Map(), paneReasons: {}, noPaneEver: false };
  const page = deps.rt.page();
  const cfg = loadOutreachConfig(deps.env);
  const usedIds = new Set<string>();
  let stop = '';
  let paneOff = false;
  let noAbout = 0;
  let sawAbout = false;
  let prevUrlId: string | null = null;
  let prevHeading = '';

  const fail = (t: ClickTarget, reason: string): void => {
    if (!t.id && Number.isInteger(t.cardIdx)) out.failed.set(t.cardIdx as number, reason);
    else bump(out.paneReasons, reason);
  };

  for (const t of targets) {
    if (stop) { fail(t, stop); continue; }
    if (!page) { stop = 'no_page'; fail(t, stop); continue; }
    if (opts.paneReads && paneOff && t.id) { fail(t, 'pane_drift'); continue; }
    if (out.clicks >= opts.maxClicks) { fail(t, 'click_limit'); continue; }
    const killed = deps.killed?.() ?? null;
    if (killed) { stop = 'killed'; fail(t, stop); continue; }
    if (haltReason(deps.db, 'linkedin')) { stop = 'halted'; fail(t, stop); continue; }
    if (opts.ceiling && !tryConsume(deps.db, 'linkedin_card_click', cfg, deps.now())) { stop = 'card_click_limit'; fail(t, stop); continue; }
    if (out.clicks > 0) await page.waitForTimeout(pauseMs(rand, opts.paneReads ? PANE_PAUSE_MAX_MS : PAUSE_MAX_MS)).catch(() => undefined);
    deps.rt.touch();
    if (opts.paneReads) {
      // State before the click: what the pane showed, to tell a changed pane from a stale one.
      prevUrlId = jobIdFromUrl(page.url());
      prevHeading = (await readPane(page))?.heading ?? '';
    }
    out.clicks++;
    try {
      // The card is marked data-jobber-card=<n> by the snapshot script; a card with a known id and no marker (link layout) is found by its link.
      const sel = Number.isInteger(t.cardIdx) ? `[data-jobber-card="${Math.trunc(t.cardIdx as number)}"]` : `a[href*="${String(t.id ?? '').replace(/\D/g, '')}"]`;
      await page.locator(sel).first().click({ timeout: 5000 });
    } catch {
      out.clickFailed++;
      fail(t, 'click_failed');
      continue;
    }
    if (!opts.paneReads) {
      let id: string | null = null;
      for (let tries = 0; tries < 2 && !id && !stop; tries++) {
        await page.waitForTimeout(AFTER_CLICK_MS).catch(() => undefined);
        const url = page.url();
        const kind = classifyUrl(url);
        if (kind === 'login' || kind === 'checkpoint') { stop = 'login_wall'; break; }
        id = jobIdFromUrl(url);
      }
      // The URL keeps the previous card's id when a click did not change the selection: an id already given to another card is stale.
      if (id && [...out.ids.values()].includes(id)) out.failed.set(t.cardIdx as number, 'stale_id');
      else if (id) out.ids.set(t.cardIdx as number, id);
      else out.failed.set(t.cardIdx as number, stop || 'no_current_job_id');
      continue;
    }

    // ---- pane mode ----
    const expect = { ...(t.id ? { expectId: t.id } : {}), prevUrlId, prevHeading };
    // Pane reading was given up for this search: only the id of a card without one is still taken.
    const idOnly = paneOff;
    let read: PaneRead | null = null;
    let ready = false;
    for (let waited = 0; waited <= POLL_BUDGET_MS && !stop; waited += POLL_MS) {
      await page.waitForTimeout(waited === 0 ? AFTER_CLICK_MS : POLL_MS).catch(() => undefined);
      const url = page.url();
      const kind = classifyUrl(url);
      if (kind === 'login' || kind === 'checkpoint') { stop = 'login_wall'; break; }
      if (!onSearchPage(url)) { stop = 'left_search_page'; break; }
      read = (await readPane(page)) ?? read;
      const trouble = troubleOf(read);
      if (trouble) { stop = trouble; break; }
      if (idOnly) { if (jobIdFromUrl(url) && jobIdFromUrl(url) !== prevUrlId) break; continue; }
      if (read && paneReady(read, expect)) { ready = true; break; }
    }
    if (stop) { fail(t, stop); continue; }
    const uid = read ? jobIdFromUrl(read.url) : jobIdFromUrl(page.url());
    let id = t.id ?? null;
    if (!id) {
      // A card without an id: the id of the click is the one the URL now carries (an id already given to another card is stale).
      if (!uid) { fail(t, 'no_current_job_id'); continue; }
      if (usedIds.has(uid)) { fail(t, 'stale_id'); continue; }
      id = uid;
      out.ids.set(t.cardIdx as number, id);
    }
    usedIds.add(id);
    if (idOnly) continue;
    if (read?.hasAbout) { sawAbout = true; noAbout = 0; } else {
      noAbout++;
      bump(out.paneReasons, 'pane_not_found');
      if (noAbout >= DRIFT_AFTER) paneOff = true;
      continue;
    }
    if (!read || (!ready && !(t.id === undefined && uid === id))) { bump(out.paneReasons, 'pane_not_selected'); continue; }
    if (!headingMatches(read.heading, t.title ?? '')) { bump(out.paneReasons, 'pane_title_mismatch'); continue; }

    let text = paneJdText(read);
    if (looksClamped(text, read.more)) {
      if (!read.more) { bump(out.paneReasons, 'clamped_no_more'); continue; }
      try {
        await page.locator(`[${MORE_ATTR}="1"]`).first().click({ timeout: 4000 });
      } catch {
        bump(out.paneReasons, 'more_click_failed');
        continue;
      }
      await page.waitForTimeout(700 + Math.floor(rand() * 600)).catch(() => undefined);
      const again = await readPane(page);
      if (!again || !again.hasAbout) { bump(out.paneReasons, 'pane_lost_after_more'); continue; }
      if (jobIdFromUrl(again.url) && jobIdFromUrl(again.url) !== id) { bump(out.paneReasons, 'pane_not_selected'); continue; }
      read = again;
      text = paneJdText(again);
    }
    if (hasMoreTail(text)) { bump(out.paneReasons, 'clamped_tail'); continue; }
    out.panes.set(id, { text, signals: read.signals });
  }
  out.noPaneEver = opts.paneReads && out.clicks - out.clickFailed > 0 && !sawAbout;
  if (stop) out.stopped = stop;
  return out;
}

/** Fold a failed map into reason counters. */
export function reasonCounts(failed: Map<number, string>): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of failed.values()) bump(m, r);
  return m;
}
