# Window rollout

Audience: owner
Last verified against: 4fb177f
Source files: config/manager-windows.json, config/windows/mail.md, config/windows/linkedin.md, scripts/stack.ts, scripts/manager.ts, scripts/permissions.ts, src/scheduler/windowDispatch.ts, src/scheduler/windowReady.ts, src/scheduler/wakeRequest.ts, src/scheduler/mailDrip.ts, src/scheduler/linkedinDrip.ts, src/scheduler/wakeWindows.ts, src/platform/checksScheduler.ts, src/platform/handoff.ts

Windows are the only path. There is no flag to turn on and no headless `claude -p` run to fall back to (owner decision 2026-11-06). `npm run up` starts the six worker windows (`mail`, `linkedin`, `boards`, `sources`, `pipeline`, `apply`) plus `manager` and `chat`, and the scheduler daemon types every drip item and every wake step into them. This page says how to watch the first ticks and what is still unverified, because real `claude` windows have never run a tick yet.

Honest limits: a window's main thread has the full tool set, there is no `dontAsk` mode (a tool that is not allowed waits on a prompt), the mail reply check runs in the same window that can send mail, hooks inside subagents are unverified, and a window reads its environment once when it starts (a changed `.env` value needs a window restart). The full list of what the headless runner used to enforce and no longer does is in [safety layers](reference/safety-layers.md).

## 0. Before the first tick

1. `npm run doctor`. Read the line `window-foundation`. It warns on purpose until you have watched a real item (the unverified behaviours are listed in section 3).
2. `npm run permissions -- --status`. The windows use the top-level permission set, so it must be `full` for the tools they call (see section 4).
3. Put `JOBBER_DRY_RUN=true` in `.env` for the first day. A dry scheduler refuses to type into a window that started live, so restart the windows after you change the flag (`npx tsx scripts/manager.ts restart <window>`).
4. Run `npm run up`. It prints one line per window (`window mail: started, startup line typed`) and then the table of components. All eight windows should say `running`. Open the dashboard terminal (every window is visible there) or Telegram `/windows` (workers first, then `manager` and `chat`; the daemons `bridge`, `scheduler` and `web` are hidden in Telegram on purpose).

## 1. Watch the first ticks

Do these in order. Do not go live (`JOBBER_DRY_RUN=false`) until each one ended `ok` in a dry run.

1. **Mail.** When an email is due (inside the send window, outside quiet hours) the scheduler types one line into the `mail` window: `Work item <id>: read .jobber/work/<id>.md ...`. Watch the window read the file and dispatch `mail-operator`. In a dry run nothing is sent. `/drip` shows the lane and can ask for one tick now (it only skips the random wait; every gate still applies). The reply check (`reply_check`) is also an item in this window: its work file names only `reply-watcher`.
2. **LinkedIn.** One action per tick, inside `LINKEDIN_ACTIVE_HOURS`. After each item the window must call `linkedin_close` (the role file says so) so the LinkedIn session lock is free for the next one.
3. **Wake.** Ask for one with `/runhunt` or `./run-hunt.sh`. That only writes a request for the running scheduler daemon (with no daemon it says "start the stack with npm run up" and exits non-zero). The daemon types the steps into `sources`, `linkedin`, `boards`, `pipeline` and `apply`, one item at a time. `pipeline` is the longest item. The wake summary comes to the `wakes` topic.
4. **Going live.** Set `JOBBER_DRY_RUN=false`, restart the scheduler and every worker window (the dry-run flag and the caps are fixed when a window starts), and watch the first real email, invite or application on the platform itself.

## 2. When a window is missing or stuck

- **Missing or not a claude pane.** The scheduler starts it itself (the same path as `npx tsx scripts/manager.ts start <window>`, with the startup line), waits up to 60 seconds for a claude pane, and only then types the item. If it still cannot, the item is skipped, nothing runs anywhere else, a line goes into `.jobber/handoff.md`, and you get one loud `alerts` notice per hour for that window. The work stays due and is tried again at the next tick or wake.
- **Busy.** A window working an item is waited for (the wake waits up to 10 minutes, a drip skips the tick). Nothing is typed twice.
- **Stuck on a permission prompt.** See section 4.
- **Usage limit.** The pane text or an API error entry sets `usage_backoff_until` (`USAGE_LIMIT_BACKOFF_MIN`) and writes a handoff entry; nothing is typed until it passes.
- **Leftovers.** At scheduler start, windows named `wake-*` or `drip-*` (from the old headless design) are killed once.

## 3. Not checked against the real `claude` yet

Watch these in the first dry run. Each one has a safe fallback (the item is skipped or ends `incomplete`, never run twice), but you should see it work once.

- `--session-id` for an interactive session, and the first prompt (the startup line is typed in after claude starts).
- The bounded start: that a window started by the scheduler really shows a claude pane within 60 seconds.
- The end of a turn in the transcript (how the scheduler knows an item is done).
- Whether `/clear` starts a new transcript file (the scheduler finds it again by the typed text).
- The pane text of a usage limit (the scheduler then backs off and writes a handoff entry).
- The footer marker `esc to interrupt` (it tells a slow tool from a stuck prompt).
- The shape of `attachments` in the Gmail `send_email` call (the guard `window-guard.cjs` checks it; if it refuses a good send, read the refusal in the window).
- `linkedin_close` called from the main thread closes the session that the subagent opened.
- Whether the hooks also fire inside subagents started from a window.

## 4. A window sits on a permission prompt

Symptom: after about 60 seconds of silence (or `RUN_STALL_SEC` when you set it) the item ends as `stalled`, you get a notice, Escape is typed and the window is cleared. Open the window and look at the last screen first (Telegram `/windows`, or the dashboard terminal).

Cause: a tool the window called is not in the permission set. The windows use the top-level set (`npm run permissions -- --status`, set `full`). Check `config/permission-sets.json` for the tool.

Fix: you decide this, the agent never edits permission sets. Add the tool names (for example `mcp__outreach__escalate`) to the `allow` list of `outreach_send` or `full` in `config/permission-sets.json`, run `npm run permissions -- full`, then restart the windows.

## 5. Reading `.jobber/handoff.md`

One line per open item: `- [id] window | what | why | since`. Code writes it when an item could not be finished (a usage limit, a spent cap, a window that could not be started). The `manager` window reads it at start and names the open items; `npx tsx scripts/handoff.ts list` lists them and Telegram reminds you about entries older than 30 minutes. Resolve one with `npx tsx scripts/handoff.ts resolve <id>`.

## 6. Automatic email replies in the mail window

With `EMAIL_AUTO_REPLY=true` (see [Email auto reply](email-auto-reply.md)) an automatic reply is one more mail item: the work file names it and asks `mail-operator` for REPLY MODE. It goes through the `mail` window like the cold email and the follow-up, with the same claims and gates in code.

## 7. The reply check and the mail window (known weakness)

The mail reply check (`reply_check`) is typed into the `mail` window. Its work file names only `reply-watcher`, whose tool list has no send tool, and the kill switch and `window-guard.cjs` still apply, but the window's main thread also holds `gmail.send_email`, so "reads only" is no longer enforced by a per-item tool list the way the old `mail_reply_check` run profile did. If you want a hard guarantee, tell the agent you want a dedicated read-only window for it.
