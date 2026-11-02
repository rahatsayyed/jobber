// file: src/jdComplete.ts
// ONE place that decides whether a stored job description is a real job description (JD). Pure, no I/O.
//
// Naukri search cards and LinkedIn job cards only carry a snippet (about 90 and 20 characters). Matching, tailoring, ATS coverage and
// every email or apply built on such a snippet is a guess. A JD is COMPLETE when the cleaned text is at least JD_MIN_CHARS_COMPLETE
// characters and does not end in a truncation marker ("...", "…", "read more", "show more"). A leading `Location: ...` line (the board
// providers put the location there) and a location-only text never count toward the length.
//
// JD_FETCH_SOURCES are the sources whose list pages give only a snippet: their jobs wait (status `jd_pending`) until a typed fetch tool
// has read the job page. API and board sources (remoteok, remotive, greenhouse, lever, ...) deliver full text and are never gated.

/** A complete JD has at least this many characters after cleaning. */
export const JD_MIN_CHARS_COMPLETE = 400;

/** Sources that list only a snippet: a job from one of these needs its JD fetched from the job page before it is matched. */
export const JD_FETCH_SOURCES: readonly string[] = ['naukri', 'linkedin-jobs', 'manual:naukri', 'manual:linkedin'];

/** Which fetch tool serves a source: 'naukri' (naukri_fetch_jd) or 'linkedin' (linkedin_fetch_jd). null: the source is not gated. */
export function jdFetchPlatform(source: string | null | undefined): 'naukri' | 'linkedin' | null {
  const s = String(source ?? '');
  if (!JD_FETCH_SOURCES.includes(s)) return null;
  return s.endsWith('naukri') ? 'naukri' : 'linkedin';
}

// A description cut by the source: an ellipsis or a "read more" style tail.
const TRUNCATION_TAIL = /(?:\.{3}|…|\[(?:truncated|\.\.\.|more)\]|\(more\)|\b(?:read|show|see|view) more)\s*$/i;
const LOCATION_LINE = /^\s*(?:📍\s*)?location\s*:[^\n]*(?:\n|$)/i;

/** The description with whitespace collapsed and a leading `Location:` line removed. */
export function cleanJdText(description: string | null | undefined): string {
  const raw = String(description ?? '').replace(/\r/g, '');
  return raw.replace(LOCATION_LINE, '').replace(/\s+/g, ' ').trim();
}

export function isJdComplete(description: string | null | undefined): boolean {
  const t = cleanJdText(description);
  if (t.length < JD_MIN_CHARS_COMPLETE) return false;
  return !TRUNCATION_TAIL.test(t);
}

export function isJdIncomplete(description: string | null | undefined): boolean {
  return !isJdComplete(description);
}

/** True when a job of this source with this description must wait for a JD fetch (gated source and incomplete text). */
export function needsJdFetch(source: string | null | undefined, description: string | null | undefined): boolean {
  return jdFetchPlatform(source) !== null && isJdIncomplete(description);
}

/** Closed values written to jobs.status, jobs.excluded_reason and jobs.jd_note by the JD flow. */
export const JOB_STATUS_JD_PENDING = 'jd_pending';
export const EXCLUDED_JD_UNAVAILABLE = 'jd_unavailable';
export const JD_NOTE_PREPARED_WITHOUT_JD = 'prepared_without_jd';
export const JD_NOTE_REPREP = 'reprep';
/** Queue row status of a prepared row whose material was built without a JD: not sendable, not applicable, rebuilt after the JD arrives. */
export const QUEUE_STATUS_NEEDS_REPREP = 'needs_reprep';
/** Page reads that still do not give a complete JD before the job is given up on as `jd_unavailable`. */
export const JD_FETCH_MAX_ATTEMPTS = 3;
