<!-- Moved verbatim from CLAUDE.md; the rules in CLAUDE.md "Safety" and "Commands" still apply. -->

## Scheduler

`npm run scheduler -- --daemon` (or `--once`, `--now` (one forced wake, implies `--once`), `--status`, `--dry-run-plan`) runs outside the
model (`src/scheduler/`). Each wake: read the kill switch and halts, skip quiet hours
(`QUIET_HOURS_START`/`END`, hours in IST, default 1 to 7), take the shared run lock
(`.jobber/`, lock name `run`), plan work from due counts and ceilings
(`planWake`: skip reasons `killed`, `halted`, `quiet_hours`, `ceilings_exhausted`,
`nothing_due`), launch one bounded `claude` run in a tmux window through
`scripts/run-claude.ts outreach_wake`, poll its stream-json output against the wall-clock and
approximate-token budgets only (`RUN_MAX_WALL_SEC` 3600 s and `RUN_MAX_TOKENS_APPROX` 1000000 by default; tool calls are counted and
reported, never a stop condition, and there is no `RUN_MAX_TOOL_CALLS`; the model run's own turn limit is `max_turns` in the run profile; the stream-json log path is stored in `scheduler_runs.log_path` under `.jobber/runs/`, and `npm run status -- runs` prints tool-call counts per subagent and tool for the latest run), then finish the run in the `scheduler_runs` log. A run whose log gets no new bytes for `RUN_STALL_SEC` (default 600, 60..3600) is killed as a network stall: status `failed`, stop reason `stalled`, summary `no output for N s (last event: ...)`; it never sets `usage_backoff`, and the next wake starts after 2 minutes instead of 10 (the drip runs get the status only). A value set outside its range (for example `RUN_MAX_WALL_SEC=24000`) falls back to the default and is warned about at daemon start and by the doctor. Wakes start a fixed
10 minutes apart (`WAKE_INTERVAL_MIN`, moved past quiet hours); there is no random burst size: each task's quota is what is due bounded by the room left under its real
ceiling (daily caps). A usage-limit hit (the run ends `usage_limit`,
in a wake or a drip run) records `usage_backoff_until` and pauses wakes AND the mail drip lane for
`USAGE_LIMIT_BACKOFF_MIN` (default 300) rather than retrying. In `--daemon` mode the scheduler also runs the mail drip lane
beside the wakes and checks for pending manual requests every 30 seconds (see "Running a wake"). Escalations go to SQLite and
`.jobber/notify.jsonl` (and `JOBBER_NOTIFY_CMD` if set). A wake runs the code pass over the script providers itself, before the `claude` run, and then the
wake session executes the planned steps in order (see "Running a wake"): `source-operator`, the
platform operators `linkedin-operator`, `naukri-operator` and `wellfound-operator`, the pipeline stage and
`apply-operator`, one Agent call each and only for stages with work (a wake has no `mail-operator` step; email
goes out through the drip lane). The sending steps (LinkedIn and Naukri `followups` and `new_outreach`, and `apply`) are the
exception: code splits their quota into chunks of at most `CHUNK_SIZE` (5, a constant in `src/scheduler/plan.ts`, no env key)
and the prompt lists them (`new_outreach quota 12 -> calls of 5, 5, 2`), so the session makes separate sequential Agent calls,
each a fresh subagent context, until the quota is spent or a call reports done 0, stopped, halted or limit reached. A chunked
step counts as proven (continuations) only when every one of its calls returned, or the final report lists it. Operator agents and their exact tools:
`config/worker-tools.json` and `.claude/agents/`. `npm run scheduler:units` writes launchd and
systemd unit files under `.jobber/units` and prints the install commands; it installs nothing.
After a non-killed wake outside quiet hours the scheduler may run the update and backup ticks
(feature-detected, flags above).

Pipeline and limit details that changed with the pacing removal: the LinkedIn ceilings are DAILY, a rolling 24 hours
(`LINKEDIN_MAX_INVITES_PER_DAY` default 25, `LINKEDIN_MAX_MESSAGES_PER_DAY` default 25); the old weekly names are gone. The
pipeline takes every unscored job saved in the last 168 hours (7 days, `PIPELINE_WINDOW_HOURS` in `src/pipelineWork.ts`, a
constant), not 24 hours. A matched job that never got an outreach row is handed back to prepare at most
`PREP_OFFER_LIMIT_APPLY` (12) times when it is apply-capable and `PREP_OFFER_LIMIT` (4) times otherwise; a Naukri job
(tier `naukri_agent`) or Wellfound job (`wellfound_agent`) counts as apply-capable (`src/lib/channels.ts`). The title filter in `config/portals.json` keeps
Software Developer and Web, Product and Founding Engineer titles. `db.list_queued_outreach` has a compact paged form
(`fields: "apply"`, `limit`, `offset`, `only_pending_apply`) that the apply, LinkedIn and Naukri operators use: the full rows
(about 56 KB) were saved to a file the operators could not read, and the full form is for the `mail-operator` only.

All limits are env-configurable: the single catalog is `src/setup/limitsCatalog.ts` (defaults,
ranges, explanations; a test fails on drift), shown by the setup `limits` step. Do not copy the
values into docs.

Rollout (each phase gated on the previous; the owner runs these): Phase 1 "Mac, dry run" (48
hours, covering at least one night, `JOBBER_DRY_RUN=true`, review `dry-run:report`, test the
kill switch first); Phase 2 "Mac, read-only live" (still dry flags, real sessions for reads);
Phase 3 "Mac, canary sends" (`JOBBER_DRY_RUN=false`, temporary low ceilings, supervision);
Phase 4 "Mac, autonomous" (ceilings raised one at a time, 5+ days unattended); Phase 5 "VPS
cutover" (re-check Naukri headless from that IP, recreate sessions, repeat phases 1 and 2
briefly: 24 hours dry, a day read-only). Plan:
`docs/superpowers/plans/2026-10-14-6d-scheduler-agents-naukri.md`.

