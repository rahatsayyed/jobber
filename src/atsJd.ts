// file: src/atsJd.ts
// Is the stored job description complete enough to score keyword coverage against? Naukri and LinkedIn list pages only give a
// snippet (about 90 and 20 characters), and a coverage figure computed against a snippet is a measurement of the snippet, not of the
// job. Such a job gets coverage NULL and the note `jd_incomplete` instead of a misleading low number. Pure, no I/O.

/** Shorter than this (after trimming) is a snippet, not a posting. The shortest full posting in the data is about 960 characters. */
export const JD_MIN_CHARS = 300;
export const ATS_NOTE_JD_INCOMPLETE = 'jd_incomplete';

// A description cut by the source: an ellipsis or a "read more" style tail.
const TRUNCATION_TAIL = /(?:\.{3}|…|\[(?:truncated|\.\.\.|more)\]|\(more\)|\b(?:read|show|see|view) more)\s*$/i;

export function isJdIncomplete(description: string | null | undefined): boolean {
  const t = String(description ?? '').replace(/\s+/g, ' ').trim();
  if (t.length < JD_MIN_CHARS) return true;
  return TRUNCATION_TAIL.test(t);
}

export interface AtsOutcome { coverage: number | null; note: string | null }

/** The coverage to store: NULL plus the note when the description is incomplete, else the computed value unchanged. */
export function applyJdNote(coverage: number | null | undefined, description: string | null | undefined): AtsOutcome {
  if (isJdIncomplete(description)) return { coverage: null, note: ATS_NOTE_JD_INCOMPLETE };
  return { coverage: coverage ?? null, note: null };
}
