import { describe, it, expect } from 'vitest';
import {
  validateNoteLength,
  extractExpectedNameFromTitle,
  extractAboutText,
  pickButtonShapedIndex,
  extractDialogRecipientName,
  namesPlausiblyMatch,
  verifyRecipientName,
  isLikelySendInvitationResponse,
  pickNearestToNameIndex,
  extractProfileSlug,
  verifyProfileUrl,
} from '../src/linkedin/verify.js';
import { SELECTORS } from '../src/linkedin/selectors.js';

describe('validateNoteLength', () => {
  it('accepts a note at or under the 300-character LinkedIn cap', () => {
    const note = 'a'.repeat(300);
    expect(validateNoteLength(note)).toEqual({ ok: true, length: 300 });
  });

  it('rejects a note over the 300-character cap', () => {
    const note = 'a'.repeat(301);
    expect(validateNoteLength(note)).toEqual({ ok: false, length: 301 });
  });

  it('rejects an empty note', () => {
    expect(validateNoteLength('')).toEqual({ ok: false, length: 0 });
  });

  it('accepts a short, realistic note', () => {
    const note = 'Hi Jordan, saw the Full Stack Developer opening at Acme — would love to connect!';
    const result = validateNoteLength(note);
    expect(result.ok).toBe(true);
    expect(result.length).toBe(note.length);
  });
});

describe('SELECTORS', () => {
  // Pure string assertions on the selector VALUES — proof that the old, live-confirmed-dead
  // selectors are gone, not proof the new ones resolve on a real page (only the live
  // inspection in .superpowers/sdd/task-6-connect-fix-report.md can confirm that).
  it('no longer relies on the obsolete reusable-search__result-container class for resultCard', () => {
    expect(SELECTORS.resultCard).not.toContain('reusable-search__result-container');
    expect(SELECTORS.resultCard).toContain('role="listitem"');
  });

  it('no longer relies on the obsolete app-aware-link class for profileLink', () => {
    expect(SELECTORS.profileLink).not.toContain('app-aware-link');
  });

  it('no longer assumes a direct Connect button is visible on the profile (More-menu flow instead)', () => {
    // Live finding: the tested profile had no top-level Connect button at all — Connect is
    // tucked inside the "More" overflow menu. `connectButton` is gone; `moreButton` +
    // `connectMenuItem` replace it.
    expect(SELECTORS).not.toHaveProperty('connectButton');
    expect(SELECTORS.moreButton).toContain('More');
    expect(SELECTORS.connectMenuItem).toContain('role="menu"');
    expect(SELECTORS.connectMenuItem).toContain('Connect');
  });

  it('no longer relies on has-text("Send invitation") for sendButton, since that button\'s VISIBLE TEXT is only "Send" (its aria-label is "Send invitation")', () => {
    // Live re-inspection of the real post-"Add a note"-click dialog (see
    // .superpowers/sdd/task-6-connect-fix-report.md, final "Fix: sendButton selector +
    // add-note transition wait" section) confirmed this button's accessible name
    // ("Send invitation") lives ONLY in its aria-label, never in its rendered text content
    // (just "Send"). `:has-text()` matches visible text, so the old
    // `button:has-text("Send invitation")` alternative could never match this element —
    // that dead alternative must be gone.
    expect(SELECTORS.sendButton).not.toContain('has-text("Send invitation")');
  });

  it('matches the real send button via an aria-label-based selector (exact and prefix)', () => {
    expect(SELECTORS.sendButton).toContain('aria-label="Send invitation"');
    expect(SELECTORS.sendButton).toContain('aria-label^="Send "');
  });

  it('does not modify the already-live-verified noteTextarea selector', () => {
    expect(SELECTORS.noteTextarea).toBe('#custom-message, textarea[name="message"]');
  });

  it('matches the real invitation dialog\'s native <dialog> tag, not just [role="dialog"] (INCIDENT 2026-08-28: LinkedIn now renders this dialog as a bare <dialog> element with no explicit role attribute — [role="dialog"] never matches its IMPLICIT ARIA role, so recipient-name verification silently failed with "could not verify" on every real profile tried, live-confirmed on example-person-21 and example-person-4)', () => {
    expect(SELECTORS.noteDialogContainer).toContain('dialog:visible');
    expect(SELECTORS.noteDialogContainer).toContain('[role="dialog"]:visible');
  });

  it('uses an EXACT text match for connectMenuItem, not a substring match (INCIDENT 2026-08-28: ":has-text(\'Connect\')" substring-matched "Remove connection" on an already-connected profile\'s More menu)', () => {
    expect(SELECTORS.connectMenuItem).not.toContain(':has-text(');
    expect(SELECTORS.connectMenuItem).toContain(':text-is("Connect")');
  });

  it('matches the real header Message button by visible text, not aria-label (INCIDENT 2026-08-28: the real button has NO aria-label at all — only sidebar decoys do; and Playwright\'s :text-is() found zero matches live in this project\'s pinned version, so :has-text() is used instead, relying on proximity to reject decoys)', () => {
    expect(SELECTORS.messageButton).toContain(':has-text("Message")');
    expect(SELECTORS.messageButton).not.toContain('aria-label');
  });

  it('uses the "Manage notifications about" bell for connection-status detection (live-confirmed present only on a real connected profile, absent on a real not-connected one)', () => {
    expect(SELECTORS.bellButton).toBe('a[aria-label^="Manage notifications about " i]');
  });
});

