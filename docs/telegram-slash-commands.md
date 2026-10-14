# Telegram Slash Commands Setup

Jobber uses explicit slash commands (`/runhunt`, `/status`, etc.) for reliable, predictable control via Telegram. This replaces relying on the agent to parse natural language like "run hunt".

## One-time Setup (via BotFather)

1. **Open Telegram** and message [@BotFather](https://t.me/botfather).

2. **Select your Jobber bot** from the list of your bots.

3. **Type `/setcommands`** and follow the prompt.

4. **Paste this command list** (one command per line):
   ```
   runhunt - Discover jobs, match, find contacts, send cold emails
   status - Show job/outreach/thread statistics
   followups - Send follow-up nudges to old sent emails
   apply - Apply to a job (Phase 2 — not implemented yet)
   applyall - Apply to all matched jobs (Phase 2 — not implemented yet)
   connect - Connect on LinkedIn with a note (Phase 2 — not implemented yet)
   checkreplies - Check email/LinkedIn replies (Phase 3 — not implemented yet)
   ```

5. **Save.** The commands are now registered for your bot.

## Using Slash Commands

In Telegram, when you open the chat with your Jobber bot, you'll see the slash commands in the autocomplete menu. Tap one to send it, or type it manually.

Examples:
```
/runhunt          → starts the full hunt (discover → match → send)
/status           → shows current job/outreach/thread counts
/followups        → sends follow-up emails to old outreach (Phase 1.5)
/apply 123        → applies to job #123 (Phase 2)
```

## Updating Commands

When Phase 2 or Phase 3 ships, update the list via BotFather again (`/setcommands`), and update this doc + `CLAUDE.md`'s Commands table.

Never leave a command description saying "Phase X not implemented yet" once Phase X is live — users will get confused.

## Fallback (Natural Language)

If a slash command doesn't work or you prefer natural language, the agent still understands:
- "run hunt" → `/runhunt`
- "show status" → `/status`
- "send follow-ups" → `/followups`

But slash commands are more reliable.
