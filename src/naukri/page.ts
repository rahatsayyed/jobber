// Naukri page policy shared by the naukri MCP and the browserctl engine: which URLs are Naukri, which
// paths are never opened, what a thread or job page URL carries. Pure; no page access.
import { hostMatches } from '../lib/hostClass.js';
import { extractNaukriJobId } from '../sources/naukri.js';

/** Only https://naukri.com or a subdomain, with no embedded credentials. */
export function isNaukriUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && !u.username && !u.password && hostMatches(url, 'naukri.com');
}

/** Paths the engine never opens (they end the session or change the account). */
const BLOCKED_PATH_RE = /(?:log-?out|sign-?out|signout|delete-?account|deactivate)/i;
export function isBlockedNaukriPath(url: string): boolean {
  try {
    return BLOCKED_PATH_RE.test(new URL(url).pathname);
  } catch {
    return true;
  }
}

/** Only these characters may appear in a thread ref (the outreach MCP rejects anything else). */
export const THREAD_REF_RE = /^[A-Za-z0-9_:./-]{1,120}$/;

export function threadUrl(ref: string): string {
  return `https://www.naukri.com/mnjuser/inbox?threadId=${encodeURIComponent(ref)}`;
}

/** The thread id a conversation URL carries, or null. */
export function threadRefOfUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/^\/(?:mnjuser\/)?inbox/i.test(u.pathname)) return null;
    for (const k of ['threadId', 'chatId', 'conversationId']) {
      const v = u.searchParams.get(k);
      if (v) return v;
    }
  } catch {
    /* no thread */
  }
  return null;
}

/** The db job id (`naukri:<n>`) of a job page URL, or null. */
export function naukriJobIdOfUrl(url: string): string | null {
  const id = extractNaukriJobId(url);
  return id ? `naukri:${id}` : null;
}
