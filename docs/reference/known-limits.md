<!-- Moved verbatim from CLAUDE.md; the rules in CLAUDE.md "Safety" and "Commands" still apply. -->

## Known limits and not yet live-verified

- Nothing in the browser apply, scout, generated-provider and search-layer work (plan 8G) has run
  against a real ATS, job site, search engine, Serper or mail verification; it is covered by unit tests
  with fakes and invented fixture pages. The terms of use of the search engine the browser dork uses
  are unreviewed.
- Nothing in the platform and outreach work (plans 6A to 7D and the browserctl rebuild) has run against real
  Naukri, Wellfound, Google OIDC sign-in, a downloaded classifier model, real tmux/ccgram wiring, a real
  backup (`age`, `rclone`) or a real update; it is covered by unit tests with fakes. The one exception is the LinkedIn
  connect path, which is partly live-verified (next bullet). The `linkedin` tools have a canary seed script
  (`npm run linkedin:seed`) for the first supervised send; check that it still matches the arm-then-commit flow before
  using it. No unattended mileage.
- LinkedIn connect, what is and is not live-verified (see "Connecting"). Verified live: top-card detection on several
  profiles, the More menu rows, the invite dialog opening with refs, note typing, the name read of a plain-invite dialog,
  and one real note invite through Send with the Pending confirmation (touch `sent`, `connections` row, ceiling counted,
  visible on the Sent invitations page). NOT verified: the Premium upsell modal structure (`custom_note_limit_reached`),
  a "Send without a note" click through to a confirmed send (`connect_plain`), the wording that gives
  `invite_limit_reached`, Naukri and Wellfound dialog work, and LinkedIn messages after an accept. A LinkedIn thread page
  opened headless can show "this conversation failed to load" (an unpadded thread id does that; the Inbox link now restores
  the padding, but the headless thread read is not verified).
- The classifier is wired through `screenUntrusted` on every surface in `SCREENED_SURFACES` and
  fails closed in live mode (see "Outreach safety layers", layer 4), but no downloaded model has
  run against real LinkedIn, Naukri or Wellfound text, its first-call latency inside a tool timeout is
  unmeasured (`npm run classifier:bench`), and the default profile is English-only. Until the owner
  has fetched, pinned and fitted a model and set `CLASSIFIER_MODEL`, live reads and sends are
  refused by design; `npm run doctor` check `classifier_wired` verifies that every surface calls
  the screen and that the profile is pinned and fitted (a warn while `JOBBER_DRY_RUN` is dry, i.e. not
  `false`, a fail when it is) and runs a smoke screen.
- The browserctl engine (`src/browserctl`: snapshot walker, semantic guard, arm and commit path, the
  screenshot and click_at tools) is covered by hermetic tests with fake pages, plus the LinkedIn profile and invite
  checks listed above; no live Naukri, Wellfound or scout page has been snapshotted, and no live Naukri or Wellfound
  commit has ever run: their arm, type and Send paths were never exercised against a real page. The screenshot tools are on by default. The data tools' extraction selectors, Naukri limits and the scheduler's real-claude behaviour
  (hook propagation into subagents, `--setting-sources project`, `--permission-prompts`,
  hook `onFailure: block`) are unverified until rollout phase 2 and the plan 6B owner checks.
