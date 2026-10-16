# Setup modes and the bring-up commands

Audience: owner
Last verified against: cc51247
Source files: scripts/bootstrap.sh, scripts/bootstrap.ts, scripts/setup.ts, scripts/stack.ts, scripts/dry-run.ts, src/setup/cli.ts, src/setup/mode.ts, src/setup/guide.ts, src/setup/skips.ts, src/setup/state.ts, src/setup/runner.ts, src/setup/steps/index.ts, src/setup/steps/final.ts, src/bootstrap/exec.ts, src/bootstrap/catalog.ts, src/stack/up.ts, src/stack/down.ts, src/stack/mode.ts, src/verify/cli.ts, src/verify/stages.ts

This page is the map of the owner path. It does not repeat the wizard's prompt wording: each
step is named by its id, and the wizard explains it on screen.

## The owner path, in order

```bash
bash scripts/bootstrap.sh
npm run setup
npm run dry-run
npm start
```

1. `bootstrap` installs what is missing (Node, dependencies, tmux, browser binaries, ccgram, the
   Claude CLI, the classifier model) after asking. It prints a table and exits.
2. `setup` is the guided wizard. It writes `.env`, `user-data/` and `secrets/` files, and records
   progress so you can stop and resume.
3. `dry-run` is an end-to-end check against fixtures and a temporary database. It sends nothing.
4. `up` runs the doctor, then starts the bridge, windows, scheduler and dashboard. `npm stop`
   stops them. `npm start` and `npm stop` are the same as `npm run up` and `npm run down`.

Nothing here flips a dry-run flag for you. `up` prints the mode; you alone change the flags in
`.env`.

## Setup modes

`npm run setup` runs in one of two modes. The mode is asked once on an interactive run and
remembered as `mode` (with `mode_at`) in the setup state file under `user-data/`
(`.setup-state.json`).

| Mode | What you get |
|---|---|
| `agent` | The wizard in your terminal plus a Claude coach in a second tmux window (session `jobber-setup`, window `guide`, started through the `setup_guide` run profile). The coach explains each step and reads doctor results. It never receives your keys; you type secrets in the wizard window. |
| `terminal` | The wizard alone. It explains every value in the terminal and asks you to confirm each step. |

### Flags

```bash
npm run setup -- --mode agent
npm run setup -- --mode terminal
npm run setup -- --no-guide
npm run setup -- --step <id>
npm run setup -- --redo
npm run setup -- --list
npm run setup -- --status
npm run setup -- --guide-only
```

Each line above is a separate invocation. Their effects:

- `--mode agent|terminal`: sets and stores the mode, then runs. Refused with `--no-guide` (for
  agent), with `--guide-only` (for terminal) and with `--list` or `--status`.
- `--no-guide`: this run is terminal-only. It is never stored. A stored `agent` mode stays stored.
  Cannot be combined with `--guide-only`.
- `--step <id>`: run only that step, in the stored mode (or in terminal text, without storing a
  mode, when none is stored), with no mode chooser and no guide launch. An unknown id lists the
  known ids.
- `--redo`: run steps even when their doctor checks already pass; also lets the guide be offered
  again.
- `--list`: print the step ids and exit.
- `--status`: print each step as done, skipped or pending, with its time, and exit. A step that setup
  never recorded but that is configured already (done by hand: the matching doctor checks pass, or the
  skippable feature is configured) shows `configured (not via setup)` instead of `pending`. This is only a
  display: the state file is not written. It runs the cheap doctor checks (the Telegram check makes one
  request when a bot token is set; the classifier smoke is not run).
- `--guide-only`: start only the guided session in this terminal.
- The wizard needs a real terminal (stdin and stdout are TTYs); otherwise it exits 2 with a message.
  Bad arguments also exit 2.

### How the mode is chosen

1. `--mode` wins and is saved.
2. Else a stored mode is used (`--mode` changes it).
3. Else, with `--no-guide` or without a terminal, the run is `terminal` and nothing is stored.
4. Else the chooser asks. Its default is `agent` when the guide is ready, `terminal` when not.

### What agent mode needs

