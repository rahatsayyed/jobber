import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  validateNoteLength,
  findLinkedinProfile,
  connectSend,
  checkConnectionStatus,
  sendLinkedinMessage,
  recordConnectionStatus,
  extractNameAndHeadline,
  extractAboutText,
  pickButtonShapedIndex,
  extractDialogRecipientName,
  namesPlausiblyMatch,
  verifyRecipientName,
  isLikelySendInvitationResponse,
  pickNearestToNameIndex,
  extractProfileSlug,
  verifyProfileUrl,
  SELECTORS,
  BROWSER_VIEWPORT,
} from '../src/mcp/connect.js';
import { openDb } from '../src/db.js';
import type Database from 'better-sqlite3';

/**
 * A minimal fake Playwright element: `click`/`fill` are spies so tests can assert
 * whether a connect/note/send action was ever attempted.
 */
function makeFakeElement() {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * A minimal fake Playwright `Locator` wrapping zero-or-one fake element(s) — mirrors the
 * shape used in tests/linkedin-apply.test.ts for its Locator conversion.
 */
function makeFakeLocator(el: ReturnType<typeof makeFakeElement> | null): any {
  const locator: any = {
    count: vi.fn().mockResolvedValue(el ? 1 : 0),
    click: vi.fn(async () => {
      if (!el) throw new Error('no element matched by locator');
      return el.click();
    }),
    fill: vi.fn(async (value: string) => {
      if (!el) throw new Error('no element matched by locator');
      return el.fill(value);
    }),
    waitFor: vi.fn().mockResolvedValue(undefined),
    textContent: vi.fn().mockResolvedValue(null),
    // Default plausible position (~130px below x=180, matching real observed header-button
    // distances) so single-match directConnectButton/pendingButton fakes built via this
    // helper (rather than makeFakeYLocator) are still accepted by pickNearestLocator's
    // distance check by default; empty when there's no element at all.
    evaluateAll: vi.fn().mockResolvedValue(el ? [{ x: 180, y: 230 }] : []),
  };
  locator.first = vi.fn(() => locator);
  // `pickNearestLocator` (src/mcp/connect.ts) calls `.nth(index)` on whatever
  // `page.locator(selector)` returns, even for a single-match locator like this one —
  // `.nth(0)` resolves to the element itself, any other index to "no match" (mirrors real
  // Playwright's out-of-range `.nth()` semantics).
  locator.nth = vi.fn((i: number) => (i === 0 ? locator : makeFakeLocator(null)));
  return locator;
}

/** A fake locator for a single text-bearing element (e.g. the connect dialog container). */
function makeFakeTextLocator(text: string | null): any {
  const locator: any = {
    count: vi.fn().mockResolvedValue(text !== null ? 1 : 0),
    textContent: vi.fn().mockResolvedValue(text),
  };
  locator.first = vi.fn(() => locator);
  return locator;
}

/**
 * A fake multi-match Locator backed by an array of fake elements and their bounding-box
 * heights — mirrors `page.locator(SELECTORS.moreButton)`, which can match several elements
 * on a real profile page. `nth(i)` returns a fake Locator wrapping just that element.
 */
function makeFakeMultiLocator(elements: Array<ReturnType<typeof makeFakeElement>>, heights: number[]): any {
  const locator: any = {
    count: vi.fn().mockResolvedValue(elements.length),
    evaluateAll: vi.fn().mockResolvedValue(heights.map((height) => ({ height }))),
    nth: vi.fn((i: number) => makeFakeLocator(elements[i] ?? null)),
    first: vi.fn(() => makeFakeLocator(elements[0] ?? null)),
  };
  return locator;
}

/**
 * A fake multi-match Locator backed by 2D positions instead of heights — mirrors
 * `page.locator(SELECTORS.directConnectButton/pendingButton)`, which `pickNearestLocator`
 * (src/mcp/connect.ts) disambiguates by proximity (full 2D distance) to the profile name
 * when more than one match exists (e.g. a real profile was confirmed to render "Invite X to
 * connect" twice — once in a sidebar card, once in the real profile card).
 */
function makeFakeYLocator(
  elements: Array<ReturnType<typeof makeFakeElement> | null>,
  points: Array<{ x: number; y: number }>
): any {
  const locator: any = {
    count: vi.fn().mockResolvedValue(elements.length),
    evaluateAll: vi.fn().mockResolvedValue(points),
    nth: vi.fn((i: number) => makeFakeLocator(elements[i] ?? null)),
    first: vi.fn(() => makeFakeLocator(elements[0] ?? null)),
  };
  return locator;
}

const DEFAULT_TEST_PROFILE_URL = 'https://linkedin.com/in/example';

/**
 * Builds the full fake `page` object connectSend() tests need. Pre-wires `title` (parsed by
 * `extractExpectedNameFromTitle`), `url()` (read by `verifyProfileUrl`), and
 * `SELECTORS.nameHeadings`/`noteDialogContainer` to a matching `name` by default — LinkedIn
 * doesn't consistently use `<h1>` for the profile name (see src/mcp/connect.ts), so the
 * expected name now comes from the page title, and the name-verification/proximity plumbing
 * (`verifyRecipientName`, `pickNearestLocator`) both read it. `waitForResponse` defaults to
 * "no match", forcing the reload+poll fallback path. `impl` handles every selector not
 * pre-wired here (moreButton, connectMenuItem, etc.).
 */
function makeConnectPage(
  impl: (selector: string) => any,
  opts: {
    name?: string;
    nameX?: number;
    nameY?: number;
    dialogText?: string;
    url?: string;
    waitForResponse?: ReturnType<typeof vi.fn>;
    screenshot?: ReturnType<typeof vi.fn>;
  } = {}
): any {
  const { name = 'Jordan Lee', nameX = 180, nameY = 100, dialogText } = opts;
  const page: any = {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForResponse: opts.waitForResponse ?? vi.fn().mockRejectedValue(new Error('no matching response')),
    title: vi.fn().mockResolvedValue(`${name} | LinkedIn`),
    url: vi.fn().mockReturnValue(opts.url ?? DEFAULT_TEST_PROFILE_URL),
    locator: vi.fn().mockImplementation((selector: string) => {
      if (selector === SELECTORS.nameHeadings) {
        return { evaluateAll: vi.fn().mockResolvedValue([{ text: name, x: nameX, y: nameY }]) };
      }
      if (selector === SELECTORS.noteDialogContainer) {
        return makeFakeTextLocator(dialogText ?? `Personalize your invitation to ${name}`);
      }
      return impl(selector);
    }),
  };
  if (opts.screenshot) page.screenshot = opts.screenshot;
  return page;
}

/**
 * A fake "result card" locator representing `page.locator(SELECTORS.resultCard)`, backed
 * by an array of card descriptors. Each card exposes `.locator(selector)` for the nested
 * profile-link / span lookups `findLinkedinProfile` performs on it.
 */
function makeFakeResultCardsLocator(
  cards: Array<{ linkTexts: string[]; linkHrefs: string[]; spanTexts: string[] }>
) {
  const cardsLocator: any = {
    count: vi.fn().mockResolvedValue(cards.length),
    nth: vi.fn((i: number) => {
      const card = cards[i];
      return {
        locator: vi.fn((selector: string) => {
          if (selector === 'span') {
            return {
              evaluateAll: vi.fn().mockResolvedValue(card.spanTexts),
            };
          }
          // profileLink selector
          const linksLocator: any = {
            count: vi.fn().mockResolvedValue(card.linkTexts.length),
            nth: vi.fn((j: number) => ({
              textContent: vi.fn().mockResolvedValue(card.linkTexts[j]),
              getAttribute: vi.fn().mockResolvedValue(card.linkHrefs[j]),
            })),
          };
          return linksLocator;
        }),
      };
    }),
  };
  return cardsLocator;
}

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

describe('extractNameAndHeadline', () => {
  // Fixtures below are taken verbatim from a live people-search inspection (see
  // .superpowers/sdd/task-6-connect-fix-report.md) — real link/span text captured from
  // `https://www.linkedin.com/search/results/people/?keywords=InfoVision%20recruiter`.
  it('extracts the clean name from the second profileLink match, ignoring the concatenated wrapper link', () => {
    const linkTexts = [
      'Example Recruiter Example Recruiter  • 2ndTalent Acquisition Specialist | End-to-End Recruitment...',
      'Example Recruiter',
      'Ankit Ambardar',
      'Nikhil V.',
    ];
    const spanTexts = [
      '• 2nd',
      '• 2nd',
      'Talent Acquisition Specialist | End-to-End Recruitment | Delivering Talent Solutions',
      'Bengaluru, Karnataka, India',
    ];

    const { name, headline } = extractNameAndHeadline(linkTexts, spanTexts);

    expect(name).toBe('Example Recruiter');
    expect(headline).toBe('Talent Acquisition Specialist | End-to-End Recruitment | Delivering Talent Solutions');
  });

  it('falls back to the first link when only one profileLink match is present', () => {
    const { name } = extractNameAndHeadline(['Jordan Lee'], []);
    expect(name).toBe('Jordan Lee');
  });

  it('returns an empty headline when no connection-degree span is found', () => {
    const { headline } = extractNameAndHeadline(['A', 'B'], ['Some unrelated span text']);
    expect(headline).toBe('');
  });

  it('handles no matches at all without throwing', () => {
    expect(extractNameAndHeadline([], [])).toEqual({ name: '', headline: '' });
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

describe('findLinkedinProfile control flow', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('returns rate_limited and never touches Playwright when the daily search limit is already reached', async () => {
    const launch = vi.fn();
    const fakeChromium = { launch };

    const result = await findLinkedinProfile(
      { company: 'Acme Corp' },
      { db, maxSearchesPerDay: 0, chromium: fakeChromium }
    );

    expect(result.status).toBe('rate_limited');
    expect(result.candidates).toEqual([]);
    // The rate-limit gate must be checked BEFORE any Playwright action — launch()
    // should never be invoked once the limit is already exhausted.
    expect(launch).not.toHaveBeenCalled();
  });

  it('returns candidates extracted via the Locator-based resultCard/profileLink flow', async () => {
    // Shaped after the live DOM pattern: two `a[href*="/in/"]` matches per card (a
    // concatenated wrapper link, then the clean name link), plus span texts holding the
    // connection-degree badge and headline.
    const cardsLocator = makeFakeResultCardsLocator([
      {
        linkTexts: [
          'Example Recruiter Example Recruiter  • 2ndTalent Acquisition Specialist...',
          'Example Recruiter',
        ],
        linkHrefs: [
          'https://www.linkedin.com/in/example-recruiter-93113815a/',
          'https://www.linkedin.com/in/example-recruiter-93113815a/',
        ],
        spanTexts: ['• 2nd', '• 2nd', 'Talent Acquisition Specialist', 'Bengaluru, Karnataka, India'],
      },
      {
        linkTexts: ['Example Recruiter Two Example Recruiter Two  • 2ndSenior Human Resource Recruiter...', 'Example Recruiter Two'],
        linkHrefs: [
          'https://www.linkedin.com/in/example-recruiter-two-322a08139/',
          'https://www.linkedin.com/in/example-recruiter-two-322a08139/',
        ],
        spanTexts: ['• 2nd', '• 2nd', 'Senior Human Resource Recruiter', 'Chennai, Tamil Nadu, India'],
      },
    ]);

    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockImplementation((selector: string) => {
        if (selector === SELECTORS.resultCard) return cardsLocator;
        return makeFakeLocator(null);
      }),
    };

    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const launch = vi.fn().mockResolvedValue(browser);
    const fakeChromium = { launch };

    const result = await findLinkedinProfile(
      { company: 'InfoVision' },
      { db, chromium: fakeChromium }
    );

    expect(result.status).toBe('ok');
    expect(result.candidates).toEqual([
      {
        profile_url: 'https://www.linkedin.com/in/example-recruiter-93113815a/',
        name: 'Example Recruiter',
        headline: 'Talent Acquisition Specialist',
      },
      {
        profile_url: 'https://www.linkedin.com/in/example-recruiter-two-322a08139/',
        name: 'Example Recruiter Two',
        headline: 'Senior Human Resource Recruiter',
      },
    ]);
    // Regression test for the viewport bug: a standalone Playwright script that
    // live-verified these exact selectors explicitly set `{ width: 1440, height: 2400 }` on
    // `newContext()`, while this file's `newContext()` call passed no viewport at all,
    // silently falling back to Playwright's 1280×720 default. Assert the same live-verified
    // viewport is now passed here too.
    expect(browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ viewport: BROWSER_VIEWPORT })
    );
  });

  it('extracts the correct name/headline/url from a card with MORE than 2 profile links, never reading beyond index 1', async () => {
    // Live finding: a real result card can have 2, 3, or 4 `a[href*="/in/"]` matches — the
    // extras beyond index 1 are "mutual connections"/"also viewed" avatar links unrelated
    // to this result's own profile, and querying them was observed to hang/timeout live.
    // `nth(2)`/`nth(3)` below reject if ever called, proving findLinkedinProfile only reads
    // indices 0 and 1 (the indices extractNameAndHeadline actually consumes).
    const cardsLocator: any = {
      count: vi.fn().mockResolvedValue(1),
      nth: vi.fn((i: number) => {
        expect(i).toBe(0);
        return {
          locator: vi.fn((selector: string) => {
            if (selector === 'span') {
              return {
                evaluateAll: vi
                  .fn()
                  .mockResolvedValue(['• 2nd', '• 2nd', 'Talent Acquisition Specialist', 'Bengaluru, India']),
              };
            }
            const linkTexts = [
              'Example Recruiter Example Recruiter  • 2ndTalent Acquisition Specialist...',
              'Example Recruiter',
            ];
            const linkHrefs = [
              'https://www.linkedin.com/in/example-recruiter-93113815a/',
              'https://www.linkedin.com/in/example-recruiter-93113815a/',
            ];
            const linksLocator: any = {
              count: vi.fn().mockResolvedValue(4), // 4 links present on the real card
              nth: vi.fn((j: number) => {
                if (j >= 2) {
                  return {
                    textContent: vi.fn().mockRejectedValue(new Error(`unused mutual-connection link nth(${j}) queried`)),
                    getAttribute: vi.fn().mockRejectedValue(new Error(`unused mutual-connection link nth(${j}) queried`)),
                  };
                }
                return {
                  textContent: vi.fn().mockResolvedValue(linkTexts[j]),
                  getAttribute: vi.fn().mockResolvedValue(linkHrefs[j]),
                };
              }),
            };
            return linksLocator;
          }),
        };
      }),
    };

    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockImplementation((selector: string) => {
        if (selector === SELECTORS.resultCard) return cardsLocator;
        return makeFakeLocator(null);
      }),
    };

    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const launch = vi.fn().mockResolvedValue(browser);
    const fakeChromium = { launch };

    const result = await findLinkedinProfile(
      { company: 'InfoVision' },
      { db, chromium: fakeChromium }
    );

    expect(result.status).toBe('ok');
    expect(result.candidates).toEqual([
      {
        profile_url: 'https://www.linkedin.com/in/example-recruiter-93113815a/',
        name: 'Example Recruiter',
        headline: 'Talent Acquisition Specialist',
      },
    ]);
  });
});

