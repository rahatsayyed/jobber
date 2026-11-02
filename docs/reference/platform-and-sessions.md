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
- **Wake profile (full session)**: the scheduled wake (`outreach_wake`, in `config/run-profiles.json`) runs like a
  regular session: all built-in tools (`Read`, `Grep`, `Glob`, `Bash`, `Edit`, `Write`, `NotebookEdit`, `WebFetch`,
  `WebSearch`, `TodoWrite`, `BashOutput`, `KillShell`, `Skill`, `Agent`, `Task`) and every tool of every
  `.mcp.json` server except `db.raw_query`. `--tools` lists them and `--disallowedTools` is omitted for it (it is
  still passed for every other profile). Only this profile may set `unrestricted_builtins: true`; `mail_drip` and
  the rest keep the narrow set. Every call is screened by the tamper-protection denylist in
  `.claude/hooks/tamper-guard.cjs` after the kill switch; operator subagents keep their own tool lists. What is
  denied and what stays open: `docs/reference/safety-layers.md`, "The wake's full session and the tamper
  guard". After changing the profile or the hook, regenerate `tests/fixtures/runner-golden.json` and fully
  restart the scheduler daemon.
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

**Escalation inbox.** Every `outreach.escalate` row (inbound LinkedIn, Naukri and Wellfound replies and recruiter
inquiries, salary or slot asks, platform and tool problems, custom-note quota, apply rows that need the owner)
shows in three places, all from code with zero LLM calls. (1) The dashboard Inbox tab (route `#/inbox`, open count
on the tab; filters platform, group and open, snoozed or handled; actions Mark handled and Snooze, written through
one short-lived connection like the Apply box, under the normal session, CSRF and Origin checks). (2) `/escalations`
(`npm run status -- escalations`), a read-only list with ids. (3) A Telegram digest from the scheduler daemon: at
most one message per 15 minutes, outside quiet hours, counts per group, the top lines and the Inbox link
(`scheduler_state` keys `esc_digest_last_at` and `esc_digest_last_id`; the link is the origin of
`WEB_OIDC_REDIRECT_URI`, else the local `WEB_PORT`). Order: real replies, recruiter inquiries and apply rows first,
platform and tool problems second, `[blocked: ...]`, `[unscreened]` and injection-suspect rows last, shown as
flags. Identical rows are merged for display only (`xN`, nothing is deleted); Mark handled sets `resolved_at` on
every merged row and Snooze sets `escalations.snoozed_until`. The LinkedIn thread link is
`https://www.linkedin.com/messaging/thread/<thread_ref>/`, shown as text with a Copy button, never as an anchor (LinkedIn thread ids are `2-` plus url-safe base64 WITH `=` padding; the stored ref has no `=`, so the link builder restores it, because an unpadded id opens "this conversation failed to load");
no URL is built for other platforms. Each Inbox card is one conversation: `outreach.escalate` takes `sender`, `sender_headline`,
`excerpt` (latest message, up to 1500 chars) and `message_at`, keeps ONE open row per `(platform, thread_ref)` (a repeat updates it and
bumps `seen_count`, shown as "x N updates"), and code derives `ask_kind` (recruiter_inquiry, interview_slot, salary, question, reply, other).
The card shows sender, headline, the ask label, the quoted excerpt, relative and absolute time, a code-built what-to-do line and the
actions; rows from before these columns show "Details not captured". Telegram and `/escalations` show sender, headline and the first
140 chars of the excerpt, never the raw flagged text; a row whose text the input screen blocked keeps a safe summary on the card and its raw text stays in `escalations.raw_text`, shown only behind a toggle in the dashboard (owner only, plain text). Escalation text is untrusted: cleaned in `src/outreach/escalations.ts`, shown
with `textContent`, one plain line in Telegram. Nothing here can answer a third party: the owner replies on the
platform itself. The `read_only` permission set lists the four status commands (`limits`, `working`, `health` and `escalations`, each as `Bash(npx tsx scripts/status.ts <name>)`, see `src/platform/permissions.ts`); re-apply the set with `npm run permissions -- read_only` after an update so `/escalations` runs in the hunt window (the set is owner-managed; the agent does not edit it).

