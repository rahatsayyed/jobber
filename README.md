# Jobber

## What Jobber is

Jobber is an autonomous job-hunting agent. It discovers new job postings, scores each one against your base resume, tailors the resume for good matches, finds a verified contact at the hiring company, drafts a cold outreach email, and sends it. It also applies through LinkedIn Easy Apply and external ATS forms and sends LinkedIn connection requests. It sends real email and takes real LinkedIn actions on your own accounts, always inside daily caps that the code enforces.

**Phase 1 (complete):** cold-email discovery and outreach.
**Phase 2 (substantially complete):** LinkedIn Easy Apply (burner account, `apply.linkedin`, the one remaining use of the burner), external ATS apply and LinkedIn connection requests and messages (main account, typed `linkedin` tools). See [Phase 2 known issues](docs/phase2-known-issues.md) before treating it as fully production-proven.
**Phase 3 (in progress):** reply detection, email follow-ups (autonomous mode is built but ships off, see `FOLLOWUPS_AUTONOMOUS` in `.env.example`) and the funnel report.

---

## Prerequisites

Git and a shell. `bash scripts/bootstrap.sh` installs what is missing after asking (macOS with Homebrew first, with an Ubuntu variant): Node 20+ (`brew install node` on macOS, where Homebrew must already be installed or it stops with the URL; on Ubuntu `apt` with sudo after a prompt when the apt package is new enough, otherwise nvm or NodeSource instructions and nothing runs), then `npm ci`, tmux, uv, the pinned ccgram, git and build tools, and the Claude Code CLI only when the npm global prefix is writable (otherwise it prints instructions). Google Chrome is a brew cask on macOS and owner instructions on Ubuntu; the classifier model is downloaded only after consent, and age and rclone are reported only. The exact ccgram version is pinned in `config/ccgram.pin.json`; the start script refuses to run on any other version. You still log in to `claude` yourself.

---

## Quick start

New here? Read [docs/00-start-here.md](docs/00-start-here.md) first; the order is bootstrap, then setup, then dry-run, then up.

```bash
bash scripts/bootstrap.sh        # 1. install and validate everything missing (asks before each action)
npm run setup                    # 2. keys, accounts, sessions, limits; optional guided Claude session
npm run dry-run                  # 3. end-to-end smoke in dry mode only, PASS/FAIL per stage
npm run up                       # 4. start bridge, windows, scheduler, dashboard (and: npm run down)
```

- `bash scripts/bootstrap.sh` detects what is missing and asks before every install (sudo steps and downloaded scripts are always shown first). Rerunning is safe. `--check` and `--plan` only report. `--yes` accepts plain actions only; a sudo step is asked about even with `--allow-sudo` unless `--yes` is also given. Installs run with their own output on your terminal (up to 30 minutes each); the result table shows only the exit code.
- `npm run setup` is the guided wizard that writes `.env`, captures accounts and sessions, converts your resume, and chooses limits and a permission set. It needs a real terminal and exits with code 2 when stdin is not a TTY. `npm run setup -- --no-guide` skips the guided Claude session for one run.
- Setup has two modes, chosen once and remembered in `user-data/.setup-state.json`: agent (a guided Claude session in a detached tmux window beside the wizard; it is launched only when the Claude CLI, its login, the guide profile and `tmux -V` all pass, otherwise the wizard says why and continues in terminal text) and terminal (plain walkthroughs for every step, no guide). The first interactive run asks which you want, with the default chosen from that readiness. Set or switch it with `npm run setup -- --mode agent|terminal`; `--status` shows the stored mode.
- Telegram and the dashboard (both labelled RECOMMENDED), Gmail (NEEDED FOR EMAIL OUTREACH) and each API key (OPTIONAL) may be skipped; a skipped step shows as skipped (not failed) in `npm run doctor`, and you add it later with `npm run setup -- --step telegram` (or `dashboard`, `gmail`, `apikeys`). Skipping never changes a permission set or a dry-run flag.
- `npm run dry-run` runs an end-to-end smoke test against fixtures and a temporary database, prints PASS, FAIL or SKIP per stage and touches no live state: it writes `.jobber/verify.json` and idempotently rewrites the launcher's `debug/runner/<profile>.settings.json` and `.policy.json` (via `run-claude --print-args`). `--llm` adds a real hunt run and only runs when `.env` itself is dry (it uses subscription usage).
- `npm run up` runs the doctor first, starts the stack, and prints `MODE: DRY RUN` or `MODE: LIVE` at the top and bottom. It never changes the mode: your `.env` decides. `npm run down` stops it again without touching data.
- `npm run doctor` can be run at any time to check the result. Each check reports ok, warn, fail or skipped.