describe('connectSend control flow', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('returns rate_limited and never touches Playwright when the daily connect limit is already reached', async () => {
    const launch = vi.fn();
    const fakeChromium = { launch };

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, maxConnectsPerDay: 0, chromium: fakeChromium }
    );

    expect(result.status).toBe('rate_limited');
    expect(launch).not.toHaveBeenCalled();
  });

  it('returns failed and never touches Playwright when the note exceeds the 300-character cap', async () => {
    const launch = vi.fn();
    const fakeChromium = { launch };
    const overLongNote = 'a'.repeat(301);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: overLongNote },
      { db, maxConnectsPerDay: 10, chromium: fakeChromium }
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/300-character/);
    expect(launch).not.toHaveBeenCalled();
  });

  it('does not burn a quota slot on a cheap pre-flight rejection (Finding 2: invalid note length)', async () => {
    const launch = vi.fn();
    const fakeChromium = { launch };
    const overLongNote = 'a'.repeat(301);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: overLongNote },
      { db, chromium: fakeChromium }
    );

    expect(result.status).toBe('failed');
    expect(launch).not.toHaveBeenCalled();

    const row = db
      .prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = ?")
      .get('connect_send') as { count: number } | undefined;
    expect(row).toBeUndefined();
  });

  it('returns failed and never proceeds when no More button is found on the profile', async () => {
    const page = makeConnectPage(() => makeFakeMultiLocator([], []));
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch } }
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/More button not found/);
  });

  it('returns failed when More buttons are found but none is button-shaped (e.g. only post "…more" toggles)', async () => {
    const smallToggle1 = makeFakeElement();
    const smallToggle2 = makeFakeElement();

    const page = makeConnectPage((selector: string) => {
      if (selector === SELECTORS.moreButton) {
        return makeFakeMultiLocator([smallToggle1, smallToggle2], [17.5, 17.5]);
      }
      return makeFakeLocator(null);
    });
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch } }
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/no button-shaped More button/);
    expect(smallToggle1.click).not.toHaveBeenCalled();
    expect(smallToggle2.click).not.toHaveBeenCalled();
  });

  it('returns failed and never clicks send when the More menu has no Connect menu item', async () => {
    const moreButton = makeFakeElement();

    const page = makeConnectPage((selector: string) => {
      if (selector === SELECTORS.moreButton) return makeFakeMultiLocator([moreButton], [48]);
      if (selector === SELECTORS.connectMenuItem) return makeFakeLocator(null);
      return makeFakeLocator(null);
    });
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch } }
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/Connect menu item not found/);
    expect(moreButton.click).toHaveBeenCalledTimes(1);
  });

  it('clicks More, then Connect in the opened menu, adds a note, and clicks send via the Locator API on the happy path', async () => {
    const moreButton = makeFakeElement();
    const connectMenuItem = makeFakeElement();
    const addNoteButton = makeFakeElement();
    const noteInput = makeFakeElement();
    const sendButton = makeFakeElement();

    const page = makeConnectPage((selector: string) => {
      // A real profile has several `SELECTORS.moreButton` matches (post "…more" toggles
      // etc.) — mirror that here with one small decoy plus the real 48px-tall button at
      // index 1, to prove pickButtonShapedIndex's filtering is actually exercised.
      if (selector === SELECTORS.moreButton) {
        const decoy = makeFakeElement();
        return makeFakeMultiLocator([decoy, moreButton], [17.5, 48]);
      }
      if (selector === SELECTORS.connectMenuItem) return makeFakeLocator(connectMenuItem);
      if (selector === SELECTORS.addNoteButton) return makeFakeLocator(addNoteButton);
      if (selector === SELECTORS.noteTextarea) return makeFakeLocator(noteInput);
      if (selector === SELECTORS.sendButton) return makeFakeLocator(sendButton);
      return makeFakeLocator(null);
    });
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch } }
    );

    expect(result.status).toBe('sent');
    expect(moreButton.click).toHaveBeenCalledTimes(1);
    expect(connectMenuItem.click).toHaveBeenCalledTimes(1);
    expect(addNoteButton.click).toHaveBeenCalledTimes(1);
    expect(noteInput.fill).toHaveBeenCalledWith('Hi, would love to connect!');
    expect(sendButton.click).toHaveBeenCalledTimes(1);
    // Regression test for the viewport bug (see findLinkedinProfile's matching assertion
    // above): connectSend's `newContext()` call must also pass the same live-verified
    // viewport, not silently fall back to Playwright's 1280×720 default.
    expect(browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ viewport: BROWSER_VIEWPORT })
    );
  });

  it('falls through to the normal "Connect menu item not found" failure when waitForConnectMenu times out after the More click', async () => {
    // Regression test for the `.catch(() => {})` in `waitForConnectMenu` (src/mcp/connect.ts),
    // added for the same bug class already fixed in `waitForFormControls`
    // (src/apply/linkedin.ts, see tests/linkedin-apply.test.ts's matching timeout test).
    // `waitForConnectMenu` wraps a bounded `locator.waitFor(...)` in a swallowing catch so a
    // timeout falls through to the existing `.count()`-based "not found" fallback instead of
    // throwing. Every other test's fake `waitFor` resolves instantly, so none of them
    // exercise the rejection branch. Here we force `waitFor` to reject and assert the run
    // still completes with the pre-existing 'failed' / "Connect menu item not found" result
    // (not an uncaught throw), and that the More button was still clicked beforehand.
    const moreButton = makeFakeElement();

    const rejectingConnectMenuLocator: any = {
      count: vi.fn().mockResolvedValue(0),
      first: vi.fn(() => ({
        waitFor: vi.fn().mockRejectedValue(new Error('Timeout 8000ms exceeded waiting for locator')),
      })),
    };

    const page = makeConnectPage((selector: string) => {
      if (selector === SELECTORS.moreButton) return makeFakeMultiLocator([moreButton], [48]);
      if (selector === SELECTORS.connectMenuItem) return rejectingConnectMenuLocator;
      return makeFakeLocator(null);
    });
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch } }
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/Connect menu item not found/);
    // The More button click itself must still have happened before the timed-out wait.
    expect(moreButton.click).toHaveBeenCalledTimes(1);
  });

  it('finds and clicks the real send button via its aria-label alone (visible text is only "Send", not "Send invitation")', async () => {
    // Regression test for the live bug: the send button's accessible name ("Send
    // invitation") lives only in its aria-label, never its visible text ("Send"). This
    // fake element models exactly that split — `makeFakeLocator`/`makeFakeElement` don't
    // carry any text/attribute data, so what actually proves the fix is that `connectSend`
    // locates and clicks whatever `page.locator(SELECTORS.sendButton)` resolves to without
    // ever needing a `:has-text("Send invitation")` match; the SELECTORS-level tests above
    // additionally confirm that broken text-based alternative is gone from the selector
    // value itself.
    const moreButton = makeFakeElement();
    const connectMenuItem = makeFakeElement();
    const addNoteButton = makeFakeElement();
    const noteInput = makeFakeElement();
    const sendButton = makeFakeElement();

    const page = makeConnectPage((selector: string) => {
      if (selector === SELECTORS.moreButton) return makeFakeMultiLocator([moreButton], [48]);
      if (selector === SELECTORS.connectMenuItem) return makeFakeLocator(connectMenuItem);
      if (selector === SELECTORS.addNoteButton) return makeFakeLocator(addNoteButton);
      if (selector === SELECTORS.noteTextarea) return makeFakeLocator(noteInput);
      if (selector === SELECTORS.sendButton) return makeFakeLocator(sendButton);
      // The note-dialog-transition wait's joined selector (noteTextarea + sendButton)
      // also resolves here via the generic fallback and its waitFor() resolves
      // instantly (see makeFakeLocator), so it doesn't block this happy path.
      return makeFakeLocator(null);
    });
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch } }
    );

    expect(result.status).toBe('sent');
    expect(sendButton.click).toHaveBeenCalledTimes(1);
  });

  it('uses the direct top-level "Connect" button and skips the More menu entirely when present', async () => {
    // Regression test for the live finding (2026-07-16, profile linkedin.com/in/example-m-):
    // not every profile hides "Connect" behind "More" — some show it directly, and in that
    // case the More menu has NO "Connect" item at all, so the old code (which only ever
    // looked inside the More menu) reported "Connect menu item not found" on a profile that
    // was perfectly connectable. This fake models exactly that: a moreButton/connectMenuItem
    // pair that would fail if used, alongside a real directConnectButton that should be
    // used instead — the More button must never be clicked in this case.
    const moreButton = makeFakeElement();
    const directConnectButton = makeFakeElement();
    const addNoteButton = makeFakeElement();
    const noteInput = makeFakeElement();
    const sendButton = makeFakeElement();

    const page = makeConnectPage((selector: string) => {
      if (selector === SELECTORS.directConnectButton) return makeFakeLocator(directConnectButton);
      if (selector === SELECTORS.moreButton) return makeFakeMultiLocator([moreButton], [48]);
      // No SELECTORS.connectMenuItem case at all — proves the More-menu path is never
      // consulted when a direct Connect button exists.
      if (selector === SELECTORS.addNoteButton) return makeFakeLocator(addNoteButton);
      if (selector === SELECTORS.noteTextarea) return makeFakeLocator(noteInput);
      if (selector === SELECTORS.sendButton) return makeFakeLocator(sendButton);
      return makeFakeLocator(null);
    });
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch }, pendingConfirmationTimeoutMs: 20, pendingConfirmationPollMs: 10 }
    );

    expect(result.status).toBe('sent');
    expect(directConnectButton.click).toHaveBeenCalledTimes(1);
    expect(moreButton.click).not.toHaveBeenCalled();
  });

  it('retries via a native DOM click when a sponsored ad element blocks the normal click, instead of failing outright (INCIDENT 2026-08-28, live-confirmed on linkedin.com/in/example-person-21: an svg#ads-small overlay intercepted every normal click attempt for 30s — AND a coordinate-based force:true retry silently no-op\'d by clicking the ad instead, so the fix dispatches a real element.click() with no coordinate/hit-testing step)', async () => {
    const addNoteButton = makeFakeElement();
    const noteInput = makeFakeElement();
    const sendButton = makeFakeElement();
    let directConnectClickCalls = 0;

    const directConnectLocator: any = makeFakeLocator(makeFakeElement());
    directConnectLocator.click = vi.fn(async () => {
      directConnectClickCalls++;
      throw new Error(
        'locator.click: Timeout 30000ms exceeded.\n' +
          'Call log:\n' +
          '  - <svg id="ads-small" ...> intercepts pointer events'
      );
    });
    directConnectLocator.evaluate = vi.fn().mockResolvedValue(undefined);

    const page = makeConnectPage((selector: string) => {
      if (selector === SELECTORS.directConnectButton) return directConnectLocator;
      if (selector === SELECTORS.addNoteButton) return makeFakeLocator(addNoteButton);
      if (selector === SELECTORS.noteTextarea) return makeFakeLocator(noteInput);
      if (selector === SELECTORS.sendButton) return makeFakeLocator(sendButton);
      return makeFakeLocator(null);
    });
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch }, pendingConfirmationTimeoutMs: 20, pendingConfirmationPollMs: 10 }
    );

    expect(result.status).toBe('sent');
    expect(directConnectClickCalls).toBe(1);
    expect(directConnectLocator.evaluate).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry with force when the click fails for an unrelated reason (never masks a genuine failure as an ad-interception retry)', async () => {
    const directConnectLocator: any = makeFakeLocator(makeFakeElement());
    directConnectLocator.click = vi.fn().mockRejectedValue(new Error('element is detached from the DOM'));

    const page = makeConnectPage((selector: string) => {
      if (selector === SELECTORS.directConnectButton) return directConnectLocator;
      return makeFakeLocator(null);
    });
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch } }
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/detached from the DOM/);
    expect(directConnectLocator.click).toHaveBeenCalledTimes(1);
  });

  it('picks the profile-card "Connect" link closest to the name (2D distance), not a sidebar duplicate at a similar Y (INCIDENT regression #2: X matters, not just Y)', async () => {
    // Regression test for a second live-confirmed incident: a sidebar suggestion card's
    // "Connect" link can sit at a Y close to the profile header's Y (x≈1052, sidebar column)
    // while the real button shares the name's X (x≈180). A Y-only distance check picks the
    // sidebar decoy here; only full 2D distance correctly picks the real, same-column match.
    const decoyConnectLink = makeFakeElement();
    const realConnectLink = makeFakeElement();
    const moreButton = makeFakeElement();
    const connectMenuItem = makeFakeElement();
    const sendButton = makeFakeElement();

    const page = makeConnectPage(
      (selector: string) => {
        // Decoy is Y-closer to the name (400 vs name's 437) but in a different column
        // (x=1052, sidebar); the real target is Y-farther (580) but same column as the name
        // (x=180). Y-only distance would wrongly pick the decoy.
        if (selector === SELECTORS.directConnectButton) {
          return makeFakeYLocator(
            [decoyConnectLink, realConnectLink],
            [
              { x: 1052, y: 400 },
              { x: 180, y: 580 },
            ]
          );
        }
        if (selector === SELECTORS.moreButton) return makeFakeMultiLocator([moreButton], [48]);
        if (selector === SELECTORS.connectMenuItem) return makeFakeLocator(connectMenuItem);
        if (selector === SELECTORS.sendButton) return makeFakeLocator(sendButton);
        return makeFakeLocator(null);
      },
      { nameX: 180, nameY: 437 }
    );
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch }, pendingConfirmationTimeoutMs: 20, pendingConfirmationPollMs: 10 }
    );

    expect(result.status).toBe('sent');
    expect(realConnectLink.click).toHaveBeenCalledTimes(1);
    expect(decoyConnectLink.click).not.toHaveBeenCalled();
    expect(moreButton.click).not.toHaveBeenCalled();
  });

  it('falls through to the More-menu path (not the sidebar decoy) when the profile has NO real direct-Connect button at all — Juliet K Gasper case (INCIDENT regression #3: false negative, only decoy candidate exists)', async () => {
    // Regression test for a live-confirmed false negative: Juliet's own profile header shows
    // only Message/Follow/More — genuinely no direct Connect button. `directConnectButton`
    // still matched ONE stray sidebar suggestion-card link ("Soumyashree SR", ~850px away),
    // and because it was the ONLY match, the old code accepted it as "nearest" by default.
    // The real fix: reject an implausibly distant sole candidate and fall through to More.
    const sidebarDecoy = makeFakeElement();
    const moreButton = makeFakeElement();
    const connectMenuItem = makeFakeElement();
    const sendButton = makeFakeElement();

    const page = makeConnectPage(
      (selector: string) => {
        if (selector === SELECTORS.directConnectButton) {
          return makeFakeYLocator([sidebarDecoy], [{ x: 1052, y: 410 }]);
        }
        if (selector === SELECTORS.moreButton) return makeFakeMultiLocator([moreButton], [48]);
        if (selector === SELECTORS.connectMenuItem) return makeFakeLocator(connectMenuItem);
        if (selector === SELECTORS.sendButton) return makeFakeLocator(sendButton);
        return makeFakeLocator(null);
      },
      { nameX: 180, nameY: 437 }
    );
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch }, pendingConfirmationTimeoutMs: 20, pendingConfirmationPollMs: 10 }
    );

    expect(result.status).toBe('sent');
    expect(sidebarDecoy.click).not.toHaveBeenCalled();
    expect(moreButton.click).toHaveBeenCalledTimes(1);
    expect(connectMenuItem.click).toHaveBeenCalledTimes(1);
  });

  it('falls through to the More-menu path (not the sidebar decoy) when the profile has NO real direct-Connect button at all — Alok Singh Baghel case (INCIDENT regression #3)', async () => {
    // Same mechanism as the Juliet case above, confirmed independently on a second real
    // profile in the same live batch: sidebar decoy was "Dhruv Sharaf", ~870px away.
    const sidebarDecoy = makeFakeElement();
    const moreButton = makeFakeElement();
    const connectMenuItem = makeFakeElement();
    const sendButton = makeFakeElement();

    const page = makeConnectPage(
      (selector: string) => {
        if (selector === SELECTORS.directConnectButton) {
          return makeFakeYLocator([sidebarDecoy], [{ x: 1060, y: 500 }]);
        }
        if (selector === SELECTORS.moreButton) return makeFakeMultiLocator([moreButton], [48]);
        if (selector === SELECTORS.connectMenuItem) return makeFakeLocator(connectMenuItem);
        if (selector === SELECTORS.sendButton) return makeFakeLocator(sendButton);
        return makeFakeLocator(null);
      },
      { nameX: 180, nameY: 500 }
    );
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch }, pendingConfirmationTimeoutMs: 20, pendingConfirmationPollMs: 10 }
    );

    expect(result.status).toBe('sent');
    expect(sidebarDecoy.click).not.toHaveBeenCalled();
    expect(moreButton.click).toHaveBeenCalledTimes(1);
    expect(connectMenuItem.click).toHaveBeenCalledTimes(1);
  });

  it('aborts BEFORE filling the note or clicking Send when the connect dialog names a different real person than the profile navigated to (INCIDENT regression: recipient-name mismatch)', async () => {
    // Regression test for the actual 2026-07-17 incident: a wrong selector match sent a
    // real request, with a note meant for someone else, to an uninvolved third party. The
    // mandatory recipient-name verification gate must catch THIS even if some future
    // selector picks the wrong element again — it does not depend on which path (direct or
    // More-menu) was taken.
    const moreButton = makeFakeElement();
    const connectMenuItem = makeFakeElement();
    const addNoteButton = makeFakeElement();
    const noteInput = makeFakeElement();
    const sendButton = makeFakeElement();

    // Profile navigated to is "Jane Doe" (per page title), but the dialog that actually
    // opened addresses a completely different person — exactly the real incident's symptom
    // ("Personalize your invitation to Vaishali S." when the intended target was someone
    // else).
    const page = makeConnectPage(
      (selector: string) => {
        if (selector === SELECTORS.moreButton) return makeFakeMultiLocator([moreButton], [48]);
        if (selector === SELECTORS.connectMenuItem) return makeFakeLocator(connectMenuItem);
        if (selector === SELECTORS.addNoteButton) return makeFakeLocator(addNoteButton);
        if (selector === SELECTORS.noteTextarea) return makeFakeLocator(noteInput);
        if (selector === SELECTORS.sendButton) return makeFakeLocator(sendButton);
        return makeFakeLocator(null);
      },
      { name: 'Jane Doe', dialogText: 'Personalize your invitation to Vaishali S.' }
    );
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch } }
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/recipient name mismatch/);
    expect(result.reason).toMatch(/Vaishali S/);
    expect(result.reason).toMatch(/Jane Doe/);
    // The note must never have been filled, and Send must never have been clicked — that's
    // the whole point of the gate running BEFORE those actions.
    expect(noteInput.fill).not.toHaveBeenCalled();
    expect(addNoteButton.click).not.toHaveBeenCalled();
    expect(sendButton.click).not.toHaveBeenCalled();
  });

  it('aborts BEFORE filling the note or clicking Send when expectedName ends up empty (e.g. a page.title() timing quirk), even though the dialog names a real person (INCIDENT #2 regression: fail-closed, not the prior silent-allow leniency)', async () => {
    // Regression test for the actual 2026-07-17 incident #2: `verifyRecipientName` used to
    // return `ok: true` (allow) whenever EITHER name was empty — a real send to the wrong
    // person got through silently because of this leniency. This models an expectedName
    // that came back empty (whatever the underlying cause — page.title() timing, a locale
    // quirk, etc.) with a dialog that DOES name someone: the flow must still abort, not
    // silently allow, because we can no longer verify the two match.
    const moreButton = makeFakeElement();
    const connectMenuItem = makeFakeElement();
    const addNoteButton = makeFakeElement();
    const noteInput = makeFakeElement();
    const sendButton = makeFakeElement();

    const page = makeConnectPage(
      (selector: string) => {
        if (selector === SELECTORS.moreButton) return makeFakeMultiLocator([moreButton], [48]);
        if (selector === SELECTORS.connectMenuItem) return makeFakeLocator(connectMenuItem);
        if (selector === SELECTORS.addNoteButton) return makeFakeLocator(addNoteButton);
        if (selector === SELECTORS.noteTextarea) return makeFakeLocator(noteInput);
        if (selector === SELECTORS.sendButton) return makeFakeLocator(sendButton);
        return makeFakeLocator(null);
      },
      // `name: ''` -> page.title() resolves to just '' | LinkedIn'`, which
      // extractExpectedNameFromTitle parses down to an empty expected name.
      { name: '', dialogText: 'Personalize your invitation to Example Person Four' }
    );
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch } }
    );

    expect(result.status).toBe('failed');
    // recipientName WAS extracted ("Example Person Four") — expectedName is what's empty — so
    // this hits the mismatch-message branch, not the "could not verify" one; either way, the
    // key assertion is that this no longer silently proceeds (the pre-fix behavior).
    expect(result.reason).toMatch(/recipient name mismatch/);
    expect(noteInput.fill).not.toHaveBeenCalled();
    expect(addNoteButton.click).not.toHaveBeenCalled();
    expect(sendButton.click).not.toHaveBeenCalled();
  });

  it('aborts BEFORE filling the note or clicking Send when the browser navigated away from the requested profile (INCIDENT #2 defense-in-depth: URL verification)', async () => {
    // Independent, text-free safety net requested after INCIDENT #2 — verifies page.url()
    // still matches the requested profile_url's slug right before the note is filled / Send
    // is clicked, regardless of what the name check concludes.
    const moreButton = makeFakeElement();
    const connectMenuItem = makeFakeElement();
    const addNoteButton = makeFakeElement();
    const noteInput = makeFakeElement();
    const sendButton = makeFakeElement();

    const page = makeConnectPage(
      (selector: string) => {
        if (selector === SELECTORS.moreButton) return makeFakeMultiLocator([moreButton], [48]);
        if (selector === SELECTORS.connectMenuItem) return makeFakeLocator(connectMenuItem);
        if (selector === SELECTORS.addNoteButton) return makeFakeLocator(addNoteButton);
        if (selector === SELECTORS.noteTextarea) return makeFakeLocator(noteInput);
        if (selector === SELECTORS.sendButton) return makeFakeLocator(sendButton);
        return makeFakeLocator(null);
      },
      { url: 'https://www.linkedin.com/in/someone-else/' }
    );
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch } }
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/profile URL mismatch/);
    expect(result.reason).toMatch(/example/);
    expect(result.reason).toMatch(/someone-else/);
    expect(noteInput.fill).not.toHaveBeenCalled();
    expect(addNoteButton.click).not.toHaveBeenCalled();
    expect(sendButton.click).not.toHaveBeenCalled();
  });

  it('captures debug screenshots at each step only when debugScreenshots is enabled', async () => {
    // The post-click "sent" confirmation heuristic was found to report a false positive
    // live (2026-07-16) with no other diagnostic signal available -- a screenshot at each
    // step is what let a real send be distinguished from a false one. Off by default so
    // routine runs never write to disk; opt-in via `debugScreenshots` or
    // `CONNECT_DEBUG_SCREENSHOTS=true`.
    const moreButton = makeFakeElement();
    const connectMenuItem = makeFakeElement();
    const addNoteButton = makeFakeElement();
    const noteInput = makeFakeElement();
    const sendButton = makeFakeElement();
    const screenshot = vi.fn().mockResolvedValue(undefined);

    const page = makeConnectPage(
      (selector: string) => {
        if (selector === SELECTORS.moreButton) return makeFakeMultiLocator([moreButton], [48]);
        if (selector === SELECTORS.connectMenuItem) return makeFakeLocator(connectMenuItem);
        if (selector === SELECTORS.addNoteButton) return makeFakeLocator(addNoteButton);
        if (selector === SELECTORS.noteTextarea) return makeFakeLocator(noteInput);
        if (selector === SELECTORS.sendButton) return makeFakeLocator(sendButton);
        return makeFakeLocator(null);
      },
      { screenshot }
    );
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const enabledResult = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch }, debugScreenshots: true }
    );
    expect(enabledResult.status).toBe('sent');
    // One screenshot per step: profile load, more-menu, connect-dialog, note-filled,
    // immediately-after-send, and the final confirmed/not-confirmed state.
    expect(screenshot.mock.calls.length).toBeGreaterThanOrEqual(6);

    screenshot.mockClear();
    const defaultResult = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch } }
    );
    expect(defaultResult.status).toBe('sent');
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('falls through to the normal "Send button not found" failure when waitForNoteDialogTransition times out after clicking Add a note', async () => {
    // Regression test for the `.catch(() => {})` in `waitForNoteDialogTransition`
    // (src/mcp/connect.ts) — added because the real "Add a note?" dialog's textarea and
    // new button set (including the Send button) don't necessarily exist in the DOM the
    // instant "Add a note" is clicked; without this bounded wait, the very next
    // `.count()` checks on noteTextarea/sendButton can race that render and report "Send
    // button not found on connect dialog" prematurely. Mirrors the equivalent
    // `waitForConnectMenu` timeout test above and `waitForFormControls`'s in
    // tests/linkedin-apply.test.ts.
    const moreButton = makeFakeElement();
    const connectMenuItem = makeFakeElement();
    const addNoteButton = makeFakeElement();

    // waitForNoteDialogTransition builds one joined selector string containing both
    // noteTextarea and sendButton and calls `.first().waitFor(...)` on it. That joined
    // string is the only selector containing both substrings, so it can be distinguished
    // from the individual `noteTextarea`/`sendButton` lookups the rest of the
    // implementation queries separately via `.count()`.
    const isNoteTransitionSelector = (selector: string) =>
      selector.includes('custom-message') && selector.includes('Send invitation');

    const page = makeConnectPage((selector: string) => {
      if (isNoteTransitionSelector(selector)) {
        return {
          count: vi.fn().mockResolvedValue(0),
          first: vi.fn(() => ({
            waitFor: vi.fn().mockRejectedValue(new Error('Timeout 8000ms exceeded waiting for locator')),
          })),
        };
      }
      if (selector === SELECTORS.moreButton) return makeFakeMultiLocator([moreButton], [48]);
      if (selector === SELECTORS.connectMenuItem) return makeFakeLocator(connectMenuItem);
      if (selector === SELECTORS.addNoteButton) return makeFakeLocator(addNoteButton);
      // Both the note textarea and the send button are absent after the timed-out
      // wait, so the flow falls through to the pre-existing "not found" checks.
      if (selector === SELECTORS.noteTextarea) return makeFakeLocator(null);
      if (selector === SELECTORS.sendButton) return makeFakeLocator(null);
      return makeFakeLocator(null);
    });
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch } }
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/Send button not found on connect dialog/);
    // Add a note must still have been clicked before the timed-out wait.
    expect(addNoteButton.click).toHaveBeenCalledTimes(1);
  });

  it('falls through to the normal "Send button not found" failure when waitForConnectDialog times out after clicking Connect', async () => {
    // Regression test for the `.catch(() => {})` in `waitForConnectDialog` (src/mcp/connect.ts)
    // — added after a LIVE run (2026-07-16, real profile, main-account session) showed the
    // "Add a note to your invitation?" dialog rendering correctly a moment after clicking
    // "Connect" (confirmed via screenshot), but the code's very next `.count()` checks on
    // addNoteButton/sendButton raced that render with no wait in between at all, incorrectly
    // reporting "Send button not found on connect dialog" — this was the real root cause of
    // the previously-reported "intermittent" connect_send failure, not selector rot or
    // anti-automation friction. Mirrors the equivalent waitForConnectMenu/
    // waitForNoteDialogTransition timeout tests above: forces the joined-selector waitFor to
    // reject and asserts the run still completes with the pre-existing 'failed' result (never
    // an uncaught throw) when the dialog genuinely never renders.
    const moreButton = makeFakeElement();
    const connectMenuItem = makeFakeElement();

    // waitForConnectDialog builds one joined selector string containing both addNoteButton
    // and sendButton and calls `.first().waitFor(...)` on it. That joined string is the only
    // selector containing both substrings, distinguishing it from the individual
    // `addNoteButton`/`sendButton` lookups queried separately via `.count()` elsewhere.
    const isConnectDialogSelector = (selector: string) =>
      selector.includes('add a note') && selector.includes('Send invitation');

    const page = makeConnectPage((selector: string) => {
      if (isConnectDialogSelector(selector)) {
        return {
          count: vi.fn().mockResolvedValue(0),
          first: vi.fn(() => ({
            waitFor: vi.fn().mockRejectedValue(new Error('Timeout 8000ms exceeded waiting for locator')),
          })),
        };
      }
      if (selector === SELECTORS.moreButton) return makeFakeMultiLocator([moreButton], [48]);
      if (selector === SELECTORS.connectMenuItem) return makeFakeLocator(connectMenuItem);
      // Both the "Add a note?" button and the send button are absent after the
      // timed-out wait, so the flow falls through to the pre-existing "not found" checks.
      if (selector === SELECTORS.addNoteButton) return makeFakeLocator(null);
      if (selector === SELECTORS.sendButton) return makeFakeLocator(null);
      return makeFakeLocator(null);
    });
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch } }
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/Send button not found on connect dialog/);
    // The Connect menu item click itself must still have happened before the timed-out wait.
    expect(connectMenuItem.click).toHaveBeenCalledTimes(1);
  });
});

