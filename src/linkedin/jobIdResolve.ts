// Job id of a card-as-button search result, read in code from the real page URL after an ordinary card click (the detail pane opens
// and the URL gets `currentJobId=<digits>`). Only digits ever leave this file; the model never supplies an id or a URL.
// Limits: at most MAX_CLICKS clicks per search, a random pause between clicks, stop on a halt or a login wall. Every card without an id
// is counted with a reason (never silently dropped).
import { haltReason } from '../outreach/limits.js';
import { bump } from './discoverCommon.js';
import { jobIdFromUrl } from './buttonCard.js';
import { classifyUrl } from './urls.js';
import type { ToolDeps } from './toolDeps.js';

export const MAX_CLICKS = 10;
export const PAUSE_MIN_MS = 1500;
export const PAUSE_MAX_MS = 4000;
const AFTER_CLICK_MS = 900;

export interface ClickTarget { cardIdx: number }
export interface ClickResolved {
  /** cardIdx -> job id digits. */
  ids: Map<number, string>;
  /** cardIdx -> why no id (also for cards never clicked). */
  failed: Map<number, string>;
  clicks: number;
}

/** Pause length in [PAUSE_MIN_MS, PAUSE_MAX_MS]; `rand` returns [0,1). */
export const pauseMs = (rand: () => number = Math.random): number => Math.round(PAUSE_MIN_MS + rand() * (PAUSE_MAX_MS - PAUSE_MIN_MS));

export async function resolveIdsByClick(
  deps: ToolDeps, targets: ClickTarget[], rand: () => number = Math.random,
): Promise<ClickResolved> {
  const out: ClickResolved = { ids: new Map(), failed: new Map(), clicks: 0 };
  const page = deps.rt.page();
  let stop = '';
  for (const t of targets) {
    if (stop) { out.failed.set(t.cardIdx, stop); continue; }
    if (out.clicks >= MAX_CLICKS) { out.failed.set(t.cardIdx, 'click_limit'); continue; }
    if (!page) { stop = 'no_page'; out.failed.set(t.cardIdx, stop); continue; }
    if (haltReason(deps.db, 'linkedin')) { stop = 'halted'; out.failed.set(t.cardIdx, stop); continue; }
    if (out.clicks > 0) await page.waitForTimeout(pauseMs(rand)).catch(() => undefined);
    deps.rt.touch();
    out.clicks++;
    try {
      // The card is marked data-jobber-card=<n> by the snapshot script; an ordinary click on it opens the detail pane.
      await page.locator(`[data-jobber-card="${Math.trunc(t.cardIdx)}"]`).first().click({ timeout: 5000 });
    } catch {
      out.failed.set(t.cardIdx, 'click_failed');
      continue;
    }
    let id: string | null = null;
    for (let tries = 0; tries < 2 && !id && !stop; tries++) {
      await page.waitForTimeout(AFTER_CLICK_MS).catch(() => undefined);
      const url = page.url();
      const kind = classifyUrl(url);
      if (kind === 'login' || kind === 'checkpoint') { stop = 'login_wall'; break; }
      id = jobIdFromUrl(url);
    }
    // The URL keeps the previous card's id when a click did not change the selection: an id already given to another card is stale.
    if (id && [...out.ids.values()].includes(id)) out.failed.set(t.cardIdx, 'stale_id');
    else if (id) out.ids.set(t.cardIdx, id);
    else out.failed.set(t.cardIdx, stop || 'no_current_job_id');
  }
  return out;
}

/** Fold a failed map into reason counters. */
export function reasonCounts(failed: Map<number, string>): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of failed.values()) bump(m, r);
  return m;
}