- Autonomous email follow-ups (rule 10 in "Safety") are built behind `FOLLOWUPS_AUTONOMOUS`,
  which ships `false`; nothing in the autonomous path has run against real Gmail, and a follow-up
  raises deliverability risk, so the daily `send_email` limit stays the ceiling (`EMAIL_MAX_PER_DAY` in the
  drip lane, `SEND_LIMIT_PER_RUN` for `/followups`). They run from the mail drip lane (one follow-up per run) and from
  `mail-operator`'s follow-up pass in `/followups`. LinkedIn and Naukri follow-ups
  run from the scheduler (the operators' `followups` task) under the cadence and ceilings in code.
- Not live-verified, all covered by unit tests with fakes only: the whole Wellfound platform (the MCP, URL shapes,
  selectors, labels, the saved-login cookie name, the arm and commit paths, the planner gating, apply; see "Wellfound");
  the three `manual_job` tools and the title and company parsing of a LinkedIn, Naukri or Wellfound job page; the promoted
  markers on Naukri and Wellfound (the badge words and selectors are guesses); the LinkedIn hiring-post permalink and card
  shapes (`src/linkedin/postExtract.ts`) and the poster profile headline and Experience parsing
  (`src/linkedin/profileCompany.ts`) behind `db.update_job_company`; the mail drip lane against real Gmail (including how
  a drip run ends when `gmail.send_email` succeeds but the record call does not: that row is quarantined, never retried);
  the dashboard Apply box in a browser; and `/apply <url>` under the `read_only` permission set (whether the command's
  `allowed-tools` rule is honoured there).
- Apply: at the last owner check 19 apply rows sat in `manual_review` (the Apply click was armed but never confirmed; a figure from the owner's database, not from code). They are not retried
  automatically; see "Operations". The Wellfound apply confirmation is unverified. The generic ATS applier runs with
  `APPLY_SUBMIT_MODE=hold` (the shipped value), so it stops at the review step and reports `held` until the owner sets
  `submit`.
- Job supply: only 4 company boards are enabled in `config/portals.json` (GitLab, Razorpay, Meesho, Linear); add more under
  `tracked_companies` and check each slug with `npx tsx scripts/check-portal.ts`. The imported feeds in
  `config/platforms.json` ship disabled until the owner has read each feed's terms of use.
- Email follow-ups run in legacy mode by default (`FOLLOWUPS_AUTONOMOUS=false`, the shipped value), so each follow-up needs Telegram approval in
  `/followups` before the drip lane sends it.
- LinkedIn inbound replies are read and recorded or escalated only; there are no typed LinkedIn
  inbox tools yet. Email replies and Naukri threads are handled as described above.
- Model-bound third-party text that is NOT classifier-screened: board, Hacker News and other
  script-provider job text, Gmail reply bodies read by `reply-watcher`, the text of a verification mail
  passed to `site_open_link` (it is not in `SCREENED_SURFACES`; host and path rules in code apply),
  and the `linkedin_screenshot`, `naukri_screenshot`, `wellfound_screenshot` and `scout_screenshot` pixels (applier screenshots too when `APPLY_SCREENSHOT` is on, which ships off; the other four tools are on by default). The launcher and doctor classifier
  readiness cover only the screened surfaces in `SCREENED_SURFACES`.
- Bring-up (plan 8E) is covered by hermetic tests with fakes only. The live checks L1 to L9 are
  defined in `docs/superpowers/plans/2026-10-15-8e-bootstrap-guided-setup-run-all.md` ("Owner-only
  live checks"). Unverified: interactive `claude` under the restricted launcher and its flags
  (U2, until L3); whether Claude's `Bash(<exact>)` rules match strings containing ` -- ` (U3,
  until L3); whether a blocked `UserPromptSubmit` prompt also leaves the model context and
  transcript (U4, until L3); tmux window environment inheritance (U7, until L9 and L8);
  single-instance scheduler and SIGINT behaviour (U9, until L8). Check upstream, no live check:
  the Claude Code CLI install method and flags (U1), Homebrew and apt package names (U5),
  Linux Node, uv and Chrome installer URLs (U6); L1 and L2
  exercise the install paths only loosely. How ccgram binds the `manager` window (U8) is owner
  decision O5 in plan 8E. The `better-sqlite3` native build toolchain (U12) is surfaced by the
  `build-tools` item and `npm ci` output. The dry-run dashboard stage runs the token login for real (plan 8C merged; it skips only on a 404 auth mode route). No browser download is needed (U13 is closed): every browser runs on the installed Google Chrome.
- Plan 8F setup text is unverified until the owner live checks: BotFather's Threaded Mode / Topics
  label and path, Mini App versus `/mybots` (unverified until owner live check L1); whether `getMe`
  returns the topics field the step reads (`has_topics_enabled`, one constant in
  `src/setup/steps/telegram.ts`; absence never fails; unverified until L1); whether ccgram needs
  topics in a private chat or a forum supergroup (unverified until L1 and upstream docs); the
  Serper and Hunter verification endpoints, their credit cost and limits (unverified until
  L7; a rejection offers keep-anyway); hidden `askSecret` input in a real terminal (unverified
  until L1); that a skipped Telegram is safe for every consumer of `TELEGRAM_BOT_TOKEN`
  (`src/platform/notify.ts`, `run.sh`, `claude-session.sh`, `start.sh`; traced by reading,
  unverified until L2); Hunter's account-endpoint credit use (unverified until L7).

Test baseline: `npx tsc -p . --noEmit` is clean and `npx vitest run` has 0 known failures in the main checkout. One
exception that is not a defect: `tests/bootstrap-sh.test.ts` ("Node present") can fail when the suite is run from a linked
worktree path (it is known to pass in the main checkout; one run of the docs task from a worktree passed it too). The
resume PDF tests (`tests/renderChecked.test.ts`, `tests/resume.test.ts`) render real PDFs through
headless installed Google Chrome (`src/pdfRender.ts`, the shared launcher; `renderer/index.js`
only writes the HTML), so they need Chrome on the machine; there is no Playwright download. The
render tests use a full-page synthetic fixture (`tests/fixtures/render/`) because the shipped example
resume is far shorter than a page. The list of known failures, mirrored in
`config/update-known-failures.json` (`{}`), is used by the auto-update test gate; update both
together if one ever appears.

- External resolve: Naukri path proven by probe structure (a plain button with `company-site` in its class, no href) but never run live; Wellfound and LinkedIn untested live (no external-apply example page was found); the popup wait, pacing and unknown-host outcomes are unmeasured.