None of these four commands has been run end to end against a real machine yet; treat the first run as supervised.

Setup is resumable and safe to rerun: a step whose checks already pass skips itself, and it never overwrites an existing resume, answers file or `.env` value without a confirm and a backup. Useful flags: `npm run setup -- --list` (print step ids), `npm run setup -- --step <id>` (run one step), `npm run setup -- --redo` (run steps again even when they pass).

---

## What setup does

In this order:

- `prereqs`: checks Node, tmux, Chrome, the browser binaries (patchright and Playwright) and the pinned ccgram version, and prints a fix for anything missing.
- `claude`: checks that the Claude Code CLI is installed and logged in, and tells you how to log in if it is not.
- `telegram`: walks you through creating a bot with @BotFather, tells you to enable Topics and turn Group Privacy off, stores the bot token in `.env` (never echoed), asks you to confirm Threaded Mode (topics) is on, records your numeric Telegram ID in `ALLOWED_USERS` (a comma-separated list of numeric IDs; each extra ID needs an explicit extra confirmation), and sends a test message. Skippable (RECOMMENDED): without it there is no phone control, no Telegram alerts and no approved email follow-ups, and `npm run up` starts no bridge or ccgram windows.
- `gmail`: guides you through creating a Desktop OAuth client in your own Google Cloud project, then runs the consent screen so the send token stays on this machine. Skippable (NEEDED FOR EMAIL OUTREACH): without it there is no cold email, no email follow-ups and no reply watching; LinkedIn and Naukri outreach still run.
- `apikeys`: optional Adzuna, Serper and Hunter keys, each skippable; Hunter stays off unless you confirm. Skipping it leaves those sources off (OPTIONAL).
- `sessions`: opens a browser so you log in once to the burner LinkedIn account (applying), the main LinkedIn account (people search, connection requests and messages) and Naukri; the saved sessions live in `secrets/`.
- `resume`: has a model transcribe your resume text into `user-data/resume.json`, rejects any number that is not in your source text, and writes nothing until you confirm.
- `profile`: asks for roles, locations, remote preference, salary floors and targets, notice period and work authorization, and writes `user-data/profile.json`, the application answers file and the language list.
- `limits`: shows every daily cap, quiet hour and pacing value with its default and an explanation, and writes the ones you choose to `.env`.
- `access`: asks which permission set sessions may use (default `read_only`), applies it and installs the ccgram hooks into `.claude/settings.local.json`.
- `classifier`: downloads the prompt-injection classifier model (about 750 MB) only after you consent, then verifies its files. The default model is English-only; see [classifier models](docs/classifier-models.md) for licences, limitations and how to switch. The smoke test is skipped while the files are only pinned by a weaker hash. Live LinkedIn and Naukri reads and sends are refused (fail closed) until a model is downloaded, pinned and fitted and `CLASSIFIER_MODEL` is set; dry runs continue unscreened.
- `dashboard`: sets up dashboard sign-in. The default is a one-time access token (`npm run dashboard -- token`, shown once, only its hash is stored); Google desktop and OIDC with one allowed Google account are options. The sign-in part is skipped only if `scripts/dashboard.ts` is missing (it is present in this repository). Skippable (RECOMMENDED): without it there is no browser status page, `npm run up` starts no `web` window, and `/limits`, `/working`, `/health` and `npm run status` still work.
- `final`: runs the doctor once more, lists anything still open and prints the next steps.

---

## Before going live: the classifier model

Live LinkedIn and Naukri reads and sends fail closed until a classifier model is downloaded, pinned and fitted. Dry runs continue, with text marked unscreened. Nothing downloads automatically. The default model (ProtectAI DeBERTa, about 750 MB of disk) is English-only and does not detect jailbreaks. In order:

1. `npm run models -- fetch` (asks before downloading; the default profile).
2. `npm run models -- verify`
3. `npm run models -- pin protectai-deberta-v3-base-v2` (review the diff of `config/classifier-models.json`).
4. `npm run classifier:fit -- --profile protectai-deberta-v3-base-v2 --write`
5. Set `CLASSIFIER_MODEL=protectai-deberta-v3-base-v2` in `.env` (the setup `classifier` step does this for you).
6. `npm run doctor` must show `classifier_wired` ok, then restart sessions.

