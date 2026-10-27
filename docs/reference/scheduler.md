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
(`LINKEDIN_MAX_INVITES_PER_DAY` default 40, `LINKEDIN_MAX_MESSAGES_PER_DAY` default 100); the old weekly names are gone. The
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
