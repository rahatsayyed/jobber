// Job sources that are discovery-only: they feed matching, contacts, email and LinkedIn connect, but never an apply attempt.
// Reasons: Workday applications are account-gated wizards (every attempt would burn one of the shared daily apply slots for a near-certain
// manual_review), the other vendors have no apply recipe, and aggregator rows (HN, Himalayas, We Work Remotely) point at the
// aggregator page or an arbitrary host that must never reach the ATS bootstrap. Recruitee apply support is future work.
export const DISCOVER_ONLY_SOURCES: ReadonlySet<string> = new Set([
  'workable', 'recruitee', 'personio', 'workday', 'smartrecruiters', 'hackernews', 'himalayas', 'weworkremotely',
]);

// Aggregator feeds: their apply_url is an aggregator page or an arbitrary host, never an apply target.
export const AGGREGATOR_SOURCES: ReadonlySet<string> = new Set(['hackernews', 'himalayas', 'weworkremotely']);

// True when a source may never reach an apply attempt: discover-only, aggregator, or a generated provider (`gen:*`).
// No gen provider has an owner approval record yet, so every `gen:*` source counts as not yet approved (held_review).
export function isApplyBlockedSource(source: string | null | undefined): boolean {
  if (typeof source !== 'string') return false;
  const s = source.trim().toLowerCase();
  return DISCOVER_ONLY_SOURCES.has(s) || AGGREGATOR_SOURCES.has(s) || s.startsWith('gen:');
}

export function isDiscoverOnlySource(source: string | null | undefined): boolean {
  return typeof source === 'string' && DISCOVER_ONLY_SOURCES.has(source.trim().toLowerCase());
}
