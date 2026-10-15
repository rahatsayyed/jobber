---
description: Show what the agent is working on: queue, halts and funnel
allowed-tools: Bash(npx tsx scripts/status.ts working:*)
---

Run exactly this one command and nothing else:

`npx tsx scripts/status.ts working`

The command is `npm run status -- working` (same script). Print its output unchanged, including any
halted state and kill switch line it reports. Do nothing else and take no other action.
