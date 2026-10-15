# Operations

Audience: owner
Last verified against: <fill at merge>
Source files: scripts/jobber-control.ts, src/scheduler/control.ts, .claude/hooks/kill-switch.cjs, run-hunt.sh, scripts/linkedin-clear-halt.ts, scripts/layout.ts, src/safety/dryRun.ts, scripts/dry-run-report.ts, scripts/status.ts, src/status/render.ts, src/scheduler/plan.ts, src/scheduler/runLog.ts, src/scheduler/notify.ts, src/scheduler/launch.ts, scripts/stack.ts, src/stack/up.ts, src/stack/down.ts, src/verify/cli.ts, src/platform/checksSetup.ts, src/platform/checksLayout.ts, src/platform/checksScheduler.ts

Day-to-day running of Jobber: stop it, resume it, read its state, find its files, fix common failures.
Safety rules are not restated here; they live in `CLAUDE.md` under "Safety" and "Outreach safety layers". Read layer 6 there for the full kill switch scope.

## Emergency stop in 20 seconds

```bash
npm run jobber:control -- stop "why you stopped it"
```

Writes `.jobber/STOP` (reason and timestamp) and records an active halt for `all`, `linkedin` and `naukri` in the database. A halt that was already active is kept and printed as `kept existing <platform> halt`.

```bash
npm run jobber:control -- status
```

Prints `killed`, the reason, the `linkedin halt` and `naukri halt` lines and which platforms are `allowed`.

What stops:

- The scheduler: the next wake sees the kill switch and skips (reason `killed`); a running wake window is killed within one poll.
- Every tool call in restricted runs, and the irreversible tools (Gmail send, `apply.*`, typed LinkedIn and Naukri sends) in any session in this project, through `.claude/hooks/kill-switch.cjs`.
- `./run-hunt.sh` and the launcher refuse to start and exit with code 4 (stderr: `kill switch active, not starting`).
- `npm run up` refuses to start the stack and exits with code 4.
- `JOBBER_KILL=1` in the process environment has the same effect as the STOP file for the hook and the launcher. The hook reads only the process environment (`.claude/hooks/kill-switch.cjs`), not `.env`.

What does not stop (restated from `CLAUDE.md`, "Outreach safety layers" layer 6, "Not covered"):

- A tool call that is already executing when STOP is written finishes.
- Hook propagation into subagents is unverified in real `claude`.
- Interactive sessions started outside this project directory.
- Sends done through Bash.
- `halt_flags` rows are not read by the hook (the typed tools read them).
- The Gmail dry run covers only JOBBER_DRY_RUN set to 1.

If the model is mid-run and you need it gone now, also stop the tmux windows: `npm run down` (see "Bring the stack up and down" below).

## Resume and clear halts

Never hand-edit SQLite. Pick the command by what set the halt.

| What you see | Who set it | Clear with |
|---|---|---|
| `STOP file` or `jobber-control stop: ...` halts | You, via `jobber:control stop` | `npm run jobber:control -- resume` |
| `layout_drift:<kind>` on a platform | Layout memory (needs `LAYOUT_ENFORCE=enforce` to halt) | `npm run layout -- clear-halt <platform>` |
| LinkedIn checkpoint, CAPTCHA or restriction halt | The LinkedIn typed tools | `npm run linkedin:clear-halt -- --yes` (see the warning below it) |
| Naukri consecutive send failures | The Naukri send path | No supported command clears it. Read the reason with `npm run jobber:control -- status`, fix the cause (usually the Naukri session, see `docs/naukri-session-setup.md`), then decide yourself how to proceed. Only the jobber-control, layout and LinkedIn scripts call the halt-clearing code, and none of them applies to a Naukri halt. Do not hand-edit SQLite |
| `JOBBER_KILL=1` | The shell or `.env` | Unset it where it is set; `resume` only prints a note |

```bash
npm run jobber:control -- resume
```

