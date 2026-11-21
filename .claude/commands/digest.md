---
description: Show what happened lately (the Telegram digest for now): sent, found, replies, problems
allowed-tools: Bash(npx tsx scripts/status.ts digest:*)
---

Run exactly this one command and nothing else (add `--since 3h` when the owner names a span, for example `--since 90m` or `--since 2d`):

`npx tsx scripts/status.ts digest`

Print its output unchanged. Do nothing else and take no other action.
