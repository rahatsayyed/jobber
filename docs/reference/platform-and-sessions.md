<!-- Moved verbatim from CLAUDE.md; the rules in CLAUDE.md "Safety" and "Commands" still apply. -->

## Platform and sessions

README.md is the owner quick start (`npm install`, `npm run setup`, `npm run doctor`); this
section is the reference for what exists.

- **tmux sessions**: `ccgram-daemon` holds the Telegram bridge; `ccgram` holds the named Claude
  windows from `config/manager-windows.json` (`hunt`, an interactive read-only session whose `/runhunt` runs one wake
  and whose `/apply <url>` queues a priority request, and `followups`; `manager` and the bridge are
  protected); `jobber-stack` (`STACK_TMUX_SESSION`) holds the scheduler daemon and the dashboard (`web`)
  windows that `npm start` (`npm run up`) creates; the scheduler's wake runs live in the
  `SCHEDULER_TMUX_SESSION` session (`jobber-runs`). Start/stop the bridge with `bash scripts/ccgram/start.sh` / `stop.sh`.
- **ccgram** is pinned to an exact version in `config/ccgram.pin.json` (4.16.0); the start script
  refuses any other version. Its own upgrade command is never to be used (owner decision,
  2026-10-14). The bridge gets only `TELEGRAM_BOT_TOKEN` and `ALLOWED_USERS` from `.env`.
- **Permission sets** (`config/permission-sets.json`): `read_only` (default, no sends),
  `outreach_send` (read_only plus fetch, queue, send email, LinkedIn arm and action tools, Naukri and
  Wellfound arm and action tools, the three `manual_job` tools, `db.update_job_company`, the poster-profile
  reads (`linkedin_open`, `linkedin_snapshot`), apply; still under the caps; re-apply the set after any change to these
  lists or the tool names, with `npm run permissions -- outreach_send`) and
  `full` (adds whole MCP servers). `read_only` also holds the read-only Wellfound tools (`wellfound_snapshot`,
  `wellfound_screenshot`, `wellfound_layout`); the owner adds `Bash(npm run apply:request:*)` for the `hunt`
  window when `/apply <url>` should run there. `npm run permissions -- read_only|outreach_send|full|--status`
  applies one to the git-ignored `.claude/settings.local.json` (a sibling
  `settings.local.managed.json` records what was written). `npm run ccgram-hooks --
  install|status|remove` merges ccgram's hooks into the same project-scoped file, never a global
  one. No session ever runs with skip-permissions.