describe('pickButtonShapedIndex', () => {
  it('picks the first candidate at or above the button-shaped height threshold', () => {
    // Shaped after the live finding: index 0 was the real 48px-tall profile-header "More"
    // button; the rest were ~17.5px "…more" show-more-text toggles inside post captions.
    const boxes = [{ height: 48 }, { height: 17.5 }, { height: 17.5 }, { height: 17.5 }];
    expect(pickButtonShapedIndex(boxes)).toBe(0);
  });

  it('skips small candidates and picks the first later one that is button-shaped', () => {
    const boxes = [{ height: 17.5 }, { height: 17.5 }, { height: 48 }];
    expect(pickButtonShapedIndex(boxes)).toBe(2);
  });

  it('returns -1 when no candidate is button-shaped', () => {
    const boxes = [{ height: 17.5 }, { height: 20 }, { height: 0 }];
    expect(pickButtonShapedIndex(boxes)).toBe(-1);
  });

  it('returns -1 for an empty list', () => {
    expect(pickButtonShapedIndex([])).toBe(-1);
  });
});
describe('extractAboutText', () => {
  // LinkedIn's About section textContent has no separator between the heading and the body —
  // live-confirmed 2026-08-29 on linkedin.com/in/example-person-4.
  it('strips the leading "About" heading text', () => {
    expect(extractAboutText('AboutBlockchain enthousiast Cardano developer')).toBe(
      'Blockchain enthousiast Cardano developer'
    );
  });

  it('is case-insensitive on the "About" prefix', () => {
    expect(extractAboutText('ABOUTSome bio text')).toBe('Some bio text');
  });

  it('returns null when the section is heading-only (empty About)', () => {
    expect(extractAboutText('About')).toBeNull();
    expect(extractAboutText('About   ')).toBeNull();
  });
});

describe('extractDialogRecipientName', () => {
  it('extracts the name from the real reported dialog copy ("Personalize your invitation to <Name>")', () => {
    expect(extractDialogRecipientName('Personalize your invitation to Vaishali S.')).toBe('Vaishali S');
  });

  it('extracts the name when the dialog copy ends with a question mark', () => {
    expect(extractDialogRecipientName('Add a note to your invitation to Jordan Lee?')).toBe('Jordan Lee');
  });

  it('returns an empty string when no "invitation to <Name>" pattern is present', () => {
    expect(extractDialogRecipientName('Send without a note')).toBe('');
  });

  it('extracts the name from the real pre-note "Add a note to your invitation?" dialog, which has a full paragraph of trailing copy after the name (false-negative regression: a legitimate Example Person Three send was fail-closed-aborted because this trailing copy defeated the old end-of-string-anchored regex)', () => {
    const dialogText =
      'Add a note to your invitation?\n\n' +
      'Personalize your invitation to Example Person Three by adding a note.\n\n' +
      'LinkedIn members are more likely to accept invitations that include a note.\n\n' +
      'You have unlimited notes with Premium\n\n' +
      'Add a note  Send without a note';
    expect(extractDialogRecipientName(dialogText)).toBe('Example Person Three');
  });

  it('still extracts correctly when the name is immediately followed by a sentence terminator (no regression on the original compose-dialog format)', () => {
    expect(extractDialogRecipientName('Personalize your invitation to Vaishali S.')).toBe('Vaishali S');
    expect(extractDialogRecipientName('Add a note to your invitation to Jordan Lee?')).toBe('Jordan Lee');
  });
});