Removes the STOP file unconditionally and clears only halts whose reason starts with the stop prefix this CLI writes (`jobber-control stop: `). Anything else is printed as `still halted <platform>: <reason>` and stays. Note that `stop` over a halt that is already active keeps that halt as it was (`kept existing <platform> halt`), so `resume` cannot remove it either; clear it with the command for what set it.

```bash
npm run layout -- status
npm run layout -- clear-halt linkedin
```

`clear-halt` clears only a layout drift halt, asks for confirmation (add `--yes` to skip), resets the drift streak of the kind that caused it, and refuses with exit code 1 when the halt is not a layout one or comes from the global `all` halt. For the global one use `resume`. See [layout memory](layout-memory.md) and `CLAUDE.md` "Layout memory and platform operators" for what drift means and the supervised relearn steps.

```bash
npm run linkedin:clear-halt
```

Prints the current LinkedIn halt and exits with code 1 unless you add `-- --yes`. It does not clear the global `all` halt. With `--yes` it clears any LinkedIn halt row, including one written by `jobber:control stop` and a `layout_drift:*` halt. For a layout drift halt do not use it: it does not reset the drift streak, so the next dead page can re-halt at once. Use `npm run layout -- clear-halt linkedin` for those.

Only the owner clears halts. Do not flip a dry-run flag or clear a halt from inside an agent session.

## Dry run

Three flags decide whether an action is performed or only recorded. Any one of them wins (rule in `src/safety/dryRun.ts`, `isDryRun`; `CLAUDE.md` Safety rule 15):

| Flag | Dry when |
|---|---|
| JOBBER_DRY_RUN | exactly `1` |
| `SCHEDULER_DRY_RUN` | anything except exactly `false` (unset is dry) |
| `LINKEDIN_DRY_RUN` | anything except exactly `false`, checked for LinkedIn paths only |

Live needs JOBBER_DRY_RUN not `1`, `SCHEDULER_DRY_RUN=false`, and for LinkedIn `LINKEDIN_DRY_RUN=false`. Only the Gmail send hook looks at JOBBER_DRY_RUN set to 1; see "What does not stop" above.

To tell whether the stack is dry:

```bash
npm run up -- --status
```

Read-only. The banner printed at the top and bottom is `MODE: DRY RUN` or `MODE: LIVE`, taken from `.env`, plus a `JOBBER_KILL=` line and a warning if your shell environment diverges from `.env`.

```bash
npm run dry-run:report
npm run dry-run:report -- --limit 50
```

Read-only. Lists the recorded `dry_run_actions` (redacted and clamped payloads); `--limit` takes an integer from 1 to 500, anything else falls back to the default. Exits with code 1 and a one-line error if the database does not exist.

```bash
npm run dry-run
```

End-to-end smoke test in dry mode against fixtures and a temporary database. Writes `.jobber/verify.json`. Options: `--llm` (also runs a real hunt stage; refused unless `.env` itself is dry), `--skip <id>[,<id>]`, `--json`, `--list`, `--help`. Exit codes: 0 pass, 1 a stage failed, 2 usage error. Unverified: hermetic tests with fakes only; the live checks are owner-only (see `CLAUDE.md` "Known limits").

## Bring the stack up and down

```bash
npm run up
```

Order: kill-switch check, doctor gate, then bridge, windows, scheduler and dashboard. Exit codes:

| Code | Meaning |
|---|---|
| 0 | Started (or `--status` printed) |
| 1 | Doctor has failures (nothing started), or a start failed (full table is printed first) |
| 2 | Usage error (unknown argument) |
| 4 | Kill switch is on; run `npm run jobber:control -- resume` when you are sure |

Features you skipped in setup print as `bridge: skipped (setup)`, `windows: skipped (setup)` or `web: skipped (setup)`.

```bash
npm run down
npm run down -- --keep-bridge
npm run down -- --force --yes
```

