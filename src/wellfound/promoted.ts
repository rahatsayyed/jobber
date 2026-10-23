// Wellfound promotion marker. UNVERIFIED GUESSES: no live Wellfound results page has been read for a promotion marker. The words below
// and the badge selectors in SEARCH_SRC (src/mcp/wellfound.ts) must be checked against a live read. Only badge texts and class or aria
// attributes are read, never the card snippet or the description (untrusted text).
import { matchPromotedSignals, type PromotedSignals } from '../promoted.js';

export const WELLFOUND_PROMOTED_WORDS = ['promoted', 'featured', 'sponsored', 'premium'] as const;
export const WELLFOUND_PROMOTED_PHRASES = [['hot', 'job']] as const;

export function isWellfoundPromoted(sig: PromotedSignals | null | undefined): boolean {
  return matchPromotedSignals(sig, WELLFOUND_PROMOTED_WORDS, WELLFOUND_PROMOTED_PHRASES);
}
