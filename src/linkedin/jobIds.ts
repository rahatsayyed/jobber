// Id derivation for LinkedIn discovery, moved from the old src/discover/linkedin-jobs.ts and
// src/discover/linkedin-posts.ts (deleted in plan 8G Task 14) with the SAME rules, so stored rows still dedupe.
import { createHash } from 'node:crypto';

/** LinkedIn numeric job id from a /jobs/view/<id> href, or null. */
export function extractLinkedInJobId(href: string): string | null {
  const match = href.match(/\/jobs\/view\/(\d+)/);
  return match ? match[1] : null;
}

/** The jobs table id for a LinkedIn job: `li-job:<numeric id>`. */
export function linkedInJobDbId(numericId: string): string {
  return `li-job:${numericId}`;
}

/** Canonical posting URL built from the numeric id only (no tracking params, never the raw href). */
export function canonicalJobUrl(numericId: string): string {
  return `https://www.linkedin.com/jobs/view/${numericId}/`;
}

/** Content search exposes no permalink, so a post id is a hash of the author profile and the first 100 chars. */
export function buildSyntheticPostId(profileUrl: string, text: string): string {
  const hash = createHash('sha256').update(profileUrl + text.slice(0, 100)).digest('hex').slice(0, 16);
  return `li-post:${hash}`;
}

const HIRING_KEYWORDS = /\b(hiring|we're hiring|we are hiring|join our team|open position|looking for)\b/i;

export function isHiringIntent(text: string): boolean {
  return HIRING_KEYWORDS.test(text);
}
