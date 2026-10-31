// External apply resolve: a Naukri "Apply on company site", a Wellfound "Apply externally" or a LinkedIn Apply that is not Easy Apply
// leads to the COMPANY site. This module finds that site in code so the job can go through the generic ATS applier (apply_open and the
// rest of the applier tools), which stays the only thing that ever drives the external page.
//
// Safety shape (CLAUDE.md rules 8, 15, 17, 18):
//  - The model supplies only a job id. The engine's current page must already be that job's page (like the arm tools).
//  - The URL comes from the platform's own apply control: its href (a decoded LinkedIn externalApply link) or, when the control is
//    a button, the popup that one code-owned click opens. Nothing is typed, nothing is read or evaluated on the external page, the
//    popup is closed at once and downloads are cancelled by the driver.
//  - The URL is then validated (validateManualUrl), refused if it is still a platform host, classified by classifyApplyUrl and
//    stored in SQLite (setExternalApply). apply_open reads it from there. The result NEVER contains the URL.
//  - Kill switch, halts, dry run, one daily ceiling (`external_resolve`) and a per-session cap with a random pause apply.
import type BetterSqlite3 from 'better-sqlite3';
import { classifyApplyUrl } from '../apply/registry.js';
import { externalApplyDuplicate, getExcludedReason, getFirstHardStop, getExternalApplyUrl, setExternalApply } from '../db.js';
import { hostMatches } from '../lib/hostClass.js';
import { extractLinkedInJobId } from '../linkedin/jobIds.js';
import { validateManualUrl } from '../manual/url.js';
import { naukriJobIdOfUrl } from '../naukri/page.js';
import type { OutreachConfig } from '../outreach/config.js';
import { ceilings, tryConsume } from '../outreach/limits.js';
import { isDryRun, recordDryRun } from '../safety/dryRun.js';
import type { ScreenPurpose, ScreenVerdict } from '../safety/screen.js';
import { wellfoundJobIdOfUrl } from '../wellfound/page.js';
import type { Engine } from './act.js';
import { writeCommitDiag } from './diag.js';
import { killReason } from './engineTypes.js';
import { NAUKRI_OFFSITE_RE, WELLFOUND_OFFSITE_RE, normName } from './guard.js';
import type { PlatformPolicy } from './policy.js';
import { renderTree, type RawNode, type RawTree } from './snapshot.js';

export type ExternalPlatform = 'naukri' | 'wellfound' | 'linkedin';

const APEX: Record<ExternalPlatform, string> = { naukri: 'naukri.com', wellfound: 'wellfound.com', linkedin: 'linkedin.com' };
const PLATFORM_APEXES = Object.values(APEX);
const JOB_ID_RE = /^[\w.:@-]{1,200}$/;

/** Resolves allowed per MCP session (one apply-operator call), and the random pause between two of them. */
export const MAX_RESOLVES_PER_SESSION = 5;
export const PACE_MIN_MS = 3000;
export const PACE_MAX_MS = 8000;
/** How long the popup may take to settle on a non-blank, stable URL. */
export const POPUP_WAIT_MS = 10_000;
export const POPUP_POLL_MS = 500;