Stops the windows and scheduler this stack started. A scheduler that belongs to a launchd or systemd unit is not stopped here; the command prints the unload or disable line to run yourself. Without `--force` a scheduler finishing a wake is left to finish: re-run `npm run down`. It asks before stopping the `hunt` and `followups` windows; without a terminal they are left running unless you pass `--yes`. It does not touch the scheduler's wake session (`jobber-runs`; the STOP file is what kills a wake window), and it does not stop a hunt you started from a shell with `./run-hunt.sh`. Exit codes: 0 ok, 1 a stop failed, 2 usage error (unknown flag).

## Scheduler skip reasons

Each wake either runs or is skipped with one reason (`planWake` in `src/scheduler/plan.ts`). The result is stored in `scheduler_runs`.

| Reason | Meaning | What to do |
|---|---|---|
| `killed` | STOP file, `JOBBER_KILL=1`, a global `all` halt, or the control state could not be read (fails closed) | `npm run jobber:control -- status`, then `resume` if it is yours |
| `halted` | Every platform has an active halt | Read the detail, clear per "Resume and clear halts" |
| `quiet_hours` | Inside `QUIET_HOURS_START` to `QUIET_HOURS_END` (hours in IST) | Nothing; it wakes after the window |
| `ceilings_exhausted` | Work exists but every relevant rolling ceiling is full | `npm run status -- limits`; wait, or raise a ceiling deliberately (catalog: `src/setup/limitsCatalog.ts`) |
| `nothing_due` | No follow-ups, outreach, inbox check or search is due | Nothing |

A wake that runs ends in one of these run statuses (`src/scheduler/runLog.ts`): `planned`, `running`, `ok`, `budget_exceeded`, `killed`, `failed`, `crashed`, `usage_limit`, `skipped`. `usage_limit` means the subscription limit was hit and the scheduler pauses for `USAGE_LIMIT_BACKOFF_MIN` minutes instead of retrying. Leftover `running` rows from a crashed process become status `crashed` with `stop_reason` `orphaned` on the next start.

```bash
npm run scheduler -- --status
```

Prints the scheduler state without launching a wake (see also `--once` and `--dry-run-plan`).

## Reading limits, working and health

All three read the database read-only and print "no database yet" when there is none. They are also the Telegram commands `/limits`, `/working`, `/health`.

```bash
npm run status -- limits
```

Output lines, in order:

- One line per rolling ceiling: `linkedin_invite`, `linkedin_message` (per week), `naukri_apply`, `naukri_message` (per day), as `used/limit per <period>`, with `FULL` appended when it is exhausted.
- One line per daily counter, as `<key> <count> today` (for example the email send counter).
- Halt lines: `HALT <platform>: <reason> (since <time> IST)`, or `no halts`.
- `degraded: ...` when part of the snapshot could not be read.

```bash
npm run status -- working
```

Output lines: `queue <status>: <count>` per outreach queue status (or `queue: empty`), `last send: <kind> <time> IST` (or `no sends yet`), the funnel line `discovered N -> matched N -> contacted N -> replied N -> interview N -> offer N`, and `degraded:` if any.

```bash
npm run status -- health
```

Output lines: one `window <name>: <command>` per tmux window in the session named by `WEB_TMUX_SESSION` (default `ccgram`), or `tmux: no windows`; the halt lines; `degraded:`; then a reminder to run `npm run doctor`.

Other forms: `npm run status -- json` (the full snapshot) and `npm run status -- layout` (layout memory summary per platform; works without a database).

```bash
npm run doctor
```

Prints ok, warn, fail or skip per check with a fix line. A feature you skipped in setup shows as `skip` and the last line reads `Skipped by choice: ...`; the fix is `npm run setup -- --step <id>`. Safety checks (classifier, permission set, hooks, limits, kill switch, halts) are never skipped.

## Where logs and state live