describe('namesPlausiblyMatch', () => {
  it('matches on first name alone, tolerating a last-initial abbreviation in the dialog', () => {
    // The real incident: dialog said "Vaishali S." for a profile whose full name is
    // "Vaishali Sharma" — first names must match even though the surnames are formatted
    // completely differently (full surname vs. a single initial).
    expect(namesPlausiblyMatch('Vaishali Sharma', 'Vaishali S.')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(namesPlausiblyMatch('jordan lee', 'JORDAN L.')).toBe(true);
  });

  it('does not match two genuinely different first names (the real incident\'s failure mode)', () => {
    expect(namesPlausiblyMatch('Jane Doe', 'Vaishali S.')).toBe(false);
  });

  it('returns false when either name is empty (cannot verify a match against nothing)', () => {
    expect(namesPlausiblyMatch('', 'Jordan Lee')).toBe(false);
    expect(namesPlausiblyMatch('Jordan Lee', '')).toBe(false);
  });
});

describe('verifyRecipientName', () => {
  it('is ok (does not block) when the dialog text matches the profile name', () => {
    const result = verifyRecipientName('Jordan Lee', 'Personalize your invitation to Jordan Lee');
    expect(result.ok).toBe(true);
    expect(result.recipientName).toBe('Jordan Lee');
  });

  it('is NOT ok when the dialog names a different real person than the profile navigated to', () => {
    const result = verifyRecipientName('Jane Doe', 'Personalize your invitation to Vaishali S.');
    expect(result.ok).toBe(false);
    expect(result.recipientName).toBe('Vaishali S');
  });

  it('FAILS CLOSED (blocks) when the profile name could not be extracted at all (INCIDENT #2: prior leniency silently disabled this gate)', () => {
    const result = verifyRecipientName('', 'Personalize your invitation to Vaishali S.');
    expect(result.ok).toBe(false);
  });

  it('FAILS CLOSED (blocks) when the dialog recipient name could not be extracted at all (INCIDENT #2)', () => {
    const result = verifyRecipientName('Jordan Lee', 'Send without a note');
    expect(result.ok).toBe(false);
  });
});

describe('pickNearestToNameIndex (2D proximity, INCIDENT #2)', () => {
  it('picks the candidate closest by full 2D distance, not just Y', () => {
    // A sidebar decoy can be Y-closer than the real target while sitting in a different
    // column (X) — Y-only distance would wrongly pick it.
    const namePoint = { x: 180, y: 437 };
    const candidates = [
      { x: 1052, y: 400 }, // sidebar decoy: Y-close, X-far
      { x: 180, y: 580 }, // real target: Y-farther, same column as the name
    ];
    expect(pickNearestToNameIndex(namePoint, candidates)).toBe(1);
  });

  it('returns -1 for an empty candidate list', () => {
    expect(pickNearestToNameIndex({ x: 0, y: 0 }, [])).toBe(-1);
  });

  it('returns -1 (rejects) when the ONLY candidate is implausibly far, instead of accepting it by default (INCIDENT #3: Juliet/Alok false-negative regression)', () => {
    // Real header buttons sit ~130-145px below the name; a sidebar decoy sits ~800-900px
    // away. Being the sole candidate must not be enough to accept it.
    const namePoint = { x: 180, y: 437 };
    expect(pickNearestToNameIndex(namePoint, [{ x: 1052, y: 410 }])).toBe(-1);
  });

  it('still accepts the only candidate when it is within the plausible distance', () => {
    const namePoint = { x: 180, y: 437 };
    expect(pickNearestToNameIndex(namePoint, [{ x: 180, y: 580 }])).toBe(0);
  });

  it('respects a custom maxDistancePx override', () => {
    const namePoint = { x: 0, y: 0 };
    expect(pickNearestToNameIndex(namePoint, [{ x: 0, y: 50 }], 40)).toBe(-1);
    expect(pickNearestToNameIndex(namePoint, [{ x: 0, y: 50 }], 60)).toBe(0);
  });
});

describe('extractProfileSlug', () => {
  it('extracts the /in/<slug> segment, lowercased', () => {
    expect(extractProfileSlug('https://www.linkedin.com/in/example-person-three-2a19222a2/')).toBe(
      'example-person-three-2a19222a2'
    );
  });

  it('returns empty string when no /in/ segment is present', () => {
    expect(extractProfileSlug('https://www.linkedin.com/feed/')).toBe('');
  });
});

describe('verifyProfileUrl', () => {
  it('is ok when both URLs resolve to the same slug', () => {
    const result = verifyProfileUrl(
      'https://www.linkedin.com/in/example-person-three-2a19222a2/',
      'https://www.linkedin.com/in/example-person-three-2a19222a2/?trk=nav'
    );
    expect(result.ok).toBe(true);
  });

  it('FAILS (blocks) when the current URL is a different profile than requested', () => {
    const result = verifyProfileUrl(
      'https://www.linkedin.com/in/example-person-three-2a19222a2/',
      'https://www.linkedin.com/in/example-person-four/'
    );
    expect(result.ok).toBe(false);
    expect(result.expectedSlug).toBe('example-person-three-2a19222a2');
    expect(result.actualSlug).toBe('example-person-four');
  });

  it('FAILS CLOSED when either URL has no parseable slug', () => {
    expect(verifyProfileUrl('', 'https://www.linkedin.com/in/example/').ok).toBe(false);
    expect(verifyProfileUrl('https://www.linkedin.com/in/example/', '').ok).toBe(false);
  });
});

/** Fake Playwright `Response` — just enough of the shape `isLikelySendInvitationResponse` reads. */
function makeFakeResponse(url: string, method: string, status: number): any {
  return {
    url: () => url,
    status: () => status,
    request: () => ({ method: () => method }),
  };
}

describe('isLikelySendInvitationResponse', () => {
  // Best-effort heuristic (NOT verified against a real captured request/response — see
  // src/mcp/connect.ts) — these tests exercise the predicate logic itself in isolation.
  it('matches a 2xx POST to a voyager-style invitation path', () => {
    const response = makeFakeResponse(
      'https://www.linkedin.com/voyager/api/voyagerRelationshipsDashMemberRelationships/invitation',
      'POST',
      201
    );
    expect(isLikelySendInvitationResponse(response)).toBe(true);
  });

  it('matches a 2xx POST to a voyager-style connect path', () => {
    const response = makeFakeResponse('https://www.linkedin.com/voyager/api/connect/send', 'POST', 200);
    expect(isLikelySendInvitationResponse(response)).toBe(true);
  });

  it('does not match a non-2xx status', () => {
    const response = makeFakeResponse('https://www.linkedin.com/voyager/api/invitation', 'POST', 500);
    expect(isLikelySendInvitationResponse(response)).toBe(false);
  });

  it('does not match a GET request even to a plausible path', () => {
    const response = makeFakeResponse('https://www.linkedin.com/voyager/api/invitation', 'GET', 200);
    expect(isLikelySendInvitationResponse(response)).toBe(false);
  });

  it('does not match an unrelated voyager path', () => {
    const response = makeFakeResponse('https://www.linkedin.com/voyager/api/feed/updates', 'POST', 200);
    expect(isLikelySendInvitationResponse(response)).toBe(false);
  });
});


describe('extractExpectedNameFromTitle', () => {
  it('strips the "| LinkedIn" suffix', () => {
    expect(extractExpectedNameFromTitle('Tanvi Gaharwar | LinkedIn')).toBe('Tanvi Gaharwar');
    expect(extractExpectedNameFromTitle('  Jane Doe ')).toBe('Jane Doe');
  });
});

describe('ported incident guards', () => {
  it('keeps the exact-match Connect menu selector (2026-08-28 "Remove connection" incident)', () => {
    expect(SELECTORS.connectMenuItem).toContain(':text-is("Connect")');
    expect(SELECTORS.connectMenuItem).not.toContain(':has-text');
  });
  it('fails closed on an empty name or an unextractable dialog', () => {
    expect(verifyRecipientName('', 'Add a note to your invitation to Jane').ok).toBe(false);
    expect(verifyRecipientName('Jane Example', 'Some unrelated dialog').ok).toBe(false);
  });
  it('rejects a lone far-away decoy', () => {
    expect(pickNearestToNameIndex({ x: 0, y: 0 }, [{ x: 800, y: 900 }])).toBe(-1);
  });
  it('carries the two new unverified selectors', () => {
    expect(SELECTORS.invitationAcceptButton).toBe('button[aria-label^="Accept" i]');
    expect(SELECTORS.messageOverlayHeader).toContain('msg-overlay');
  });
});
