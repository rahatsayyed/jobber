// Naukri promotion marker. UNVERIFIED GUESSES: no live Naukri results page has been read for a promotion marker. The words below and
// the badge selectors in SEARCH_SRC (src/mcp/naukri.ts) must be checked against a live read. Only badge texts and class or aria
// attributes are read, never the posting description or snippet (untrusted text).
import { matchPromotedSignals, type PromotedSignals } from '../promoted.js';

export const NAUKRI_PROMOTED_WORDS = ['promoted', 'featured', 'sponsored', 'premium'] as const;
export const NAUKRI_PROMOTED_PHRASES = [['hot', 'job']] as const;

export function isNaukriPromoted(sig: PromotedSignals | null | undefined): boolean {
  return matchPromotedSignals(sig, NAUKRI_PROMOTED_WORDS, NAUKRI_PROMOTED_PHRASES);
}
