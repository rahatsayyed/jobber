// file: src/atsJd.ts
// Is the stored job description complete enough to score keyword coverage against? Naukri and LinkedIn list pages only give a
// snippet (about 90 and 20 characters), and a coverage figure computed against a snippet is a measurement of the snippet, not of the
// job. Such a job gets coverage NULL and the note `jd_incomplete` instead of a misleading low number. Pure, no I/O.
// The definition of "complete" lives in ONE place, src/jdComplete.ts; this file only applies it to the ATS coverage figure.
import { JD_MIN_CHARS_COMPLETE, isJdIncomplete } from './jdComplete.js';

export { isJdIncomplete };
/** Shorter than this (after cleaning) is a snippet, not a posting. */
export const JD_MIN_CHARS = JD_MIN_CHARS_COMPLETE;
export const ATS_NOTE_JD_INCOMPLETE = 'jd_incomplete';

export interface AtsOutcome { coverage: number | null; note: string | null }

/** The coverage to store: NULL plus the note when the description is incomplete, else the computed value unchanged. */
export function applyJdNote(coverage: number | null | undefined, description: string | null | undefined): AtsOutcome {
  if (isJdIncomplete(description)) return { coverage: null, note: ATS_NOTE_JD_INCOMPLETE };
  return { coverage: coverage ?? null, note: null };
}
