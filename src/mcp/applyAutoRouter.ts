import { detectAts } from '../apply/external.js';
import { hostMatches } from '../lib/hostClass.js';

export type ApplyAutoRoute = { kind: 'naukri_agent' } | { kind: 'linkedin' } | { kind: 'external'; platform: string | null };

function isLinkedInUrl(url: string): boolean {
  return hostMatches(url, 'linkedin.com');
}

/**
 * Pure routing decision for the `apply.auto` tool: inspects `apply_url` and decides which
 * underlying apply path handles it. Never reimplements platform logic itself — a
 * `{kind: 'external', platform: null}` result means "no known platform matched; let
 * applyExternal's own bootstrap step (learn-or-manual_review) handle it," exactly the
 * no-expected_platform case self-extending ATS bootstrapping requires to ever fire.
 */
function isNaukriUrl(url: string): boolean {
  // https only (hostMatches also admits http); credentials are rejected by hostMatches.
  try {
    if (new URL(url).protocol !== 'https:') return false;
  } catch {
    return false;
  }
  return hostMatches(url, 'naukri.com');
}

export function routeApplyAuto(applyUrl: string): ApplyAutoRoute {
  if (isNaukriUrl(applyUrl)) return { kind: 'naukri_agent' };
  if (isLinkedInUrl(applyUrl)) return { kind: 'linkedin' };
  const ats = detectAts(applyUrl);
  return { kind: 'external', platform: ats?.platform ?? null };
}
