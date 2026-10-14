// LinkedIn DOM selectors COPIED from src/mcp/connect.ts (cannot import it: it opens data.sqlite at
// import). connect.ts's names are kept; incident comments record why each is shaped as it is.

// LinkedIn people-search / profile DOM selectors. See git history / .superpowers/sdd/task-6
// -connect-fix-report.md for the live-inspection notes behind each of these.
export const SELECTORS = {
  resultCard: 'div[role="listitem"]',
  profileLink: 'a[href*="/in/"]',
  // Filtered further by pickButtonShapedIndex (below) to isolate the real profile-header
  // "More" button from small post "…more" text toggles that also match this selector.
  moreButton: 'main button:has-text("More")',
  // Scoped to [role="menu"] so it never matches unrelated sidebar "Invite X to connect" links.
  // `:text-is()` (exact, whitespace-normalized match) — NOT `:has-text()`. INCIDENT
  // 2026-08-28: `:has-text("Connect")` is a substring match, and a real already-connected
  // profile's More menu has a "Remove connection" item — "connection" contains "connect" as a
  // substring, so the old selector clicked "Remove connection" instead of finding no match.
  // The recipient-name verification gate caught it before the real "Remove connection" button
  // (the resulting dialog's copy doesn't match the "invitation to <Name>" pattern), so nothing
  // was actually removed, but the selector itself was wrong independent of that safety net.
  connectMenuItem: '[role="menu"] [role="menuitem"]:text-is("Connect")',
  // INCIDENT 2026-08-28: LinkedIn now renders "Add a note" as an <a>, not a <button>, on the
  // intermediate "Add a note to your invitation?" screen (confirmed live on
  // linkedin.com/in/example-person-3) — a button-only selector silently matched nothing, so the
  // click was skipped and the code correctly refused rather than send without a note.
  addNoteButton:
    'button[aria-label*="add a note" i], button:has-text("Add a note"), a:has-text("Add a note")',
  noteTextarea: '#custom-message, textarea[name="message"]',
  // The Send button's accessible name ("Send invitation") lives only in its aria-label, not
  // its visible text ("Send") — hence the aria-label-based alternatives.
  sendButton:
    'button[aria-label="Send invitation" i], button[aria-label^="Send " i], button:has-text("Send now")',
  // Once a request is recorded, LinkedIn shows a "Pending" `<a>` (not a `<button>`) in place
  // of "+ Follow". Multiple matches can exist on one page (e.g. a duplicate sticky-nav copy)
  // — disambiguated by proximity to the profile's own name, see pickNearestLocator below.
  pendingButton: 'a[aria-label^="Pending" i]',
  // Some profiles show "Connect" directly at the top level instead of hiding it behind
  // "More" — an `<a>`, not a `<button>`. Can also match more than once on a real page (e.g.
  // a real profile was confirmed to render this twice — once in a sticky nav element with no
  // section ancestor, once in the actual profile card ~143px below the name) — disambiguated
  // by proximity, not a DOM-ancestor guess (two different ancestor-based guesses have each
  // failed on a different real profile). See pickNearestLocator below.
  directConnectButton: 'a[aria-label^="Invite " i][aria-label$=" to connect" i]',
  // LinkedIn shows a "Message" control in the profile header ONLY for an existing 1st-degree
  // connection (in place of "Connect"/"Follow") — used to detect "already connected" before
  // connectSend attempts a Connect click that could never succeed. Live-confirmed 2026-08-28
  // (linkedin.com/in/example-person-2): the REAL header button has NO aria-label at all — its
  // accessible name is the visible text "Message" only. `:text-is("Message")` (exact) found
  // ZERO matches live despite the button's textContent being exactly "Message" (likely
  // unsupported/behaves differently in this project's pinned Playwright version) —
  // `:has-text("Message")` (substring, case-insensitive) DID match it live, at the cost of
  // also matching sidebar "More profiles for you" decoy links and unrelated feed posts that
  // merely mention "message" — same tradeoff directConnectButton already accepts, resolved the
  // same way: pickNearestLocator's 2D-proximity check picks the real near-the-name match
  // regardless of how many far-away decoys also matched.
  messageButton: 'main a:has-text("Message"), main button:has-text("Message")',
  // The "Manage notifications about <Name>" bell — live-confirmed 2026-08-28 present ONLY on a
  // real 1st-degree connection's profile (linkedin.com/in/example-person-2) and absent entirely
  // on a real not-connected profile (linkedin.com/in/example-person, 2nd-degree). Used by
  // checkConnectionStatus as the primary "already connected" signal — more reliable than
  // Message-button presence, which some Premium/InMail-enabled non-connections also show.
  bellButton: 'a[aria-label^="Manage notifications about " i]',
  // The message-compose box that opens after clicking messageButton. Not live-verified —
  // LinkedIn's real messaging UI uses a contenteditable div, not a plain textarea/input.
  messageComposeTextarea:
    'div.msg-form__contenteditable[contenteditable="true"], [aria-label*="message" i][contenteditable="true"], textarea[name="message"]',
  // The Send button inside the message compose box. Not live-verified.
  messageSendButton: 'button.msg-form__send-button, button[type="submit"]:has-text("Send")',
  // LinkedIn doesn't consistently render the profile's own name in one heading tag (a real
  // profile was confirmed to have ZERO `<h1>` anywhere, with the name in an `<h2>` instead)
  // — search both. Used only to locate the name's position for proximity-based picks.
  nameHeadings: 'main h1, main h2',
  // The "Add a note?" / "Personalize your invitation to <Name>" dialog container, used only
  // to extract the stated recipient name for verification against the expected name.
  // `:visible` (a Playwright selector extension, not standard CSS) excludes hidden/decoy
  // dialog elements that may share this role elsewhere on the page — INCIDENT 2026-07-17
  // (#2): `.first()` on an unfiltered match is a plausible way to silently grab the wrong
  // one, the same class of bug as directConnectButton's.
  // INCIDENT 2026-08-28: `[role="dialog"]`/`[role="alertdialog"]` alone silently matched
  // NOTHING live (confirmed on linkedin.com/in/example-person and linkedin.com/in/example-person-3 —
  // the dialog visibly rendered, per debug screenshots, but recipient-name verification always
  // failed with "could not verify"). Root cause: LinkedIn now renders this as a native HTML
  // `<dialog>` element with no explicit `role` attribute — CSS attribute selectors don't know
  // about `<dialog>`'s IMPLICIT ARIA dialog role, so `[role="dialog"]` never matches it. The
  // `dialog` tag selector is added first to catch this directly.
  noteDialogContainer: 'dialog:visible, [role="dialog"]:visible, [role="alertdialog"]:visible',
  // NEW in plan 6C, UNVERIFIED LIVE: written from the DOM shape of the invitation manager, not
  // from a live inspection. Any use must fail closed on a miss.
  invitationAcceptButton: 'button[aria-label^="Accept" i]',
  // NEW in plan 6C, UNVERIFIED LIVE: header of the open message overlay, used to read the
  // recipient name shown there. Fail closed when it does not match.
  messageOverlayHeader: '.msg-overlay-conversation-bubble header, [class*="msg-overlay"] header',
  // NEW in plan 6C, UNVERIFIED LIVE (owner canary confirms): the OPENED conversation overlay only.
  // The messaging dock/list bubble (msg-overlay-list-bubble) and minimized bubbles must not match.
  conversationBubble: '.msg-overlay-conversation-bubble',
  conversationBubbleHeader: 'header h2',
  conversationBubbleMessages: '.msg-s-message-list li',
} as const;
