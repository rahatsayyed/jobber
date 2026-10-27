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
   followups - Draft and send email follow-ups, resolve stale
   apply - Priority run on a job URL or careers page, or status of job #N
   applyall - Apply queue and caps for today's matched jobs
   connect - Draft + send a LinkedIn connect request or message
   include - Un-exclude a vetoed job (manual override)
   outcome - Record a job outcome (replied/interview/offer/rejected...)
   calibrate - Check whether match scores predict interviews
   checkreplies - Detect replies in Gmail and record outcomes
   patterns - What kind of jobs reply
   report - Offline HTML funnel
   limits - Today's send, apply and connect limits
   working - Queue, halts and funnel snapshot
   health - Platform and pipeline health
   sources - Per-source status table
   escalations - Open escalations that need you
   ```

5. **Save.** The commands are now registered for your bot.

## Using Slash Commands

In Telegram, when you open the chat with your Jobber bot, you'll see the slash commands in the autocomplete menu. Tap one to send it, or type it manually.

Examples:
```
/runhunt          → runs one wake now (discover → match → contacts → send → apply)
/status           → shows current job/outreach/thread counts
/followups        → drafts and sends email follow-ups (needs your approval unless FOLLOWUPS_AUTONOMOUS=true)
/apply #123       → shows job #123 in the apply queue (applying happens in a wake)
/apply https://example.com/jobs/1 [--force]
                  → a priority run on one job page or careers page: validated in code, queued, picked up by an early wake
                    (the hunt window needs the rule Bash(npm run apply:request:*)); the report comes back on Telegram
/sources          → the per-source status table
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
