// file: src/jdFetch.ts
// Typed, read-only fetch of ONE job description (JD) from the job page, for the `naukri_fetch_jd` and `linkedin_fetch_jd` tools.
//
// The model passes at most a job id (usually nothing): CODE picks the job (a waiting one, see src/jdStore.ts), takes its URL from SQLite
// (never from the model; validated again here), checks halts and the daily ceilings, loads the page in the operator's own session, reads
// the description section, runs the input gate and the classifier screen, and saves the text in jobs.description only when it is a
// COMPLETE JD (src/jdComplete.ts). A page that says the job is gone marks the job `jd_unavailable`. Page text never reaches the result.
//
// Nothing here sends, applies or clicks. UNVERIFIED live: the page structure of Naukri and LinkedIn job pages (selectors in the in-page
// scripts below and the closed-page phrases) was written from the known markup and fixtures, no live page has been read for it.
import type BetterSqlite3 from 'better-sqlite3';
import { extractNaukriJobId } from './sources/naukri.js';
import { isNaukriUrl } from './naukri/page.js';
import { canonicalJobUrl, extractLinkedInJobId } from './linkedin/jobIds.js';
import { cleanJdText, isJdComplete, jdFetchPlatform } from './jdComplete.js';
import { listJdCandidates, markJdPending, markJdUnavailable, recordJdAttempt, saveFetchedJd } from './jdStore.js';
import { loadOutreachConfig } from './outreach/config.js';
import { ceilings, haltReason, tryConsume, type LimitKey } from './outreach/limits.js';
import { isDryRun, recordDryRun } from './safety/dryRun.js';
import { gateField } from './safety/fieldGate.js';
import type { ScreenPurpose, ScreenVerdict } from './safety/screen.js';

type Db = BetterSqlite3.Database;

export type JdPlatform = 'naukri' | 'linkedin';

/** Most JD pages one tool process (one wake) reads, whatever the daily ceiling says. */
export const JD_FETCH_PER_RUN_MAX = 15;
/** Longest JD text kept (the page scripts cut at 12000 too). */
export const JD_MAX_CHARS = 12000;

/** Random pause (ms) before every page after the first of a session: 3 to 8 seconds, so job pages are not opened back to back. */
export function jdGapMs(rng: () => number = Math.random): number {
  return 3000 + Math.floor(Math.min(0.999999, Math.max(0, rng())) * 5001);
}

/** The ceiling that charges a fetch, per platform (LinkedIn also charges the profile-view ceiling). */
const CEILING: Record<JdPlatform, LimitKey> = { naukri: 'naukri_jd_fetch', linkedin: 'linkedin_jd_fetch' };

// ---- in-page scripts (strings on purpose: no helper may be injected into them; they only read the DOM) ----

/** Generic page notices for the closed-page and block-page checks: title, first heading, alerts and the head of the body text. */
export const JD_NOTICE_SRC = `(() => {
  const txt = (e) => ((e && (e.innerText || e.textContent)) || '').replace(/\\s+/g, ' ').trim();
  const alerts = Array.from(document.querySelectorAll('[role="alert"], [class*="toast"], [class*="expired"], [class*="closed"], [class*="error"]')).map(txt).filter((t) => t && t.length < 300).slice(0, 6);
  return { title: document.title || '', heading: txt(document.querySelector('h1')), alerts: alerts, bodyHead: txt(document.body).slice(0, 1500) };
})()`;

/** LinkedIn job page: the description section plus the same notices. Selectors cover the signed-in and the public markup (unverified live). */
export const JD_LINKEDIN_SRC = `(() => {
  const txt = (e) => ((e && (e.innerText || e.textContent)) || '').replace(/\\s+/g, ' ').trim();
  const el = document.querySelector('#job-details, .jobs-description__content, .jobs-box__html-content, .jobs-description-content__text, .show-more-less-html__markup, [class*="jobs-description"]');
  const alerts = Array.from(document.querySelectorAll('[role="alert"], .artdeco-inline-feedback, [class*="closed-job"], [class*="apply-error"], [class*="no-longer"]')).map(txt).filter((t) => t && t.length < 300).slice(0, 6);
  return { jd: txt(el).slice(0, 12000), title: document.title || '', heading: txt(document.querySelector('h1')), alerts: alerts, bodyHead: txt(document.body).slice(0, 1500) };
})()`;

/** What a page read returns. Every field is untrusted page text. */
export interface JdPageRead { jd?: unknown; title?: unknown; heading?: unknown; alerts?: unknown; bodyHead?: unknown }

// ---- pure page rules ----

