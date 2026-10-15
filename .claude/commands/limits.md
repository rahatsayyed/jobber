---
description: Show today's send, apply and connect limits and usage
allowed-tools: Bash(npx tsx scripts/status.ts limits:*)
---

Run exactly this one command and nothing else:

`npx tsx scripts/status.ts limits`

The command is `npm run status -- limits` (same script). Print its output unchanged, including any
halted state and kill switch line it reports. Do nothing else and take no other action.