**LinkedIn traffic limits (human-like pacing).** LinkedIn warned the owner about high-volume data access and expired the
session, so LinkedIn work is shaped like a person's day. (1) `LINKEDIN_ACTIVE_HOURS` (default `09:30-20:30`, IST, `HH:MM-HH:MM`,
start before end; an invalid value falls back to the default and the doctor warns): outside it `planWake` gets
`linkedinActive: false` (computed by the driver, `src/linkedin/activeHours.ts`) and plans NO LinkedIn task (inbox, discover,
accept checks, follow-ups, new outreach and manual pages included; Naukri and Wellfound are unaffected), and every `linkedin`
MCP tool except `linkedin_limits`, `linkedin_layout`, `linkedin_close` and `linkedin_find_profiles` (which skips only its
LinkedIn layer) answers `rate_limited` / `outside_active_hours` without opening anything. (2) The LinkedIn messaging page
(`inbox`; with the drip lane on it is a lane item, see below) is read at most every 60 minutes (`LINKEDIN_INBOX_MIN_GAP_MIN`, a floor under `INBOX_EVERY_MIN`, using the
`inbox_last_checked_at` timestamp). (3) Acceptance detection is one page a day: the `accept_recent` task (at most once per 24 hours,
`scheduler_state` key `linkedin_accept_recent_last_at`, only while a sent invite is open) calls `linkedin_check_accepted_recent`;
the per-profile `accept_check` is only the fallback (3 profiles per wake, invites older than 3 days, each profile once per 72 hours,
14 day window). (4) A random 4 to 9 second pause (`LINKEDIN_NAV_GAP_MIN_SEC` / `LINKEDIN_NAV_GAP_MAX_SEC`, `0`/`0` off) precedes every
page navigation to linkedin.com after the first of a process (`src/linkedin/navGap.ts`, shared by the runtime and the engine;
clicks on the same page are not delayed). Shipped defaults were lowered: invites 25, messages 25, profile views 40,
`MAX_LINKEDIN_SEARCHES_PER_DAY` 10, `LINKEDIN_MAX_DISCOVER_PER_DAY` 6, `COMPANY_CONTACT_LIMIT` 2.

