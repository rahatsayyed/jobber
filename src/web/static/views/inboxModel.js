// Inbox: pure helpers for one escalation card (no DOM, so they run in tests). Every value is untrusted text: callers set it with textContent only.

/** Excerpts longer than this start collapsed behind 'Show more'. */
export const CLAMP_CHARS = 400;

/** "5m ago", "3h ago", "2d ago" (or "just now") for an ISO time, relative to `now` (a Date). Unknown input gives ''. */
export function relativeTime(iso, now) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const min = Math.max(0, Math.floor((now.getTime() - t) / 60000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  if (min < 48 * 60) return `${Math.floor(min / 60)}h ago`;
  return `${Math.floor(min / 1440)}d ago`;
}

/** Badge kind for the ask label: salary and interview slots are time-sensitive, recruiter inquiries and replies are good news, the rest is neutral. */
export function askBadge(item) {
  if (item.group === 'noise') return 'bad';
  if (item.group === 'platform') return 'warn';
  if (item.askKind === 'salary' || item.askKind === 'interview_slot') return 'warn';
  if (item.askKind === 'recruiter_inquiry' || item.askKind === 'reply') return 'good';
  return '';
}

/**
 * What the body of a card shows: the message excerpt, or for a flagged row the safe summary plus a hidden toggle for the raw text,
 * or a muted note when the row has no captured details (rows from before the details existed). Platform problems show no message.
 */
export function bodyState(item) {
  if (item.excerpt) return { kind: 'excerpt', text: item.excerpt, long: item.excerpt.length > CLAMP_CHARS };
  if (item.group === 'platform') return { kind: 'problem', text: item.detail || '' };
  return { kind: 'missing', text: 'Details not captured. Open the thread to read it.' };
}