- **Scripts** (only those in `package.json`): `doctor` (ok/warn/fail/skip checks, never prints
  secret values), `setup` (guided wizard, 13 resumable steps, needs a TTY; `-- --list`,
  `-- --step <id>`, `-- --redo`, `-- --mode agent|terminal`), `status -- limits|working|health|json`, `web` (dashboard on
  127.0.0.1, access-token sign-in by default, `WEB_CHAT_ENABLED` off by default),
  `dashboard -- token|rotate|allow <email>|status|audit|google-url`, `models -- list|verify|fetch|pin`, `scheduler`,
  `scheduler:units`, `jobber:control -- stop|resume|status`, `dry-run:report`, `auto-update`
  (`--tick|--now|--dry-run|--status`), `backup` (`--tick|--now|--plan|--status`), `restore`,
  `user-data -- init|migrate`, `linkedin:login`, `naukri:login`, `wellfound:login`, `linkedin:clear-halt`, `linkedin:seed`,
  `apply:request -- <url> [--force]` (queue a priority manual request, see the `/apply` command), `env:example`
  (regenerates `.env.example` from the settings catalog; `-- --check` exits 1 on drift), `mail:release -- <job_id> [--reset]`
  (makes a failed email row sendable again),
  `classifier:fit`, `classifier:bench`, `report`, `render` (resume HTML and PDF by hand), `build`, `test`, `eval:gen|metrics|judge`,
  `permissions`, `ccgram-hooks`, `site:account -- add|list|remove|status` (owner-managed site credentials), `providers -- list|show|validate|approve|reject` (generated job-source providers), `settings -- list|get KEY|check|backups|diff ID` (read-only), `layout`, and `mcp:<name>` (job-fetch, resume, contacts, email, db, gates,
  applier, outreach) to start one stdio server by hand (there are no scripts for the linkedin, naukri, wellfound and scout servers: `.mcp.json` starts them). `linkedin:login`, `naukri:login` and `wellfound:login` take no flag. The dashboard (`scripts/web.ts` serving `src/web/server.ts`, sign-in in
  `src/dash/oidc.ts`) listens on loopback by default (`WEB_BIND`, `WEB_ALLOW_REMOTE_BIND`) and
  keeps its chat box off (`WEB_CHAT_ENABLED=false`). `WEB_AUTH_MODE` is `token` (default: a
  one-time access token from `dashboard -- token`, only its SHA-256 hash in
  `.dashboard/auth.sqlite`, `rotate` replaces it and revokes sessions, never in a query string,
  loopback or a TLS proxy with `WEB_TRUST_PROXY=true` and `WEB_ALLOWED_HOSTS`), `google_desktop`
  (loopback only, reuses the Gmail Desktop client for one allowed account; Google's redirect
  acceptance is unverified) or `oidc` (Web client, `WEB_OIDC_*`; chosen implicitly when the mode
  is unset and the client id and secret are set). See README.md for the dashboard and
  `docs/dashboard-exposure.md` for exposure and login recovery. The dashboard has an **Apply** tab (no env flag:
  always available to an authenticated session, `src/web/applyRoutes.ts`) for the same priority request as
  `/apply <url> [--force]`: step one (`POST /api/apply/prepare`) validates the URL with the shared validator and shows how it
  will be handled, step two (`POST /api/apply/confirm`) consumes a one-time token and writes ONE pending `manual_requests` row
  through a short-lived write connection (the dashboard's own handle stays read-only); it needs a fresh sign-in (a stale session
  gets `reauth_required`), the server's CSRF, Origin and Host checks for every POST, and is limited to 10 confirmed requests per
  hour per session; `GET /api/apply/requests` lists the latest 20 with their reports. It fetches nothing; with the kill
  switch on the request is still stored and the answer carries `stopped: true`, and the wake that picks it up honours
  the kill switch, halts and dry run like any other. The dashboard's settings editor is off by default (`WEB_SETTINGS_EDIT`, read-only without it); the catalog, validation, atomic write and backup code is in `src/settings/` and the settings routes exist, but the editor UI is still in progress (plan 8H, part B) and unverified, so use `npm run settings` to read values.
- **Bring-up scripts** (plan 8E): `bootstrap`, `dry-run`, `up`, `down`, and `setup -- --no-guide|
  --guide-only|--status`; see "Bring-up commands" below. The `setup-guide` skill (interactive
  setup coach, `.claude/skills/setup-guide/`) is the skill the `setup_guide` profile loads.
- **One credentials file**: `.env` (mode 600, git-ignored; `.env.example` lists every key).
  Launchers parse it themselves and pass child processes an allowlisted environment; nothing
  sources it into a shell. `user-data/` (mode 700) and `secrets/` hold personal data and
  sessions and are never read by the agent beyond the tools that need them. There is no
  pre-commit guard any more (the `.githooks/pre-commit` file was removed in c8c302a); the only protection against committing these paths is `.gitignore`
  (`.env`, `.env.*` except `.env.example`, `secrets/`, `user-data/`, `.ccgram/`, `data.sqlite`,
  `.claude/settings.local.json`, `models/`, `.jobber/`), so check `git status` before you commit.
- **Auto-update and backup** (both off by default, `AUTO_UPDATE`, `BACKUP_ENABLED`): see
  `docs/backup-and-restore.md`. Updates are fast-forward only, signed commits by default,
  with a test gate and rollback; an update never changes permission sets or the allow list.
  Backups are age-encrypted, exclude `secrets/` unless `BACKUP_INCLUDE_SECRETS=true`, and
  need a restore drill (`npm run restore -- <archive> --identity <key> --drill`). Restart Claude
  sessions after an applied update (MCP servers keep old code).

