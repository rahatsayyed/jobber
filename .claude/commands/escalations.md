---
description: List the open escalations that need the owner (replies, recruiter inquiries, platform problems)
allowed-tools: Bash(npx tsx scripts/status.ts escalations:*)
---

Run exactly this one command and nothing else:

`npx tsx scripts/status.ts escalations`

The command is `npm run status -- escalations` (same script). Print its output unchanged. Do nothing else and take no other action. Never reply to anyone on a platform; the owner answers there and marks the item handled in the dashboard Inbox tab.