/**
 * Builds a minimal page mock for the connect happy path (More → Connect → Send),
 * parameterized on whether SELECTORS.pendingButton ever becomes visible on a post-send
 * reload — this is the real confirmation gate (see connect.ts, 2026-07-16): a first attempt
 * that trusted the Send button disappearing from the DOM was live-tested and found to
 * false-positive on a real send, so only the "Pending" action button reappearing is now
 * trusted for the final sent/failed decision.
 */
function makeSendConfirmationPage(pendingButtonAppears: boolean) {
  const moreButton = makeFakeElement();
  const connectMenuItem = makeFakeElement();
  const sendButton = makeFakeElement();

  const pendingElement = {
    waitFor: pendingButtonAppears
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(new Error('Timeout exceeded')),
  };
  const emptyElement = { waitFor: vi.fn().mockRejectedValue(new Error('no match')) };
  const pendingButtonLocator: any = {
    count: vi.fn().mockResolvedValue(pendingButtonAppears ? 1 : 0),
    // Plausible position (~130px below the default name) so pickNearestLocator's distance
    // check accepts it when it exists — only reached when count > 0.
    evaluateAll: vi.fn().mockResolvedValue(pendingButtonAppears ? [{ x: 180, y: 230 }] : []),
    first: vi.fn(() => pendingElement),
    nth: vi.fn((i: number) => (i === 0 ? pendingElement : emptyElement)),
  };

  const page = makeConnectPage((selector: string) => {
    if (selector === SELECTORS.moreButton) return makeFakeMultiLocator([moreButton], [48]);
    if (selector === SELECTORS.connectMenuItem) return makeFakeLocator(connectMenuItem);
    if (selector === SELECTORS.sendButton) return makeFakeLocator(sendButton);
    if (selector === SELECTORS.pendingButton) return pendingButtonLocator;
    return makeFakeLocator(null);
  });
  const context = { newPage: vi.fn().mockResolvedValue(page) };
  const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
  return { launch: vi.fn().mockResolvedValue(browser), sendButton, page };
}