The guide launches only when all of these pass: the doctor checks `claude-cli`, `claude-login`
and `setup_guide_ready`, and `tmux -V` works. Otherwise the wizard prints why ("The guide is not
ready: ...") and continues in terminal-only text. You can still store `agent` while it is not
ready; the guide starts on a later run once the checks pass. If the `jobber-setup` session already
runs, the wizard says so instead of starting a second one. With no tmux, open a second terminal
and run `npm run setup -- --guide-only`.

## Wizard steps

Step order is the step list in `src/setup/steps/index.ts`. A step is skipped over when its doctor
checks already pass, unless you pass `--redo`. The "Owner-only" column marks actions only a
human can do (account login, consent screens, key creation, sudo); the agent coach never types
for you in any step. Writes to `.env` go through the comment-preserving writer.

| # | Step id | What it covers | Writes | Owner-only part | Skippable |
|---|---|---|---|---|---|
| 1 | `prereqs` | Checks Node, tmux, Chrome, browser binaries and the ccgram version; points to `bash scripts/bootstrap.sh` for installs | nothing | sudo or package installs | no |
| 2 | `claude` | Claude Code installed and logged in | nothing | the `claude` login | no |
| 3 | `telegram` | Bot token from BotFather, Threaded Mode, chat id, a test message | `.env` (`TELEGRAM_BOT_TOKEN` and the allowed-user key) | creating the bot, pasting the token | yes, id `telegram` |
| 4 | `gmail` | Google Cloud project, consent screen, OAuth client file, authorisation | Creates the directory of `GMAIL_OAUTH_PATH` (mode 700) and chmods the keys file 600 if present; the auth helper writes the credentials file at `GMAIL_CREDENTIALS_PATH` (chmod 600). It never writes the OAuth keys file: you download it to `GMAIL_OAUTH_PATH` yourself | Downloading the OAuth keys file, OAuth consent in a browser | yes, id `gmail` |
| 5 | `apikeys` | Adzuna, Serper, Hunter keys, each checked with one best-effort call | `.env` | creating each key | yes, id `apikeys`, per provider |
| 6 | `sessions` | LinkedIn burner, LinkedIn main and Naukri login sessions | files under `secrets/` | every login (password, 2FA, QR) | per account, can be deferred |
| 7 | `resume` | Converts your resume file to `user-data/resume.json` | `user-data/resume.json` | supplying your resume | can stop with the step skipped |
| 8 | `profile` | Job questions and the answers file | `user-data/profile.json`, the Easy Apply answers file | answering about yourself | no |
| 9 | `limits` | Limits and pacing, from the single catalog `src/setup/limitsCatalog.ts` | `.env` | choosing values | no |
| 10 | `access` | Permission set and project hooks; never skip-permissions | `.claude/settings.local.json` (permission set and ccgram hooks, in the same file); appends missing rules to `.gitignore` after confirmation | choosing the set, confirming the `.gitignore` additions | hooks part can be declined |
| 11 | `classifier` | Prompt-injection classifier: choose a profile, download, pin, fit | `.env` (the classifier model key), `models/` | choosing the profile, large download | step can end skipped; live reads and sends stay refused until it is ready |
| 12 | `dashboard` | Local web settings, then the access token (or Google sign-in) | `.env` (`WEB_AUTH_MODE`, `WEB_PORT`, `WEB_TMUX_SESSION`, `WEB_TMUX_WINDOW`, and `DASHBOARD_ALLOWED_EMAIL` for the Google option); the token is created by `scripts/dashboard.ts` | opening the sign-in link once | yes, id `dashboard` |
| 13 | `final` | Full doctor run, optional `chmod 600` of the database, list of what is still open and the next commands | file mode only | running the printed next commands | always runs |

Notes:

- Do not copy limit values from this page. Use `npm run status -- limits` and the catalog file.
- Sessions follow the account rule in `CLAUDE.md` (burner for apply, main for connects). Setup
  details: [LinkedIn sessions](linkedin-sessions-setup.md) and [Naukri session](naukri-session-setup.md).
- Bot creation: [Telegram bot setup](telegram-bot-setup.md). Gmail: [Gmail MCP setup](gmail-mcp-setup.md).
  Classifier: [classifier models](classifier-models.md).
- Dashboard sign-in details are in [dashboard login](dashboard-login.md). API keys:
  [API keys](api-keys.md). Prerequisites: [prerequisites](prerequisites.md). Day-to-day running
  after setup: [operations](operations.md).
- Terminal mode prints longer explanations than agent mode (`src/setup/coach.ts`), and both
  label the parts only a human can do (OAuth consent, bot creation, key creation, browser logins).
- Exit codes of `npm run setup`: 0 when no step failed (a skipped step still gives 0), 1 when at
  least one step failed, 2 for a usage error, no terminal, or an unknown `--step` id. A step that
  ends `skipped` is not recorded as done and is asked again on the next run. A step that fails
  or does not pass its checks gets retry and skip prompts.

### What skipping costs

Only four features are skippable as a recorded choice (catalog in `src/setup/skips.ts`). A skip is
a state entry `steps.<id>.status: skipped`. It never writes `.env`, a dry-run flag, a permission
set or a halt. Only a deliberate choice records a skip (answering "Skip for now", or choosing skip
when a confirmation is offered). A step that simply did not finish (a failed token or consent
command, a declined sign-in method, the dashboard script not installed yet) ends `pending`: nothing
is recorded, a skip recorded earlier is cleared, and the doctor, `npm run up` and the dry-run
`dashboard-login` stage keep treating the feature as not skipped.

| Skip id | Label | What you lose |
|---|---|---|
| `telegram` | RECOMMENDED | No phone control, no Telegram alerts, and email follow-ups cannot be approved, so none are sent. `up` starts neither the bridge nor the ccgram windows. |
| `dashboard` | RECOMMENDED | No status page in a browser. `/limits`, `/working`, `/health` and `npm run status` still work. `up` starts no web window. |
| `gmail` | NEEDED FOR EMAIL OUTREACH | No cold email, no email follow-ups and no reply watching. LinkedIn and Naukri outreach still run. |
| `apikeys` | OPTIONAL | Adzuna off as a job source, fewer verified contacts without Serper, no last-resort email lookup without Hunter. |

The doctor rule: a fail or warn of that feature's allowlisted checks (`telegram-api`,
`ccgram-env`, `daemon`; `web`, `dashboard-login`; `gmail-oauth`; `api-keys`) is shown as `skip`
with the fix `npm run setup -- --step <id>`, and the doctor text output ends with a
`Skipped by choice: ...` line (not present in `--json`). If the feature is configured anyway
(for example a token added by hand), the record is ignored and the normal result shows. Safety
checks (classifier, permission set, hooks, limits, kill switch, halts) are never skipped.
`final` and `up` use the same definition and print the skip list too.