**The LinkedIn drip lane** (`src/scheduler/linkedinDrip.ts`). A wake used to send 5 to 9 invites and several DMs within minutes, which drew a
LinkedIn warning and repeated logouts. Now LinkedIn work is one slow action at a time, in the scheduler daemon only (never `--once` or
`--now`), under its own lock (name `linkedin`) so a long wake never pauses it. `LINKEDIN_DRIP` (default `true`) switches it; `false` gives the
LinkedIn tasks back to the wakes (today's burst behaviour). While it is on, `planWake` (`linkedinDrip: true`) plans NO LinkedIn `inbox`,
`accept_recent`, `accept_check`, `followups` or `new_outreach` (and the pipeline no longer pulls `new_outreach` in); wakes keep the LinkedIn
`manual_url` and `discover` tasks, the pipeline and apply (a drip tick waits while a wake with a `linkedin-operator` step runs, so there is never a
second LinkedIn session). Every 30 seconds a tick runs in code with zero LLM calls and does nothing unless: no kill switch and no `all` or `linkedin`
halt, outside quiet hours AND inside `LINKEDIN_ACTIVE_HOURS`, no usage backoff, the stored next-tick time (`linkedin_drip_next_at` in
`scheduler_state`) and the minimum gap since the last action have passed, the configuration is sane (an invalid `LINKEDIN_DRIP*` /
`LINKEDIN_INBOX_MIN_GAP_MIN` value is the default AND stops the lane with `bad_config`; the doctor check `linkedin-drip-config` says which key), and
there is work. A due tick runs exactly ONE action as ONE tiny restricted `claude` run (profile `linkedin_drip`, trigger `linkedin_drip` in
`scheduler_runs`, only the `linkedin-operator` tools, an allowlisted env with no secrets) that dispatches `linkedin-operator` in DRIP MODE for the one
item code chose; afterwards the next tick is pushed out by a random `LINKEDIN_DRIP_MIN_GAP_MIN` to `LINKEDIN_DRIP_MAX_GAP_MIN` minutes (defaults 8 and 20).
An item a run already tried is not offered again for 3 hours (6 for the accept check), so a failing item never becomes a loop.
Priority, one item per tick, chosen in code: (a) **replies first**: an `inbox` read when none was done in the last `LINKEDIN_INBOX_MIN_GAP_MIN`
minutes (60; `linkedin_inbox_last_at`); (b) an **owner-approved reply** (below); (c) the **accept check**: `accept_recent` (one page, once per 24 hours)
then the capped per-profile `accept_check` (one profile per tick); (d) a **DM** to a newly connected person (`role_ask`, `rapport`), then the other due
follow-ups, in the order `dueTouchesFor` returns them; (e) a **new invite** (`connect_note` or `connect_plain`) for the next queued contact (one person per
company, the per-company contact limit and the profile-view ceiling apply). The run prompt names exactly that item (`Drip item: ...`); the operator never
picks. Daily caps, the profile-view ceiling, halts, kill switch, dry run, arm-then-commit, recipient verification and the output and fact gates are
unchanged. **Unanswered messages pause a person.** A person with an inbound message the owner has not dealt with (an open escalation on their thread,
or an inbound row never escalated, noise excepted) gets no DM, follow-up or invite from any pick until the escalation is resolved; only the approved
reply to that very message may go. `npm run status -- working` and `limits` show the lane (next tick, last action, what is waiting, drafts waiting for
approval); `npm run scheduler -- --status` prints `next linkedin drip not before`.

**Window dispatcher (used by the `mail` lane only, when `WINDOW_LANES` lists it; see "Mail lane through the `mail` window" below).** `src/scheduler/windowDispatch.ts` (`WindowDispatcher`) hands ONE work item to a long-lived interactive worker window and reports the outcome. `dispatch({window, lane, trigger, item, promptText, deadlineMs})` refuses (status `unavailable`, with a reason) on the kill switch, a usage backoff, a missing window, a pane that is not claude, or a busy window (per-window lock `win-<window>`); otherwise it writes `.jobber/work/<runId>.md` (0600, files older than 24 hours are removed), types ONE line with `sendText` (`Work item <runId>: read .jobber/work/<runId>.md and do exactly what it says; do not do anything else`), tails the window's transcript and returns `{status: ok|failed|stalled|usage_limit|killed|timeout|unavailable, stopReason, summary, toolCalls, tokensApprox}`. Stall means a tool call is pending and the transcript is quiet for 60 seconds while the pane does not show a busy claude; a usage limit is read from an API error entry of the transcript or from the last lines of the pane (`LIMIT_RE`), and the CALLER sets the backoff; the kill switch sends Escape once. The run is a `scheduler_runs` row (trigger given by the caller, `log_path` = the transcript). After the caller has reconciled the DB state it calls `finish(runId)`, which removes the work file, types `/clear` (after an Escape when the turn did not end by itself), and the next dispatch finds the new transcript file by the typed line. The feature flag `WINDOW_LANES` (comma list of lane names, default empty, read by `src/scheduler/windowLanes.ts`, restart the scheduler after a change) decides which lanes use a window: a lane stays on the old headless path until the owner lists it (today only `mail` is wired). The doctor check `window-foundation` lists what is still unverified against the installed claude: `--session-id` in an interactive session and a first positional prompt (the startup line is typed instead), plus the pane text the stall check relies on (`esc to interrupt`).

### Mail lane through the `mail` window (Phase 3a, optional, off by default)

The mail drip lane can hand each email to the long-lived `mail` claude window instead of a headless `mail_drip` run. Nothing changes until you opt in.

- **Enable:** add `mail` to `WINDOW_LANES` in `.env` (for example `WINDOW_LANES=mail`), restart the scheduler daemon, then run `npm run up` (it starts the `mail` window from `config/manager-windows.json`; while the lane is not listed `up` skips that window). The window reads its role from `config/windows/mail.md`.
- **Roll back:** remove `mail` from `WINDOW_LANES` and restart the scheduler. The headless path is the default again; the window can stay idle or be stopped with `npm run down`.
- **What stays in code, before any text is typed:** the kill switch, quiet hours, the send window, spacing, the daily cap, the usage backoff, the `SEND_LIMIT_PER_RUN=0` brake, item choice, the cold-row claim, quarantine and the reply-check line. `runOne` builds the SAME prompt as the headless path (`buildDripPrompt`) and passes it to `WindowDispatcher.dispatch` (window `mail`, lane `mail`, trigger `mail_drip`, deadline `RUN_MAX_WALL_SEC`); after the DB is reconciled it always calls `finish()` (the `/clear`). The `scheduler_runs` row is the dispatcher's (its id differs from the `run_id` inside the prompt).
- **Results:** `ok` and every typed failure (`failed`, `stalled`, `timeout`, `killed`) go through the same reconciliation as a headless run: a cold row still `sending` or `queued` is quarantined and the owner is told. `usage_limit` also sets `usage_backoff_until` and writes a handoff entry for the item (`.jobber/handoff.md`). `window_busy` and the other refusals (`killed`, `usage_backoff`, send failure) send nothing: the claimed row goes back to `queued`, the item is not marked as tried and the tick stops. A missing window or a pane that is not claude (nothing typed) falls back to the headless path for that item and warns once.
- **Fixed at window start:** the window's `SEND_LIMIT_PER_RUN` (read by `claim_followup_for_send`) is derived from `EMAIL_MAX_PER_DAY` (or 100000 when 0 or unset) by `scripts/window-env.ts`. Changing `EMAIL_MAX_PER_DAY` needs a window restart (`npx tsx scripts/manager.ts restart mail`); the doctor check `window-foundation` warns when the recorded start value (`.jobber/window-start/mail.json`) differs. The per-item `DAILY_SEND_LIMIT` line in the prompt is always current, and the code gate also enforces `EMAIL_MAX_PER_DAY`.
- **Guards in an interactive window:** the `mail_drip` profile's `screen_args` live only in the headless hook. The Gmail MCP is an external package with no argument checks of its own, so the `send_email` screen (attachments only a rendered resume PDF, no secret-shaped path in any argument) is ported into `.claude/hooks/window-guard.cjs` (shared function `screenSendEmail` from `tool-allowlist.cjs`) and applies in every worker window. The Gmail search sender allowlist belongs to the site-mail profile, not to `mail_drip`, so it is not needed here. The window's main thread has `full` tools: the role file only instructs; the hooks, the tool list of `.claude/agents/mail-operator.md` (it still bounds the subagent; the `agents-worker-tools` doctor check keeps it equal to `config/worker-tools.json`) and the db tool checks enforce.
- **Unverified live:** transcript completion detection, the `/clear` re-discovery, the pane text for stall and usage limit, and the startup line with the installed `claude`. Run one item in dry run first (`JOBBER_DRY_RUN=true`) and watch the window.
