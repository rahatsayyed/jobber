// Shared markers for LinkedIn hiring posts (source `linkedin-posts`). The extractor writes them, the veto gate reads them.
export const POST_SOURCE = 'linkedin-posts';
/** Title written when no role could be read from the post; the gate treats it as "role missing". */
export const POST_TITLE_FALLBACK_PREFIX = 'Hiring post by ';
export const POST_THIN_FLAG = 'thin post: no company or no requirements';
export const POST_EMPTY_REASON = 'post has no identifiable company or role';

const REQ_SIGNAL = new RegExp(
  [
    '\\d+\\s*\\+?\\s*(?:years?|yrs?)\\b', '\\bexperience\\b', '\\bskills?\\b', '\\bproficien', '\\bknowledge of\\b', '\\bmust[- ]have\\b',
    '\\brequirements?\\b', '\\bresponsibilit', '\\bqualifications?\\b', '\\btech stack\\b', '\\bstack\\b',
    '\\b(?:react|angular|vue|node(?:\\.?js)?|typescript|javascript|python|java|golang|rust|aws|azure|gcp|sql|postgres|mongodb|docker|kubernetes|graphql|next\\.?js|django|flask|spring|\\.net|php|laravel|kotlin|swift|flutter)\\b',
  ].join('|'),
  'i',
);

/** True when the post text names years, skills, a requirement word or a well-known technology. */
export function hasRequirementSignal(text: string | null | undefined): boolean {
  return REQ_SIGNAL.test(String(text ?? ''));
}
