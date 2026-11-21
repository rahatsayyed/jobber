// file: src/linkedinSignals.ts
// Social-proof signals of a LinkedIn job page, read while `linkedin_fetch_jd` already has the page open: "N connections work here"
// (people the owner knows at the company) and the "Meet the hiring team" entries with their connection degree. Read-only; they only
// ORDER work (src/promoted.ts), never change a score, a veto or a threshold.
//
// The in-page collector below is thin: it picks the page's OWN top block and hiring-team block (never a "More jobs" or similar-jobs card,
// which show the signals of OTHER jobs) and returns short raw strings. All rules live in the pure `parseLinkedinSignals`.
// UNVERIFIED live: where the line sits for the page's own job (the probe only saw it inside other jobs' cards); the first real hit shows it.
import { gateField } from './safety/fieldGate.js';

/** Blocks whose text belongs to OTHER jobs or people; a signal found inside one is never attributed to this job. */
const OTHER_JOBS = /(more jobs|similar jobs|jobs you may be interested in|people also viewed)/i;

/** In-page collector (a string on purpose, like the other page scripts). Returns {top, hiring, hasHiring, probe}; reads the DOM only. */
export const LINKEDIN_SIGNALS_SRC = `(() => {
  const txt = (e) => ((e && (e.innerText || e.textContent)) || '').replace(/\\s+/g, ' ').trim();
  const BAD = /more jobs|similar jobs|jobs you may be interested in|people also viewed/i;
  const h1 = document.querySelector('h1');
  let top = '', topEl = null, n = h1;
  for (let i = 0; n && i < 5; i++) {
    n = n.parentElement;
    if (!n) break;
    const t = txt(n);
    if (t.length > 1500 || BAD.test(t)) break;
    topEl = n; top = t;
  }
  let hirEl = null;
  const heads = Array.from(document.querySelectorAll('h2, h3, h4, span, p, div')).filter((e) => /^meet the hiring team$/i.test(txt(e)));
  if (heads.length) {
    let c = heads[0], last = null;
    for (let i = 0; c && i < 4; i++) {
      c = c.parentElement;
      if (!c || BAD.test(txt(c))) break;
      if (c.querySelector('a[href*="/in/"]')) { last = c; break; }
    }
    hirEl = last;
  }
  const hiring = hirEl ? Array.from(hirEl.querySelectorAll('a[href*="/in/"]')).slice(0, 8).map((a) => {
    let t = txt(a);
    if (!/[•·]\\s*(1st|2nd|3rd)/i.test(t)) { const p = a.closest('li') || a.parentElement; const pt = txt(p); if (pt.length < 240) t = pt; }
    return { text: t.slice(0, 300), href: a.getAttribute('href') || '' };
  }) : [];
  const probe = [];
  for (const root of [topEl, hirEl]) {
    if (!root || !/connection/i.test(txt(root))) continue;
    for (const e of Array.from(root.querySelectorAll('*'))) {
      const t = txt(e);
      if (t.length < 120 && /connection/i.test(t) && probe.length < 5) probe.push({ tag: e.tagName.toLowerCase(), role: e.getAttribute('role') || '', text: t });
    }
  }
  return { top: top.slice(0, 1500), hiring: hiring, hasHiring: !!hirEl, probe: probe };
})()`;

export type LiDegree = 1 | 2 | 3 | null;
export interface HiringEntry { name: string; degree: LiDegree; headline: string; profile_key: string }
export interface LinkedinSignals {
  /** True when the page's own top block or hiring block was found, so "none" really means none. */
  checked: boolean;
  /** Parsed from "N connection(s) work(s) here" inside the scoped block, else null. */
  connections_here: number | null;
  /** Up to 5 entries from the hiring-team block only. */
  hiring_team: HiringEntry[];
  /** The scoped text mentions "connection" but nothing parsed (a diag is due). */
  saw_connection_word: boolean;
  /** Short raw probe nodes for the diag (untrusted; the diag writer redacts them). */
  probe: Array<{ tag: string; role: string; text: string }>;
}