describe('connectSend post-click confirmation (false-positive regression)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('returns sent only once the "Pending" button actually appears after a post-send reload', async () => {
    const { launch, sendButton } = makeSendConfirmationPage(true);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch }, pendingConfirmationTimeoutMs: 20, pendingConfirmationPollMs: 10 }
    );

    expect(result.status).toBe('sent');
    expect(sendButton.click).toHaveBeenCalledTimes(1);
  });

  it('returns failed (not sent) when the "Pending" button never appears', async () => {
    // Regression test for the same false-positive-risk pattern fixed in
    // linkedin.ts's applyEasyApply: a Send click that silently no-ops must never be
    // reported as 'sent'. This also regression-tests the 2026-07-16 finding that the
    // Send-button-disappears heuristic ALONE isn't trustworthy — only a confirmed
    // "Pending" button is.
    const { launch, sendButton } = makeSendConfirmationPage(false);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch }, pendingConfirmationTimeoutMs: 20, pendingConfirmationPollMs: 10 }
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/"Pending" button never appeared/);
    // The click still happens — it's the unverifiable *outcome* that's unsafe to trust.
    expect(sendButton.click).toHaveBeenCalledTimes(1);
  });

  it('waits for network idle after each post-send reload before checking for the Pending button (premature-check regression)', async () => {
    // Regression test: a real connect_send got all the way through (correct recipient,
    // Send clicked, and the user independently confirmed the request went through on
    // LinkedIn) but still reported 'failed' — the reload inside the polling loop checked
    // for the Pending button immediately after `domcontentloaded`, before the page had
    // hydrated, same premature-check bug already fixed for the initial page load via
    // `waitForLoadState('networkidle', ...)`. Assert that same wait now also happens after
    // each reload in the loop, before the Pending-button locator is ever queried.
    const { launch, page } = makeSendConfirmationPage(true);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch }, pendingConfirmationTimeoutMs: 20, pendingConfirmationPollMs: 10 }
    );

    expect(result.status).toBe('sent');
    // waitForLoadState('networkidle', ...) is called once for the initial load and at least
    // once more per reload inside the polling loop.
    const networkIdleCalls = page.waitForLoadState.mock.calls.filter(
      (call: unknown[]) => call[0] === 'networkidle'
    );
    expect(networkIdleCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('confirms immediately via a matching 2xx network response, with no reload/poll needed', async () => {
    // The requested fast path: a real send took longer than the reload+poll window to show
    // the "Pending" button on a genuinely successful send. A matching send-invitation API
    // response is a faster, more authoritative signal — when it fires, connectSend should
    // report 'sent' without ever reloading the profile.
    const moreButton = makeFakeElement();
    const connectMenuItem = makeFakeElement();
    const sendButton = makeFakeElement();
    const matchingResponse = makeFakeResponse(
      'https://www.linkedin.com/voyager/api/voyagerRelationshipsDashMemberRelationships/invitation',
      'POST',
      201
    );

    const page = makeConnectPage(
      (selector: string) => {
        if (selector === SELECTORS.moreButton) return makeFakeMultiLocator([moreButton], [48]);
        if (selector === SELECTORS.connectMenuItem) return makeFakeLocator(connectMenuItem);
        if (selector === SELECTORS.sendButton) return makeFakeLocator(sendButton);
        return makeFakeLocator(null);
      },
      { waitForResponse: vi.fn().mockResolvedValue(matchingResponse) }
    );
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch }, pendingConfirmationTimeoutMs: 20, pendingConfirmationPollMs: 10 }
    );

    expect(result.status).toBe('sent');
    expect(sendButton.click).toHaveBeenCalledTimes(1);
    // No reload/poll: goto is called exactly once, for the initial profile navigation.
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it('falls through to the reload+poll fallback when no matching network response fires', async () => {
    // The network-response predicate is a best-effort guess (see isLikelySendInvitationResponse
    // in src/mcp/connect.ts) and might not match on a real page — the existing reload+poll
    // path must still work as before when it doesn't fire.
    const { launch, sendButton, page } = makeSendConfirmationPage(true);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch }, pendingConfirmationTimeoutMs: 20, pendingConfirmationPollMs: 10 }
    );

    expect(result.status).toBe('sent');
    expect(sendButton.click).toHaveBeenCalledTimes(1);
    // Falls through to the reload+poll path: goto is called more than once (initial load +
    // at least one post-send reload).
    expect(page.goto.mock.calls.length).toBeGreaterThan(1);
  });
});

