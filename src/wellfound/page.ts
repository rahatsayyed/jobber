// Wellfound page policy shared by the wellfound MCP and the browserctl engine: which URLs are Wellfound, which
// paths are never opened, what a thread or job page URL carries. Pure; no page access. Every URL shape here
// is UNVERIFIED against the live site (no live check has ever run): confirm in the supervised phase 2 run.
import { hostMatches } from '../lib/hostClass.js';

/** Only https://wellfound.com or a subdomain, with no embedded credentials. */
export function isWellfoundUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && !u.username && !u.password && hostMatches(url, 'wellfound.com');
}

/** Paths the engine never opens (they end the session or change the account). */
const BLOCKED_PATH_RE = /(?:log[-_]?out|sign[-_]?out|delete[-_]?account|deactivate|\/delete\b)/i;
export function isBlockedWellfoundPath(url: string): boolean {
  try {
    return BLOCKED_PATH_RE.test(new URL(url).pathname);
  } catch {
    return true;
  }
}

/** Only these characters may appear in a thread ref (the outreach MCP rejects anything else). */
export const THREAD_REF_RE = /^[A-Za-z0-9_:./-]{1,120}$/;

export function threadUrl(ref: string): string {
  return `https://wellfound.com/jobs/messages/${encodeURIComponent(ref)}`;
}

/** The thread id a conversation URL carries (`/jobs/messages/<id>` or `/messages/<id>`), or null. */
export function threadRefOfUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const m = /^\/(?:jobs\/)?messages\/([^/]+)\/?$/i.exec(u.pathname);
    if (!m) return null;
    const ref = decodeURIComponent(m[1]);
    return THREAD_REF_RE.test(ref) ? ref : null;
  } catch {
    return null;
  }
}

const JOB_PATH_RE = /^\/(?:company\/[^/]+\/)?jobs\/(\d{3,12})(?:-[^/]*)?\/?$/i;

/** The numeric job id of a job page URL (`/jobs/<id>-<slug>` or `/company/<c>/jobs/<id>-<slug>`), or null. */
export function extractWellfoundJobId(url: string): string | null {
  try {
    const m = JOB_PATH_RE.exec(new URL(url).pathname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** The db job id (`wellfound:<n>`) of a job page URL, or null. */
export function wellfoundJobIdOfUrl(url: string): string | null {
  const id = extractWellfoundJobId(url);
  return id ? `wellfound:${id}` : null;
}

/** Page kind from the URL alone (layout memory and the guard's `thread` check). */
export function wellfoundKind(url: string): string {
  let host = '';
  let path = '';
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    return 'other';
  }
  if (host !== 'wellfound.com' && !host.endsWith('.wellfound.com')) return 'other';
  if (/^\/(login|signin|sign-in|users\/sign_in)(\/|$)/.test(path)) return 'login';
  if (JOB_PATH_RE.test(new URL(url).pathname)) return 'job';
  if (/^\/(jobs\/)?messages\/[^/]+\/?$/.test(path)) return 'thread';
  if (/^\/(jobs\/)?messages\/?$/.test(path)) return 'inbox';
  if (/^\/(role|location|jobs|remote)(\/|$)/.test(path)) return 'search';
  if (path === '/' || path === '') return 'home';
  return 'other';
}
