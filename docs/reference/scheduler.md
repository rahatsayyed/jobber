<!-- Moved verbatim from CLAUDE.md; the rules in CLAUDE.md "Safety" and "Commands" still apply. -->

## Scheduler

`npm run scheduler -- --daemon` (or `--once`, `--now` (a request for one forced wake, implies `--once`; it only asks the running daemon), `--status`, `--dry-run-plan`) runs outside the
model (`src/scheduler/`). Each wake: read the kill switch and halts, skip quiet hours
(`QUIET_HOURS_START`/`END`, hours in IST, default 1 to 7), take the shared run lock
(`.jobber/`, lock name `run`), plan work from due counts and ceilings
(`planWake`: skip reasons `killed`, `halted`, `quiet_hours`, `ceilings_exhausted`,
`nothing_due`), run the code pass over the script providers, and type the planned steps as work items into the long-lived worker windows (below). Each item is watched through its transcript
against the wall-clock budget only (`RUN_MAX_WALL_SEC` 3600 s by default; `RUN_STALL_SEC` sets the stall limit; tool calls are counted and
reported, never a stop condition, and there is no `RUN_MAX_TOOL_CALLS` or token budget; the transcript path is stored in `scheduler_runs.log_path`, and `npm run status -- runs` prints the runs), then finish the run in the `scheduler_runs` log. A run whose log gets no new bytes for `RUN_STALL_SEC` (default 600, 60..3600) is killed as a network stall: status `failed`, stop reason `stalled`, summary `no output for N s (last event: ...)`; it never sets `usage_backoff`, and the next wake starts after 2 minutes instead of 10 (the drip runs get the status only). A value set outside its range (for example `RUN_MAX_WALL_SEC=24000`) falls back to the default and is warned about at daemon start and by the doctor. Wakes start 10 minutes apart
(`WAKE_INTERVAL_MIN`, the base, moved past quiet hours) while there is work, and the wait grows after empty wakes (below); there is no random burst size: each task's quota is what is due bounded by the room left under its real
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
step counts as proven only when the item's final report lists it. Operator agents and their exact tools:
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
there is work. A due tick types exactly ONE action as ONE work item into the `linkedin` window (trigger `linkedin_drip` in
`scheduler_runs`) that dispatches `linkedin-operator` in DRIP MODE for the one
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

### Adaptive wake delay (`WAKE_IDLE_MAX_MIN`)

Code in `src/scheduler/adaptiveWake.ts`, used by `src/scheduler/driver.ts`; zero LLM, no gate, cap or code pass cadence changes. A wake that ended `ok` and
made no progress is an EMPTY wake. Progress means any of: the final report counts a task `done` or `escalated`, or the row counts of `jobs`,
scored `jobs`, excluded `jobs`, `outreach_queue` or `followups` differ between the start and the end of the wake (so new jobs from the code pass, a
match, a veto, a prepared job or a drafted follow-up all count). When the report is missing or a count query fails the wake counts as progress
(unsure never lengthens the wait). The streak of consecutive empty wakes is stored in `scheduler_state` key `empty_wake_streak`. The wait after a wake
is `10 * 2^streak` minutes, capped by `WAKE_IDLE_MAX_MIN` (default 60, range 10 to 240, read at daemon start; 10 turns it off and keeps the fixed 10
minutes): 10, 20, 40, 60. Quiet-hours push-out is applied on top as before. Skipped wakes (`nothing_due`, ceilings, halts) and failed, killed or
incomplete wakes leave the streak as it is.
The streak resets to 0, and a stretched `next_wake_at` is pulled back to 10 minutes, when: a wake makes progress; the daemon starts; an owner
`/runhunt` wake or a pending manual request starts a wake (the manual and forced wakes never leave a later `next_wake_at` than their own draw); or the
daemon sees the `jobs` row count rise while the streak is above 0 (checked every 30 seconds, for example jobs saved by a drip lane or an import).
Reply and inbox checks are not affected: they run in the mail and LinkedIn drip lanes on `REPLY_CHECK_EVERY_MIN`.