Paths marked git-ignored are never committed. Do not read or paste the contents of `secrets/`, `user-data/` or `.env` into a chat.

| Path | Written by | Safe to delete? |
|---|---|---|
| `data.sqlite` (location set by the db path module `src/dbPath.ts`) | Every db tool, the scheduler, the hunt | No. Back up first (`docs/backup-and-restore.md`) |
| `.jobber/STOP` | `npm run jobber:control -- stop` | Only through `resume` |
| `.jobber/notify.jsonl` | Scheduler and layout notifier (`src/scheduler/notify.ts`); one JSON line per notice with `ts`, `level`, `title`, optional `detail` and `run_id` | Yes (history only) |
| `JOBBER_NOTIFY_CMD` | Optional command the notifier runs with the notice title as its only argument; never receives the detail | Not a file; unset to stop |
| `.jobber/runs/<run id>.log` | The scheduler's wake window output (`src/scheduler/launch.ts`); path also stored in `scheduler_runs.log_path` | Yes, old ones |
| `.jobber/runs/<run id>.prompt.txt` | The prompt handed to that wake's `claude` run (`src/scheduler/launch.ts`) | Yes, old ones |
| `scheduler_runs` table | `src/scheduler/runLog.ts` | No (it is in the database) |
| `.jobber/units/` | `npm run scheduler:units` (unit files only, never installs) | Yes, regenerate |
| `.jobber/logs/` | The log directory written into the generated unit files | Yes, old ones |
| `.jobber/layout/<platform>.json` | Layout memory observer (`src/layout/`); ids from a closed vocabulary only | Use `npm run layout -- reset`, not `rm` |
| `.jobber/verify.json` | `npm run dry-run` (mode 600, no details) | Yes |
| `.jobber/bootstrap.json` | `bash scripts/bootstrap.sh` | Yes |
| `dry_run_actions` table | `src/safety/dryRun.ts`, read by `npm run dry-run:report` | No (it is in the database) |
| `reports/funnel-<date>.html` | `npm run report` (git-ignored) | Yes |
| `.claude/settings.local.json` | `npm run permissions` | No; regenerate with `npm run permissions -- --status` first |
| `secrets/` | Session capture scripts and OAuth setup | No, you would have to log in again |

Hunt output: `./run-hunt.sh` does not redirect to a log file itself; it execs the launcher with the `hunt` profile and the output goes to the terminal or whatever redirect your cron line adds. Unverified: no dedicated hunt log path exists in the code.

## Daily and weekly routine

Daily, about 10 minutes:

1. `npm run status -- health` and `npm run status -- working`: any `HALT` line, `degraded`, an unexpected queue backlog.
2. `npm run status -- limits`: anything `FULL` that you did not expect.
3. `npm run doctor`: no `fail`; read each `warn`.
4. `/checkreplies` (Telegram) and approve or skip the proposals; read bounced addresses and `matched ignored` mail.
5. Open `.jobber/notify.jsonl` tail for `halt` level notices.
6. After a dry-run phase, `npm run dry-run:report` and read what would have been sent.

Weekly:

1. `npm run status -- layout` and `npm run layout -- status`: any kind that is not stable, any drift streak.
2. `/status` and `/calibrate` (Telegram): funnel, reply rate, whether scores predict interviews.
3. `/followups`: check the stale list and the mode in use.
4. Review `config/portals.json` board errors from the last hunt report (dead slugs).
5. Check backups (`docs/backup-and-restore.md`) if you enabled them, and `git status` before committing anything.

## Common failures