`npm run setup -- --step classifier` covers fetch, verify and the `.env` line. To use Llama Prompt Guard 2 instead, see [classifier models](docs/classifier-models.md).

---

## Where your data lives

| Location | Holds | Notes |
|---|---|---|
| `user-data/` | resume, application answers, languages, profile, fact-gate allow-lists | mode 700, git-ignored; start from the synthetic `user-data.example/` with `npm run user-data -- init` |
| `.env` | settings, limits and tokens | mode 600, git-ignored; copy `.env.example` if you skip the wizard |
| `secrets/` | Gmail OAuth files, LinkedIn and Naukri session files | git-ignored |
| `data.sqlite` | jobs, scores, outreach queue, outcomes, counters | git-ignored |

None of it is committed because `.gitignore` excludes these names (there is no pre-commit guard any more, so check `git status` before you commit). None of it is sent to a model beyond what a single stage needs for its job.

---

## Permission sets

Sessions run with an allow-list of tool names taken from one set in `config/permission-sets.json`. The set is the ceiling for what a session may do.

- `read_only`: the default. Look at stats, drafts and status; nothing is sent, applied or changed.
- `outreach_send`: `read_only` plus the tools that fetch jobs, queue outreach, and send email, LinkedIn connection requests and messages, Naukri messages and applications (still bound by the daily and weekly caps).
- `full`: `outreach_send` plus whole MCP servers, every tool they expose. Only for someone who has read the tool list.

Change it with `npm run setup -- --step access`. No session ever runs with skip-permissions.

---

## Starting and stopping sessions

```bash
bash scripts/ccgram/start.sh    # start the Telegram bridge (ccgram) in its own tmux session
bash scripts/ccgram/stop.sh     # stop the bridge; Claude windows it created keep running
```

- `npm run up` starts all of this in order (bridge, named windows, scheduler, dashboard; `npm run up -- --status` is read-only) and `npm run down` stops it (`--keep-bridge` leaves the bridge running). The commands above and `./run-hunt.sh` remain the building blocks and the manual route.
- The Telegram topic bound to the manager session lists, reads, starts and stops the named windows in `config/manager-windows.json` (`hunt` and `followups`). The `manager` window and the bridge are protected and cannot be stopped from Telegram. The manager never types into another window and never runs outreach itself. See [the manager skill](.claude/skills/manager/SKILL.md).
- A headless, cron-friendly hunt runs with `./run-hunt.sh "run the hunt"`. It uses the restricted launcher `scripts/run-claude.sh`, profile `hunt` in `config/run-profiles.json`: the tool list comes from the `outreach_send` set, and permission checks are never skipped.
- The older route, a single `claude --channels plugin:telegram@claude-plugins-official` session, is documented in `CLAUDE.md`; the ccgram route above is the one setup configures.
- To route Claude Code through another Anthropic-compatible provider (for example the Claude Code Router), see [model auth setup](docs/model-auth-setup.md). If a `.env.ccr` file exists, the launcher reads it. It is optional.

---

## Status commands

- `npm run doctor`: environment and configuration checks.
- `npm run status -- limits`, `npm run status -- working`, `npm run status -- health`: today's caps and usage, the queue and halts, and platform health. The same three are the `/limits`, `/working` and `/health` Telegram commands (see [slash commands](docs/telegram-slash-commands.md)).
- `npm run report`: a self-contained HTML funnel report under `reports/`.
- `npm run web`: the local status page, described in the next section.

Commands you can send from Telegram (or type in a CLI session):

- `/runhunt`: run the full pipeline (discover, match, contacts, drafts, send).
- `/status`: funnel, reply and interview rates.
- `/followups`: check replies, then draft email follow-ups; they wait for your approval unless `FOLLOWUPS_AUTONOMOUS=true` (ships off), in which case code approves and sends them under the shared daily send cap.
- `/checkreplies`: detect replies in Gmail and propose outcomes.
- `/apply #N`: apply to one matched job.
- `/limits`, `/working`, `/health`: caps and usage, queue and halts, platform health.

---

## Status web page

Start it with `npm run web`; on first run use `npm run dashboard -- token` (setup does this for you) and open the printed URL. The token is shown once, and `npm run dashboard -- rotate` replaces it. The sign-in mode is `WEB_AUTH_MODE`: `token` (default), `google_desktop` (loopback only, reuses the Gmail Desktop client, unverified) or `oidc` (Web client, `WEB_OIDC_*`); see `.env.example`, and `npm run doctor` shows the dashboard checks. `npm run web` prints `http://127.0.0.1:<port>`.