### Windows are the only path (no headless `claude -p`, no flag)

Owner decision 2026-11-06: every model step runs in a regular interactive `claude` window of the tmux session `Jobber`. The old per-lane opt-in flag, the
headless `claude -p` runner (`scripts/run-claude.ts` for the agent), `--resume` continuations, the residual headless session,
the `wake-<id>` / `drip-*` run windows and `RUN_WINDOW_KEEP_MIN` are gone. At scheduler start a one-time cleanup kills leftover `wake-*` / `drip-*` windows.

**Window dispatcher.** `src/scheduler/windowDispatch.ts` (`WindowDispatcher`) hands ONE work item to a long-lived interactive worker window and reports the outcome.
`dispatch({window, lane, trigger, item, promptText, deadlineMs})` refuses (status `unavailable`, with a reason) on the kill switch, a usage backoff, a window that is
missing or not a claude pane and could not be started (`window_unavailable:<why>:<detail>`), or a busy window (per-window lock `win-<window>`); otherwise it writes
`.jobber/work/<runId>.md` (0600, files older than 24 hours are removed), types ONE line with `sendText` (`Work item <runId>: read .jobber/work/<runId>.md and do exactly what it says; do not do anything else`),
tails the window's transcript and returns `{status: ok|failed|stalled|usage_limit|killed|timeout|unavailable, stopReason, summary, toolCalls, tokensApprox}`.
Stall means a tool call is pending and the transcript is quiet for 60 seconds (or `RUN_STALL_SEC` when set) while the pane does not show a busy claude (a permission prompt);
a usage limit is read from an API error entry of the transcript or from the last lines of the pane (`LIMIT_RE`), and the CALLER sets the backoff
(`USAGE_LIMIT_BACKOFF_MIN`); the kill switch sends Escape once; `RUN_MAX_WALL_SEC` is the per-item wall limit (`timeout`). The item is a `scheduler_runs` row (trigger given by
the caller, `log_path` = the transcript). After the caller has reconciled the DB state it calls `finish(runId)`, which removes the work file, types `/clear` (after an Escape when
the turn did not end by itself), and the next dispatch finds the new transcript file by the typed line.

**A window that is missing.** When the window is not there or is not a claude pane, the dispatcher calls `ensureReady` (`src/scheduler/windowReady.ts`): the manager `startWindow`
path (`scripts/claude-window.sh <window> --session-id <uuid>` plus the startup line from `.jobber/handoff.md`), then waits up to 60 seconds for a claude pane. Only a confirmed
claude pane gets text. If that fails, the item is skipped with nothing typed and nothing run elsewhere: `noteWindowUnavailable` writes a handoff entry (`skipped: <item>`,
`window unavailable (...); stays due`) and sends one loud `alerts` notice per hour per window. Every caller treats the item as still due: the mail and LinkedIn drips put the
row or stamps back, the wake item stays due because the plan is DB-driven.

**Mail drip (window `mail`).** Same prompt, claim, reconciliation and quarantine as before: the cold row is claimed (`sending`) before the prompt is typed; a typed item whose row is
still `sending` or `queued` afterwards is quarantined and the owner is told. `usage_limit` sets the backoff and a handoff entry. A dry scheduler never types into a mail window that
started live (`.jobber/window-start/mail.json` records `JOBBER_DRY_RUN` and `SEND_LIMIT_PER_RUN` at window start). `SEND_LIMIT_PER_RUN` of the window is fixed at start from
`EMAIL_MAX_PER_DAY` (`scripts/window-env.ts`); the prompt also carries `DAILY_SEND_LIMIT`. Changing `EMAIL_MAX_PER_DAY` needs a window restart (`npx tsx scripts/manager.ts restart mail`); the doctor warns when the two differ.

