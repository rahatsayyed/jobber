# Window rollout

Audience: owner
Last verified against: 6826780
Source files: config/manager-windows.json, config/windows/mail.md, config/windows/linkedin.md, scripts/stack.ts, scripts/manager.ts, scripts/permissions.ts, src/scheduler/windowDispatch.ts, src/scheduler/mailDrip.ts, src/scheduler/linkedinDrip.ts, src/scheduler/wakeWindows.ts, src/platform/checksScheduler.ts, src/platform/handoff.ts

How to turn the window lanes on, one at a time. By default everything runs as headless `claude` runs and nothing here is needed. A lane in `WINDOW_LANES` hands its work to long-lived Claude windows in the tmux session `Jobber`. The scheduler still plans, picks the item and checks every gate (kill switch, quiet hours, caps, dry run) in code before anything is typed into a window.

Order: `mail`, then `linkedin`, then `wake`. Do each step with a dry run first. Do not start the next lane until the one before it ran clean for a day.

Honest limits: a window's main thread has the full tool set, there is no `dontAsk` mode (a tool that is not allowed waits on a prompt), hooks inside subagents are unverified, and a window reads its environment once when it starts.

## 0. Before you start

1. `npm run doctor`. Read the line `window-foundation`. With `WINDOW_LANES` empty it says skip. That is right.
2. `npm run permissions -- --status`. The windows use the top-level permission set, so it must be `full` for the tools they call (see section 6).
3. Open the dashboard terminal (every window is visible there) or Telegram `/windows` (workers first, then `manager` and `chat`; the daemons `bridge`, `scheduler` and `web` are hidden in Telegram on purpose).

## 1. The mail lane

1. In `.env` set `JOBBER_DRY_RUN=true` and `WINDOW_LANES=mail`.
2. Restart the scheduler daemon (`npm run down`, then `npm run up`, or restart only the `scheduler` window), then `npm run up` so the `mail` window exists.
3. Watch: Telegram `/windows`, tap `mail` (its view lands in the lane topic `mail`, the same topic as the mail lane notices; `linkedin` likewise), or the dashboard terminal. When an email is due (inside the send window, outside quiet hours) the scheduler types one line `Work item <id>: read .jobber/work/<id>.md ...`; the window reads the file, calls `mail-operator` once, prints one JSON line, and the scheduler types `/clear`. In a dry run nothing is sent and the action is recorded in `dry_run_actions`.
4. `/drip` shows the lane and can ask for one tick now (it only skips the random wait; every gate still applies).
5. Doctor: `window-foundation` now says warn with `lanes through windows: mail` and the list of unverified behaviours (section 6). That warning is expected until you have watched a real item. It must NOT say the window started with a different `SEND_LIMIT_PER_RUN`; if it does, run `npx tsx scripts/manager.ts restart mail`.
6. When one dry-run item ended `ok` in the window and the scheduler logged it, set `JOBBER_DRY_RUN=false`, restart the scheduler and the `mail` window (the dry-run flag is fixed at window start), and watch the first real email. Check Gmail Sent.

## 2. The LinkedIn lane

1. In `.env` set `JOBBER_DRY_RUN=true` and `WINDOW_LANES=mail,linkedin`.
2. Restart the scheduler, then `npm run up`. This starts the `linkedin` window.
3. Watch the `linkedin` window the same way. One LinkedIn action per tick, inside `LINKEDIN_ACTIVE_HOURS`. After each item the window must call `linkedin_close` (the role file says so) so the LinkedIn session lock is released.
4. Doctor: `window-foundation` warns `lanes through windows: mail, linkedin`. If it says the window started with different values (dry run, `APPLY_LINKEDIN_EASY`, `MAX_APPLIES_PER_DAY`, `LINKEDIN_MAX_*`), run `npx tsx scripts/manager.ts restart linkedin`.
5. Going live: set `JOBBER_DRY_RUN=false`, restart the scheduler and the `linkedin` window. Watch the first invite or message on LinkedIn itself.

## 3. The wake lane