/**
 * A fake locator representing the "any clickable control" query the hybrid fallback
 * issues when a primary selector misses — mirrors tests/linkedin-apply.test.ts's
 * `makeFakeClickableLocator`.
 */
function makeFakeClickableLocator(
  candidates: string[],
  elementsByText: Record<string, ReturnType<typeof makeFakeElement>> = {}
): any {
  return {
    evaluateAll: vi.fn().mockResolvedValue(candidates),
    filter: vi.fn(({ hasText }: { hasText: string }) => makeFakeLocator(elementsByText[hasText] ?? null)),
  };
}

describe('connectSend hybrid fallback (option 3)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('escalates to the Claude fallback and clicks the control it chooses when no button-shaped More button is found', async () => {
    const fallbackMoreButton = makeFakeElement();
    const connectMenuItem = makeFakeElement();
    const sendButton = makeFakeElement();

    // First call (More button escalation) matches; later calls (none expected here, since
    // Connect menu item and Send both resolve via their primary selectors) would find
    // nothing if invoked.
    const runClaude = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ matchedText: 'More' }))
      .mockResolvedValue(JSON.stringify({ matchedText: null }));

    const page = makeConnectPage((selector: string) => {
      if (selector === SELECTORS.moreButton) return makeFakeMultiLocator([], []); // none found at all
      if (selector.includes('[role="button"]')) {
        return makeFakeClickableLocator(['Follow', 'More'], { More: fallbackMoreButton });
      }
      if (selector === SELECTORS.connectMenuItem) return makeFakeLocator(connectMenuItem);
      if (selector === SELECTORS.sendButton) return makeFakeLocator(sendButton);
      return makeFakeLocator(null);
    });
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch }, fallbackEnabled: true, fallback: { runClaude } }
    );

    expect(fallbackMoreButton.click).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('sent');
  });

  it('escalates to the Claude fallback for the Connect menu item when its selector misses', async () => {
    const moreButton = makeFakeElement();
    const fallbackConnectItem = makeFakeElement();
    const sendButton = makeFakeElement();

    const runClaude = vi.fn().mockResolvedValue(JSON.stringify({ matchedText: 'Connect' }));

    const page = makeConnectPage((selector: string) => {
      if (selector === SELECTORS.moreButton) return makeFakeMultiLocator([moreButton], [48]);
      if (selector === SELECTORS.connectMenuItem) return makeFakeLocator(null); // primary misses
      if (selector === '[role="menu"] [role="menuitem"]') {
        return makeFakeClickableLocator(['Send profile in a message', 'Connect'], {
          Connect: fallbackConnectItem,
        });
      }
      if (selector === SELECTORS.sendButton) return makeFakeLocator(sendButton);
      return makeFakeLocator(null);
    });
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch }, fallbackEnabled: true, fallback: { runClaude } }
    );

    expect(fallbackConnectItem.click).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('sent');
  });
});

