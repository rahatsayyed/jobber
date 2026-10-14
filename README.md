# Jobber

## What Jobber is

Jobber is an autonomous job-hunting agent. It discovers new job postings, scores each one against your base resume, tailors the resume for good matches, finds a verified contact at the hiring company, drafts a cold outreach email, and sends it. It also applies through LinkedIn Easy Apply and external ATS forms and sends LinkedIn connection requests. It sends real email and takes real LinkedIn actions on your own accounts, always inside daily caps that the code enforces.

**Phase 1 (complete):** cold-email discovery and outreach.
**Phase 2 (substantially complete):** LinkedIn Easy Apply (burner account), external ATS apply and LinkedIn connection requests (main account). See [Phase 2 known issues](docs/phase2-known-issues.md) before treating it as fully production-proven.
**Phase 3 (in progress):** reply detection, follow-ups and the funnel report.

---

## Prerequisites

- **Node 20+** (matches `engines` in `package.json`).
- **Git**.
- **Claude Code CLI** (`claude`), logged in. Every stage runs through it.
- **Google Chrome**: needed for Naukri headless search and for capturing LinkedIn and Naukri sessions.
- **tmux** and **ccgram** (installed with `uv` and Python): needed only for Telegram sessions. The exact ccgram version is pinned in `config/ccgram.pin.json`; the start script refuses to run on any other version.

---

## Quick start

```bash
npm install
npm run setup
npm run doctor
```

- `npm install` installs dependencies.
- `npm run setup` is a guided wizard that writes `.env`, captures accounts and sessions, converts your resume, and chooses limits and a permission set. It needs a real terminal and exits with code 2 when stdin is not a TTY (a pipe or CI).
- `npm run doctor` checks the result. Each check reports ok, warn, fail or skipped (for pieces that a later plan installs).

Setup is resumable and safe to rerun: a step whose checks already pass skips itself, and it never overwrites an existing resume, answers file or `.env` value without a confirm and a backup. Useful flags: `npm run setup -- --list` (print step ids), `npm run setup -- --step <id>` (run one step), `npm run setup -- --redo` (run steps again even when they pass).

---

## What setup does

In this order:

- `prereqs`: checks Node, tmux, Chrome, the Claude CLI, ccgram and Git, and prints a fix for anything missing.
- `claude`: checks that Claude Code is installed and logged in, and tells you how to log in if it is not.
- `telegram`: walks you through creating a bot with @BotFather, stores the bot token in `.env` (never echoed), records your numeric Telegram ID as the only allowed user, and sends a test message.
- `gmail`: guides you through creating a Desktop OAuth client in your own Google Cloud project, then runs the consent screen so the send token stays on this machine.
- `sessions`: opens a browser so you log in once to the burner LinkedIn account (applying), the main LinkedIn account (connection requests) and Naukri; the saved sessions live in `secrets/`.
- `resume`: has a model transcribe your resume text into `user-data/resume.json`, rejects any number that is not in your source text, and writes nothing until you confirm.
- `profile`: asks for roles, locations, remote preference, salary floors and targets, notice period and work authorization, and writes `user-data/profile.json`, the application answers file and the language list.
- `limits`: shows every daily cap, quiet hour and pacing value with its default and an explanation, and writes the ones you choose to `.env`.
- `access`: asks which permission set sessions may use (default `read_only`), applies it and installs the ccgram hooks into `.claude/settings.local.json`.
- `classifier`: downloads the prompt-injection classifier model (about 750 MB) only after you consent, then verifies its files. The default model is English-only; see [classifier models](docs/classifier-models.md) for licences, limitations and how to switch. The smoke test is skipped while the files are only pinned by a weaker hash.
- `dashboard`: sets up sign-in with one allowed Google account through an OAuth client from your own Google Cloud project; no password or token is created and the client secret is stored only in `.env`. The sign-in part is skipped until plan 7C (the dashboard) is installed.
- `final`: runs the doctor once more, lists anything still open and prints the next steps.

---

## Where your data lives

| Location | Holds | Notes |
|---|---|---|
| `user-data/` | resume, application answers, languages, profile, fact-gate allow-lists | mode 700, git-ignored; start from the synthetic `user-data.example/` with `npm run user-data -- init` |
| `.env` | settings, limits and tokens | mode 600, git-ignored; copy `.env.example` if you skip the wizard |
| `secrets/` | Gmail OAuth files, LinkedIn and Naukri session files | git-ignored |
| `data.sqlite` | jobs, scores, outreach queue, outcomes, counters | git-ignored |

None of it is committed (a pre-commit guard blocks these names; enable it with `git config core.hooksPath .githooks`). None of it is sent to a model beyond what a single stage needs for its job.

---

## Permission sets

Sessions run with an allow-list of tool names taken from one set in `config/permission-sets.json`. The set is the ceiling for what a session may do.

- `read_only`: the default. Look at stats, drafts and status; nothing is sent, applied or changed.
- `outreach_send`: `read_only` plus the tools that fetch jobs, queue outreach, and send email, connection requests and applications (still bound by the daily caps).
- `full`: `outreach_send` plus whole MCP servers, every tool they expose. Only for someone who has read the tool list.

Change it with `npm run setup -- --step access`. No session ever runs with skip-permissions.

---

## Starting and stopping sessions

```bash
bash scripts/ccgram/start.sh    # start the Telegram bridge (ccgram) in its own tmux session
bash scripts/ccgram/stop.sh     # stop the bridge; Claude windows it created keep running
```

