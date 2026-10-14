# Platform requirements: tmux sessions, Telegram manager, dashboard, setup and doctor

Status: requirements gathering, 2026-10-14. Separate from the outreach runtime
(`2026-10-08-agent-browser-outreach-requirements.md`, ADR-001), which this platform hosts.

## Decisions so far

| Area | Decision |
|---|---|
| Distribution | Self-hosted per user: each person runs their own copy on a Mac or VPS with their own accounts, Telegram bot, database and secrets. Nothing is shared between users. |
| Sessions | Every Claude run lives in a tmux window (named, listable, resumable). One manager session owns the Telegram channel and manages the rest through tmux. |
| Telegram | `alexei-led/ccgram` for now (owner's decision 2026-10-14, topic per tmux window, user-ID allowlist), pinned to a reviewed commit and run from this project. The source review recommended `six-ddc/ccbot` instead (smaller surface); the owner chose ccgram. Fallback: the official Claude Code Telegram plugin plus a small tmux manager. See "Telegram decision". |
| Permissions | Named permission sets chosen at setup (default read-only), written to the project's `.claude/settings.local.json`. See "Permission sets". |
| Setup form | CLI wizard (`setup`, `doctor`) for everything deterministic (checks, file writes, browser logins), plus a small Claude skill for the conversational resume and preference steps. Chosen as the easier path for the user (2026-10-14). |
| tmux skill | Use a plain skill, not an extra MCP server. Candidate: `mitsuhiko/agent-stuff` `skills/tmux` (runs tmux through Bash on a private socket). Read its source and pin a commit before installing. |
| Dashboard | Web app with login, read-only in v1. Shows jobs applied and pending, conversations and history, emails, funnel, running sessions. Sending input to sessions from the UI is optional, phase 2. |
| Setup | Two commands: a guided setup wizard and a doctor check. |
| Backup | Backup of the SQLite database to Google Drive: parked for later, but the database must be secured now and the design must allow it. |

## Session manager and Telegram

- All sessions run as `tmux` windows with stable names (for example `manager`, `wake-<time>`, `hunt`). The manager can list them, read recent output (`capture-pane`), start, stop and restart them.
- Only the manager session has the Telegram channel. A bot token allows one `getUpdates` poller, so other sessions must never open their own.
- Telegram sender allowlist by numeric user ID (the official plugin's allowlist). Messages from anyone else are dropped.
- Optional input to a session (`send-keys`) is limited to allowlisted sessions and to an authorized sender. Text from third parties (recruiter replies, profiles, job posts) is never forwarded into a pane.
- No session runs with `--dangerously-skip-permissions` or `bypassPermissions`. Sessions use the restricted tool sets from the outreach plans.
- Telegram replies use the existing `telegram-format` skill; progress updates for long runs, as CLAUDE.md already requires.

### Bridge vetting (2026-10-14, README-level only, no source read)

The community bridges (CCGram forks, two `ccbot` forks, `claude-telegram-bridge`, `telegram-mcp-bridge`, `claude-telegram-mirror`) were checked from README and PyPI text. Findings: most are 0-star forks with unverified activity and licenses; several suggest or default to skipping permissions; they paste keystrokes into panes, so an allowlisted Telegram ID becomes shell control; `claude-telegram-mirror` trusts a whole chat rather than individual users; `claude-telegram-bridge` handles one pane and one chat ID. Upstream `alexei-led/ccgram` (topic per tmux window, user-ID allowlist) is the only one worth a later look, after reading its source and pinning a commit. It targets Python 3.14.

## Dashboard (read-only v1)

- **Content:** jobs discovered, matched, applied, pending, failed; conversation threads and message history per person; sent emails and follow-ups; outcomes and funnel (from the existing `db.get_funnel`); running tmux sessions and their last output line; halt flags and ceiling usage.
- **Data access:** a read-only SQLite connection. v1 exposes no write endpoint.
- **Exposure:** a public web app with login (owner's choice). Because it shows emails and conversations, minimum security requirements: HTTPS only; password stored with a slow hash (argon2 or bcrypt); TOTP second factor; httpOnly, secure, sameSite session cookies; CSRF protection; rate limiting and lockout; Content-Security-Policy; an audit log of logins. Never serve anything under `secrets/`, `.env`, session storage files, tokens or Gmail credentials, and redact those patterns from any text shown.
- **Exposure is the user's job (decided 2026-10-14):** we ship the dashboard; domain, tunnel and TLS are handled by each user, with a short doc listing the options. The dashboard binds to localhost by default, and login plus TOTP are mandatory regardless of how it is exposed.
- Optional, phase 2: a box to message a tmux session from the UI, behind the same login plus a confirmation.

## Setup and doctor commands

**`doctor`** (non-interactive, exit code 0 only if nothing fails) checks and prints pass, warn or fail with a one-line fix hint for each:
- Node version, `tmux`, `claude` CLI installed and logged in, Google Chrome, Patchright.
- SQLite file exists, is writable, and has owner-only permissions; migrations applied.
- `.env` limits parse and are in sane ranges; config files validate against their schemas.
- Telegram token valid (`getMe`), allowlist non-empty, bot reachable.
- Gmail OAuth present and working; LinkedIn and Naukri session files present and still logged in (headless check).
- Resume JSON valid; MCP servers connect; blocking hooks installed; classifier model present.
- Dashboard reachable and login configured; backup configured (warn if not).

**`setup`** (interactive, resumable, guides each step with exact instructions):
1. Prerequisites check (runs the relevant doctor checks first).
2. Telegram: how to create a bot with BotFather, paste the token, find and set the allowed user ID, send a test message.
3. Claude login, Gmail OAuth, LinkedIn and Naukri login (a headed browser window to capture the sessions).
4. Resume: take the user's resume file and convert it to the project's resume JSON, then confirm it.
5. Job questions: roles, locations, remote preference, salary floors and targets (in each relevant currency), work authorization, notice period, languages.
6. Limits and pacing: explain each ceiling, quiet hours and per-company limit, and write them with safe defaults.
7. Dashboard login (password and TOTP), tmux session layout, then a final doctor run.

## Auto-update (`AUTO_UPDATE`)

- Env var `AUTO_UPDATE`, default `false`. When `true`, a daily job (run by the scheduler, at a random time outside quiet hours) fetches new commits from the project's upstream and applies them.
- Because updated code runs with the user's real accounts and send permissions, the update step must be conservative:
  - Fetch and fast-forward only. No merge, no rebase, no force. If the working tree has local changes or the branch has diverged, skip and notify.
  - Never update while a hunt or outreach wake is running; take the same lock as the scheduler.
  - Apply only commits from the configured branch or tags, ideally verified (signed commits or tags from a configured signer; unsigned means notify, not apply).
  - After pulling: install dependencies, run migrations, then run `doctor` and the test suite. On any failure, roll back to the previous commit and notify.
  - Updates can never change the user's permission set. New tools shipped in an update are not added to `.claude/settings.local.json`; `doctor` flags tools that exist but are not allowed, and the user runs setup to opt in.
  - Notify the owner (Telegram) with the commit range and a changelog summary after every update or skip.
- ccgram is separate: it stays pinned to the reviewed commit and its own `/upgrade` stays off. `AUTO_UPDATE` does not touch it.
- `doctor` reports the current commit, whether `AUTO_UPDATE` is on, and the last update result.

## Config and data hygiene (needed before anyone else uses this)

- Today preferences live in CLAUDE.md prose, `config/*.json` and `.env`. For multiple users there must be one per-user, gitignored profile file that everything reads, with a committed `*.example.json` template.
- Found 2026-10-14: `input/resume.json` and `config/easy-apply-answers.json` are tracked in git and contain the owner's real email and phone number. Before the repository is shared or published: untrack and gitignore them, ship example templates, and scrub the history.
- `secrets/` and `.env` are already untracked (good).
- The SQLite database holds conversations, emails and contact data. Requirements: owner-only file permissions, never inside a served directory, backups made with SQLite's online backup (not a raw copy of a live file), and backups encrypted before they leave the machine.

## Backup (parked, design only)

- Scope is everything a user would be unhappy to lose, not just SQLite: the SQLite database (online backup), `.claude/settings.local.json`, the user's config and preferences (profile and limits, `config/*.json`, resume and answers files, the ccgram pin), and optionally the `.env` and the `secrets/` session files. Credentials and session files are only included when the user opts in, and always encrypted.
- Google Drive via OAuth with the narrowest scope that works; encrypted before upload; scheduled by the same scheduler; restore documented and tested. The doctor warns when no backup is configured.

## Credentials, `.env` and ccgram

- One credentials file: the project `.env` (mode 600, gitignored), including the Telegram bot token and allowed user IDs.
- ccgram does not read it directly. A launcher extracts only the two keys ccgram needs and starts it with a stripped environment. Reason: ccgram is third-party code with a Telegram-facing process, voice and upgrade features, and 13 dependencies; if it leaked its environment, only the bot token would be exposed, not the Gmail app password or search keys. This keeps the single-file convenience without giving the bridge every secret.
- Hooks for ccgram go in the user's `.claude/settings.local.json` because the hook command embeds a machine-specific Python path. A portable committed hook script (so the hooks could live in the shared `settings.json` for all users) is a possible later improvement.

## Text safety: AI tells and the humanizer

- Outbound text passes: the humanizer step in the drafting skills, then a deterministic style gate (em and en dashes, stock phrases, markdown, exclamation marks, length caps; configurable list in `config/ai-tells.json`, partly borrowed from the "hard ban list" in `ethanplusai/harvey`, an MIT-licensed sales-email agent), then the fact gate and output gate. Specified in plan 6A, Task 8.

## Configurability

- Every limit, pacing value, cadence gap and cooldown is its own env var with a documented default, so each user can tune them (plan 6A, Tasks 2 and 2b). The setup wizard asks about them and writes `.env`; `doctor` validates ranges.

## Repository hygiene and history reset (do first)

- Plan 0 (`docs/superpowers/plans/2026-10-14-0-repo-hygiene-and-history-reset.md`): untrack personal files, synthetic templates, a PII scanner with a pre-commit hook, then reset the whole history to one clean commit before building anything else. The reset is gated on explicit owner confirmation, with a verified backup first.

## Open items

1. How the ccgram state directory and config are kept inside this project (its default is `~/.ccgram`; check for a config-directory setting before relying on it).
2. Dashboard stack and where it lives in the repo.
3. Order of work against the outreach plans 6A to 6D (the platform pieces are mostly independent).

## Telegram decision (2026-10-14)

Chosen: `alexei-led/ccgram` (MIT, very active, last commit seen 2026-10-08, 842 commits, tests, CI, a `doctor` command). It runs from this project, and the Claude sessions it manages use the project as their working directory, so they load the project's settings, MCP config and `.claude/settings.local.json`.

Review found (web read of source, partly unverified): allowlist (`ALLOWED_USERS`) fails closed when unset or empty and is checked per handler; no skip-permissions by default; optional Whisper, LLM, TTS and Mini App integrations, all off unless configured; no telemetry seen; Python 3.14 floor; 13 dependencies; a 9-event Claude hook; a Shell provider; an `/upgrade` command.

Must do before it runs:
1. Read the unreviewed parts first: the tmux send path, `handlers/text`, `handlers/shell`, `handlers/voice`, the hook installer, and the `YOLO` setting. Pin a commit; install from that pinned source.
2. Do not enable the Shell provider, any YOLO mode, voice or LLM integrations, and never put skip-permissions in `CCGRAM_CLAUDE_COMMAND`.
3. Allowlist only the owner's numeric Telegram ID; use a private chat or a private group.
4. It sets no file modes: `chmod 700` its state directory and `chmod 600` its `.env`.
5. Re-audit the allowlist checks after every upgrade (checks are per handler). Treat `/upgrade` as a risk and keep it off or pinned.
6. Python 3.14: let `uv` provision it so users do not need a system Python; `doctor` verifies it.
7. Anyone allowlisted can drive Claude, so the permission sets below are the real ceiling on damage.

## Permission sets

- Defined once in a committed file (proposed `config/permission-sets.json`) as named groups of tools:
  - `read_only` (default): reads only (list jobs, stats, funnel, discovery reads, browser state reads, resume read, gates checks). No sends, applies or writes.
  - `outreach_send`: `read_only` plus the send actions (email send, LinkedIn and Naukri connect and message tools, applies).
  - `full`: every Jobber tool, including Gmail send and LinkedIn send. It never includes unrestricted Bash, file access outside the project, or skip-permissions.
- Setup asks which set to use (default `read_only`) and writes the matching `permissions.allow` entries (`mcp__<server>__<tool>`, or `mcp__<server>` for a whole server) into `.claude/settings.local.json`. The committed `.claude/settings.json` stays the shared baseline (hooks, deny rules). Deny rules always win.
- `.claude/settings.local.json` must be in the repository `.gitignore`. Today it is ignored only through the owner's global git ignore, which other users do not have.
- `doctor` checks the local allow list matches the chosen set, flags unexpected entries, and warns when `full` is selected.
- The per-run `--allowedTools` and blocking hooks from the outreach plans stay narrower than the user's set. The set is the ceiling, not what every run gets.