const NAUKRI_CLOSED = /(this job (has )?(expired|is (no longer|closed))|job (has )?(expired|been (removed|closed))|no longer (accepting|available|active|open)|position (has been )?filled|the job you are looking for|page (you are looking for )?(was )?not found|\boops\b.{0,80}\b(page|job)\b|\b404\b)/i;
const LINKEDIN_CLOSED = /(no longer accepting applications|job (posting )?(has been )?(removed|closed)|this job is no longer available|unable to load the page|this job post(ing)? (is|has been) (no longer|removed)|page (isn.t|is not) available|the job you(.re| are) looking for)/i;
const BLOCKED = /(access denied|you don.t have permission to access|are you a robot|verify you are (a )?human|unusual traffic|captcha)/i;
const LOGIN = /(sign in|log ?in|join now|authwall)/i;

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** 'closed' (the job is gone), 'blocked' (bot wall) or 'ok'. A closed phrase in the body head counts only when no description section was found. */
export function classifyJdPage(platform: JdPlatform, page: JdPageRead): 'closed' | 'blocked' | 'ok' {
  const head = [str(page.title, 300), str(page.heading, 300), ...(Array.isArray(page.alerts) ? page.alerts.map((a) => str(a, 300)) : [])].join('\n');
  const body = str(page.bodyHead, 1500);
  const jd = str(page.jd, JD_MAX_CHARS).trim();
  if (BLOCKED.test(head) || (!jd && BLOCKED.test(body))) return 'blocked';
  const closed = platform === 'naukri' ? NAUKRI_CLOSED : LINKEDIN_CLOSED;
  if (closed.test(head)) return 'closed';
  if (!jd && closed.test(body)) return 'closed';
  return 'ok';
}

/** True when the read looks like a sign-in wall rather than a job page (no description, login wording, nothing else). */
export function looksLikeLoginWall(page: JdPageRead): boolean {
  return !str(page.jd, 100).trim() && LOGIN.test(`${str(page.title, 300)}\n${str(page.heading, 300)}`) && str(page.bodyHead, 1500).length < 800;
}

const LINKEDIN_END = /(set alert for similar jobs|about the company|show more|show less|see how you compare|meet the hiring team|premium|more jobs)/i;

/** Fallback for the LinkedIn page text: the section after "About the job" up to the next page block. Pure. */
export function jdFromLinkedinBody(bodyText: string): string {
  const t = String(bodyText ?? '');
  const m = /about the job/i.exec(t);
  if (!m) return '';
  const rest = t.slice(m.index + m[0].length);
  const end = LINKEDIN_END.exec(rest);
  return (end ? rest.slice(0, end.index) : rest).trim();
}

/** The cleaned JD text from a read, or ''. A trailing "Show less" (expanded state label) is dropped; "Show more" stays and counts as truncation. */
export function jdTextOf(page: JdPageRead): string {
  const raw = str(page.jd, JD_MAX_CHARS).replace(/\s*(?:show|see) less\s*$/i, '');
  return cleanJdText(raw);
}

// ---- URL rules (the URL always comes from SQLite) ----

