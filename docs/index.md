# Owner docs index

Audience: owner
Last verified against: 384fcd7
Source files: docs/, README.md, CLAUDE.md, tests/docs-owner.test.ts

This page lists every owner doc in `docs/`. Start with the ordered list, then use the topic list as a reference.

## Read in this order

1. [Start here](00-start-here.md): the ordered path from clone to first supervised send.
2. [Prerequisites](prerequisites.md): what you need on the machine and in your accounts before you begin.
3. [Setup modes](setup-modes.md): bootstrap, setup (agent or terminal), dry-run, start and stop (`npm start`, `npm stop`).
4. [API keys](api-keys.md): which keys and credentials exist and where each goes.
5. [Config reference](config-reference.md): what lives in `config/`, `user-data/` and the env catalog.
6. [Rollout](rollout.md): the five phases from dry run to autonomous.
7. [Operations](operations.md): stop, halts, dry run, status, logs and the failure table.
8. [Scheduler install](scheduler-install.md): launchd and systemd units for the scheduler.
9. [Layout memory](layout-memory.md): how page layouts are remembered and what drift does.
10. [Dashboard login](dashboard-login.md): the login options for the dashboard.
11. [Architecture](architecture.md): how the pieces fit together.

## Topic docs

- [Backup and restore](backup-and-restore.md): encrypted backup, restore drill and auto-update runbook.
- [Classifier models](classifier-models.md): the prompt-injection classifier and how to fetch, pin and fit a model.
- [Dashboard exposure](dashboard-exposure.md): how to reach the dashboard from elsewhere and the sign-in modes.
- [Gmail MCP setup](gmail-mcp-setup.md): Gmail sending and reading runbook.
- [LinkedIn sessions setup](linkedin-sessions-setup.md): the main and burner LinkedIn sessions.
- [Model auth setup](model-auth-setup.md): how Claude Code picks the model and how it is authenticated.
- [Naukri session setup](naukri-session-setup.md): saving the Naukri login session.
- [Phase 2 known issues](phase2-known-issues.md): live-test findings recorded during Phase 2.
- [Telegram bot setup](telegram-bot-setup.md): bot and bridge runbook.
- [Telegram bot branding](telegram-branding.md): text to paste into BotFather.
- [Telegram slash commands](telegram-slash-commands.md): the slash command list and setup.

## For developers

Plans are in [superpowers/plans/](superpowers/plans/) and design specs in [superpowers/specs/](superpowers/specs/).

## Staleness

Each owner doc carries a `Last verified against:` line with the short commit hash it was last checked against. A page is only as fresh as that hash, so if the repo has moved on, treat the page with care and recheck it against the code. To check that the markers, links, script names, env vars and config files named in the docs still resolve, run:

```bash
env DOCS_STRICT=1 npx vitest run tests/docs-owner.test.ts
```

The command passes when every owner doc has a real hash marker and no dead reference. A failure names the file and the problem.
