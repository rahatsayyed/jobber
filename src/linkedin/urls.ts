import { hostMatches } from '../lib/hostClass.js';
import { normalizeProfileKey } from '../outreach/people.js';
import type { PageKind } from './types.js';

function parse(url: string): URL | null {
  try { return new URL(url); } catch { return null; }
}

/** https only, apex linkedin.com or a subdomain, no embedded credentials. */
export function isLinkedInUrl(url: string): boolean {
  const u = parse(url);
  if (!u || u.protocol !== 'https:') return false;
  return hostMatches(url, 'linkedin.com');
}

function pathOf(url: string): string {
  return (parse(url)?.pathname ?? '').toLowerCase();
}

const startsWithSeg = (p: string, seg: string) => p === seg || p.startsWith(seg + '/');

export function isProfileUrl(url: string): boolean {
  if (!isLinkedInUrl(url)) return false;
  return /^\/in\/[^/]+/.test(pathOf(url));
}

export function classifyUrl(url: string): PageKind {
  if (!isLinkedInUrl(url)) return 'other';
  const p = pathOf(url);
  if (startsWithSeg(p, '/checkpoint')) return 'checkpoint';
  if (startsWithSeg(p, '/login') || startsWithSeg(p, '/uas/login') || startsWithSeg(p, '/authwall')) return 'login';
  if (p.startsWith('/in/')) return 'profile';
  if (startsWithSeg(p, '/search/results')) return 'search';
  if (startsWithSeg(p, '/messaging')) return 'messaging';
  if (startsWithSeg(p, '/mynetwork/invitation-manager')) return 'invitations';
  if (startsWithSeg(p, '/jobs')) return 'jobs';
  if (startsWithSeg(p, '/feed')) return 'feed';
  return 'other';
}

const BLOCKED: Array<[string, string]> = [
  ['/m/logout', 'logout'],
  ['/uas/logout', 'logout'],
  ['/logout', 'logout'],
  ['/psettings', 'settings'],
  ['/mypreferences', 'settings'],
  ['/settings', 'settings'],
  ['/premium', 'premium'],
  ['/sales', 'sales navigator'],
  ['/help', 'help'],
];

export function isBlockedPath(url: string): { blocked: boolean; why?: string } {
  const p = pathOf(url);
  for (const [prefix, why] of BLOCKED) {
    if (startsWithSeg(p, prefix)) return { blocked: true, why };
  }
  return { blocked: false };
}

export function profileKeyOf(url: string): string {
  return normalizeProfileKey(url);
}
