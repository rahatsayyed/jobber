---
description: Show platform and pipeline health
allowed-tools: Bash(npx tsx scripts/status.ts health:*)
---

Run exactly this one command and nothing else:

`npx tsx scripts/status.ts health`

The command is `npm run status -- health` (same script). Print its output unchanged, including any
halted state and kill switch line it reports. Do nothing else and take no other action.