**Setup modes and optional steps** (plan 8F). `npm run setup` runs in one of two modes, asked once and
stored as `mode` (with `mode_at`) in `user-data/.setup-state.json`: `agent` (the guided Claude
session of the `setup_guide` profile in a detached tmux window beside the wizard; it is launched
only when `claude-cli`, `claude-login`, `setup_guide_ready` and `tmux -V` all pass, otherwise the
wizard says why and continues in terminal text; the chooser is always shown on an interactive run
with no stored mode and no `--no-guide`, readiness only picks its default, and `agent` can be
stored while not ready) and `terminal` (plain walkthroughs for telegram, gmail, apikeys and dashboard, no
guide). `--mode agent|terminal` sets and stores it, `--no-guide` is per run and not stored, and
`--step <id>` runs one step in the stored mode, or in terminal text without storing it when none is stored, with no chooser. The skippable catalog is
`src/setup/skips.ts`: `telegram` and `dashboard` (RECOMMENDED), `gmail` (NEEDED FOR EMAIL
OUTREACH), `apikeys` (OPTIONAL). A skip is recorded as `steps.<id>.status: skipped` in the same
state file; it never writes `.env`, a dry-run flag, a permission set or a halt. The doctor rule:
the doctor wrapper (`withSkips`) turns a fail or warn of that feature's allowlisted checks
(`telegram-api`, `ccgram-env`, `daemon`; `web`, `dashboard-login`; `gmail-oauth`; `api-keys`) into
`skip` with the fix `npm run setup -- --step <id>`, and prints `Skipped by choice: ...` as the last
line of the text output (not in `--json`). Configured wins: when the feature is configured anyway
(for example a `TELEGRAM_BOT_TOKEN` added by hand) the record is ignored and the normal result
shows. Safety checks (classifier, permission set, hooks, limits, kill switch, halts) are not in
the allowlist and are never skipped. `npm run up` and `npm run dry-run` use the same definition:
with Telegram skipped `up` prints `bridge: skipped (setup)` and `windows: skipped (setup)` and
starts neither the bridge nor the ccgram windows; with the dashboard skipped it prints `web:
skipped (setup)` and starts no `web` window; it ends with a `STACK: skipped by choice` line, and
the dry-run `dashboard-login` stage is skipped for a skipped dashboard.

**Bring-up commands** (plan 8E; README.md quick start): `bash scripts/bootstrap.sh` (detects and
installs what is missing after asking; `--check` and `--plan` only report; writes
`.jobber/bootstrap.json`; `npm run bootstrap` is the same CLI once Node exists; install actions run with inherited stdio and a 30 minute cap, `--yes` never covers sudo without `--allow-sudo` and `--allow-sudo` alone still prompts; `BOOTSTRAP_MODEL_PROFILE` is read from `.env`, process env wins), `npm run setup` (the wizard, plus an optional guided Claude session
under the `setup_guide` profile in `config/run-profiles.json`: `interactive`, `classifier:
not_required`, no MCP tools, only `Skill` and `Read` limited to the prefixes `docs/`,
`config/`, `user-data.example/` and `.claude/skills/setup-guide/`, and Bash limited
to the exact strings in `bash_exact`, no wildcard; the guide never reads secrets or `.env`),
`npm run dry-run` (end-to-end smoke in dry mode against fixtures and a temporary database; writes
`.jobber/verify.json` plus the idempotent launcher debug files; `--llm` runs a real hunt and is refused unless `.env` itself is dry; its dashboard stage logs in for real in token mode against a temp auth store and temp token, and is skipped only for a server whose auth mode route answers 404)
and `npm start` / `npm stop` (aliases of `npm run up` / `npm run down`; doctor gate, kill-switch refusal with exit 4, ordered start of
bridge, windows, scheduler and dashboard; exit 1 when a start failed, after printing the full table; `up -- --status` is read-only; the final lines show the dashboard auth mode and, in token mode with no token stored, `npm run dashboard -- token`). `up` never changes the
mode: it prints `MODE: DRY RUN` or `MODE: LIVE` from `.env`, and the owner alone flips the flags.