// LinkedIn: the external Apply is a link to /jobs/view/externalApply/<id>?url=<target>, or a plain "Apply" control (never "Easy Apply").
const LINKEDIN_APPLY_RE = /^apply(?: on (?:the )?company(?:'s)? (?:site|website))?$/;
const LINKEDIN_EASY_RE = /^easy apply\b/;
const LINKEDIN_EXTERNAL_PATH_RE = /\/jobs\/view\/externalapply\b/i;
const EMBEDDED_URL_PARAMS = ['url', 'u', 'redirect', 'redirect_url', 'redirecturl', 'target', 'dest', 'destination', 'link', 'goto', 'externalurl'];

const APPLIED_RE = /^(?:applied|already applied)$/i;
const EXPIRED_RE = /^(?:this job (?:has )?expired|job (?:has )?expired|expired|no longer accepting applications|this job is no longer available)\.?$/i;

export interface ExternalResult {
  status: 'resolved' | 'manual_review' | 'refused' | 'halted' | 'rate_limited' | 'dry_run' | 'failed';
  code: string;
  reason?: string;
  /** resolved only: the generic apply platform and tier the row now has (never the URL). */
  platform?: string;
  tier?: string;
}

export interface ExternalState { resolves: number; lastAt: number | null }
export const createExternalState = (): ExternalState => ({ resolves: 0, lastAt: null });

export interface ExternalDeps {
  engine: Engine;
  db: BetterSqlite3.Database;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  cfg: OutreachConfig;
  policy: PlatformPolicy;
  screen: (text: string, purpose: ScreenPurpose) => Promise<ScreenVerdict>;
  state: ExternalState;
  stopFile?: string;
  diagDir?: string;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  popupWaitMs?: number;
  popupPollMs?: number;
}

const killCode = (k: string): 'killed' | 'halted' => (k.startsWith('kill switch') ? 'killed' : 'halted');

export function jobKeyOfUrl(platform: ExternalPlatform, url: string): string | null {
  if (platform === 'naukri') return naukriJobIdOfUrl(url);
  if (platform === 'wellfound') return wellfoundJobIdOfUrl(url);
  try { const id = extractLinkedInJobId(new URL(url).pathname); return id ? `li-job:${id}` : null; } catch { return null; }
}

const isControl = (n: RawNode): boolean => (n.role === 'button' || n.role === 'link') && n.dialog === undefined;

/** The external-apply control of a platform job page, or null. Pure: reads the tree only. */
export function pickExternalControl(platform: ExternalPlatform, tree: RawTree): RawNode | null {
  const controls = tree.nodes.filter(isControl);
  if (platform === 'naukri') return controls.find((n) => !n.disabled && NAUKRI_OFFSITE_RE.test(normName(n.name))) ?? null;
  if (platform === 'wellfound') return controls.find((n) => !n.disabled && WELLFOUND_OFFSITE_RE.test(normName(n.name))) ?? null;
  // LinkedIn: an externalApply link wins; else a plain Apply control, but only when the page has no Easy Apply control at all.
  const link = controls.find((n) => n.role === 'link' && n.href && LINKEDIN_EXTERNAL_PATH_RE.test(n.href));
  if (link) return link;
  if (controls.some((n) => LINKEDIN_EASY_RE.test(normName(n.name)))) return null;
  return controls.find((n) => !n.disabled && LINKEDIN_APPLY_RE.test(normName(n.name))) ?? null;
}

/**
 * The company URL a control's href carries, or null (no href, or a platform link with no embedded target: then the click path runs).
 * A relative href is resolved against the page. A LinkedIn externalApply link carries its target in a query parameter.
 */
export function resolveHrefTarget(platform: ExternalPlatform, href: string | undefined, pageUrl: string): string | null {
  if (!href) return null;
  let u: URL;
  try { u = new URL(href, pageUrl); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!hostMatches(u.toString(), APEX[platform])) return u.toString();
  for (const [k, v] of u.searchParams) {
    if (!EMBEDDED_URL_PARAMS.includes(k.toLowerCase())) continue;
    for (const cand of [v, (() => { try { return decodeURIComponent(v); } catch { return ''; } })()]) {
      try {
        const t = new URL(cand);
        if (t.protocol === 'https:' || t.protocol === 'http:') return t.toString();
      } catch { /* try the next form */ }
    }
  }
  return null;
}

/** Cut a long tracking URL down so it fits the 500 character rule: drop the fragment and every query parameter except job identifiers. */
export function trimExternalUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { return raw; }
  u.hash = '';
  if (u.toString().length <= 500) return u.toString();
  const keep = new URLSearchParams();
  for (const [k, v] of u.searchParams) if (/^(?:gh_jid|jid|jobid|job_id|id|jobreqid|req|reqid|requisitionid)$/i.test(k)) keep.set(k, v);
  u.search = keep.toString();
  return u.toString();
}

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function resolveExternalApply(d: ExternalDeps, platform: ExternalPlatform, a: { job_id: string }): Promise<ExternalResult> {
  const { db } = d;
  const fail = (status: ExternalResult['status'], code: string, reason?: string): ExternalResult => ({ status, code, ...(reason ? { reason } : {}) });
  try {
    if (typeof a?.job_id !== 'string' || !JOB_ID_RE.test(a.job_id)) return fail('refused', 'bad_job_id', 'job_id has a bad shape');
    const k = killReason({ db, env: d.env, stopFile: d.stopFile, policy: d.policy });
    if (k) return fail('halted', killCode(k), k);

    // Pre-flight, before any browser use
    const job = db.prepare('SELECT id, source, apply_url FROM jobs WHERE id = ?').get(a.job_id) as { id: string; source: string | null; apply_url: string | null } | undefined;
    if (!job) return fail('refused', 'unknown_job', 'no such job');
    if (getExcludedReason(db, a.job_id)) return fail('refused', 'vetoed', 'the job is excluded');
    if (getFirstHardStop(db, a.job_id)) return fail('refused', 'hard_stop', 'the job has a hard stop');
    const pageUrl = job.apply_url ?? '';
    if (!pageUrl || !hostMatches(pageUrl, APEX[platform])) return fail('refused', 'wrong_platform', `this job is not a ${platform} job page`);
    const key = jobKeyOfUrl(platform, pageUrl);
    if (!key) return fail('refused', 'no_job_key', 'the stored URL has no job id');
    const dup = externalApplyDuplicate(db, a.job_id);
    if (dup) return fail('refused', dup, dup === 'already_applied' ? 'an application was already submitted for this job' : 'the same company and title were applied to in the last 90 days');

    // Already resolved earlier (for example the owner has since allowed unknown hosts): route again from the stored URL, no click.
    const known = getExternalApplyUrl(db, a.job_id);
    if (known) return finalize(d, a.job_id, job.source, known);

    if (d.state.resolves >= MAX_RESOLVES_PER_SESSION) return fail('rate_limited', 'session_cap', `at most ${MAX_RESOLVES_PER_SESSION} resolves per apply run`);
    const c = ceilings(db, d.cfg, d.now()).external_resolve;
    if (!c.ok) return fail('rate_limited', 'rate_limited', `external_resolve ${c.used} of ${c.limit} today`);

    // The engine's page must be this job's page (the operator opened it), and its text must pass the input screen.
    const page = await d.engine.page();
    if (!page) return fail('failed', 'no_page', `call ${d.policy.tool}_open first`);
    const urlBefore = page.url();
    if (jobKeyOfUrl(platform, urlBefore) !== key) return fail('refused', 'job_url_mismatch', 'browser is not on the job page');
    await d.engine.peek();
    const tree = d.engine.lastTree();
    if (!tree) return fail('failed', 'no_snapshot', 'could not read the page');
    const v = await d.screen(renderTree(tree, d.engine.refs.epoch), 'read');
    if (v.blocked) return v.code === 'classifier_unavailable' ? fail('failed', 'classifier_unavailable') : fail('refused', 'injection_suspected', 'page text flagged by the input screen');

    // Page state: applied on the platform already, or expired.
    if (tree.nodes.some((n) => (n.role === 'text' && APPLIED_RE.test(n.text.trim())) || (isControl(n) && APPLIED_RE.test(normName(n.name))))) {
      return fail('refused', 'applied_on_platform', 'the platform page already shows Applied');
    }
    if (tree.nodes.some((n) => n.role === 'text' && n.text.trim().length <= 60 && EXPIRED_RE.test(n.text.trim()))) return fail('refused', 'job_expired', 'the platform page says the job expired');

    const ctl = pickExternalControl(platform, tree);
    const diag = async (code: string, popups: { url: string }[] = []): Promise<string> => {
      const p = await writeCommitDiag({ now: d.now, diagDir: d.diagDir }, page, {
        platform, code, live: { role: ctl?.role ?? 'text', name: ctl?.name ?? '' }, urlBefore, after: tree, extra: { popups, responses: [], nearButtons: [] },
      });
      return p ? ` (diag: ${p})` : '';
    };
    if (!ctl) return fail('manual_review', 'no_external_control', `no company-site apply control on the page${await diag('external_no_control')}`);

    if (isDryRun(d.env)) {
      try { recordDryRun(db, { runId: d.env.JOBBER_RUN_ID ?? null, action: `${platform}_resolve_external`, platform, payload: { job_id: a.job_id } }, d.now(), d.env); } catch { /* the result is still dry_run */ }
      return fail('dry_run', 'dry_run', 'dry run: the control was not clicked');
    }

    // (a) the control's own href
    const viaHref = resolveHrefTarget(platform, ctl.href, urlBefore);
    if (viaHref) {
      d.state.resolves += 1;
      return finalize(d, a.job_id, job.source, viaHref);
    }

    // (b) one code-owned click and the popup it opens
    if (ctl.n < 0 || !page.watch) return fail('manual_review', 'no_click_path', `the control cannot be clicked from code${await diag('external_no_click_path')}`);
    if (!tryConsume(db, 'external_resolve', d.cfg, d.now())) return fail('rate_limited', 'rate_limited', 'external_resolve ceiling reached');
    d.state.resolves += 1;
    const sleep = d.sleep ?? sleepReal;
    const rnd = d.random ?? Math.random;
    if (d.state.lastAt !== null) {
      const want = PACE_MIN_MS + Math.floor(rnd() * (PACE_MAX_MS - PACE_MIN_MS));
      const wait = want - (d.now().getTime() - d.state.lastAt);
      if (wait > 0) await sleep(wait);
    }
    d.state.lastAt = d.now().getTime();

    const watch = page.watch();
    let popups: { url: string }[] = [];
    let found: string | null = null;
    try {
      try {
        if (page.robustClick) await page.robustClick(ctl.n); else await page.clickNode(ctl.n);
      } catch {
        return fail('failed', 'click_failed', `the control click failed${await diag('external_click_failed')}`);
      }
      const waitMs = d.popupWaitMs ?? POPUP_WAIT_MS;
      const pollMs = d.popupPollMs ?? POPUP_POLL_MS;
      let last: string | null = null;
      for (let t = 0; t <= waitMs; t += pollMs) {
        await page.waitMs(pollMs).catch(() => undefined);
        popups = watch.popups();
        // Candidate: a popup that left about:blank and the platform, else the main page itself when it navigated away.
        const here = (() => { try { return page.url(); } catch { return ''; } })();
        const cand = popups.map((p) => p.url).find((u) => u && u !== 'about:blank' && !onPlatform(u))
          ?? (here && here !== urlBefore && /^https?:/i.test(here) && !onPlatform(here) ? here : null);
        if (cand && cand === last) { found = cand; break; }
        last = cand;
      }
    } finally {
      // Close at once; nothing is read from the popup beyond its URL.
      try { await watch.closePopups?.(); } catch { /* best effort */ }
      watch.stop();
    }
    if (!found) {
      const code = popups.length === 0 ? 'no_popup' : (popups.some((p) => p.url && p.url !== 'about:blank' && !onPlatform(p.url)) ? 'popup_unstable' : 'still_on_platform');
      return fail('manual_review', code, `Apply did not lead to a stable company page${await diag(`external_${code}`, popups)}`);
    }
    return finalize(d, a.job_id, job.source, found);
  } catch {
    return fail('failed', 'error', 'unexpected error while resolving');
  }
}

const onPlatform = (url: string): boolean => PLATFORM_APEXES.some((a) => hostMatches(url, a));

/** Validate, classify and store one resolved URL. The result carries the platform and tier only. */
function finalize(d: ExternalDeps, jobId: string, source: string | null, raw: string): ExternalResult {
  const url = trimExternalUrl(raw);
  const v = validateManualUrl(url);
  if (!v.ok) return { status: 'manual_review', code: 'invalid_url', reason: v.reason };
  if (onPlatform(v.url)) return { status: 'manual_review', code: 'still_on_platform', reason: 'the apply link stays on the platform' };
  const cls = classifyApplyUrl(v.url, source, d.env);
  setExternalApply(d.db, jobId, v.url, cls);
  if (cls.platform === 'none') {
    return { status: 'manual_review', code: cls.reason ?? 'host_unknown', reason: 'the company site is not an ATS the applier may drive; the row stays manual_review (see apply_note)' };
  }
  return { status: 'resolved', code: 'resolved', platform: cls.platform, tier: cls.tier };
}
