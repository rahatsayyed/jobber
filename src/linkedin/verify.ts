// Pure verification helpers originally from the removed legacy connect MCP.
// Behavior must stay identical to the original; the
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

/**
 * Pure: extracts the profile owner's name from `page.title()` (e.g. "Tanvi Gaharwar |
 * LinkedIn" -> "Tanvi Gaharwar") — confirmed reliable where `<h1>` is not. Exported for
 * unit testing.
 */
export function extractExpectedNameFromTitle(title: string): string {
  const idx = title.indexOf(' | ');
  return (idx === -1 ? title : title.slice(0, idx)).trim();
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