### Unverified in the wizard

These come from the "Known limits" section of `CLAUDE.md` and the source comments. Treat the
wizard text as a best guess until you have checked it yourself.

- The BotFather Threaded Mode / Topics label and path, and Mini App versus `/mybots`: unverified.
- The `getMe` field the telegram step reads for topics (`has_topics_enabled`): unverified; its
  absence never fails the step.
- Whether ccgram needs topics in a private chat or a forum supergroup: check upstream (ccgram
  docs).
- The Adzuna, Serper and Hunter verification endpoints, credit cost and limits: unverified. A
  rejected key offers keep-anyway.
- Hidden secret input in a real terminal: unverified.
- That a skipped Telegram is safe for every consumer of `TELEGRAM_BOT_TOKEN`: traced by reading
  only.
- Install commands and package names used by `bootstrap` for Homebrew, apt, Playwright system
  dependencies, uv, Chrome and the Claude CLI: check upstream.

## bootstrap

```bash
bash scripts/bootstrap.sh --check
```

Reports what is present or missing and changes nothing (exits 1 if a required item is missing).

`scripts/bootstrap.sh` first makes sure Node (the major version in `package.json` `engines`) and
`node_modules` exist, asking before `brew install node` (macOS), `sudo apt-get install -y nodejs
npm` (Debian-like, only when apt offers a new enough Node) or `npm ci`. It then hands over to
`scripts/bootstrap.ts`, which is also `npm run bootstrap` once Node exists.

| Flag | Effect |
|---|---|
| `--check` | Detect only, change nothing. |
| `--plan` | Show what would run, run nothing. `--check` and `--plan` are exclusive. |
| `--yes` | Accept plain (non-sudo) actions without asking. |
| `--allow-sudo` | With `--yes`, also accept sudo actions. Alone it still prompts. |
| `--only <id>[,<id>]` | Limit to these items. |
| `--with-optional` | Also offer report-only optional items (`age`, `rclone`). |
| `--skip-model` | Skip the classifier model. |
| `--json` | Print the result list as JSON only. |
| `--help` | Print usage. |

Items (ids from `src/bootstrap/catalog.ts`): `git`, `build-tools`, `node`, `npm-deps`,
`renderer-deps`, `playwright-chromium`, `chrome`, `tmux`, `uv`, `ccgram`, `claude-cli`,
`classifier-model`, plus the optional `age` and `rclone`. The classifier model profile is read
from `config/classifier-models.json` (`BOOTSTRAP_MODEL_PROFILE` in `.env` can override; process
env wins).

Exit codes (from the script headers):

