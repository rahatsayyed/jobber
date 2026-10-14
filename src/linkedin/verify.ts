// Pure verification helpers COPIED verbatim from src/mcp/connect.ts (which opens data.sqlite at
// import, so it cannot be imported from src/linkedin/*). Behavior must stay identical; the
// incident notes record why each check is fail-closed.

/** LinkedIn's hard cap on connection-request note length. */
export const MAX_NOTE_LENGTH = 300;

/**
 * Pure: enforce LinkedIn's 300-character connection-note cap. Returns `ok: false` for
 * empty notes too — an empty note is never a valid, ready-to-send connect note.
 */
export function validateNoteLength(note: string): { ok: boolean; length: number } {
  const length = note.length;
  return { ok: length > 0 && length <= MAX_NOTE_LENGTH, length };
}

// LinkedIn people-search / profile DOM selectors. See git history / .superpowers/sdd/task-6

/**
 * Pure: extracts the profile owner's name from `page.title()` (e.g. "Tanvi Gaharwar |
 * LinkedIn" -> "Tanvi Gaharwar") — confirmed reliable where `<h1>` is not. Exported for
 * unit testing.
 */
export function extractExpectedNameFromTitle(title: string): string {
  const idx = title.indexOf(' | ');
  return (idx === -1 ? title : title.slice(0, idx)).trim();
}

export interface Point {
  x: number;
  y: number;
}

// Max plausible 2D distance (px) between the profile's own name and a real header action
// button. INCIDENT 2026-07-17 (#3): confirmed-working real header buttons sit ~130-145px
// below the name in the same X column; sidebar-suggestion-card decoys sit ~800-900px away
// (mostly in X, a different column entirely). 300px is a generous margin above the real
// case and well under the decoy distance — a candidate farther than this is rejected as
// implausible rather than accepted just for being the only/closest match available.
const MAX_PLAUSIBLE_CANDIDATE_DISTANCE_PX = 300;

/**
 * Pure: given the profile name element's position and each selector-match candidate's
 * position, picks the index of the candidate closest by full 2D (Euclidean) distance — the
 * real profile-card element, not a duplicate/decoy elsewhere on the page. Y-only distance is
 * NOT enough (INCIDENT #2: a sidebar card can share the header's Y while sitting in a
 * different X column). Returns -1 if there are no candidates, OR if the single nearest one
 * is farther than `maxDistancePx` — an implausibly distant "nearest" match (e.g. the only
 * candidate on the page is a sidebar decoy, INCIDENT #3) must be rejected, not accepted just
 * for being the closest available. Exported for unit testing.
 */