describe('recordConnectionStatus (Finding 3: drafted/skipped bookkeeping)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('records a "drafted" row without touching Playwright or the rate-limit counter', () => {
    const result = recordConnectionStatus(
      {
        profile_url: 'https://linkedin.com/in/example',
        note: 'Hi, would love to connect!',
        status: 'drafted',
        job_id: 'job-1',
        company: 'Acme Corp',
      },
      { db }
    );

    expect(result.status).toBe('ok');

    const row = db.prepare('SELECT * FROM connections WHERE profile_url = ?').get(
      'https://linkedin.com/in/example'
    ) as any;
    expect(row.status).toBe('drafted');
    expect(row.job_id).toBe('job-1');
    expect(row.company).toBe('Acme Corp');
    expect(row.sent_at).toBeNull();

    const counterRow = db
      .prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = 'connect_send'")
      .get();
    expect(counterRow).toBeUndefined();
  });

  it('records a "skipped" row when the user declines to approve a draft', () => {
    const result = recordConnectionStatus(
      {
        profile_url: 'https://linkedin.com/in/example-2',
        note: 'Hi, would love to connect!',
        status: 'skipped',
      },
      { db }
    );

    expect(result.status).toBe('ok');

    const row = db.prepare('SELECT * FROM connections WHERE profile_url = ?').get(
      'https://linkedin.com/in/example-2'
    ) as any;
    expect(row.status).toBe('skipped');
    expect(row.job_id).toBeNull();
    expect(row.company).toBeNull();
  });
});

