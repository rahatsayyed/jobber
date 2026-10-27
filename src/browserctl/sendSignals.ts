// What the page shows after a Send click, beyond the network response: error signals (a modal, alert or toast
// that says the invitation was refused) and the counts-only facts the commit diag records. Page text is read
// here only to match word lists; none of it is stored or returned.
import type { RawTree } from './snapshot.js';

/** After the Send click, the page is re-read for at most this long (ms) while waiting for a confirmation or an error. */
export const CONFIRM_POLL_MS = 6000;
export const CONFIRM_POLL_STEP_MS = 500;

/** Lower-case phrases of a platform limit (the weekly invitation limit and its kin): the operator stops the task. */
export const LIMIT_WORDS: readonly string[] = ['limit', 'too many', 'weekly'];
/** Lower-case phrases of any other refusal: a generic error, a verification interstitial, a restriction. */
export const ERROR_WORDS: readonly string[] = ['try again', 'something went wrong', 'verify', 'captcha', 'restricted'];

export type ErrorSignal = 'none' | 'limit' | 'error';

/** Counts and enums only: what held after the click. Written to the diag file. */
export interface SendFacts {
  strong: boolean;
  network: boolean;
  dialogGone: boolean;
  signal: ErrorSignal;
  polledMs: number;
}

const TEXT_MAX = 200;

/** Short visible strings of a tree: dialog names, headings and text nodes (toasts and alerts are text nodes). */
function shownTexts(tree: RawTree): Set<string> {
  const out = new Set<string>();
  for (const x of tree.nodes) {
    const s = x.role === 'text' ? x.text : x.role === 'dialog' || x.role === 'heading' ? x.name : '';
    const t = s.trim().toLowerCase();
    if (t && t.length <= TEXT_MAX) out.add(t);
  }
  return out;
}

/** Error signal among the texts that are in `after` but were not in `before`: limit wins over a generic error. */
export function errorSignalOf(before: RawTree, after: RawTree): ErrorSignal {
  const old = shownTexts(before);
  let found: ErrorSignal = 'none';
  for (const t of shownTexts(after)) {
    if (old.has(t)) continue;
    if (LIMIT_WORDS.some((w) => t.includes(w))) return 'limit';
    if (ERROR_WORDS.some((w) => t.includes(w))) found = 'error';
  }
  return found;
}