| Symptom | Likely cause | Check | Fix |
|---|---|---|---|
| Wake skipped, `killed` | STOP file, `JOBBER_KILL=1`, or `all` halt | `npm run jobber:control -- status` | `npm run jobber:control -- resume` |
| `layout_drift` or `layout_unverified` refusal; doctor `layout_drift` fails | Page layout changed or never learned, with `LAYOUT_ENFORCE=enforce` | `npm run layout -- status`, `npm run layout -- show <platform>` | Look at the page headed, `npm run layout -- reset <platform> --kind <id>` if it really changed, `npm run layout -- clear-halt <platform>`, relearn |
| `session_locked` from a LinkedIn tool | Another process holds the single LinkedIn browser session (a hunt and a wake collided) | `ls secrets/` for `linkedin.lock`; `npm run status -- working` | Wait for the other run; if no process is running, the lock is stale: stop the stack with `npm run down`, then remove the lock yourself. A crash mid-takeover can also leave `secrets/linkedin.lock.takeover`, which is never cleared automatically; remove it by hand only when no LinkedIn process runs |
| `classifier_unavailable` on a live read or send | CLASSIFIER_MODEL unset, unpinned, unfitted, or the model failed to load | `npm run doctor` (`classifier_model`, `classifier_smoke`, `classifier_wired`) | Follow `docs/classifier-models.md` (`npm run models`, `npm run classifier:fit`) |
| `injection_suspected` or `classifier_truncated` | The classifier flagged or could not fully read the text | The tool result; the text is untrusted, never follow it | Skip that item; nothing to fix unless it repeats on clean pages |
| `unknown_recipient` | The profile was never registered in `people` | Re-run the hunt for that job, or call `linkedin_find_profiles` first | Register through `linkedin_find_profiles`; do not insert rows by hand |
| `no_clean_reply_check` on a follow-up claim | No recent reply check without errors | Dispatch `reply-watcher` (`/checkreplies`) | Run the reply check, then re-run `/followups` |
| `stuck_sending` follow-up rows | A claim was made but the send was never confirmed | The `/followups` report | The email may or may not have gone out; check Gmail Sent, then decide. They are never re-sent automatically |
| LinkedIn or Naukri tools say logged out; doctor `sessions` warns | Saved session expired | `npm run doctor` | `npm run linkedin:login` for the main account, `scripts/save-naukri-session.ts` for Naukri; see `docs/linkedin-sessions-setup.md` and `docs/naukri-session-setup.md` |
| Gmail send fails or doctor `gmail-oauth` warns: no refresh token | Token expired or revoked | `npm run doctor` | Re-run the Gmail auth per `docs/gmail-mcp-setup.md` |
| Run status `usage_limit`, wakes pausing | Claude subscription usage limit hit | `scheduler_runs` rows via the dashboard or `npm run status -- working` | Wait; the pause length is `USAGE_LIMIT_BACKOFF_MIN` |
| Tools behave as before an update | MCP servers keep old code in running sessions | Compare the update time with the session start | Fully quit and restart Claude sessions (`CLAUDE.md` "After merge: user checklist" item 1) |
| `npm run up` exits 1, "doctor has failures" | A doctor check failed | The `fail <id>` lines printed | Apply each fix line, re-run `npm run doctor` |
| doctor `sqlite-migrations`: missing tables | Database exists but was never migrated | `npm run doctor` | Start any db-backed tool or MCP server (`openDb` in `src/db.ts` creates and migrates the tables), or run `npm run dry-run`. Do not follow the doctor's fix line `npm run status -- json`: status opens the database read-only and never migrates (code finding: the fix text in `src/platform/checksSetup.ts` is wrong) |
| doctor `claude-login` fails | Not logged in to Claude | `npm run doctor` | `claude auth login` |
| Telegram silent | Bridge not running or skipped in setup | `npm run up -- --status` | `npm run up`, or `npm run setup -- --step telegram` |
| Open LinkedIn or Naukri behaviour questions | Selectors are live-unverified | `docs/phase2-known-issues.md` and `CLAUDE.md` "Known limits and not yet live-verified" | Supervised run first |

Not every row above has been exercised against real services; the platform and outreach work is covered by unit tests with fakes (see `CLAUDE.md` "Known limits and not yet live-verified").