/** The URL to open for a job of this platform, or null when the stored URL is not a plain job page of that platform. */
export function jdUrlFor(platform: JdPlatform, stored: string): string | null {
  if (platform === 'naukri') {
    if (!isNaukriUrl(stored) || !extractNaukriJobId(stored)) return null;
    try {
      const u = new URL(stored);
      u.hash = '';
      u.search = '';
      return u.toString();
    } catch {
      return null;
    }
  }
  const id = extractLinkedInJobId(stored);
  if (!id) return null;
  try {
    const u = new URL(stored);
    if (u.protocol !== 'https:' || u.username || u.password || !/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
  } catch {
    return null;
  }
  return canonicalJobUrl(id);
}

// ---- the flow ----

export interface JdFetchIo {
  /** Navigate the operator's session to a code-built URL. */
  load(url: string): Promise<'ok' | 'login_required' | 'halted' | 'failed'>;
  /** Read the page just loaded. null: unreadable. */
  read(): Promise<JdPageRead | null>;
}

export interface JdFetchDeps {
  db: Db;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  screen: (t: string, p: ScreenPurpose) => Promise<ScreenVerdict>;
  /** Called before every page load; the MCP layer waits the 3 to 8 second gap here (not before the first page of a session). */
  beforeLoad?: () => Promise<void>;
}

export type JdFetchStatus = 'ok' | 'dry_run' | 'halted' | 'rate_limited' | 'failed';
export interface JdFetchResult {
  status: JdFetchStatus;
  /** ok: saved | none | unavailable | incomplete | injection_suspected; failed: login_required | blocked | load_failed | unreadable | classifier_unavailable | not_waiting | bad_url | halt_state_unreadable; rate_limited: jd_fetch_limit | profile_view_limit */
  code: string;
  job_id?: string;
  /** Characters of the saved JD (a number, never text). */
  chars?: number;
  /** True when the job returned to unscored because of this JD. */
  reset?: boolean;
  /** Jobs still waiting for a JD on this platform after this call. */
  waiting: number;
  injection_suspected?: boolean;
}

const waitingOf = (db: Db, platform: JdPlatform, now: Date): number => {
  try { return listJdCandidates(db, platform, now, 100000).length; } catch { return 0; }
};

/** Fetches the JD of the next waiting job (or of `jobId` when it is waiting) for one platform. Never throws. */
export async function fetchJd(platform: JdPlatform, io: JdFetchIo, deps: JdFetchDeps, a: { job_id?: string } = {}): Promise<JdFetchResult> {
  const { db, env } = deps;
  const now = deps.now();
  const out = (status: JdFetchStatus, code: string, extra: Partial<JdFetchResult> = {}): JdFetchResult =>
    ({ status, code, waiting: waitingOf(db, platform, deps.now()), ...extra });
  try {
    if (haltReason(db, platform) ?? haltReason(db, 'all')) return out('halted', 'halted');
  } catch {
    return out('failed', 'halt_state_unreadable');
  }
  if (a.job_id !== undefined && !/^[\w.:@-]{1,200}$/.test(String(a.job_id))) return out('failed', 'not_waiting');
  const candidates = listJdCandidates(db, platform, now, a.job_id ? 100000 : 1);
  const job = a.job_id ? candidates.find((c) => c.id === a.job_id) : candidates[0];
  if (!job) return out(a.job_id ? 'failed' : 'ok', a.job_id ? 'not_waiting' : 'none');
  if (jdFetchPlatform(job.source) !== platform) return out('failed', 'not_waiting', { job_id: job.id });
  const url = jdUrlFor(platform, job.url);
  if (!url) {
    // A stored URL that is not a job page of this platform can never be fetched: give the job up instead of retrying it.
    markJdUnavailable(db, job.id, 'bad_url');
    return out('ok', 'unavailable', { job_id: job.id });
  }

  // Ceilings are checked before the page is opened and consumed right before it is (a refused fetch opens nothing).
  const cfg = loadOutreachConfig(env);
  const c = ceilings(db, cfg, now);
  if (!c[CEILING[platform]].ok) return out('rate_limited', 'jd_fetch_limit', { job_id: job.id });
  if (platform === 'linkedin' && !c.linkedin_profile_view.ok) return out('rate_limited', 'profile_view_limit', { job_id: job.id });

  if (isDryRun(env)) {
    recordDryRun(db, { runId: null, action: `${platform}_fetch_jd`, platform, payload: { job_id: job.id } }, now, env);
    return out('dry_run', 'dry_run', { job_id: job.id });
  }
  markJdPending(db, job.id);
  if (!tryConsume(db, CEILING[platform], cfg, now)) return out('rate_limited', 'jd_fetch_limit', { job_id: job.id });
  if (platform === 'linkedin' && !tryConsume(db, 'linkedin_profile_view', cfg, now)) return out('rate_limited', 'profile_view_limit', { job_id: job.id });

  try { await deps.beforeLoad?.(); } catch { /* a failed pause never blocks the fetch */ }
  const loaded = await io.load(url);
  if (loaded === 'halted') return out('halted', 'halted', { job_id: job.id });
  if (loaded !== 'ok') return out('failed', loaded === 'login_required' ? 'login_required' : 'load_failed', { job_id: job.id });
  let page: JdPageRead | null;
  try { page = await io.read(); } catch { page = null; }
  if (!page) return out('failed', 'unreadable', { job_id: job.id });
  if (looksLikeLoginWall(page)) return out('failed', 'login_required', { job_id: job.id });

  const verdict = classifyJdPage(platform, page);
  if (verdict === 'blocked') return out('failed', 'blocked', { job_id: job.id });
  if (verdict === 'closed') {
    markJdUnavailable(db, job.id, 'closed');
    return out('ok', 'unavailable', { job_id: job.id });
  }

  const g = gateField(jdTextOf(page), JD_MAX_CHARS + 500);
  if (g.blocked) {
    markJdUnavailable(db, job.id, 'injection_suspected');
    return out('ok', 'injection_suspected', { job_id: job.id, injection_suspected: true });
  }
  if (g.text) {
    let v: ScreenVerdict;
    try { v = await deps.screen(g.text, 'read'); } catch { return out('failed', 'classifier_unavailable', { job_id: job.id }); }
    if (v.blocked) {
      markJdUnavailable(db, job.id, 'injection_suspected');
      return out('ok', 'injection_suspected', { job_id: job.id, injection_suspected: true });
    }
  }
  if (!isJdComplete(g.text)) {
    const attempts = recordJdAttempt(db, job.id, now);
    if (attempts >= 3) {
      markJdUnavailable(db, job.id, 'incomplete');
      return out('ok', 'unavailable', { job_id: job.id });
    }
    return out('ok', 'incomplete', { job_id: job.id });
  }
  const saved = saveFetchedJd(db, job.id, g.text, now);
  if (!saved.saved) return out('failed', 'unreadable', { job_id: job.id });
  return out('ok', 'saved', { job_id: job.id, chars: g.text.length, reset: saved.reset });
}
