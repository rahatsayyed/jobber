# Operations

Audience: owner
Last verified against: 21e67ef
Source files: scripts/jobber-control.ts, src/scheduler/control.ts, .claude/hooks/kill-switch.cjs, run-hunt.sh, scripts/linkedin-clear-halt.ts, scripts/layout.ts, src/safety/dryRun.ts, scripts/dry-run-report.ts, scripts/status.ts, src/status/render.ts, src/scheduler/plan.ts, src/scheduler/runLog.ts, src/scheduler/notify.ts, src/scheduler/launch.ts, src/scheduler/mailDrip.ts, src/scheduler/driver.ts, scripts/apply-request.ts, src/manual/requests.ts, src/web/applyRoutes.ts, scripts/stack.ts, src/stack/up.ts, src/stack/down.ts, src/verify/cli.ts, src/platform/checksSetup.ts, src/platform/checksLayout.ts, src/platform/checksScheduler.ts, src/applier/cooldown.ts, src/sources/status.ts

Day-to-day running of Jobber: stop it, resume it, read its state, find its files, fix common failures.
Safety rules are not restated here; they live in `CLAUDE.md` under "Safety" and "Outreach safety layers". Read layer 6 there for the full kill switch scope.

## Emergency stop in 20 seconds

```bash
npm run jobber:control -- stop "why you stopped it"
```

Writes `.jobber/STOP` (reason and timestamp) and records an active halt for `all`, `linkedin`, `naukri` and `wellfound` in the database. A halt that was already active is kept and printed as `kept existing <platform> halt`.

```bash
npm run jobber:control -- status
```

Prints `killed`, the reason, the `linkedin halt`, `naukri halt` and `wellfound halt` lines and which platforms are `allowed`.

What stops:

