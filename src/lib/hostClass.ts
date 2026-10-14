// Adapted from MadsLorentzen/ai-job-search .claude/commands/apply.md source-host check (MIT, (c) 2026 Mads Lorentzen).
// host == apex || host.endsWith('.' + apex), on the parsed hostname, http(s) only, never with embedded credentials.
export function hostMatches(url: string, apex: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const a = apex.toLowerCase();
  return host === a || host.endsWith(`.${a}`);
}

const BRAND_APEXES = ['greenhouse.io', 'lever.co', 'myworkdayjobs.com', 'ashbyhq.com', 'linkedin.com'];
const BRAND_SUBSTRINGS = ['greenhouse', 'workday', 'ashby', 'linkedin'];

/**
 * True when a URL is NOT a real ATS/LinkedIn host but imitates one (brand in the host or in embedded
 * credentials). Callers must refuse such a URL outright instead of treating it as an unknown platform.
 * `lever` is matched as a whole dot/dash-separated label only, so "clever.com" is not flagged.
 */
export function lookAlikeAtsHost(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (BRAND_APEXES.some((a) => hostMatches(url, a))) return false;
  const authority = `${u.username} ${u.password} ${u.hostname}`.toLowerCase();
  if (BRAND_SUBSTRINGS.some((b) => authority.includes(b))) return true;
  return authority.split(/[^a-z0-9]+/).includes('lever');
}