**LinkedIn drip (window `linkedin`).** Same as the mail drip pattern. The window's start environment carries the fixed lane marker `JOBBER_RUN_LANE=linkedin_drip` (`config/manager-windows.json`), the only value
`linkedin_arm_send` kind `easy_apply` accepts; every other window has a different marker, so Easy Apply stays closed there. The role file tells the window to call `linkedin_close` after each item.
Start-time values (dry run, Easy Apply switch, daily limits) are recorded in `.jobber/window-start/linkedin.json`; a dry scheduler refuses to type into a window that started live.

**Reply priority (both drip lanes).** `src/scheduler/replyCheck.ts`. Mail: item `reply_check` is picked before any send, at daemon start and every `REPLY_CHECK_EVERY_MIN` (default 60, clamp 10..1440), and on demand before a follow-up (a mailbox check when the last clean one is older than `FOLLOWUP_CHECK_MAX_AGE_MIN`, then a check of the follow-up's Gmail thread). It is ONE work item typed into the long-lived `mail` window (the work file names only `reply-watcher`; see the known weakness in `docs/reference/safety-layers.md`), is not subject to the send window, `EMAIL_MAX_PER_DAY`, the `SEND_LIMIT_PER_RUN=0` brake or send spacing, and follows the kill switch, halts, quiet hours (decision: reply checks follow quiet hours), usage backoff, lock and dry run (decision: a dry run runs no check and posts nothing). After the run, code posts one grouped notice to Telegram `inbox` for new `processed_messages` rows (🔔 `needs you` for test, link, time, salary, documents, references, personal data). A thread-scoped check is stored in `followup_thread_checks`, never in `reply_checks`; the follow-up claim (`claim_followup_for_send`, both modes) additionally needs a clean thread check no older than `FOLLOWUP_CHECK_MAX_AGE_MIN`, on top of every existing precondition. A failed check holds the follow-up for 10 minutes, adds a handoff line and sends the owner at most one notice per hour. LinkedIn: the inbox read is due at daemon start and every `REPLY_CHECK_EVERY_MIN` (an explicit `LINKEDIN_INBOX_MIN_GAP_MIN` still wins), ignores only the 8 to 20 minute spacing (it leaves `linkedin_drip_next_at` and `_last_at` untouched), and announces new threads and queued replies (`linkedinNotice.ts`); escalations announced there are not repeated by the 15-minute digest. **Email auto reply (`EMAIL_AUTO_REPLY=true`, ships false, tier never; owner howto `docs/email-auto-reply.md`).** `triage_replies` stores a deterministic verdict per inbound mail in `processed_messages.auto_class` (`src/outreach/emailReplyClass.ts`, no model: `safe` for plain CTC, notice period, location, relocation, availability and work authorization asks; `record_only` for plain acknowledgements; everything else, and any mail with an owner-only part, a link that asks for action, an attachment, instruction-like text or a sender that bounced or rejected, is `owner`). Right after a reply check, before the notice, `processAutoReplies` (`src/outreach/emailReplies.ts`) looks only at mail not yet announced and, only while the flag is true and `user-data/reply-facts.json` has `"confirmed": true`, builds a reply from templates filled only from that file, runs `checkStyle`, the fact gate (the facts file values are allowed facts for replies only) and the output gate, and stores it as an `approved` row in `email_replies` (`message_id` UNIQUE: one reply per inbound message; at most 3 per Gmail thread). Mail that is not answered gets a 🔔 `needs you` notice that names the reason; unusable facts give one loud notice an hour. Sending is the mail drip lane's new item kind `email_reply`, picked right after `reply_check` and BEFORE cold emails and follow-ups, inside the send window and outside quiet hours, one per mail window item (`mail-operator` REPLY MODE: `db.claim_email_reply_for_send` consumes the shared `send_email` counter in one transaction after re-checking the flag, the job outcome, the sender, the thread (no newer inbound, nothing escalated), a verified recipient and a fresh clean mailbox check; then `gmail.send_email` with `threadId`, plain text, no attachment; then `db.mark_email_reply_sent`). A claim refusal that sees a changed situation cancels the row and tells the owner loudly; a cap or a missing check leaves it approved. A run that ends with the row still `sending` is never re-sent: the owner is told (`alerts`) and repairs it with `npm run email-replies -- resolve <id> sent|cancelled`. A reply waiting for the window or the cap leaves a handoff line. The sent notice (`inbox`, silent) shows the full address, subject, what was answered and the exact text. With the flag off nothing is drafted, claimed or sent. `EMAIL_REPLY_NUDGE=true` (ships false, tier never, `EMAIL_REPLY_NUDGE_DAYS` default 3, clamp 1..30) adds ONE nudge per thread after our own automatic reply and then silence, through the normal follow-up drafter, fact gate and guarded claim (fresh clean mailbox AND thread check, shared counter); `nudgeEligible` in `src/followups.ts` is the only exception to the follow-up block list and lifts it only for a job whose every inbound mail was answered by a sent automatic reply, with no outcome, no bounce, no owner-only mail and no reply to another job from the same address.

**The wake through windows.** `src/scheduler/wakeWindows.ts`. `planWake`, the code pass, the manual-request ingest, the run lock, quiet hours, halts, ceilings, the kill switch, the usage backoff and the dry-run flag stay in
the driver. The planned steps (in `stepOrder`) are grouped by owning window: `sources` (discover_agent), `linkedin` (every LinkedIn step), `boards` (every Naukri and Wellfound step), `pipeline` (sweep, reply check, match, vetoes, contacts,
prepare, follow-up drafts) and `apply`. Code steps (manual, discover_scripts) already ran. Consecutive steps of one window are one item; between two barrier steps (sources, pipeline, apply) the platform steps of
different platforms are independent and one window's steps of that stretch are put together. Items are dispatched one at a time, in order, then `finish()`.

- **Results:** the item's last assistant text is parsed for the final JSON line (`reportFromText`); the steps are proven or unproven (`unprovenSteps`). An item that is not proven is `incomplete`, is never continued (no `--resume`), and its work is due again at the next wake because the plan reads the database. `usage_limit` sets the backoff and stops the rest of the wake; `killed` and quiet hours stop dispatching.
- **A busy window** (for example `linkedin` working a drip item) is waited for up to 10 minutes (`WAKE_WINDOW_WAIT_MS`), then the item is skipped with a handoff entry. A window that cannot be started is skipped as described above. The wake is then `incomplete` and says why in its reason.
- **Records:** one `scheduler_runs` row per typed item (trigger `wake`, window name, `log_path` = the window transcript), and the wake row (trigger `scheduled` or `forced`) carries the aggregate status and the combined `wakes` topic notice.
- **A forced wake** (`/runhunt`, `./run-hunt.sh`, `npm run scheduler -- --once --now`) is a request row (`scheduler_state` key `wake_request`, `src/scheduler/wakeRequest.ts`) that the running daemon takes within its 30 second slice and runs through the same windows; with no daemon running the request is refused ("start the stack with npm run up", exit code 3). The result is stored under `wake_request_result`.
- **Guards in an interactive window:** `.claude/hooks/window-guard.cjs` keeps the kill switch (`kill-switch.cjs`), the tamper denylist (`tamper-guard.cjs`) and the secret-path screens (`SCREENED_TOOLS`, `send_email` attachments). There is no per-item tool list any more; see `docs/reference/safety-layers.md` for what was lost.
- **Unverified live:** real claude windows have never run a tick. Transcript completion detection, the `/clear` re-discovery, the pane text for stall and usage limit, the startup line, `--session-id` and a first positional prompt with the installed `claude`, and the bounded window start. Watch the first ticks (`docs/window-rollout.md`).