describe('checkConnectionStatus (standalone, read-only, checked BEFORE drafting)', () => {
  // 2026-08-28 redesign: already-connected detection moved OUT of connectSend entirely, into
  // its own read-only tool, using the "Manage notifications about <Name>" bell
  // (SELECTORS.bellButton) instead of Message-button presence — live-confirmed present ONLY on
  // a real connected profile (linkedin.com/in/example-person-3-here) and absent on a real
  // not-connected profile (linkedin.com/in/example-person-21), including one that also shows a Message
  // button (Premium/InMail) — the exact false-positive case that motivated moving off
  // Message-button as the signal. connectSend no longer knows about connection status at all.

  it('returns connected when the bell is present', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(null),
      locator: vi.fn().mockImplementation((selector: string) => {
        if (selector === SELECTORS.bellButton) return makeFakeLocator(makeFakeElement());
        return makeFakeLocator(null);
      }),
    };
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await checkConnectionStatus(
      { profile_url: 'https://linkedin.com/in/example' },
      { chromium: { launch } }
    );

    expect(result.status).toBe('connected');
  });

  it('returns not_connected when the bell is absent, even if a Message control is present (INCIDENT 2026-08-28 false positive this replaces: linkedin.com/in/example-person-21 shows Message but no bell)', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(null),
      locator: vi.fn().mockImplementation((selector: string) => {
        if (selector === SELECTORS.messageButton) return makeFakeLocator(makeFakeElement());
        return makeFakeLocator(null);
      }),
    };
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await checkConnectionStatus(
      { profile_url: 'https://linkedin.com/in/example' },
      { chromium: { launch } }
    );

    expect(result.status).toBe('not_connected');
  });

  it('scrapes profileContext.about from the About section when present (2026-08-29)', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      // Live-confirmed shape (linkedin.com/in/example-person-4): the About section's raw
      // textContent has no separator between the heading and the body.
      evaluate: vi.fn().mockResolvedValue('AboutBlockchain enthousiast Cardano developer'),
      locator: vi.fn().mockImplementation((selector: string) => {
        if (selector === SELECTORS.bellButton) return makeFakeLocator(makeFakeElement());
        return makeFakeLocator(null);
      }),
    };
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await checkConnectionStatus(
      { profile_url: 'https://linkedin.com/in/example' },
      { chromium: { launch } }
    );

    expect(result.profileContext?.about).toBe('Blockchain enthousiast Cardano developer');
  });

  it('omits profileContext when the profile has no About section', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(null),
      locator: vi.fn().mockImplementation((selector: string) => {
        if (selector === SELECTORS.bellButton) return makeFakeLocator(makeFakeElement());
        return makeFakeLocator(null);
      }),
    };
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await checkConnectionStatus(
      { profile_url: 'https://linkedin.com/in/example' },
      { chromium: { launch } }
    );

    expect(result.profileContext).toBeUndefined();
  });

  it('returns failed (not throw) when the browser launch itself errors', async () => {
    const launch = vi.fn().mockRejectedValue(new Error('browser launch failed: no such executable'));

    const result = await checkConnectionStatus(
      { profile_url: 'https://linkedin.com/in/example' },
      { chromium: { launch } }
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/browser launch failed/);
  });
});