- The Telegram topic bound to the manager session lists, reads, starts and stops the named windows in `config/manager-windows.json` (`hunt` and `followups`). The `manager` window and the bridge are protected and cannot be stopped from Telegram. The manager never types into another window and never runs outreach itself. See [the manager skill](.claude/skills/manager/SKILL.md).
- A headless, cron-friendly hunt runs with `./run-hunt.sh "run the hunt"`. It uses the restricted launcher `scripts/run-claude.sh`, profile `hunt` in `config/run-profiles.json`: the tool list comes from the `outreach_send` set, and permission checks are never skipped.
- The older route, a single `claude --channels plugin:telegram@claude-plugins-official` session, is described in `CLAUDE.md` and still works, but the ccgram route above is the one setup configures.
- To route Claude Code through another Anthropic-compatible provider (for example the Claude Code Router), see [model auth setup](docs/model-auth-setup.md). If a `.env.ccr` file exists, the launcher reads it. It is optional.

---

## Status commands

- `npm run doctor`: environment and configuration checks.
- `npm run status -- limits`, `npm run status -- working`, `npm run status -- health`: today's caps and usage, the queue and halts, and platform health. The same three are the `/limits`, `/working` and `/health` Telegram commands (see [slash commands](docs/telegram-slash-commands.md)).
- `npm run report`: a self-contained HTML funnel report under `reports/`.
- `npm run web`: the local status page, described in the next section.

---

## Status web page

Start it with `npm run web` (needs `WEB_TOKEN` of at least 24 characters in `.env`; see `.env.example`). It prints `http://127.0.0.1:<port>`.

- The send box types into a live Claude session. Keep the permission set at `read_only` unless you need more.
- Text typed in the chat box also answers any pending permission or confirmation prompt in the Claude window, so only enable it with a token you trust and keep the permission set `read_only`.
- The page listens on localhost only. From another machine use an SSH tunnel (`ssh -L 8787:127.0.0.1:8787 host`); never open the port.

---

## The hunt pipeline

"Run hunt" dispatches one subagent per stage and sees only each stage's compact result:

1. **Discover** (`discoverer`): new jobs from Adzuna, Remotive, RemoteOK, Naukri, company boards and LinkedIn.
2. **Match** (`matcher`): scores each job against your base resume; code vetoes (location, language, deal-breakers, legitimacy) then apply.
3. **Filter**: jobs below `MATCH_THRESHOLD` (default 60) are skipped.
4. **Find contacts** (`contact-finder`): a verified email and up to two LinkedIn profiles per job.
5. **Prepare** (`outreach-preparer`): tailors the resume, drafts the email and connect notes, reviews and fact-checks them, then queues them.
6. **Execute** (`sender`): sends email, connection requests and applies from the queue, within the daily caps.
7. **Report**: counts and flags to Telegram, or to the terminal when Telegram is not active.

Tune the basics in the Preferences block of `CLAUDE.md` and the limits in `.env`:

```
MATCH_THRESHOLD=60        # min score to pursue a job
SEND_LIMIT_PER_RUN=1      # max real emails per day (a daily counter, not per invocation)
```

---

## Safety model

- Email goes only to addresses marked verified; an unverified guess is never sent to.
- Daily caps (emails, applies, connects, messages) are enforced in code, not by prompts; items over a cap stay queued.
- A fact gate blocks resumes and emails that contain claims not supported by your own resume.
- Follow-ups and reply outcomes need your explicit approval; auto-recording of outcomes ships off.
- The permission set is the ceiling, and no session skips permissions. Job posting text, board data and reply mail are untrusted input and never instructions.

---

## Deploying to a VPS

Provision any small Ubuntu host, install Node 20+, git, tmux, Chrome, the Claude Code CLI and ccgram, then:

```bash
git clone <your-repo-url> ~/jobber
cd ~/jobber
npm install
npm run setup        # run it in a real terminal (ssh -t or tmux)
bash scripts/ccgram/start.sh
```

Capture the LinkedIn and Naukri sessions on a machine with a display, or run the `sessions` step over a forwarded display; `secrets/` is never committed, so copy only what you need. For scheduled runs add a crontab line such as:

```
0 9 * * * cd ~/jobber && ./run-hunt.sh "run the hunt" >> hunt.log 2>&1
```

---

## Troubleshooting

- **Anything looks wrong:** `npm run doctor` names the failing check and the fix.
- **Gmail not authorized:** rerun `npm run setup -- --step gmail` (see [Gmail setup](docs/gmail-mcp-setup.md)).
- **LinkedIn or Naukri session expired:** rerun `npm run setup -- --step sessions` (see [LinkedIn sessions](docs/linkedin-sessions-setup.md) and [Naukri session](docs/naukri-session-setup.md)).
- **Playwright PDF rendering fails:** `npx playwright install --with-deps chromium`.
- **Jobs found but no matches:** lower `MATCH_THRESHOLD` temporarily or add missing skills to `user-data/resume.json`.

---

## Links

- [CLAUDE.md](CLAUDE.md): full orchestration spec and safety rules.
- [Platform, sessions, dashboard and setup requirements](docs/superpowers/specs/2026-10-14-platform-sessions-dashboard-setup-requirements.md)
- [Plans](docs/superpowers/plans/) and [design specs](docs/superpowers/specs/)
- [Phase 2 known issues](docs/phase2-known-issues.md)
- [Model auth setup](docs/model-auth-setup.md)
- [Gmail setup](docs/gmail-mcp-setup.md)
- [LinkedIn sessions setup](docs/linkedin-sessions-setup.md)
- [Naukri session setup](docs/naukri-session-setup.md)
- [Classifier models](docs/classifier-models.md)
- [Telegram slash commands](docs/telegram-slash-commands.md)
