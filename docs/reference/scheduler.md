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
reported, never a stop condition, and there is no `RUN_MAX_TOOL_CALLS`; the model run's own turn limit is `max_turns` in the run profile; the stream-json log path is stored in `scheduler_runs.log_path` under `.jobber/runs/`, and `npm run status -- runs` prints tool-call counts per subagent and tool for the latest run), then finish the run in the `scheduler_runs` log. Wakes start a fixed
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
