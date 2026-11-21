// The right-hand detail pane of the LinkedIn jobs search: after a card click it shows the full job description ("About the job"), so the JD
// can be read at that moment with no extra page load. Read-only. The in-page script only reads the DOM and marks the "more" control of the
// description; every rule (is the pane the clicked job, is the text complete, is it clamped) is pure code below.
// UNVERIFIED live: the real pane DOM (where "About the job" sits, the name of the "more" control). A search that clicked but never found an
// "About the job" section writes ONE structure diag (see discoverDiag.writePaneDiag) so the selectors can be fixed from data.
import { jdFromLinkedinBody, jdTextOf } from '../jdFetch.js';
import { linkedinSignalsSrc } from '../linkedinSignals.js';
import { jobIdFromUrl } from './buttonCard.js';
import type { LiPage } from './types.js';

/** Attribute the in-page script puts on the description's "more" control, so code can click it with an ordinary locator. */
export const MORE_ATTR = 'data-jobber-more';
const MAX_TEXT = 40000;

/** In-page reader. Pane root = the container of the "About the job" heading, widened while it still holds no more than one job-list item. */
export const PANE_SRC = String.raw`(function () {
  function txt(e) { return ((e && (e.innerText || e.textContent)) || '').replace(/\s+/g, ' ').trim(); }
  function raw(e) { return String((e && (e.innerText || e.textContent)) || ''); }
  var old = document.querySelectorAll('[${MORE_ATTR}]');
  for (var o = 0; o < old.length; o++) old[o].removeAttribute('${MORE_ATTR}');
  var cand = document.querySelectorAll('h2, h3, h4, span, p, div'), head = null, i;
  for (i = 0; i < cand.length; i++) {
    var c = cand[i];
    if (c.children && c.children.length > 2) continue;
    if (/^about the job$/i.test(txt(c))) { head = c; break; }
  }
  var LIST = 'li[data-occludable-job-id], [data-job-id], [data-jobber-card]';
  var pane = null;
  if (head) {
    pane = head;
    for (i = 0; i < 12 && pane.parentElement; i++) {
      var p = pane.parentElement;
      if (p === document.body || p.tagName === 'MAIN' || p.querySelectorAll(LIST).length > 1) break;
      pane = p;
    }
  }
  var more = false;
  if (head && pane) {
    var btns = pane.querySelectorAll('button, [role="button"], a');
    for (i = 0; i < btns.length && !more; i++) {
      var b = btns[i], nm = txt(b) || String(b.getAttribute('aria-label') || '');
      if (!/^(?:(?:…|\.\.\.)\s*)?(?:(?:show|see|view|read)\s+)?more$/i.test(nm.trim())) continue;
      if (!(head.compareDocumentPosition(b) & 4)) continue;
      b.setAttribute('${MORE_ATTR}', '1');
      more = true;
    }
  }
  var h1 = pane ? pane.querySelector('h1') : null;
  return {
    url: String(location.href || ''), hasAbout: !!head, paneFound: !!pane, heading: txt(h1).slice(0, 200),
    paneText: pane ? raw(pane).slice(0, ${MAX_TEXT}) : '', bodyText: raw(document.body).slice(0, 60000), more: more,
    signals: pane ? ${linkedinSignalsSrc('pane')} : null
  };
})()`;

export interface PaneRead {
  url: string;
  hasAbout: boolean;
  paneFound: boolean;
  heading: string;
  paneText: string;
  bodyText: string;
  /** A "more" control of the description was found and marked. */
  more: boolean;
  /** Raw output of the signals collector (untrusted; parsed by parseLinkedinSignals). */
  signals: unknown;
}

const s = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** One read of the pane. null when the page cannot be read (never throws). */
export async function readPane(page: LiPage): Promise<PaneRead | null> {
  try {
    const r = (await page.evaluate<unknown>(PANE_SRC)) as Record<string, unknown> | null;
    if (!r || typeof r !== 'object') return null;
    return {
      url: s(r.url, 600) || page.url(), hasAbout: r.hasAbout === true, paneFound: r.paneFound === true, heading: s(r.heading, 200),
      paneText: s(r.paneText, MAX_TEXT), bodyText: s(r.bodyText, 60000), more: r.more === true, signals: r.signals ?? null,
    };
  } catch {
    return null;
  }
}

// ---- pure rules ----

const norm = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** True when the pane heading can belong to the card (either contains the other); an empty side cannot be judged and passes. */
export function headingMatches(heading: string, title: string): boolean {
  const h = norm(heading);
  const t = norm(title);
  if (!h || !t) return true;
  return h.includes(t) || t.includes(h);
}

export interface PaneExpect { expectId?: string; prevUrlId: string | null; prevHeading: string }

/** The pane shows the clicked job: the URL carries the card's id, or (no id in the URL) the pane heading changed. Needs an "About the job" section. */
export function paneReady(read: PaneRead, e: PaneExpect): boolean {
  if (!read.hasAbout) return false;
  const uid = jobIdFromUrl(read.url);
  if (e.expectId) return uid ? uid === e.expectId : read.heading !== '' && read.heading !== e.prevHeading;
  return !!uid && (uid !== e.prevUrlId || (read.heading !== '' && read.heading !== e.prevHeading));
}

/** The JD text of a read: the section after "About the job", from the pane when it was found, else from the whole page text. */
export function paneJdText(read: PaneRead): string {
  return jdTextOf({ jd: jdFromLinkedinBody(read.paneFound && read.paneText ? read.paneText : read.bodyText) });
}

const TAIL = /(?:(?:…|\.{3})\s*more|\b(?:show|see|view|read)\s+more)\s*$/i;

/** True when the text ends in a truncation marker, or is short while a "more" control exists. A clamped text must be expanded first. */
export function looksClamped(text: string, moreControl: boolean): boolean {
  return TAIL.test(text) || (moreControl && text.length < 400);
}

/** Truncation tail of a text that otherwise passes the JD gate (the gate misses "…more"); such a text is never stored. */
export const hasMoreTail = (text: string): boolean => TAIL.test(text);

const RATE_RE = /(too many requests|error 429|\b429\b.{0,40}(error|too many)|unusual (activity|traffic)|temporarily (restricted|limited|blocked)|verify you.re (a )?human|complete the captcha|quick security check)/i;
const WALL_RE = /(sign in to view|join linkedin|authwall|please log ?in)/i;

/** A warning page instead of the job: 'rate_limit' (429, unusual activity, captcha) or 'login_wall'; null when the read looks normal. Only judged when no job section is shown. */
export function troubleOf(read: PaneRead | null): 'rate_limit' | 'login_wall' | null {
  if (!read || read.hasAbout) return null;
  const head = read.bodyText.slice(0, 3000);
  if (RATE_RE.test(head)) return 'rate_limit';
  if (read.hasAbout === false && head.length < 1500 && WALL_RE.test(head)) return 'login_wall';
  return null;
}
