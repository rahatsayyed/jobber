# Phase 2 — known issues & live-test findings

Recorded 2026-07-11/12, after the Task 6 end-to-end live smoke test (see
`docs/superpowers/plans/2026-07-07-jobapplier-phase2.md`, Task 6). This captures what a
live LinkedIn session revealed that unit tests alone couldn't catch, since LinkedIn's DOM has
no stable public contract (fully obfuscated/hashed CSS classes, no `data-test-*` attributes).

## What's proven working end-to-end

- **Rate limiting** (`src/lib/rateLimit.ts`) — confirmed for real: `MAX_APPLIES_PER_DAY` was hit
  organically during testing and correctly blocked further attempts without erroring.
- **Session isolation** — burner (`linkedin-apply`) vs. main (`connect`) accounts never cross;
  verified structurally (hardcoded paths) and in every code review this phase.
- **Safety fallbacks** — every "can't proceed safely" path (`manual_review`, `failed`) was
  exercised live and never produced a wrong click, a garbled submission, or a bypass of the
  human-approval gate on `connect_send`.
- **`external-apply`** (Greenhouse/Lever/Workday/Ashby) — unit-tested; NOT live-tested against a
  real posting (no real ATS-hosted job was available during this session). Selectors are
  best-effort per publicly known ATS markup conventions, not live-verified.
- **`connect` people-search** — live-verified against a real search (10 real InfoVision
  recruiter/HR results returned with correct profile URLs and headlines).
- **`connect` draft → Telegram-or-fallback approval gate → send** — the approval-gate wording in
  `CLAUDE.md` was reviewed and confirmed unambiguous (no path lets an LLM orchestrator call
  `connect_send` in the same turn as drafting).

## Bugs found and fixed this session (all committed, all re-reviewed clean)

`linkedin-apply.ts`:
1. Stale `ElementHandle` queries crashed on LinkedIn's dynamic Easy Apply modal → converted to
   Playwright's `Locator` API throughout (commit `42b45e8`).
2. `aria-label`-based Next/Review/Submit selectors were obsolete → replaced with
   footer-scoped text matching (commit `599ff47`).
3. No wait after opening the modal/advancing a step before checking for controls → added a
   bounded, auto-retrying wait with graceful timeout fallthrough (commit `417a57a`, tested in
   `32241bb`).

`connect.ts`:
4. Same stale-`ElementHandle` pattern → converted to Locators; `resultCard` selector was
   obsolete (matched 0 of 10 real results) → replaced with `div[role="listitem"]` (commit
   `c690b88`).
5. Profile-link extraction loop read every link in a result card (2–4, varies), including
   irrelevant "mutual connections" avatar links, causing a live timeout → bounded to the 2
   indices actually consumed (commit `386e285`).
6. **Connect isn't a direct button on a profile page** — it's a menu item behind a "More"
   overflow button. The old code assumed a bare "Connect" button existed; live inspection
   showed only "Follow" + "More" at top level (commit `0a83d5d`).
7. Missing wait for the "More" menu to render before checking for "Connect" (commit `79f03c9`).
8. `sendButton`'s aria-label (`"Send invitation"`) differs from its visible text (`"Send"`) —
   the old selector checked visible text and never matched; fixed to aria-label matching, plus
   a missing wait for the post-"Add a note" transition (commit `336dd71`).
9. Playwright's default viewport (1280×720) vs. the 1440×2400 viewport used during live
   verification — applied the larger viewport as a defensible, no-downside fix (commit
   `def0e3b`). **Unconfirmed** whether this was a real contributing cause (see below).

## Still open

- **`connect_send`'s final click intermittently fails** with "Send button not found on connect
  dialog" even after fix #8/#9 above. Direct instrumentation of the real `connectSend()`
  function (headed browser, temporary debug logging, since reverted) showed a run where the
  page displayed **ad-overlay controls** ("Why am I seeing this ad?", "Report this ad") instead
  of the connect dialog, and only 1 "More"-button match instead of the usual 6 — i.e. LinkedIn
  served meaningfully different page content that run. This looks like anti-automation friction
  from the volume of automated interaction against one profile in a single session, not a
  defect in the selectors or control flow (which had already been confirmed correct via manual
  reproduction moments earlier, with an identical result).
  - **Recommendation**: re-verify on a fresh day, ideally against a different profile, with
    natural pacing between attempts (not back-to-back automated runs). If it still fails,
    capture the exact DOM state at the failure point (the debug-logging pattern used this
    session — see git history around commit `def0e3b` for reference, or re-add temporarily) —
    do not guess further from selector strings alone.
- **`external-apply` selectors** (Greenhouse/Lever/Workday/Ashby field maps and submit buttons)
  have never been exercised against a real posting. Expect the same class of drift found in the
  LinkedIn flows — verify before relying on `manual_review` never firing spuriously in
  production.
- **`connect_send`'s `connectButton`/`addNoteButton`/`sendButton` selectors, and
  `linkedin-apply`'s Next/Review/Submit selectors, are inherently fragile** — LinkedIn's DOM has
  no stable public contract. Expect to revisit these selectors periodically as LinkedIn ships
  UI changes; the fix pattern established this session (live headless inspection with
  `secrets/linkedin-{burner,main}-state.json`, ARIA-role or visible-text anchors over class
  names, bounded auto-retrying waits, never fixed sleeps) is the reusable playbook.