export function pickNearestToNameIndex(
  namePoint: Point,
  candidates: Point[],
  maxDistancePx: number = MAX_PLAUSIBLE_CANDIDATE_DISTANCE_PX
): number {
  if (candidates.length === 0) return -1;
  const distanceSq = (p: Point) => (p.x - namePoint.x) ** 2 + (p.y - namePoint.y) ** 2;
  let bestIndex = 0;
  let bestDistance = distanceSq(candidates[0]);
  for (let i = 1; i < candidates.length; i++) {
    const distance = distanceSq(candidates[i]);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return Math.sqrt(bestDistance) <= maxDistancePx ? bestIndex : -1;
}

/**
 * Pure: extracts the recipient name from LinkedIn's "...invitation to <Name>" dialog copy.
 * Bounded by the first sentence terminator (`.`/`?`/`!`), a newline, " by adding a note", or
 * end-of-string — NOT by end-of-string alone, since a real dialog variant (the pre-note
 * "Add a note to your invitation?" screen) has a full paragraph of trailing copy after the
 * name, which previously made this return '' and silently fail-closed on a legitimate send.
 * Exported for unit testing.
 */
export function extractDialogRecipientName(dialogText: string): string {
  const match = dialogText.match(/invitation to\s+(.+?)(?:\s+by adding a note\b|[.?!]|\n|$)/i);
  return match ? match[1].trim() : '';
}

/**
 * Pure: case-insensitive first-name comparison, tolerating LinkedIn's "first name + last
 * initial" dialog abbreviation (e.g. "Vaishali S." for "Vaishali Sharma").
 */
export function namesPlausiblyMatch(expectedName: string, recipientName: string): boolean {
  const firstWord = (s: string) => s.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const expectedFirst = firstWord(expectedName);
  const recipientFirst = firstWord(recipientName);
  if (!expectedFirst || !recipientFirst) return false;
  return (
    expectedFirst === recipientFirst ||
    expectedFirst.startsWith(recipientFirst) ||
    recipientFirst.startsWith(expectedFirst)
  );
}

/**
 * Pure: the mandatory recipient-name verification gate. FAIL-CLOSED: if either name can't be
 * extracted, this BLOCKS (does not proceed) — INCIDENT 2026-07-17 (#2) showed the previous
 * "unverifiable, so allow" leniency let a real wrong-recipient send through silently when
 * extraction came back empty. Only an actual, extracted, matching pair is considered safe.
 */
export function verifyRecipientName(
  expectedName: string,
  dialogText: string
): { ok: boolean; recipientName: string } {
  const recipientName = extractDialogRecipientName(dialogText);
  if (!expectedName || !recipientName) {
    return { ok: false, recipientName };
  }
  return { ok: namesPlausiblyMatch(expectedName, recipientName), recipientName };
}

/**
 * Pure: extracts the `/in/<slug>` segment from a LinkedIn profile URL, lowercased. Returns
 * '' if no such segment is found. Exported for unit testing.
 */
export function extractProfileSlug(url: string): string {
  const match = url.match(/\/in\/([^/?#]+)/i);
  return match ? match[1].toLowerCase() : '';
}

/**
 * Pure: independent, text-free safety net — verifies the browser is still on the originally
 * requested profile right before the note is filled / Send is clicked, comparing slugs (not
 * exact URL equality) to tolerate redirects/query params. FAIL-CLOSED: an unparseable slug on
 * either side blocks, same rationale as verifyRecipientName above.
 */
export function verifyProfileUrl(
  expectedUrl: string,
  actualUrl: string
): { ok: boolean; expectedSlug: string; actualSlug: string } {
  const expectedSlug = extractProfileSlug(expectedUrl);
  const actualSlug = extractProfileSlug(actualUrl);
  return { ok: Boolean(expectedSlug) && expectedSlug === actualSlug, expectedSlug, actualSlug };
}

/** Minimal structural shape of a response, so tests and non-playwright callers need no Response type. */
export interface InviteResponseLike {
  url(): string;
  status(): number;
  request(): { method(): string };
}

// Best-effort heuristic, NOT verified against a real captured request (no live browser
// access): a POST to a "voyager"-style path mentioning invitation/connect/relationship, 2xx.
export function isLikelySendInvitationResponse(response: InviteResponseLike): boolean {
  const url = response.url().toLowerCase();
  const isLikelyPath = url.includes('voyager') && /invitation|connect|relationship/.test(url);
  return (
    isLikelyPath &&
    response.request().method() === 'POST' &&
    response.status() >= 200 &&
    response.status() < 300
  );
}

/**
 * Pure: given the bounding-box heights of every `SELECTORS.moreButton` match, picks the
 * index of the first button-shaped one (height >= minHeightPx) — the real profile-header
 * "More" action, as opposed to small "…more" show-more-text toggles. Returns -1 if none
 * qualify. Exported for unit testing without a live Playwright page.
 */
export function pickButtonShapedIndex(boxes: Array<{ height: number }>, minHeightPx = 40): number {
  return boxes.findIndex((box) => box.height >= minHeightPx);
}

/**
 * Pure: strips the leading "About" heading text from the About section's raw textContent.
 * LinkedIn's DOM has no separator between the heading and the body — e.g. the real textContent
 * reads "AboutBlockchain enthousiast Cardano developer" (live-confirmed 2026-08-29, see
 * scrapeAboutText). Returns null for empty/heading-only content. Exported for unit testing
 * without a live page.
 */
export function extractAboutText(rawSectionText: string): string | null {
  const stripped = rawSectionText.replace(/^about\s*/i, '').trim();
  return stripped || null;
}
