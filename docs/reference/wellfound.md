<!-- Moved verbatim from CLAUDE.md; the rules in CLAUDE.md "Safety" and "Commands" still apply. -->

## Wellfound (LinkedIn and Naukri style platform)

The third platform (commits de47961, 1156848): the `wellfound` MCP (`src/mcp/wellfound.ts`) is built on the same
`src/browserctl` engine, the same Chrome recipe and the same arm-then-commit rules as the Naukri server, with its own
guard classes (`wellfound_send`, `wellfound_apply`), ceilings, halt target and layout vocabulary. EVERYTHING about it is
live-unverified: no URL shape, selector, label, promoted marker or cookie name has been checked against the real site, and
it is covered by unit tests with fakes only (a supervised phase 2 run is where they get checked).

- **Session**: ONE persistent locked headless session on the owner's account, saved login in
  `secrets/wellfound-state.json` (lock `secrets/wellfound.lock`), refreshed with `npm run wellfound:login` (headed real
  Chrome, a manual login, no flag; the setup wizard does not cover it). The saved state is judged by cookie NAME only, a
  name starting `_wellfound` or `_angellist`, a guess that no live login has confirmed; the doctor check
  `wellfound-session` uses the same rule and checks the file mode (600). The session closes after about 10 minutes idle.
- **Tools** (17, see `TOOL_NAMES`): the generic ref tools, `wellfound_screenshot` and `wellfound_click_at` (on by default,
  off only when `WELLFOUND_SCREENSHOT=false`), `wellfound_arm_send` (kinds `role_ask`, `rapport`, `referral_ask`,
  `followup`, `feedback`, only in a thread that already exists server-side and is verified; style, fact and output gates, the
  classifier screen, a message length cap; `wellfound-operator`), `wellfound_arm_apply` (the native Apply with an optional
  note of at most 600 characters, gated like any outbound text; `apply-operator` only, see "Applying"), `wellfound_discover`
  (one NAMED search from `config/wellfound-discovery.json`; the URL is built in code from role, location and remote, never by
  the model; it reads the result cards, reads at most `detail_quota` (cap 10) job pages for cards without a description,
  screens everything and saves the new jobs itself, with `jobs.promoted` set from card badges), `wellfound_manual_job`,
  `wellfound_inbox`, `wellfound_read_thread`, `wellfound_layout` and `wellfound_close`. Paths that end the session or
  change the account (logout, delete or deactivate account) are never opened.
- **Operators**: `wellfound-operator` (tasks `manual_url`, `inbox`, `discover`; never applies, has no
  `wellfound_arm_apply`; answers only simple, scheduling-free questions in an existing thread and escalates salary,
  interview times, personal data, documents and anything else) and the `apply-operator` for applies.
- **No cold messaging**: a message goes out only in a thread a founder or recruiter already started (the same rule as
  Naukri). There is no Wellfound outreach queue and no `new_outreach` or `followups` task.
- **Ceilings** (daily, rolling, in `src/outreach/limits.ts`; defaults in `src/setup/limitsCatalog.ts`):
  `wellfound_apply` (`WELLFOUND_MAX_APPLIES_PER_DAY`, consumed beside the shared `MAX_APPLIES_PER_DAY`),
  `wellfound_message` (`WELLFOUND_MAX_MESSAGES_PER_DAY`) and `wellfound_discover` (`WELLFOUND_MAX_DISCOVER_PER_DAY`).
  Halt target `wellfound` (`halt_flags`); three unconfirmed or failed sends halt it; a block page, bot wall or CAPTCHA
  stops the task and is escalated, never worked around. `JOBBER_DRY_RUN` covers every Wellfound action.
- **Scheduling**: the planner dispatches the `wellfound-operator` only when `secrets/wellfound-state.json` exists (existence
  only is checked, never read) AND `config/wellfound-discovery.json` names a search, so no operator call is wasted before
  the owner has logged in. `discover` is due every `WELLFOUND_DISCOVER_EVERY_HOURS` (default 6) while the `wellfound_discover`
  ceiling has room; `inbox` runs with the other platforms' inbox sweeps (`INBOX_EVERY_MIN`).
- **Pipeline interplay**: a Wellfound job is a normal job (source `wellfound`), is not discover-only, gets email and
  LinkedIn outreach when a contact exists, its `apply_platform` is `wellfound` and `classifyApplyUrl` treats any
  wellfound.com URL as apply-capable (tier `wellfound_agent`); `promoted` listings are ordered first (see P1 and P4).
  The promotion words (`promoted`, `featured`, `sponsored`, `premium`, `hot job`) and the badge selectors are guesses.

- **Apply externally**: `wellfound_resolve_external({job_id})` reads the control's href, else clicks once and reads the popup URL, then routes the job to the generic applier (see "External apply" in `applying.md`). Untested live: the probed pages only had a native Apply.
