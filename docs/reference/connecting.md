<!-- Moved verbatim from CLAUDE.md; the rules in CLAUDE.md "Safety" and "Commands" still apply. -->

## Connecting

LinkedIn connection requests and messages are sent automatically by the `linkedin-operator` (tasks
`new_outreach` and `followups`, see "Layout memory and platform operators") as part of scheduled wakes,
through the `linkedin` MCP (main account, one locked headless session; arm tool plus ref actions). There is no
per-note Telegram approval gate. This was an explicit, informed decision (not an oversight): the
wrong-recipient incident that originally motivated the approval gate was root-caused and fixed at the
automated-verification level rather than relying on a human catching it after the fact. The
arm and commit steps fail closed on every call regardless of who triggered it: the recipient must be a known row in
`people` (a refused `unknown_recipient` means the contact was never registered: `contact-finder`
registers people through `linkedin_find_profiles`, so rerun the pipeline for that job), the profile
URL and the recipient name shown in the dialog are verified against the expected person
(`src/linkedin/verify.ts`: `verifyProfileUrl`, `verifyRecipientName`, `namesPlausiblyMatch`), outbound text passes the style and output gates and the classifier screen (see "Outreach
safety layers"), and the ceiling is consumed right before the Send click.

The only connect caps are the daily rolling ceilings (24 hours, like the other daily caps) in `src/outreach/limits.ts`: `linkedin_invite`
(`LINKEDIN_MAX_INVITES_PER_DAY`) and `linkedin_message` (`LINKEDIN_MAX_MESSAGES_PER_DAY`), plus the
per-company limits and halts there. `MAX_LINKEDIN_SEARCHES_PER_DAY` (daily counter for
`linkedin_find_profiles`, 0 to 100000) and `LINKEDIN_MAX_DISCOVER_PER_DAY` (named job and post
searches) also exist. On a `rate_limited` result the operator stops the task and reports it; there is
no one to ask during a wake, so a cap is never raised from inside a wake. The old `connect` MCP and
its hybrid Claude fallback are gone; the browser applier's own LinkedIn Easy Apply route is covered
under "Applying".

The `linkedin-operator` flow for a new contact (`new_outreach`): `outreach.next_contacts` returns the
only people it may contact (it enforces the per-company limit). With `queue: true` (arguments `platform`,
`limit`, `exclude_company_keys`) it returns ONE person per different company of the connect queue (priority jobs
first, then the company with the fewest recent failures, then oldest); a company drops out after 3 failed people in
14 days (`MAX_COMPANY_FAILURES`, `src/outreach/service.ts`), a paused company or a company in `exclude_company_keys` is
skipped, and an employer-gate refusal pauses that person. `linkedin_open` plus `linkedin_snapshot` confirm the page shows
the expected person, and the connection state is read from the snapshot header BEFORE anything is drafted (see
"Profile page rules" below: `connect_state`; a 1st degree mark without a Connect path means connected, Pending means
skip, `check_more` means open More and snapshot again). Not connected: the `draft-connect-note` skill drafts a note
(at most 300 characters), the operator calls `linkedin_arm_send({kind: "connect_note", ...})` with the exact text,
then clicks Connect by ref, types the exact note and clicks Send. While the monthly note quota is used up it arms
`connect_plain` instead (no text, "Send without a note" only). Connected: the `draft-linkedin-message` skill drafts a
DM, `linkedin_arm_send` with `kind` `role_ask` or `rapport`, then open the message dialog, type the exact armed text and
click Send.

**Profile page rules** (`src/browserctl/topCard.ts`, `snapshot.ts`, `guard.ts`). On a `/in/<slug>` page every
snapshot node carries a region (`topcard`, `sidebar`, `main`, `dialog` or `menu`, shown as `@topcard` and so on in the
rendered lines), and the header has `connect_state: connectable|via_more|not_connectable|already_pending|check_more`.
The top card is the profile's own name heading plus every node after it in document order up to the next section
heading, in the main column only (not the aside, not cards of other people). A Connect click outside it is refused with
`connect_not_top_card` (a Connect in a sidebar or recommendation card sends the invitation directly, without a dialog;
one accidental invite went out that way during a probe), and an "Invite <Name> to connect" control must name the
profile's own person. State rule: a Connect in the top card is `connectable`; otherwise the engine opens More and reads
its rows (`role=menuitem`; live the popover is `body > div[data-floating-ui-portal] > div[popover] > div[role=menu]`
with each label as text in a nested `<p>`, no aria-label); a row named Connect, Personalize invite or "Invite <Name> to
connect" gives `via_more`; menu rows read with no such row give `not_connectable` (probably 1st degree or follow only);
Pending or Withdraw in the top card gives `already_pending`; More clicked but no menu rows found gives `check_more` plus
a `more_menu_missing` diag file, never `not_connectable`. Any other More-menu row is refused (`menu_row_not_allowed`).
The snapshot walker caps the page at `MAX_NODES` (1500) nodes but still reads open menu rows (`MENU_EXTRA`) and dialog
content (`DIALOG_EXTRA`) past the cap, because the portal and the modal sit at the end of the body; a link or button
name falls back to a descendant aria-label.

**Invite dialog.** Live, it is `div[role=dialog][data-test-modal]` inside nested open shadow roots, appears about 4 to 6
seconds after the Connect click and fills in later; its buttons carry an aria-label. The engine waits up to 15 seconds
from the click (`OPEN_CEILING_MS`), reads the dialog controls through the walker and the locator layer (with a CSS
fallback), and `linkedin_click_at` and `linkedin_type` resolve inside shadow roots through locators. Missing controls give
the code `dialog_controls_missing` and a structural diag file (how the controls were found, the locator path, whether the
node cap was hit, the aria-hidden chain, how long it waited). The live dialog text reads "Personalize your invitation
to <name> by adding a note..." with the name in a SEPARATE text node (`inviteDialogName` reads it). When the dialog names
nobody, recipient verification uses the top-card name captured before the click plus the URL slug match.

**Plain invites and the note quota.** A LinkedIn free account has a monthly quota of personalized notes. Arm kind
`connect_plain` sends an invite with no text: the only dialog button it may click is "Send without a note" (the
"Add a note" button is refused for it). When the Premium upsell appears after "Add a note", the engine presses Escape,
stores `linkedin_note_quota_until` in `scheduler_state` (the first instant of the next month, IST) and returns
`custom_note_limit_reached`, which is never a failure of that person. While the key is set, a `connect_note` arm is
refused with `note_quota_exhausted` and the operator arms `connect_plain` for everyone; a plain invite still uses the
daily invite ceiling.

**Live verification status (LinkedIn connect).** Verified live by the owner: top-card detection on several profiles,
the More menu rows, the dialog opening with refs, note typing, the name read of a plain-invite dialog, and one real note
invite through Send with the Pending confirmation (touch `sent`, a `connections` row, the ceiling counted, the invite
visible on the Sent invitations page). NOT live-verified: the Premium upsell modal structure, a "Send without a note"
click through to a confirmed send, the wording of `invite_limit_reached`, any Naukri or Wellfound dialog work, and LinkedIn
messages after an accept.

**LinkedIn hiring posts** (source `linkedin-posts`, `src/linkedin/searchPosts.ts` and `postExtract.ts`, all card
shapes and the permalink forms unverified on live LinkedIn). One hiring post is one job: its id is
`li-post:<number>` from the activity URN, and `url` and `apply_url` are the canonical permalink
`https://www.linkedin.com/feed/update/urn:li:<activity|share|ugcPost>:<number>/` (never the author profile, so the same
post dedupes). `poster_url` is the author's profile URL; the company, role title, location (as the first description
line `Location: ...`) and posted date are parsed from the card by code; `apply_email` (an address written in the post)
and `apply_link` (the first external https link) are stored as data and never opened or followed. The author is
registered in `people` with category `hiring_manager` (headline and company included when known) only when the
profile URL verifies and the post is about hiring for the role. A post stored with no company and the fallback title
`Hiring post by <author>` is vetoed at P2b (`post has no identifiable company or role`); one with no company or no
requirement wording carries the `thin post: no company or no requirements` flag. Rows that an older extractor stored with
the author profile as url and no company are marked `status: bad_extraction` (with an `excluded_reason`, and their
queued outreach rows skipped) by the one-off owner script `npx tsx scripts/fix-linkedin-posts.ts [--dry]`; re-discovery
then stores the same posts under their permalink ids.

