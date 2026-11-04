# Telegram Slash Commands Setup

Jobber uses explicit slash commands (`/runhunt`, `/status`, etc.) for reliable, predictable control via Telegram. This replaces relying on the agent to parse natural language like "run hunt".

## One-time Setup (via BotFather)

1. **Open Telegram** and message [@BotFather](https://t.me/botfather).

2. **Select your Jobber bot** from the list of your bots.

3. **Type `/setcommands`** and follow the prompt.

4. **Paste this command list** (one command per line):
   ```
   runhunt - Run one wake now: discover, match, contacts, send, apply
   status - Funnel, rates and benchmarks
   apply - Priority run on a job URL or careers page, or status of job #N
   instruction - Give the agent a standing instruction
   include - Un-exclude a vetoed job (manual override)
   outcome - Record a job outcome (replied/interview/offer/rejected...)
   calibrate - Check whether match scores predict interviews
   patterns - What kind of jobs reply
   report - Offline HTML funnel
   limits - Today's send, apply and connect limits
   working - Queue, halts and funnel snapshot
   health - Platform and pipeline health
   sources - Per-source status table
   escalations - Open escalations that need you
   windows - List the live tmux windows
   window - Live view of one tmux window
   drip - Mail and LinkedIn drip status, run one now
   ```

5. **Save.** The commands are now registered for your bot.

The custom Telegram bridge types `/limits`, `/working`, `/health`, `/sources`, `/escalations`, `/apply`, `/runhunt`, `/instruction`, `/report`, `/status`, `/outcome`, `/include`, `/calibrate`, `/patterns`, `/windows`, `/window` and `/drip` in code. `/clear`, `/compact` and `/chat restart` work only inside the `chat` topic (they go to the long-running chat window), so they are not in the BotFather list. `/followups` and `/checkreplies` are not wired in the bridge yet and have no window right now (a dedicated window comes in a coming phase), so they are not in the list above. `/applyall` and `/connect` no longer exist.

## Using Slash Commands

In Telegram, when you open the chat with your Jobber bot, you'll see the slash commands in the autocomplete menu. Tap one to send it, or type it manually.

Examples:
```
/runhunt          → runs one wake now (discover → match → contacts → send → apply)
/status           → shows current job/outreach/thread counts
/followups        → not wired in the bridge yet (no window for it right now; a dedicated window comes in a coming phase)
/apply #123       → shows job #123 in the apply queue (applying happens in a wake)
/apply https://example.com/jobs/1 [--force]
                  → a priority run on one job page or careers page: validated in code, queued, picked up by an early wake
                    (the session that types it needs the rule Bash(npm run apply:request:*)); the report comes back on Telegram
/sources          → the per-source status table
/windows          → buttons for the live tmux windows
/window chat      → a live view of one tmux window (Refresh, Pause, Close)
/drip             → drip status; buttons Mail now, LinkedIn now, Status (a confirm step follows)
```

## Updating Commands

When Phase 2 or Phase 3 ships, update the list via BotFather again (`/setcommands`), and update this doc + `CLAUDE.md`'s Commands table.

Never leave a command description saying "Phase X not implemented yet" once Phase X is live — users will get confused.

## Fallback (Natural Language)

If a slash command doesn't work or you prefer natural language, the agent still understands:
- "run hunt" → `/runhunt` (one forced wake via `./run-hunt.sh`)
- "show status" → `/status`
- "send follow-ups" → `/followups`

But slash commands are more reliable.