**One shared browser for every platform and the web group (`BROWSER_HOST`, default on; ADR `docs/superpowers/specs/2026-11-02-adr-shared-browser-host.md`).** ONE long-lived host process (`scripts/browser-host.ts run`, code in `src/webcore/hostServer.ts`) owns the ONE persistent Chrome profile `secrets/browser-profile/` (mode 0700, git-ignored, under the `secrets/` exclusions of backup and AUTO_UPDATE). LinkedIn (`src/linkedin/runtime.ts`), Naukri (`src/mcp/naukri.ts`), Wellfound (`src/mcp/wellfound.ts`), scout, applier, the sources runner, the contacts dork (`src/webcore/runtime.ts`) and the contacts email scraping (`src/lib/scrape.ts`) all attach to it over CDP (`src/webcore/hostClient.ts`) and each opens its OWN tab, so cookies and Chrome's own history are shared and the MCP processes no longer block each other with `session_locked` on the web lock. How it runs: (1) the first client that needs a browser takes `secrets/browser-host.start.lock`, removes a stale pidfile (dead pid, heartbeat older than 2 minutes or unreadable), starts the host detached (`node --import tsx scripts/browser-host.ts run --mode headless`, output in `.jobber/browser-host.log`, which never holds the endpoint) and waits until it is ready. (2) Chrome is started with `--remote-debugging-port=0` on loopback (`--remote-debugging-address=127.0.0.1`): Chrome picks a random port and writes it into `<profile>/DevToolsActivePort`; the host copies the websocket endpoint ONLY into the pidfile `secrets/browser-host.json` (mode 0600, refused when wider), with pid, mode, state, a heartbeat every 5 seconds and the counts of attached clients and tabs. No log, tool result, doctor line or status line shows the endpoint. (3) Each client writes a lease `secrets/browser-host-clients/<pid>-<id>.json`; the host counts live leases (leases of dead pids are removed) and exits after `BROWSER_HOST_IDLE_MIN` minutes (default 10) with none, under the start lock so no client attaches while it goes away. (4) A client's `close()` closes only its own tabs (and popups they opened), removes its lease and disconnects; it never closes the browser or the shared context. The runtimes' idle auto-close and `closeSession` semantics are unchanged, they just close a tab. (5) The kill switch (`.jobber/STOP`, `JOBBER_KILL=1`) refuses the attach in the client, and the host exits at once when it sees it; while an `all` halt is on (or the halt state is unreadable) the host closes every NEW tab. The platform runtimes still check their own halts first. (6) Locks: `secrets/linkedin.lock`, `secrets/wellfound.lock` and `secrets/naukri-profile.lock` still stop two sessions of the SAME platform. The web group needs no `secrets/webcore.lock` on the host; instead the per-host `WEB_MIN_GAP_SEC` gap is shared across processes through `.jobber/web-nav.json` (host names and times only). (7) Fingerprint: the host context carries `HEADLESS_CONTEXT_OPTIONS` (user agent, `en-IN`, `Asia/Kolkata`, 1440x900) and each client sets the same viewport, user agent, locale and timezone on its tab where the page allows it (`LINKEDIN_CONTEXT_OPTIONS` for LinkedIn, which is the same object). (8) Migration: on first start the host imports `secrets/site-sessions/*.json` (marker `.legacy-sessions-imported.json`) and each platform state file (`secrets/linkedin-main-state.json`, `naukri-state.json`, `wellfound-state.json`; markers `.platform-state-imported-<name>.json`) into the profile once; the files stay. Each platform session still rewrites its state file from the context when it ends, so `npm run linkedin:check`, `naukri:check`, the doctor and the fallback keep a current file. (9) Fallback: when the host is off (`BROWSER_HOST=false`), on Windows, or cannot be started or attached (`unavailable`), every runtime runs exactly as before: its own browser (the old per-platform profile `secrets/browser-profile-<name>/` when it exists, else a fresh browser plus the state file; the web group under `secrets/webcore.lock` with its own launch of `secrets/browser-profile/`). Owner commands: `npm run browser:host -- status` (pid, mode, attached clients, tabs; removes a stale pidfile) and `npm run browser:host -- stop`. `npm run browser:history -- [--host x] [--limit n]` copies `Default/History` to a temp file and prints host, last visit, visit count, title and address (no query string). The resume PDF render (`src/pdfRender.ts`), and the Naukri code-pass search (`src/sources/naukri.ts`, an anonymous search) keep their own throwaway browser. Chrome's password manager is switched off in the profile (passwords live only in `secrets/site-accounts.json`).