| Code | Meaning |
|---|---|
| 0 | Every required item is present. |
| 1 | A required item failed, was declined or needs you. In `bootstrap.sh`: also root user, missing git, declined install. |
| 2 | Usage error (unknown argument). |
| 3 | Non-interactive and an action needs `--yes`. |
| 4 | Unsupported platform (only macOS and Linux). |

Files written: `.jobber/bootstrap.json` (mode 600, best effort). Install actions run with
inherited output and a time cap. Do not run it as root.

## dry-run

```bash
npm run dry-run
```

Prints the banner `DRY RUN VERIFY: nothing is sent, applied or connected; temp database; your
.env is not changed`, then a table of stages. It uses fixtures from `src/verify/fixtures/`, a
temporary database and a temporary dashboard auth store.

| Flag | Effect |
|---|---|
| `--list` | List stage ids and whether each is `skippable` or `required`. |
| `--skip <id>[,<id>]` | Skip named skippable stages (an unknown or required id exits 2). |
| `--json` | Print the result as JSON (no banner). |
| `--llm` | Also run the LLM hunt stage in dry mode. Off by default; refused unless `.env` itself is dry. Slower: its stage has a longer timeout. |
| `--help` | Print usage. |

Stage ids (from `src/verify/stages.ts`): `env-guard`, `doctor`, `classifier-smoke` (skippable),
`launcher`, `scheduler-plan`, `pipeline-fixture`, `kill-switch-drill`, `status-render`,
`dashboard-login` (skippable), `llm-hunt` (skippable). The `dashboard-login` stage logs in for
real in token mode against a temporary auth store and token; it is skipped only for a server
whose auth mode route answers 404.

Exit codes: 0 all non-skipped stages passed, 1 a stage failed or an internal error, 2 usage error.
File written: `.jobber/verify.json` (mode 600, stage ids and statuses only). `up` reads it and
prints the last result.

Not live-verified: this runs against fakes and fixtures; it is not a test of real LinkedIn,
Naukri or Gmail.

## up and down

```bash
npm start
npm start -- --status
npm stop
```

`npm run up` and `npm run down` are equivalent.

`up` order: print the mode banner, check the kill switch, run the doctor, then start the bridge,
the ccgram windows, the scheduler and the dashboard, each only if not already running. It is
idempotent. `--status` is read-only and starts nothing.

The banner is printed at the top and again at the bottom:

```
MODE: DRY RUN (nothing is sent)
MODE: LIVE (real email, LinkedIn and Naukri actions, within caps)
```

followed by the values of the three dry-run flags (the jobber, scheduler and LinkedIn ones, named in
`src/stack/mode.ts`) and the kill variable. The banner reads the flags as the children will see them (the parsed `.env`), and
warns when your shell exports a different value. `up` never changes a flag.

Exit codes for `up`: 0 ok (also for `--status`), 1 doctor failures (nothing started) or a start
failed (after printing the full table), 2 usage error, 4 the kill switch is on (`.jobber/STOP`
or the kill variable): `up` refuses; clear it yourself with `npm run jobber:control -- resume`.

What it prints: a component table (bridge, windows, scheduler, web, with `skipped (setup)` for
skipped features), the dashboard URL and auth mode, the tmux attach commands, whether the
auto-update and backup ticks are on, the last dry-run result, a `STACK: skipped by choice: ...`
line when features were skipped, and `Stop: npm stop (or npm run down)   Emergency: npm run jobber:control -- stop`.
It skips the scheduler when `SCHEDULER_ENABLED=false` or an installed unit already runs it.

`down` flags:

| Flag | Effect |
|---|---|
| `--keep-bridge` | Leave the Telegram bridge running. |
| `--force` | Kill the scheduler instead of letting it finish its wake. |
| `--yes` | Stop the named windows without asking (needed when not in a terminal). |

`down` stops the web window, then the scheduler (Ctrl-C style, so a wake finishes; run it again or
use `--force`), then the named windows (not `manager`, which is protected), then the bridge. A
scheduler that belongs to a launchd or systemd unit is not stopped here. Exit 0 unless a stop
failed (1); unknown flags exit 2.

Files written: none by `up` or `down` itself; the tmux sessions it starts are named by
`STACK_TMUX_SESSION` (a default is used when unset).

## Known code behaviours worth knowing

- The `claude` step throws (and the wizard stops with a message) when Claude Code is not logged
  in after its retry rounds; `prereqs` instead prints what is missing and continues.
- `--mode` plus `--step` is allowed; the mode is stored but no guide is launched on a `--step` run.