- The send box is off unless `WEB_CHAT_ENABLED=true`; when on, it types your text into a live Claude session after a two-step confirmation; the only slash commands it accepts are bare `/limits`, `/working` and `/health`. Keep the permission set at `read_only` unless you need more.
- Text typed in the chat box also answers any pending permission or confirmation prompt in the Claude window, so only enable it for an account you trust and keep the permission set `read_only`.
- The page listens on localhost only. From another machine use an SSH tunnel (`ssh -L 8787:127.0.0.1:8787 host`); never open the port.
- Exposure options and login recovery: [docs/dashboard-exposure.md](docs/dashboard-exposure.md).

---

## The hunt pipeline

"Run hunt" dispatches one subagent per stage and sees only each stage's compact result:

1. **Discover** (`discoverer`): new jobs from Adzuna, Remotive, RemoteOK, Naukri, company boards and LinkedIn.
2. **Match** (`matcher`): scores each job against your base resume; code vetoes (location, language, deal-breakers, legitimacy) then apply.
3. **Filter**: jobs below `MATCH_THRESHOLD` (default 60) are skipped.
4. **Find contacts** (`contact-finder`): a verified email and up to two LinkedIn profiles per job.
5. **Prepare** (`outreach-preparer`): tailors the resume, drafts the email and connect notes, reviews and fact-checks them, then queues them.
6. **Execute** (`sender`): sends email, connection requests and applies from the queue, within the caps. Email follow-ups are not part of the hunt; they run from the follow-up command.
7. **Report**: counts and flags to Telegram, or to the terminal when Telegram is not active.

Tune the basics in the Preferences block of `CLAUDE.md` and the limits in `.env`:

```
MATCH_THRESHOLD=60        # min score to pursue a job
SEND_LIMIT_PER_RUN=1      # max real emails per day (a daily counter, not per invocation)
```

---

## Safety model

- Email goes only to addresses marked verified; an unverified guess is never sent to.
- Caps (daily emails and applies, weekly LinkedIn invites and messages) are enforced in code, not by prompts; items over a cap stay queued.
- A fact gate blocks resumes and emails that contain claims not supported by your own resume.
- Reply outcomes need your explicit approval; auto-recording of outcomes ships off. Email follow-ups need your approval by default; with `FOLLOWUPS_AUTONOMOUS=true` (ships `false`) they send without approval under four code guards (fresh clean reply check, claim step, block list, fact gate) and the same daily send cap.
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

- **xAI "Invalid message role", OpenRouter 402 or Claude Code Router problems:** see [model auth setup](docs/model-auth-setup.md).
- **Anything looks wrong:** `npm run doctor` names the failing check and the fix.
- **Gmail not authorized:** rerun `npm run setup -- --step gmail` (see [Gmail setup](docs/gmail-mcp-setup.md)).
- **LinkedIn or Naukri session expired:** rerun `npm run setup -- --step sessions` (see [LinkedIn sessions](docs/linkedin-sessions-setup.md) and [Naukri session](docs/naukri-session-setup.md)).
- **Playwright PDF rendering fails:** `npx playwright install --with-deps chromium`.
- **Jobs found but no matches:** lower `MATCH_THRESHOLD` temporarily or add missing skills to `user-data/resume.json`.

---

## Links

- Owner docs: [docs/00-start-here.md](docs/00-start-here.md) first, then the [index](docs/index.md) for operations, rollout, config reference, architecture and more.
- [CLAUDE.md](CLAUDE.md): full orchestration spec and safety rules.
- [Platform, sessions, dashboard and setup requirements](docs/superpowers/specs/2026-10-14-platform-sessions-dashboard-setup-requirements.md)
- [Plans](docs/superpowers/plans/) and [design specs](docs/superpowers/specs/)
- [Phase 2 known issues](docs/phase2-known-issues.md)
- [Model auth setup](docs/model-auth-setup.md)
- [Gmail setup](docs/gmail-mcp-setup.md)
- [LinkedIn sessions setup](docs/linkedin-sessions-setup.md)
- [Naukri session setup](docs/naukri-session-setup.md)
- [Classifier models](docs/classifier-models.md)
- [Telegram bot setup](docs/telegram-bot-setup.md)
- [Telegram slash commands](docs/telegram-slash-commands.md)
- [Telegram bot branding](docs/telegram-branding.md)