describe('sendLinkedinMessage control flow', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('returns rate_limited and never touches Playwright when the daily message limit is already reached', async () => {
    const launch = vi.fn();

    const result = await sendLinkedinMessage(
      { profile_url: 'https://linkedin.com/in/example', message: 'Good to be connected — question about the role.' },
      { db, maxMessagesPerDay: 0, chromium: { launch } }
    );

    expect(result.status).toBe('rate_limited');
    expect(launch).not.toHaveBeenCalled();
  });

  it('returns failed and never touches Playwright when the message is empty', async () => {
    const launch = vi.fn();

    const result = await sendLinkedinMessage(
      { profile_url: 'https://linkedin.com/in/example', message: '   ' },
      { db, chromium: { launch } }
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/empty/);
    expect(launch).not.toHaveBeenCalled();
  });

  it('does not burn a quota slot on the empty-message pre-flight rejection', async () => {
    const launch = vi.fn();

    await sendLinkedinMessage(
      { profile_url: 'https://linkedin.com/in/example', message: '' },
      { db, chromium: { launch } }
    );

    const row = db
      .prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = ?")
      .get('linkedin_message_send') as { count: number } | undefined;
    expect(row).toBeUndefined();
  });

  it('returns failed when no Message button is found on the profile', async () => {
    const page = makeConnectPage(() => makeFakeLocator(null));
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await sendLinkedinMessage(
      { profile_url: 'https://linkedin.com/in/example', message: 'Good to be connected!' },
      { db, chromium: { launch } }
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/Message button not found/);
  });

  it('clicks Message, types the message, clicks Send, and records a "messaged" row on the happy path', async () => {
    const messageButton = makeFakeElement();
    const composeBox = makeFakeElement();
    const sendButton = makeFakeElement();

    const page = makeConnectPage((selector: string) => {
      if (selector === SELECTORS.messageButton) return makeFakeLocator(messageButton);
      if (selector === SELECTORS.messageComposeTextarea) return makeFakeLocator(composeBox);
      if (selector === SELECTORS.messageSendButton) return makeFakeLocator(sendButton);
      return makeFakeLocator(null);
    });
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await sendLinkedinMessage(
      { profile_url: 'https://linkedin.com/in/example', message: 'Good to be connected — quick question about the role.', job_id: 'job-1', company: 'Acme Corp' },
      { db, chromium: { launch } }
    );

    expect(result.status).toBe('sent');
    expect(messageButton.click).toHaveBeenCalledTimes(1);
    expect(composeBox.fill).toHaveBeenCalledWith('Good to be connected — quick question about the role.');
    expect(sendButton.click).toHaveBeenCalledTimes(1);

    const row = db
      .prepare('SELECT * FROM connections WHERE profile_url = ?')
      .get('https://linkedin.com/in/example') as any;
    expect(row.status).toBe('messaged');
    expect(row.note).toBe('Good to be connected — quick question about the role.');
    expect(row.job_id).toBe('job-1');
    expect(row.company).toBe('Acme Corp');
  });

  it('aborts before typing or sending when the browser navigated away from the requested profile', async () => {
    const messageButton = makeFakeElement();
    const composeBox = makeFakeElement();
    const sendButton = makeFakeElement();

    const page = makeConnectPage(
      (selector: string) => {
        if (selector === SELECTORS.messageButton) return makeFakeLocator(messageButton);
        if (selector === SELECTORS.messageComposeTextarea) return makeFakeLocator(composeBox);
        if (selector === SELECTORS.messageSendButton) return makeFakeLocator(sendButton);
        return makeFakeLocator(null);
      },
      { url: 'https://www.linkedin.com/in/someone-else/' }
    );
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await sendLinkedinMessage(
      { profile_url: 'https://linkedin.com/in/example', message: 'Good to be connected!' },
      { db, chromium: { launch } }
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/profile URL mismatch/);
    expect(composeBox.fill).not.toHaveBeenCalled();
    expect(sendButton.click).not.toHaveBeenCalled();
  });

  it('returns failed (not a false-positive sent) when the compose box still holds the typed text after clicking Send', async () => {
    const messageButton = makeFakeElement();
    const sendButton = makeFakeElement();
    // A compose box whose textContent still reports the typed message after Send is clicked —
    // models a click that silently no-op'd.
    const stillFullComposeBox: any = makeFakeLocator(makeFakeElement());
    stillFullComposeBox.textContent = vi.fn().mockResolvedValue('Good to be connected!');
    stillFullComposeBox.first = vi.fn(() => stillFullComposeBox);

    const page = makeConnectPage((selector: string) => {
      if (selector === SELECTORS.messageButton) return makeFakeLocator(messageButton);
      if (selector === SELECTORS.messageComposeTextarea) return stillFullComposeBox;
      if (selector === SELECTORS.messageSendButton) return makeFakeLocator(sendButton);
      return makeFakeLocator(null);
    });
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await sendLinkedinMessage(
      { profile_url: 'https://linkedin.com/in/example', message: 'Good to be connected!' },
      { db, chromium: { launch }, messageComposeClearTimeoutMs: 20, messageComposeClearPollMs: 5 }
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/send was not confirmed/);
  });

  it('does NOT false-negative when the compose box clears a moment after Send, not immediately (INCIDENT 2026-08-28: a real message sent successfully on linkedin.com/in/example-person-3-here, but a single immediate read reported it as unconfirmed — LinkedIn clears the box asynchronously)', async () => {
    const messageButton = makeFakeElement();
    const sendButton = makeFakeElement();
    // Reports non-empty on the first read, then empty on every read after — models the real
    // async-clear race the incident exposed.
    let reads = 0;
    const delayedClearComposeBox: any = makeFakeLocator(makeFakeElement());
    delayedClearComposeBox.textContent = vi.fn().mockImplementation(async () => {
      reads++;
      return reads === 1 ? 'Good to be connected!' : '';
    });
    delayedClearComposeBox.first = vi.fn(() => delayedClearComposeBox);

    const page = makeConnectPage((selector: string) => {
      if (selector === SELECTORS.messageButton) return makeFakeLocator(messageButton);
      if (selector === SELECTORS.messageComposeTextarea) return delayedClearComposeBox;
      if (selector === SELECTORS.messageSendButton) return makeFakeLocator(sendButton);
      return makeFakeLocator(null);
    });
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await sendLinkedinMessage(
      { profile_url: 'https://linkedin.com/in/example', message: 'Good to be connected!' },
      { db, chromium: { launch }, messageComposeClearTimeoutMs: 2000, messageComposeClearPollMs: 5 }
    );

    expect(result.status).toBe('sent');
    expect(reads).toBeGreaterThanOrEqual(2);
  });
});
