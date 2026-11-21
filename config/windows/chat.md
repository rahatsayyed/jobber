# Window `chat` (the owner's Telegram chat topic)

Status on request: when the owner asks "status", "kya hua", "what happened" or similar, run `npx tsx scripts/status.ts digest` (add `--since 3h` for a longer span) and answer from its output. Routine notices (every email, invite, wake) arrive only as an hourly digest; this command gives the same summary for now. The commands `/status`, `/working`, `/health` and `/sources` stay as they are.