**Poster outreach.** The author of a matched hiring post is contacted directly, with or without a known company.
`outreach.next_contacts` has three modes: `company_key` (the people of one company, per-company limit), `job_id` (the
author of one hiring post) and `posters: true` (the authors of every `linkedin-posts` job that has a `poster_url`, is not
excluded and scored at or above `MATCH_THRESHOLD`, priority jobs first, then oldest). A poster row is `{person_id, name,
profile_url, job_id, job_title, company (null when unknown), post_url, post_text, priority}` (`post_text` is untrusted data,
at most 1500 characters). A person is returned once (stage `new`, not paused, no sent, sending or unconfirmed touch; the
`reserveTouch` ledger refuses a repeat anyway), the per-company limit and pause apply only when the job names a company,
and the daily ceilings, quiet hours, halts and dry run are still enforced by the arm tool. The `contact-finder` works a
hiring post in this order: (1) `contacts.find_company_emails({company, job_id})`: code returns the post's `apply_email`
first as a contact with `source: "post"` (verified only when the normal verification passes; a free-mail host such as
gmail.com is never probed and never verified) and a `company_check` of `ok` or `company_unresolved`; (2) when the company
is empty or its `company_confidence` is `low`, it opens the poster's profile (`linkedin_open` on the stored `poster_url`
and `linkedin_snapshot`; no other page, no click) and calls `db.update_job_company({job_id, headline, experience})` with
the headline and first Experience lines exactly as read; code parses the current employer and computes the confidence
(`high` when the headline names it or post and profile agree), and only a `high` result writes `jobs.company` and
`company_key` (plus `company_confidence` and `company_source`: `headline`, `experience`, `post+profile` or `conflict`),
clears the thin-post flag when the post has requirement wording, and gives the poster's own `people` row the company
while it has none; a `low` result only marks the job `company_unresolved` and a `high` company is never overwritten;
(3) only once the company is known does it repeat the email search and run the LinkedIn people searches
(`linkedin_find_profiles`); an unresolved post gets no domain guess, `linkedin_profiles: []` and the note
`company_unresolved`, and the poster alone is contacted. The `linkedin-operator` then calls `next_contacts({platform:
"linkedin", posters: true, limit})` after its queued rows, handles each poster like any new contact (connect note or DM by
the snapshot's connection state) and drafts from the post when no company is known: the drafting skills take an optional
`post` input `{post_text, job_title, poster_name}`, never name a company they were not given and claim only what the post
says; `linkedin_arm_send` gets `job_id` (and `company` only when known). The page shapes behind the poster's headline and
Experience parsing (`src/linkedin/profileCompany.ts`) are unverified.

**Arm, then commit** (`src/browserctl`; unit-tested with fakes, and the LinkedIn connect path is live-verified in part, see above). Every browser
action goes through one engine: it refuses a ref from an old snapshot epoch, re-reads the element, its
role, accessible name and enclosing dialog live at the moment of the action, and classifies it with a
pure semantic guard (`src/browserctl/guard.ts`: `free`, `commit_connect_send`, `commit_message_send`,
`commit_accept_invite`, `naukri_send`, `naukri_apply`, `irreversible_other`; a dialog-footer or submit
button whose name is not on the known-safe list is `irreversible_other`; an unresolvable `click_at`
point is refused). A commit-class click, an Enter in a composer, or typing into a composer needs an
ARMED INTENT: the arm tool (`linkedin_arm_send`, `naukri_arm_send`, `naukri_arm_apply`) runs the
existing code gates first (recipient must be a known `people` row, employer, style, fact and output
gates, `reserveTouch` idempotency, quiet hours, halts, dry run, a spent daily ceiling refuses at
arm) and holds one in-memory intent per platform for 300 seconds (5 minutes), single use. At commit time the
engine re-verifies on the live page (profile key equals the armed key, the dialog recipient name
plausibly matches; the live invite dialog names nobody, so then the top card name, or the one captured when the engine's own Connect click opened the dialog, must match, any navigation drops the capture, and no name anywhere is `dialog_name_unverified`; the composer text read from the live field equals the armed text exactly), then
consumes the ceiling right before the click, watches the platform POST and, after the click, re-reads the page for up to 6 seconds: `sent` needs the dialog gone and
either Pending or an "Invitation sent" toast, or a successful LinkedIn POST with no error text; a new error or limit
message (modal, alert or toast) is `failed` with `send_error_modal` or `invite_limit_reached` (the operator stops the
task on the latter); the diag file records which confirmation held. Statuses: `sent`, `dry_run`, `unconfirmed` (clicked but not confirmed: never retried,
the owner checks it), `refused`, `rate_limited`, `halted`; `no_armed_intent` refuses an unarmed
commit. An armed intent that expires or is disarmed without a commit releases its reserved touch.
If a Connect click sends the invite with no dialog at all and Pending or the toast shows, the engine records the touch as `sent` without a note and never retries it (`sent_without_note`). A touch left in `sending` for more than 30 minutes becomes `unconfirmed` (`markStaleSending`, `src/linkedin/touches.ts`). Typing text other than the armed text into a composer is refused; search and other fields are capped
and output-gated; password and hidden field values never appear in a snapshot.

**Failure ladder** (written into the operator prompts): snapshot, act by ref; if a ref is missing or
the page is odd, scroll and re-snapshot once; then screenshot (only with the flag on); then
`*_click_at` (only after a snapshot and a screenshot at the current epoch, never for a commit class
without an arm); then escalate with a one-line reason through `outreach.escalate` rather than looping.
A drifted layout is no longer a stop reason, but a block, CAPTCHA, checkpoint or login wall still
halts and escalates.

The manual on-demand `/connect` command (one hand-picked job and profile, outside a wake) uses the same
tools and also sends without a separate approval step. "Manual" means "you trigger it for one
job/profile," not "requires a review step." Steps:

1. Call `linkedin_find_profiles({company, role_hint, category})` -> candidate profiles (registered in
   `people` as a side effect, which the arm tool requires).
2. `linkedin_open` the chosen profile and `linkedin_snapshot`; read the connection state from the
   snapshot before drafting anything (see above) and pass any visible About text to the drafting skill.
3. Connected: invoke `draft-linkedin-message`, then `linkedin_arm_send({kind, profile_url, text,
   job_id, company})` (kind `role_ask`, `rapport`, `referral_ask`, `followup` or `feedback`), open the
   message dialog, type the exact text, click Send.
4. Not connected: invoke `draft-connect-note` (<=300 chars, references the role by name),
   `linkedin_arm_send({kind: "connect_note", ...})` (`connect_plain` while the note quota is used up), click Connect (the
   top-card or More-menu one), type the exact note, click Send.
5. Report the status (`sent`, `dry_run`, `unconfirmed`, `refused`, `rate_limited`) to Telegram. An
   unclear page: report it, do not guess which path to take.

`linkedin_arm_send` is gated by the daily rolling `linkedin_invite` ceiling for connects and the
separate `linkedin_message` ceiling for messages (limit values live in the catalog, not here), and a
confirmed send is recorded in `connections` (`status: "messaged"` for a DM).