1. In `.env` set `JOBBER_DRY_RUN=true` and `WINDOW_LANES=mail,linkedin,wake`.
2. Restart the scheduler, then `npm run up`. This starts `sources`, `pipeline`, `boards` and `apply`.
3. A scheduled wake now types its steps as items into those windows, one at a time. `pipeline` is the longest item. A forced wake (`/runhunt`, `./run-hunt.sh`) is always headless: it is your escape hatch.
4. Doctor: `window-foundation` warns `lanes through windows: mail, linkedin, wake`. It also names windows that are not running (run `npm run up`) or started with an old `.env`.
5. A window that cannot be used hands its steps to a headless session for that wake. Nothing runs twice.
6. Going live: as for the other lanes (dry run off, restart the scheduler and every wake window).

## 4. Reading `.jobber/handoff.md`

One line per open item: `- [id] window | what | why | since`. Code writes it when a lane could not finish an item (a usage limit, a spent cap). The `manager` window reads it at start and names the open entries. A grouped reminder reaches the Telegram `alerts` topic for entries older than 30 minutes (`HANDOFF_REMIND_EVERY_MIN`). Commands: `npx tsx scripts/manager.ts handoff list`, `handoff resolve <id>`.

## 5. Roll back

For any lane: remove it from `WINDOW_LANES` in `.env` and restart the scheduler. The headless path is the default again at the next tick or wake. The windows can stay idle, or be stopped with `npm run down` (it asks first and never stops `manager`). To stop one lane only, remove only that lane. To stop everything at once the kill switch always wins (`.jobber/STOP`).

## 6. Not checked against the real `claude` yet

Watch these in the first dry run of each lane. Each one has a safe fallback, but you should see it work once.

- `--session-id` for an interactive session, and the first prompt (the startup line is typed in after claude starts).
- The end of a turn in the transcript (how the scheduler knows an item is done).
- Whether `/clear` starts a new transcript file (the scheduler finds it again by the typed text).
- The pane text of a usage limit (the lane then backs off and writes a handoff entry).
- The footer marker `esc to interrupt` (it tells a slow tool from a stuck prompt).
- The shape of `attachments` in the Gmail `send_email` call (the guard `window-guard.cjs` checks it; if it refuses a good send, read the refusal in the window).
- `linkedin_close` called from the main thread closes the session that the subagent opened.
- Whether the hooks also fire inside subagents started from a window.

## 7. A window sits on a permission prompt

Symptom: after about 60 seconds of silence the item ends as `stalled`, the lane warns you, Escape is typed and the window is cleared. Open the window and look at the last screen first (Telegram `/windows`, or the dashboard terminal).

Cause: a tool the window called is not in the permission set. The windows use the top-level set (`npm run permissions -- --status`, set `full`). Tools that the shipped `full` set does not allow (check `config/permission-sets.json`): the whole `outreach` server (`list_due_touches`, `next_contacts`, `record_inbound`, `escalate`, `save_reply_draft`, `complete_instruction`) and the `linkedin_scroll`, `linkedin_wait_for`, `linkedin_screenshot`, `linkedin_limits` and `linkedin_close` tools. The LinkedIn window needs them.

Fix: you decide this, the agent never edits permission sets. Add the tool names (for example `mcp__outreach__escalate`) to the `allow` list of `outreach_send` or `full` in `config/permission-sets.json`, run `npm run permissions -- full`, then restart the window (`npx tsx scripts/manager.ts restart <window>`). `npm run permissions -- --status` shows the set that is applied. Note that `full` allows every Jobber send and apply tool for any session on this machine.

## Automatic email replies in the mail window

With `EMAIL_AUTO_REPLY=true` (see [Email auto reply](email-auto-reply.md)) an automatic reply is one more mail item: the work file names it and asks `mail-operator` for REPLY MODE. It goes through the `mail` window like the cold email and the follow-up (same claim, same checks); the reply check that precedes it still stays headless. Add `mcp__db__claim_email_reply_for_send`, `mcp__db__mark_email_reply_sent` and `mcp__db__mark_email_reply_failed` to the `full` permission set if you use a custom one (`outreach_send` already has them).

## Reply checks stay headless

The mail reply check (`reply_check`, profile `mail_reply_check`) is never typed into the `mail` window, even with `WINDOW_LANES=mail`: a long-lived window cannot enforce a per-item tool list, so the read-only guarantee (no `gmail.send_email`) is only provable in the headless profile. Enforcement of the window path was not proven, so it is not built. The LinkedIn inbox read goes through the `linkedin` window like any other item, and it ignores only the item spacing.