- The scheduler: the next wake sees the kill switch and skips (reason `killed`); a running wake window is killed within one poll. The mail drip lane stops too: no new email run starts, and a drip run in flight is killed within one poll.
- Every tool call in restricted runs, and the irreversible tools (Gmail send, the applier's acting tools, the scout tools, typed LinkedIn, Naukri and Wellfound page and send tools) in any session in this project, through `.claude/hooks/kill-switch.cjs`.
- The launcher refuses to start and exits with code 4 (stderr: `kill switch active, not starting`); a forced wake from `./run-hunt.sh` is skipped with reason `killed`.
- `npm run up` refuses to start the stack and exits with code 4.
- `JOBBER_KILL=1` in the process environment has the same effect as the STOP file for the hook and the launcher. The hook reads only the process environment (`.claude/hooks/kill-switch.cjs`), not `.env`.

What does not stop (restated from `CLAUDE.md`, "Outreach safety layers" layer 6, "Not covered"):

- A tool call that is already executing when STOP is written finishes.
- Hook propagation into subagents is unverified in real `claude`.
- Interactive sessions started outside this project directory.
- Sends done through Bash.
- `halt_flags` rows are not read by the hook (the typed tools read them).

If the model is mid-run and you need it gone now, also stop the tmux windows: `npm run down` (see "Bring the stack up and down" below).

## Resume and clear halts

Never hand-edit SQLite. Pick the command by what set the halt.

| What you see | Who set it | Clear with |
|---|---|---|
| `STOP file` or `jobber-control stop: ...` halts | You, via `jobber:control stop` | `npm run jobber:control -- resume` |
| `layout_drift:<kind>` on a platform (ATS pages, or an old row) | Layout memory (needs `LAYOUT_ENFORCE=enforce` to halt; LinkedIn and Naukri drift is telemetry only) | `npm run layout -- clear-halt <platform>` |
| LinkedIn checkpoint, CAPTCHA or restriction halt | The LinkedIn typed tools | `npm run linkedin:clear-halt -- --yes` (see the warning below it) |
| Wellfound unconfirmed or failed sends (three in a row) | The Wellfound send path | No supported command clears it, the same as Naukri below: read the reason with `npm run jobber:control -- status`, fix the cause (usually the session: `npm run wellfound:login`), then decide yourself how to proceed. Only `jobber:control resume` clears halts it wrote itself |
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

One flag decides whether an action is performed or only recorded (rule in `src/safety/dryRun.ts`, `isDryRun`; `CLAUDE.md` Safety rule 15):

| Flag | Dry when |
|---|---|
| `JOBBER_DRY_RUN` | the trimmed, lowercased value is `1` or `true` |

Unset, empty, `false`, `0` or anything else is LIVE. `.env.example` ships `JOBBER_DRY_RUN=true`. The old per-area dry-run keys (one each for the scheduler, LinkedIn, web, apply and scout) are ignored; `npm run doctor` warns when `.env` still has one and prints `MODE: DRY RUN` or `MODE: LIVE`. The Gmail send hook uses the same parse.

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

End-to-end smoke test in dry mode against fixtures and a temporary database. Writes `.jobber/verify.json`. Options: `--llm` (also runs the `llm-hunt` stage in dry mode; refused unless `.env` itself is dry), `--skip <id>[,<id>]`, `--json`, `--list`, `--help`. Exit codes: 0 pass, 1 a stage failed, 2 usage error. Unverified: hermetic tests with fakes only; the live checks are owner-only (see `CLAUDE.md` "Known limits").

## Bring the stack up and down

```bash
npm start
```

`npm start` is the same as `npm run up`, and `npm stop` is the same as `npm run down`. Extra flags go after `--`, for example `npm start -- --status`.

Order: kill-switch check, doctor gate, then bridge, windows, scheduler and dashboard. The scheduler and the dashboard run in the tmux session `jobber-stack` (`STACK_TMUX_SESSION`); the scheduler daemon is also what runs the mail drip lane and the early wake for a priority request. Exit codes:

| Code | Meaning |
|---|---|
| 0 | Started (or `--status` printed) |
| 1 | Doctor has failures (nothing started), or a start failed (full table is printed first) |
| 2 | Usage error (unknown argument) |
| 4 | Kill switch is on; run `npm run jobber:control -- resume` when you are sure |

`npm start`, `npm stop`, `npm run doctor` and `npm run dry-run` colour their tables on a terminal; add `--no-color` to turn that off.

Features you skipped in setup print as `bridge: skipped (setup)`, `windows: skipped (setup)` or `web: skipped (setup)`.

```bash
npm stop
npm stop -- --keep-bridge
npm stop -- --force --yes
```

Stops the windows and scheduler this stack started. A scheduler that belongs to a launchd or systemd unit is not stopped here; the command prints the unload or disable line to run yourself. Without `--force` a scheduler finishing a wake is left to finish: re-run `npm run down`. It asks before stopping the `hunt` and `followups` windows; without a terminal they are left running unless you pass `--yes`. It does not touch the scheduler's wake session (`jobber-runs`; the STOP file is what kills a wake window), and it does not stop a hunt you started from a shell with `./run-hunt.sh`. Exit codes: 0 ok, 1 a stop failed, 2 usage error (unknown flag).

## The mail drip lane (how email goes out)

A wake never sends email. It only queues cold emails and follow-ups (`outreach_queue`). The scheduler daemon (`npm start`, or `npm run scheduler -- --daemon`; never `--once` or `--now`) runs a separate lane beside the wakes: every 30 seconds it checks, in code and with no model call, whether a send is due. It sends only when all of these hold: no kill switch (`.jobber/STOP`, `JOBBER_KILL=1`, an `all` halt), outside `QUIET_HOURS_START` to `QUIET_HOURS_END`, inside the send window (`EMAIL_SEND_WINDOW_START` to `EMAIL_SEND_WINDOW_END`, IST), no usage-limit pause, a valid configuration, enough time since the last send and since the stored next-tick time, room under `EMAIL_MAX_PER_DAY` when you set it, and a sendable item. Then it sends a small batch (`EMAIL_DRIP_MIN_BATCH` to `EMAIL_DRIP_MAX_BATCH` emails), one tiny `claude` run per email (profile `mail_drip`, trigger `mail_drip` in `scheduler_runs`, one email each), with a random pause (`EMAIL_DRIP_INTRA_PAUSE_MIN_SEC` to `EMAIL_DRIP_INTRA_PAUSE_MAX_SEC`) between two emails and a random wait (`EMAIL_DRIP_MIN_GAP_MIN` to `EMAIL_DRIP_MAX_GAP_MIN` minutes) before the next tick. The defaults are in `src/setup/limitsCatalog.ts` and `.env.example`. Order: queued cold emails first (never the same exact address twice), then approved follow-ups, which wait for a clean, fresh reply check (run `/checkreplies`, or let a wake's reply check do it).

Things to know:

- `EMAIL_MAX_PER_DAY` is the only daily cap of the lane; `0` or unset means no cap (the slow spacing is the protection). `SEND_LIMIT_PER_RUN` does not limit the lane; it still limits an interactive `/followups` session. Decide on `EMAIL_MAX_PER_DAY` before the first live day.
- An invalid `EMAIL_*` value stops the lane (`bad_config`) and the doctor check `mail-drip-config` says which key.
- A drip run that ends without a recorded send leaves its row quarantined (it is never picked again automatically) and writes a notice to `.jobber/notify.jsonl`: check Gmail Sent first. No supported command clears that quarantine (it is the `mail_drip_quarantine` entry of `scheduler_state`); `npm run mail:release -- <job_id>` (or `--reset`) only repairs a row whose email was marked `failed`, so a quarantined row stays unsent until you decide by hand.
- `npm run scheduler -- --status` prints `next mail drip not before: <time>`. The lane has its own lock (name `mail`), so a long wake never pauses it.
- Under `JOBBER_DRY_RUN=true` the drip runs record what they would send and send nothing.
- Email follow-ups follow the mode in `FOLLOWUPS_AUTONOMOUS`: in legacy mode (the shipped default) the lane sends a follow-up only after you approved it in `/followups`.

## Priority requests (`/apply <url>`)

Hand Jobber one job page or careers page and it runs the whole pipeline on it first:

```bash
npm run apply:request -- <https url> [--force]
```

The command only validates the URL and writes one pending request (`manual_requests`); it fetches nothing. The same request can be made from Telegram (`/apply <https url> [--force]`, in the `hunt` window) and from the dashboard Apply tab (signed in recently; two steps, a confirmation token, 10 requests per hour per session). The scheduler daemon checks for a pending request every 30 seconds and runs an early wake outside quiet hours; the wake ingests it in code, reads a platform job page with the platform operator, matches, vets, finds contacts, prepares and queues outreach and apply, taking these jobs first (at most 10 per wake), and a report for each request arrives on Telegram, written by code. Every gate and cap still applies; `--force` also prepares a score below `MATCH_THRESHOLD` and skips the 90-day repeat-contact guard. A request made while the kill switch is on is stored and waits. If `/apply <url>` is refused with a permission prompt in the `hunt` window, allow the Bash permission rule for the `apply:request` script (the pattern is in `.claude/commands/apply.md`) there. A `/apply #N` lookup only reports the state of job N.

## Scheduler skip reasons

Each wake either runs or is skipped with one reason (`planWake` in `src/scheduler/plan.ts`). The result is stored in `scheduler_runs`.

| Reason | Meaning | What to do |
|---|---|---|
| `killed` | STOP file, `JOBBER_KILL=1`, a global `all` halt, or the control state could not be read (fails closed) | `npm run jobber:control -- status`, then `resume` if it is yours |
| `halted` | Every platform (LinkedIn, Naukri, Wellfound) has an active halt | Read the detail, clear per "Resume and clear halts" |
| `quiet_hours` | Inside `QUIET_HOURS_START` to `QUIET_HOURS_END` (hours in IST) | Nothing; it wakes after the window |
| `ceilings_exhausted` | Work exists but every relevant rolling ceiling is full | `npm run status -- limits`; wait, or raise a ceiling deliberately (catalog: `src/setup/limitsCatalog.ts`) |
| `nothing_due` | No follow-ups, outreach, inbox check or search is due | Nothing |

A wake that runs ends in one of these run statuses (`src/scheduler/runLog.ts`): `planned`, `running`, `ok`, `budget_exceeded`, `killed`, `failed`, `crashed`, `usage_limit`, `skipped`, `incomplete`. `incomplete` means claude exited 0 but the log does not prove the wake finished (no final report line, or a subagent still pending); the scheduler then continues the same session with `claude --resume`, at most twice (each continuation is its own row with a `parent_run_id`). `usage_limit` means the subscription limit was hit and the scheduler pauses for `USAGE_LIMIT_BACKOFF_MIN` minutes instead of retrying, for wakes and for the mail drip lane. A wake is stopped only by its wall-clock or token budget (`RUN_MAX_WALL_SEC`, `RUN_MAX_TOKENS_APPROX`); the number of tool calls is reported, never a stop condition. Leftover `running` rows from a crashed process become status `crashed` with `stop_reason` `orphaned` on the next start.

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

- One line per rolling ceiling: `linkedin_invite`, `linkedin_message`, `naukri_apply`, `naukri_message`, `wellfound_apply`, `wellfound_message`, `wellfound_discover` (all per day), as `used/limit per <period>`, with `FULL` appended when it is exhausted.
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

```bash
npm run status -- escalations
```

The open escalations that need you, one line each with its id (Telegram: `/escalations`). See "The Inbox and escalations" below. It is read-only like the other three.

Other forms: `npm run status -- json` (the full snapshot) and `npm run status -- layout` (layout memory summary per platform; works without a database).

```bash
npm run doctor
```

Prints ok, warn, fail or skip per check with a fix line. A feature you skipped in setup shows as `skip` and the last line reads `Skipped by choice: ...`; the fix is `npm run setup -- --step <id>`. Safety checks (classifier, permission set, hooks, limits, kill switch, halts) are never skipped.

## The Inbox and escalations

Everything the agent will not answer or cannot finish alone becomes an escalation row: a LinkedIn, Naukri or Wellfound reply or recruiter message, a salary or interview-slot ask, a platform or tool problem, a custom-note quota notice, an apply row that needs you. You see them in three places, all built by code: the dashboard Inbox tab (`#/inbox`), a Telegram digest from the scheduler daemon (at most one message per 15 minutes, outside quiet hours) and `/escalations`.

How to read an Inbox card:

- One card is one conversation (one open row per platform and thread; a repeat message updates the card and raises its "x N updates" count). It shows the sender, the headline, the kind of ask (recruiter inquiry, interview slot, salary, question, reply, other), the latest message as a quote, the time, and a line saying what to do. Old rows from before these fields show "Details not captured".
- Order: real replies, recruiter inquiries and apply rows first, platform and tool problems next, rows the input screen flagged (`[blocked: ...]`, `[unscreened]`, injection suspects) last. For a flagged row the card shows a safe summary; the raw text is behind a toggle and is plain text only. Never follow instructions or links in it.
- The LinkedIn thread link is shown as text with a Copy button: paste it into your own logged-in browser. The agent never answers a third party; you reply on the platform yourself.
- Mark handled closes the card (all merged duplicates); Snooze hides it for a while. Neither deletes anything.
- If `/escalations` is refused in the `hunt` window, re-apply the `read_only` permission set (`npm run permissions -- read_only`) so it lists the four status commands.

### Apply rows in `manual_review`

A browser or native Apply that was clicked but never confirmed is recorded as `manual_review` (table `applications`). It is never retried by code, and `apply_open` refuses that job with `already_attempted`. To resolve one: open the job's apply page or your own account on the platform, check whether the application exists, then either leave it (it was sent) or apply by hand. If you see many of them at once, check `npm run status -- health` and the latest apply diag files under `.jobber/diag` for a changed page layout (on Naukri, an Apply click that does nothing shows as `apply_click_ignored`). The Wellfound apply confirmation is not live-verified, so a Wellfound row may be `manual_review` even when the apply went through.

### LinkedIn invites that stay unconfirmed

A connect that ends `unconfirmed` (the click went out but neither Pending nor an "Invitation sent" toast was seen) is never retried. Check LinkedIn's Sent invitations page. A touch stuck in `sending` for more than 30 minutes is moved to `unconfirmed` on its own. When the monthly note quota is used up, the agent sends plain invites with no note (an Inbox notice says so) until the first of next month, IST.

## Where logs and state live

Paths marked git-ignored are never committed. Do not read or paste the contents of `secrets/`, `user-data/` or `.env` into a chat.

| Path | Written by | Safe to delete? |
|---|---|---|
| `data.sqlite` (location set by the db path module `src/dbPath.ts`) | Every db tool, the scheduler and its wakes | No. Back up first (`docs/backup-and-restore.md`) |
| `.jobber/STOP` | `npm run jobber:control -- stop` | Only through `resume` |
| `.jobber/notify.jsonl` | Scheduler and layout notifier (`src/scheduler/notify.ts`); one JSON line per notice with `ts`, `level`, `title`, optional `detail` and `run_id` | Yes (history only) |
| `JOBBER_NOTIFY_CMD` | Optional command the notifier runs with the notice title as its only argument; never receives the detail | Not a file; unset to stop |
| `.jobber/runs/<run id>.log` | The scheduler's wake window output (`src/scheduler/launch.ts`); path also stored in `scheduler_runs.log_path` | Yes, old ones |
| `.jobber/runs/<run id>.prompt.txt` | The prompt handed to that wake's `claude` run (`src/scheduler/launch.ts`) | Yes, old ones |
| `scheduler_runs` table | `src/scheduler/runLog.ts` | No (it is in the database) |
| `.jobber/units/` | `npm run scheduler:units` (unit files only, never installs) | Yes, regenerate |
| `.jobber/logs/` | The log directory written into the generated unit files | Yes, old ones |
| `.jobber/layout/<platform>.json` | Layout memory observer (`src/layout/`); ids from a closed vocabulary only | Use `npm run layout -- reset`, not `rm` |
| `.jobber/ats-recipes/` | The browser applier (learned recipes from confirmed applications) | Yes; the applier falls back to shipped recipes and the operator |
| `generated/providers/` | Generated provider specs (JSON data) | Not by hand: use `npm run providers -- reject <id>` |
| `.jobber/verify.json` | `npm run dry-run` (mode 600, no details) | Yes |
| `.jobber/bootstrap.json` | `bash scripts/bootstrap.sh` | Yes |
| `dry_run_actions` table | `src/safety/dryRun.ts`, read by `npm run dry-run:report` | No (it is in the database) |
| `reports/funnel-<date>.html` | `npm run report` (git-ignored) | Yes |
| `.claude/settings.local.json` | `npm run permissions` | No; regenerate with `npm run permissions -- --status` first |
| `secrets/` | Session capture scripts and OAuth setup | No, you would have to log in again |

Wake output: `./run-hunt.sh` does not redirect to a log file itself; it execs `npm run scheduler -- --once --now`, which prints one line (`run <id>: <status>`) to the terminal or to whatever redirect your cron line adds. The wake window's own output goes to `.jobber/runs/<run id>.log`.

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
4. `npm run status -- sources`: fix dead slugs and failing or flaky sources in `config/portals.json` and `config/platforms.json`; `npm run providers -- list` for generated providers waiting for your review (their outreach stays held until you approve).
5. Check backups (`docs/backup-and-restore.md`) if you enabled them, and `git status` before committing anything.

## Email format

Every cold email and email follow-up is sent as multipart/alternative. The plain part is the stored, gated text. The HTML part is built in code from that text, never by the model: paragraphs, "- " lines as a list, and links only for your own sites (the `website` and `social` URLs in `user-data/resume.json`; forms like `GitHub: @handle`, `Portfolio: https://site` and a bare `site.xyz` become full links, any other URL stays plain text). The draft may wrap at most three short phrases in `**...**`; they become bold in the HTML and are removed from the plain part, and the fact gate reads the text without them. HTML from the model is escaped; there are no images, tracking or remote styles. The HTML is stored in `outreach_queue.email_html` and `followups.body_html` (older drafts get it built when listed). Preview a queued draft without sending: build it from the stored row (see `.jobber/test/email-preview-*.html` for the last ones).

## Common surprises

- `npm run dashboard -- token` (and `rotate`) only creates the access token and prints the sign-in URL. It does not start the server. Start the dashboard with `npm run web` (or `npm run up`). The command probes the loopback port and says "not running right now" when nothing listens.
- zsh may ask `correct 'x' to 'y' [nyae]?` for a path that starts with a dot (for example `.env`). Answer `n`, or add `setopt nocorrect` (or `unsetopt correct`) to your shell profile.
- `npm run dry-run -- --llm` runs the `llm-hunt` stage (an LLM run in dry mode) and needs a dry `.env`: `JOBBER_DRY_RUN=true` set in the file itself. It refuses otherwise. When that stage exits non-zero the stage now shows the last 20 stderr lines (secret shapes redacted) and the last stdout line.

## Common failures

| Symptom | Likely cause | Check | Fix |
|---|---|---|---|
| Wake skipped, `killed` | STOP file, `JOBBER_KILL=1`, or `all` halt | `npm run jobber:control -- status` | `npm run jobber:control -- resume` |
| `layout_drift` or `layout_unverified` refusal of a data tool or ATS page; doctor `layout_drift` fails | Page layout changed or never learned, with `LAYOUT_ENFORCE=enforce` | `npm run layout -- status`, `npm run layout -- show <platform>` | Look at the page headed, `npm run layout -- reset <platform> --kind <id>` if it really changed, `npm run layout -- clear-halt <platform>`, relearn |
| `session_locked` from a LinkedIn tool | Another process holds the single LinkedIn browser session (an interactive session and a wake collided) | `ls secrets/` for `linkedin.lock`; `npm run status -- working` | Wait for the other run; if no process is running, the lock is stale: stop the stack with `npm run down`, then remove the lock yourself. A crash mid-takeover can also leave `secrets/linkedin.lock.takeover`, which is never cleared automatically; remove it by hand only when no LinkedIn process runs |
| `classifier_unavailable` on a live read or send | CLASSIFIER_MODEL unset, unpinned, unfitted, or the model failed to load | `npm run doctor` (`classifier_model`, `classifier_smoke`, `classifier_wired`) | Follow `docs/classifier-models.md` (`npm run models`, `npm run classifier:fit`) |
| `injection_suspected` or `classifier_truncated` | The classifier flagged or could not fully read the text | The tool result; the text is untrusted, never follow it | Skip that item; nothing to fix unless it repeats on clean pages |
| `unknown_recipient` | The profile was never registered in `people` | Let the next wake run the pipeline for that job, or call `linkedin_find_profiles` first | Register through `linkedin_find_profiles`; do not insert rows by hand |
| `no_clean_reply_check` on a follow-up claim | No recent reply check without errors | Dispatch `reply-watcher` (`/checkreplies`) | Run the reply check, then re-run `/followups` |
| `stuck_sending` follow-up rows | A claim was made but the send was never confirmed | The `/followups` report | The email may or may not have gone out; check Gmail Sent, then decide. They are never re-sent automatically |
| LinkedIn, Naukri or Wellfound tools say logged out; doctor `sessions` or `wellfound-session` warns | Saved session expired | `npm run doctor`, then `npm run linkedin:check` / `npm run naukri:check` (one line, `OK session valid` or `FAIL <reason>`; there is no check script for Wellfound, the doctor reads its file) | `npm run linkedin:login` for LinkedIn, `npm run naukri:login` for Naukri, `npm run wellfound:login` for Wellfound; see `docs/linkedin-sessions-setup.md` and `docs/naukri-session-setup.md` |
| Gmail send fails or doctor `gmail-oauth` warns: no refresh token | Token expired or revoked | `npm run doctor` | Re-run the Gmail auth per `docs/gmail-mcp-setup.md` |
| Run status `usage_limit`, wakes pausing | Claude subscription usage limit hit | `scheduler_runs` rows via the dashboard or `npm run status -- working` | Wait; the pause length is `USAGE_LIMIT_BACKOFF_MIN` |
| Tools behave as before an update | MCP servers keep old code in running sessions | Compare the update time with the session start | Fully quit and restart Claude sessions (`CLAUDE.md` "After merge: user checklist" item 1) |
| `npm run up` exits 1, "doctor has failures" | A doctor check failed | The `fail <id>` lines printed | Apply each fix line, re-run `npm run doctor` |
| doctor `sqlite-migrations`: missing tables | Database exists but was never migrated | `npm run doctor` | Start any db-backed tool or MCP server (`openDb` in `src/db.ts` creates and migrates the tables), or run `npm run dry-run`. Do not follow the doctor's fix line `npm run status -- json`: status opens the database read-only and never migrates (code finding: the fix text in `src/platform/checksSetup.ts` is wrong) |
| doctor `claude-login` fails | Not logged in to Claude | `npm run doctor` | `claude auth login` |
| Telegram silent | Bridge not running or skipped in setup | `npm run up -- --status` | `npm run up`, or `npm run setup -- --step telegram` |
| Apply result `held` | `APPLY_SUBMIT_MODE` is `hold` (the shipped default): the form was prepared and not submitted | The apply report; `docs/apply.md` | Set `APPLY_SUBMIT_MODE=submit` only after the supervised checks |
| Apply refused with `host_cooldown`, `host_cap` or `attempt_cap` | Blocks on that host, or a per-host or daily apply cap is spent | `npm run status -- limits`, `docs/apply.md` | Wait; raise a cap only on purpose (`APPLY_MAX_PER_HOST`, `APPLY_MAX_ATTEMPTS_PER_DAY`) |
| A source shows an error or `flaky` | A provider failed or its shape drifted; a fallback task was queued | `npm run status -- sources` | See `docs/sources-and-platforms.md`; fix the slug or leave the fallback to the next wake |
| Open LinkedIn or Naukri behaviour questions | Selectors are live-unverified | `docs/phase2-known-issues.md` and `CLAUDE.md` "Known limits and not yet live-verified" | Supervised run first |

Not every row above has been exercised against real services; the platform and outreach work is covered by unit tests with fakes (see `CLAUDE.md` "Known limits and not yet live-verified").