**Headed and headless on the same profile.** Chrome allows one process per profile directory, so the host hands over: an owner window command (`npm run browser:open`, `npm run apply:assist -- <job_id>`, `npm run linkedin:login`, `naukri:login`, `wellfound:login`) asks for a headed host. A headless host with no client attached gets `SIGUSR1` and exits (cookies and history are on disk in the profile), and the command starts the host headed on the same directory; a headless host with a client attached (a running wake) refuses (`session_locked`, try again later). While the host is headed, task clients get `session_locked` ("the owner has the shared browser open in a window"), the same as the old web lock while `browser:open` ran, and a second owner window is refused too. When the owner presses Enter, the command closes its tab and stops the host (`SIGTERM`); the next task starts it headless again. `browser:open -- --profile <linkedin-main|naukri|wellfound>` also takes that platform's lock first and refreshes its state file, and the state file is refreshed only when the login cookie is present. `linkedin:login`, `naukri:login` and `wellfound:login` use the same profile as `browser:open` (shared profile through the host when on, the platform's own profile otherwise), read cookies instead of the crash-prone storageState, close without error, and print one final line `Session saved: login done in <profile>`. `linkedin:check` and `naukri:check` test the session the way the platform tools open it (host profile topped up from the state file when the host is on, else own profile, else the state file) and print `profile tested: <which>`.

**Extensions.** Extensions are allowed in general: the host starts Chrome without `--disable-extensions` (`ignoreDefaultArgs`) in both modes, and whatever is installed in the profile loads. Branded Chrome 137 and later ignores `--load-extension`, so nothing is loaded from the command line: install an extension once from the Chrome Web Store with `npm run browser:open` (default page the Chrome Web Store home; any `--profile` opens the one shared profile while the host is on), press Enter when done. Limits: an extension that needs a visible window (a popup you click, a toolbar prompt) does not work headless; only what Chrome's new headless mode supports works, and none of it is verified live. Extensions in the old per-platform profiles are not moved: install them again in the shared profile. Extensions get no tool input from the model and no tool navigates to a model-supplied URL. `npm run doctor` has a `Browser profiles and extensions` line (which profiles exist and how many extension ids each holds) and a `Shared browser host` line (pid, mode, attached clients, tabs, or a stale pidfile).

**Dashboard live terminal (Sessions page).** The Sessions page shows the Jobber tmux windows live. Only sessions in an allowlist are listed or streamed: the `WEB_TMUX_SESSION` value, `ccgram`, `ccgram-daemon` and `STACK_TMUX_SESSION` (default `jobber-stack`); any other tmux session is invisible and refused by the server (`src/web/terminalRoutes.ts`). It is not a pty: the API polls `tmux capture-pane -p -e` about twice a second and sends a frame only when the screen changed, over a Server-Sent Events stream that the Next proxy passes through; xterm.js repaints each frame. The routes use the normal signed session cookie, Host check and rate limit; the stream is read only. It stops on the kill switch (`.jobber/STOP`, `JOBBER_KILL=1`) and pane text goes through the secret redaction first. Terminal content and typed keys are never logged; the audit log records only the session and window name. Typing is allowed by the server unless `WEB_TERMINAL_INPUT=false` (owner decision; restart the dashboard after a change), but the page starts with its Input switch Off on every load: turning it On shows the red "Input enabled" badge, focuses the terminal and enables a Send-keys row (Enter, Ctrl+C, Esc, Tab, Up, Down, handy on a phone). Keys go to a CSRF and Origin checked POST that runs `tmux send-keys` (printable text literal, special keys by name); the kill switch refuses input and the audit log records only `terminal_open` and `terminal_input` with the session and window, never the keys. The permission-set rule of the chat box applies: whatever is typed runs under that window's own session, so keep the window on `read_only`. The page needs tmux on the dashboard host and says so when tmux is missing, no session is running or a window closes.
