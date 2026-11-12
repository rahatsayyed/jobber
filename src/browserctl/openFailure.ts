// A precise reason for a failed page open (LinkedIn): a closed code from the error text, the page url path and the page title, never a bare
// "open failed". Pure and structural: the result carries the code, the url PATH (no query) and a short control-free title.
import { safeName } from './diag.js';

export const OPEN_FAILURE_CODES = [
  'nav_timeout', 'net_error', 'auth_wall', 'login_required', 'bot_wall', 'not_found', 'job_removed', 'nav_aborted', 'nav_failed',
] as const;
export type OpenFailureCode = (typeof OPEN_FAILURE_CODES)[number];

/** Codes a second attempt can fix; the others need the owner or mean the page is gone. */
export const TRANSIENT_OPEN_CODES: ReadonlySet<string> = new Set(['nav_timeout', 'net_error', 'nav_aborted', 'nav_failed']);

const NET_RE = /net::ERR_[A-Z_]+|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ERR_[A-Z_]{4,}/;
const BOT_TITLE_RE = /security verification|quick security check|let(?:'|’)?s do a quick|verify you(?:'|’)?re (?:a )?human|are you a robot|captcha|access denied|unusual activity|request blocked/i;
const JOB_GONE_RE = /no longer accepting|job (?:is )?(?:no longer )?(?:available|removed)|this job (?:has )?(?:expired|been removed)|no longer available/i;
const NOT_FOUND_RE = /page not found|this page doesn(?:'|’)?t exist|404\b|not found/i;

export interface OpenFailureInput {
  /** The thrown error's message, when there was one. */
  error?: unknown;
  /** The page's url after the failure (may be the old page when navigation never started). */
  url?: string;
  title?: string;
  /** HTTP status of the main response when the caller has it. */
  status?: number;
}
export interface OpenFailure { code: OpenFailureCode; reason: string; transient: boolean }

const pathOf = (u: string): string => { try { return new URL(u).pathname.slice(0, 80); } catch { return ''; } };

export function classifyOpenFailure(i: OpenFailureInput): OpenFailure {
  const msg = String((i.error as { message?: unknown } | undefined)?.message ?? i.error ?? '');
  const url = i.url ?? '';
  const p = pathOf(url);
  const title = safeName(i.title ?? '');
  let code: OpenFailureCode;
  let net = '';
  if (/\/authwall\b/i.test(p)) code = 'auth_wall';
  else if (/^\/(?:uas\/)?(?:login|signin)\b|\/checkpoint\/lg\/sign-in/i.test(p)) code = 'login_required';
  else if (/\/checkpoint\b|\/challenge\b/i.test(p) || BOT_TITLE_RE.test(i.title ?? '')) code = 'bot_wall';
  else if (i.status === 404 || i.status === 410) code = JOB_GONE_RE.test(i.title ?? '') || /\/jobs\/view\//.test(p) ? 'job_removed' : 'not_found';
  else if (i.status === 999 || i.status === 429 || i.status === 403) code = 'bot_wall';
  else if (JOB_GONE_RE.test(i.title ?? '')) code = 'job_removed';
  else if (NOT_FOUND_RE.test(i.title ?? '')) code = 'not_found';
  else if (/timeout|timed out/i.test(msg)) code = 'nav_timeout';
  else if (/ERR_ABORTED|frame was detached|navigation .* interrupted/i.test(msg)) code = 'nav_aborted';
  else if (NET_RE.test(msg)) { code = 'net_error'; net = NET_RE.exec(msg)?.[0] ?? ''; }
  else code = 'nav_failed';
  const bits = [`code ${code}`];
  if (net) bits.push(net);
  if (i.status) bits.push(`status ${i.status}`);
  if (p) bits.push(`path ${p}`);
  if (title) bits.push(`title "${title}"`);
  return { code, reason: `open failed: ${bits.join(', ')}`, transient: TRANSIENT_OPEN_CODES.has(code) };
}

/** A page that loaded but says the job or page is gone (the tree title and first lines); null when it looks normal. */
export function classifyLoadedPage(title: string, firstLines: string): 'job_removed' | 'not_found' | null {
  if (JOB_GONE_RE.test(`${title}\n${firstLines}`)) return 'job_removed';
  if (NOT_FOUND_RE.test(title) || /^\s*(?:this )?page (?:not found|doesn(?:'|’)?t exist)/i.test(firstLines)) return 'not_found';
  return null;
}
