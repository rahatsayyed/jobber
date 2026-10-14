// Job sources that are discovery-only: they feed matching, contacts, email and LinkedIn connect, but never an apply attempt.
// Reasons: Workday applications are account-gated wizards (every attempt would burn one of the shared daily apply slots for a near-certain
// manual_review), the other vendors have no apply module in src/ats/, and aggregator rows (HN, Himalayas, We Work Remotely) point at the
// aggregator page or an arbitrary host that must never reach the ATS bootstrap. Recruitee apply support is future work.
export const DISCOVER_ONLY_SOURCES: ReadonlySet<string> = new Set([
  'workable', 'recruitee', 'personio', 'workday', 'smartrecruiters', 'hackernews', 'himalayas', 'weworkremotely',
]);

export function isDiscoverOnlySource(source: string | null | undefined): boolean {
  return typeof source === 'string' && DISCOVER_ONLY_SOURCES.has(source.trim().toLowerCase());
}