const MAX_TEAM = 5;
const HEADLINE_MAX = 80;
const NAME_MAX = 60;
const CTRL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');
const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(CTRL, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** The profile slug of an https linkedin.com/in/<slug> link (relative links count as linkedin.com), else ''. */
export function profileKeyOf(href: unknown): string {
  if (typeof href !== 'string' || href.length > 500) return '';
  try {
    const u = new URL(href.trim(), 'https://www.linkedin.com');
    if (u.protocol !== 'https:' || u.username || u.password || !/(^|\.)linkedin\.com$/i.test(u.hostname)) return '';
    const m = /^\/in\/([A-Za-z0-9%_-]{2,100})\/?$/.exec(u.pathname);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

const DEGREE_RE = /^(.{1,120}?)\s*[•·]\s*(1st|2nd|3rd)\+?(?![A-Za-z])\s*(.*)$/i;

/** One hiring-team entry from a link's text ("Name • 2nd Headline") and href; null when the href is not a profile link or no name is left. */
export function parseHiringEntry(text: unknown, href: unknown): HiringEntry | null {
  const key = profileKeyOf(href);
  const t = clean(text, 300);
  if (!key || !t) return null;
  let name: string;
  let degree: LiDegree = null;
  let headline: string;
  const m = DEGREE_RE.exec(t);
  if (m) {
    name = m[1].trim();
    degree = m[2][0] === '1' ? 1 : m[2][0] === '2' ? 2 : 3;
    headline = m[3].trim();
  } else {
    // No degree marker: the first three words are taken as the name (degree stays unknown, so it never adds priority).
    const w = t.split(' ');
    name = w.slice(0, 3).join(' ');
    headline = w.slice(3).join(' ');
  }
  // Screen readers duplicate the name ("Pranati R Pranati R"): keep one copy.
  const nw = name.split(' ');
  if (nw.length % 2 === 0 && nw.slice(0, nw.length / 2).join(' ') === nw.slice(nw.length / 2).join(' ')) name = nw.slice(0, nw.length / 2).join(' ');
  name = name.slice(0, NAME_MAX).trim();
  if (!name) return null;
  return { name, degree, headline: headline.slice(0, HEADLINE_MAX), profile_key: key };
}

/**
 * Pure rules: raw collector output (all untrusted) to signals. The "N connections work here" text counts only in the top block, and only
 * before any "More jobs" / similar-jobs marker; hiring-team entries come only from the hiring-team links. Never throws.
 */
export function parseLinkedinSignals(raw: unknown): LinkedinSignals {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { top?: unknown; hiring?: unknown; hasHiring?: unknown; probe?: unknown };
  let top = clean(r.top, 1500);
  const cut = OTHER_JOBS.exec(top);
  if (cut) top = top.slice(0, cut.index);
  const hiring = Array.isArray(r.hiring) ? r.hiring.slice(0, 8) : [];
  const seen = new Set<string>();
  const team: HiringEntry[] = [];
  for (const h of hiring) {
    const o = (h && typeof h === 'object' ? h : {}) as { text?: unknown; href?: unknown };
    if (OTHER_JOBS.test(clean(o.text, 300))) continue;
    const e = parseHiringEntry(o.text, o.href);
    if (!e || seen.has(e.profile_key)) continue;
    seen.add(e.profile_key);
    team.push(e);
    if (team.length >= MAX_TEAM) break;
  }
  const m = /(?<!\d)(\d{1,4})\s+connections?\s+works?\s+here/i.exec(top);
  const n = m ? Number(m[1]) : null;
  const connections_here = n !== null && Number.isFinite(n) ? n : null;
  const checked = top.length > 0 || r.hasHiring === true;
  const sawWord = /connection/i.test(top) || (Array.isArray(r.probe) && r.probe.length > 0);
  const probe = Array.isArray(r.probe)
    ? r.probe.slice(0, 5).map((p) => {
      const o = (p && typeof p === 'object' ? p : {}) as { tag?: unknown; role?: unknown; text?: unknown };
      return { tag: clean(o.tag, 20), role: clean(o.role, 20), text: clean(o.text, 120) };
    })
    : [];
  return { checked, connections_here, hiring_team: team, saw_connection_word: sawWord, probe };
}

/** True when the diag is due: the scoped text speaks of "connection" but nothing parsed. */
export const signalsDiagDue = (s: LinkedinSignals): boolean => s.saw_connection_word && s.connections_here === null && s.hiring_team.length === 0;

/** Names and headlines go through the stored-page-text field gate; an entry that is blocked is dropped. */
export function gateSignals(s: LinkedinSignals): LinkedinSignals {
  const team: HiringEntry[] = [];
  for (const e of s.hiring_team) {
    const n = gateField(e.name, NAME_MAX);
    const h = gateField(e.headline, HEADLINE_MAX);
    if (n.blocked || h.blocked || !n.text) continue;
    team.push({ ...e, name: n.text, headline: h.text });
  }
  return { ...s, hiring_team: team };
}

/** The 0.1-scale bonus inputs read back from storage: li_connections (null unknown) and the stored JSON of hiring-team entries. */
export function readHiringTeam(json: unknown): HiringEntry[] {
  if (typeof json !== 'string' || !json) return [];
  try {
    const a = JSON.parse(json) as unknown;
    return Array.isArray(a) ? (a.filter((x) => x && typeof x === 'object') as HiringEntry[]).slice(0, MAX_TEAM) : [];
  } catch {
    return [];
  }
}
