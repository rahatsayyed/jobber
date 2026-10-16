# Plan 8H: dashboard settings editor (one env catalog, edit .env and the owner config files from the website, with diff, backup and rollback)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per project preference, dispatch subagents with `model: sonnet`, one task at a time, review gate after each task.

**Goal:** the owner can open the dashboard, search every environment variable, read what it does (default, allowed range, required or optional, which feature, whether a restart is needed), change it, see a diff, apply it atomically with an automatic backup, and roll back. The same flow edits the config and user-data files the owner is meant to edit (`portals.json`, `target-regions.json`, `deal-breakers.json`, `replies.json`, the LinkedIn discovery file, `languages.json`, `easy-apply-answers.json`, `profile.json`, `fact-gate.json`), with per-file validation, a form view for the simple fields, a raw JSON editor, a diff, a backup and a rollback. A dry-run or LIVE banner is visible on every page. Secrets are write-only. Safety-critical settings need a fresh re-authentication and a typed phrase, or are not editable from the web at all. No agent, chat message, MCP tool or restricted profile can reach any of it.

**Architecture:** four layers, each testable alone.
1. `src/settings/envCatalog.ts`: ONE catalog of every owner-settable env key (section, type, default, range, secret, required, edit tier, restart scope, about text). It composes `src/setup/limitsCatalog.ts` for the numeric limits instead of copying them. `.env.example` becomes a GENERATED artifact of the catalog (`npm run env:example`, with a `--check` mode and a test), and `tests/env-example-complete.test.ts` is rebased onto the catalog.
2. `src/settings/*` (pure and fs-injected, no HTTP): value validation per catalog type, change plans (`planEnvChange`, `planFileChange`), the friction policy (`requiredFriction`: tier plus direction of the change gives none, fresh re-auth, or re-auth plus a typed phrase, or refusal), atomic apply with backup (reusing `updateEnvText` and the `EnvFs` seam from `src/setup/envWriter.ts`), rollback as a new change plan, file registry with an explicit allowlist, etag detection, line diff.
3. `src/web/settingsRoutes.ts`: `/api/settings/*`, registered inside the existing server so it inherits the session cookie, the Host check, security headers, CSRF header, Origin check, per-session rate limit and JSON body limits. Writes are two-step (`preview` returns a one-time token bound to session, etag and plan hash; `apply` consumes it), mirroring the chat prepare/confirm pattern. The master switch `WEB_SETTINGS_EDIT` ships `false` and is itself never editable from the web.
4. Static no-build frontend: a sticky mode banner on every view, a Settings view with Environment, Files and Backups tabs.

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffixes), vitest, `node:http`, `node:crypto`, `node:fs`, `better-sqlite3` (auth store, one additive table), `zod` (already a dependency; used for the file validators that have no loader), plain ES modules for the frontend. No new dependency, no `npm install`.

**Builds on:** plan 8C (token login, sessions, reauth, chat prepare/confirm pattern; merged), 8A (kill switch hooks, `screenUntrusted`), 8E/8F (stack, setup, skips), 7D (backup and update flags). **Partly parallel with plan 8G** (`docs/superpowers/plans/2026-10-16-8g-unified-sources-and-browser-apply.md`): see "Overlap with plan 8G and build order". Tasks 2 and 3 build after 8G-1 has landed its env keys; every other task can be built in parallel with 8G.

**Spec:** `docs/superpowers/specs/2026-10-14-platform-sessions-dashboard-setup-requirements.md` (dashboard section) stays binding except where this plan says it adds a write path; that is an explicit, owner-requested exception (O1). Format follows `2026-10-15-8c-dashboard-simple-login.md` and `2026-10-15-8a-wiring-and-legacy-removal.md`.

---

## What the code does today (verified by reading it)

- **Dashboard is read-only.** `src/web/server.ts` has `GET` and `POST` only (405 otherwise). The only POSTs are `/auth/*`, `/api/logout` and the chat prepare/confirm. Non-open routes get the session cookie check, a 120 requests/min per-session limit and, for POST, `X-CSRF-Token` plus an exact `Origin` match. `isFresh(session, now, reauthMaxAgeSec)` (default 300 s) and the `reauth_required` JSON (`url` is `/#/login?reauth=1` in token mode) already exist and `views/chat.js` already handles them.
- **`/api/config` is a masked name list.** `src/dash/configView.ts` takes names from `.env.example`, masks by the regex `TOKEN|SECRET|PASS|KEY|COOKIE|CREDENTIAL|AUTH` and shows values for a short allow-list (`MAX_*`, `*_PER_DAY`, ...). That allow-list is by prefix, which plan 8G's new `WEB_DRY_RUN`, `WEB_MIN_GAP_SEC` (web core, not the dashboard) would collide with. The catalog replaces the regexes with an explicit `secret` flag per key.
- **`scripts/web.ts` reads `.env` once at start** (`{...fileEnv, ...process.env}`); a changed `.env` needs a dashboard restart. Other launchers parse `.env` themselves and pass an allowlisted env to children (`env -i`), so every key needs a restart scope (Task 2 records evidence).
- **`.env` writing exists:** `src/setup/envWriter.ts` has `updateEnvText` (comment-preserving, quoting, key-name check, newline refusal), `EnvFs`, `writeEnvFile` (atomic temp + rename, mode 600, backup as `.env.bak-<ts>` beside the file) and `nodeEnvFs`. `src/platform/envFile.ts` `parseEnv` is the loader view. The setup wizard uses these; this plan does NOT modify them.
- **`.env.example`** has 73 active keys plus many commented optional keys in 13 sections; each key already has a comment line above it in a regular shape (`Default X. Allowed: ... Secret. Optional.`), so a one-shot importer can seed the catalog. `tests/env-example-complete.test.ts` guards: every env name the code reads is listed (or in its `INTERNAL` map), no inline comments, comment above each active key, every `LIMITS` key present, no em or en dashes, dry-run flags and secrets ship safe.
- **Numeric limits** live in `src/setup/limitsCatalog.ts` (`LIMITS`: key, group, default, min, max, unit, what, raiseNote; `validateLimit`, `validatePairs`) with a drift test against the loaders (`tests/setup-limits-catalog.test.ts`).
- **Run mode:** `src/stack/mode.ts` `currentMode(env)` returns DRY RUN or LIVE from the three flags via `isDryRun`; `fileFlags(parseEnv(...))` is the view the children see. A test greps `src/stack` so that nothing there writes a dry-run flag; the settings code therefore lives in `src/settings/`, never in `src/stack/`.
- **Config files and their loaders:** `loadPortals(file)` returns `{config, error, warnings}`; `loadTargetRegionsStatus(file)` returns `{config, invalid}`; `loadLanguageConfigStatus(file)` returns problem info; `validateProfile(obj)` returns string[]; `loadDealBreakers(file)`, `loadRepliesConfig(file)` and the Easy Apply answers loader (`src/apply/linkedin.ts`, moved to `src/apply/answers.ts` by 8G Task 17) do not return a problem report. `fact-gate.json` is validated inside `src/resumeFacts.ts` (throws on unknown key or non-string array). `src/platform/checksSetup.ts` already has shape checks for several of these files for the doctor.
- **Agent isolation today:** `.claude/hooks/tool-allowlist.cjs` (restricted runs) already denies `.env*`, `secrets`, `user-data`, `.dashboard`, `.jobber` path segments. `block-outside-project.cjs` (all project sessions) only denies paths OUTSIDE the project, so whether an interactive project session may `Edit` `.env` is UNVERIFIED (Task 9 checks it).
- **Auth sqlite audit** (`src/dash/authStore.ts`): `audit(db, kind, {ip, note, textHash, idHint}, now)`, `AuditKind` union, `listAudit`. `chat_pending(token_hash, session_hash, text_hash, expires_at, used_at)` is the pattern for a one-time confirm token.
- **Existing exposure docs:** `docs/dashboard-exposure.md`, `docs/dashboard-login.md`.

## Global Constraints

- **Test baseline before and after EVERY task:** `npx tsc -p . --noEmit` clean; `npx vitest run` shows exactly the 5 known failures (4 in `tests/renderChecked.test.ts`, 1 in `tests/resume.test.ts`) and nothing else.
- Never read, print, write or commit `user-data/`, `secrets/`, `.env*` (except `.env.example`, which is committed and, after Task 3, generated), `.dashboard/`, `.jobber/`, `generated/`, `data.sqlite`. Tests use temp directories (`fs.mkdtempSync(path.join(os.tmpdir(), 'jobber-'))`), an in-memory `EnvFs`, the invented fixture `tests/fixtures/settings/env.fixture` and `user-data.example/`. **No test touches the real `.env`**: `tests/helpers/noRealEnv.ts` (Task 4) wraps `fs.readFileSync`, `fs.openSync`, `fs.statSync` and `fs.existsSync` and throws if the resolved path is the repository's `.env`, `.dashboard/` or `.jobber/`; every settings test file imports it.
- No network. No `npm install`, no new dependency. No real browser, tmux, MCP server or `claude`.
- **No secret value** appears in: any API response (including previews, diffs, errors and the unknown-keys list), a log line, an audit row, a thrown message, a backup FILE NAME, the pending table, the URL, `process.argv` or a child environment. Secrets are shown as `set` or `not set` only. Fixture secrets are all named `FIXTURE-SECRET-<n>` so a leak test can scan for them.
- Fail closed. An unknown catalog key, an unregistered file id, a stale etag, a plan whose hash does not match, a missing master switch or a validation error means no write. Nothing is partially applied: one change set is written whole or not at all.
- Dry run wins and the owner alone decides: no code in this plan, no agent, no test and no default ever flips a dry-run flag, a halt, a permission set or the STOP file. The web editor can flip a flag only for an authenticated, freshly re-authenticated owner who typed the phrase (D4).
- `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function` stay forbidden in `src/web/**` (`tests/web-frontend-lint.test.ts` greps).
- Do not edit `CLAUDE.md` or `README.md` before Task 15 (project preference: batch doc edits). Agent, hook, config and `.env.example` changes ARE behaviour and go in their task.
- Do not weaken or remove anything in `src/dash/sessions.ts`, `src/dash/accessToken.ts`, `src/dash/oidc.ts`, the chat send rules, the read-only data guarantee or the security headers. Additive changes only to `authStore.ts` and `server.ts`.
- Commit per task with explicit paths, never `git add -A`, never `--no-verify`, never push.
- Match surrounding style: file header comment `// src/...`, `.js` import suffixes, tests in `tests/*.test.ts`, one file with `npx vitest run <file>`.

## Review Focus

1. **Secrets never leave (Tasks 5, 7, 10, 11):** read the leak tests; they scan every response, audit row, console call, backup name and the pending table for `FIXTURE-SECRET-`.
2. **Friction table (Task 6):** the tier x direction table IS the test. Reviewers read the table, not the prose.
3. **Agent unreachable (Task 9):** the import-graph lint, the hook, the absence of any write CLI and of any MCP tool.
4. **Atomicity and concurrency (Task 5):** etag check, rename failure leaves the original, backup before write, rollback creates its own backup.
5. **Catalog is the single source (Tasks 2, 3):** generated `.env.example`, rebased completeness test, limits composition, suffix rules for dry-run flags so plan 8G's new flags are covered by construction.
6. **Allowlist and path safety (Task 4):** ids only, never client paths; symlink, traversal and size tests.
7. **Lockout safety (Tasks 2, 6):** the keys that could lock the owner out or expose the dashboard are `never`.

## Decisions (accepted here, with cost if wrong)

| # | Decision | Cost if wrong |
|---|---|---|
| D1 | One catalog, `src/settings/envCatalog.ts`. Numeric limits are COMPOSED from `LIMITS` (`fromLimit(spec)`), never copied, so `limitsCatalog.ts` stays the source for those 28+ keys and its drift test keeps guarding them. Everything else is authored in the catalog. | Two files own one list (limits vs the rest). Accepted: a copy would drift; a test asserts every `LIMITS` key appears in the catalog with identical default, min, max. Low. |
| D2 | `.env.example` is GENERATED from the catalog (`npm run env:example`; `-- --check` exits 1 on drift; a test runs the check). Hand edits to it fail the test. Section order, header block and comment style are reproduced from today's file; the first generation must round-trip to today's file except for a reviewed diff. | A plan that adds an env key must edit the catalog and regenerate. Plan 8G-2 keys land after Task 3 (see order). Medium for merge friction, low for correctness. |
| D3 | Master switch `WEB_SETTINGS_EDIT`, default `false`, tier `never`. While false: the Settings page and the banner work read-only and show the one-line instruction to enable it; every write route answers `403 settings_disabled`. | The owner edits `.env` by hand once to turn the editor on. Intended. |
| D4 | Four edit tiers plus direction. `never`: shown with a reason, not editable. `safety`: a change that WEAKENS needs a fresh re-auth (`isFresh`) AND a typed phrase; a change that STRENGTHENS (for example going back to dry run) needs only the normal session and CSRF. `guarded`: a weakening change needs fresh re-auth. `normal`: session and CSRF. Direction is per key (`weakens: 'true' \| 'false' \| 'increase' \| 'decrease' \| 'cleared' \| 'any'`). Phrase: `GO LIVE` when the resulting file mode flips DRY RUN to LIVE, `CHANGE <KEY>` for one key, `CHANGE <N> SAFETY SETTINGS` for several. | An owner who finds the phrase annoying edits `.env` by hand; the phrase is the point. Low. |
| D5 | Secrets are write-only: the list API returns `{secret: true, state: 'set' \| 'not set'}` and no value; the editor offers Replace and Clear; the preview shows `set -> replaced` or `set -> cleared`; the audit note carries the key name only; the value is held in browser memory until apply and never in `localStorage`, a DOM attribute or a URL. | No "show" button: a forgotten key is re-entered. Intended. |
| D6 | Remote exposure rule: when the dashboard is bound non-loopback or `WEB_TRUST_PROXY=true`, `safety` tier weakening changes are refused (`remote_exposure`) unless `WEB_SETTINGS_REMOTE_SAFETY=true` (tier `never`, ships false). Normal and guarded edits still work. | Flipping LIVE from a phone over Tailscale needs the owner to set one more flag by hand. Chosen on purpose: a stolen token over the network must not be able to go LIVE. Low to medium. |
| D7 | Two-step writes. `preview` stores `settings_pending(token_hash, session_hash, plan_hash, etag, expires_at, used_at)` (TTL 120 s) and returns the plan plus a random token once. `apply` must resend the changes; the server recomputes the plan and requires `plan_hash == sha256(token + canonical(changes, etag))` (salted by the unstored token, so a stored hash cannot be brute-forced for a low-entropy secret). Token is single-use, session-bound, consumed even on mismatch. | Large secrets resent once. Low. |
| D8 | Backups live in `.jobber/settings-backups/` (directory 0700, files 0600; `.jobber/` is already git-ignored): `env/<UTC stamp>-<etag8>.env` and `files/<fileId>/<stamp>-<etag8>.json`, full copies, newest 10 per target kept (`SETTINGS_BACKUP_KEEP`, 1..100). Names are generated by code, never from client input. Rollback is a normal change plan (diff current to backup, same friction as the equivalent edit) and takes its own backup first, so a rollback can be undone. | Full copies hold secrets in plaintext, exactly like `.env` and the existing `.env.bak-*` files in the same trust boundary. A redacted backup was rejected: it cannot recover a lost key. Low. |
| D9 | No write CLI. `scripts/settings.ts` is read-only (`list`, `get`, `check`, `backups`, `diff`). A write command would hand any session with Bash an easy way to flip a flag. | Headless editing stays manual (`.env` by hand). Low. |
| D10 | Audit policy: key names always; before and after values only for non-secret keys of type `bool`, `int` or `enum` (so the log shows `JOBBER_DRY_RUN 1 -> 0`); strings, paths, lists and emails are never logged as values (they can be personal data); file edits log the file id and a changed-path count, never content. | Less forensic detail for string keys. Low. |
| D11 | Config and user-data files are edited IN PLACE (same files the owner edits by hand today). Committed `config/*.json` therefore become locally modified in git, as with hand edits. The doctor reports the count; the docs say so. | An edited committed file can conflict with a later fast-forward auto-update touching the same file (how `scripts/auto-update.ts` treats a dirty tree is UNVERIFIED). A local-override layer was rejected as a separate project. Medium, documented. |
| D12 | JSON writes: the raw editor stores EXACTLY the submitted text after it parses and validates (comments are not valid JSON, so none exist to lose); the form view re-serializes with 2-space indent and a trailing newline. The first form save of a hand-formatted file can show a formatting-only diff; the diff view counts "N formatting-only lines" separately. | Noise once. Low. |
| D13 | Restart scope defaults to `stack` (`npm run down && npm run up`, plus a full restart of Claude Code sessions for MCP changes). A narrower scope requires `restartEvidence` (the reader file) in the catalog entry, enforced by a test. Applied keys are recorded in `.jobber/settings/pending-restart.json`; `npm run up` clears the entries it restarts. | An over-conservative badge costs one extra restart. Under-claiming would be worse, hence the default. Low. |
| D14 | Editable files (allowlist, by id): `portals`, `target-regions`, `deal-breakers`, `replies`, `linkedin-discovery` (successor of `discover-linkedin`, whichever exists), `languages`, `easy-apply-answers`, `profile`, `fact-gate`. View-only: `permission-sets`, `run-profiles`, `worker-tools`, `classifier-models`, `manager-windows`, `platforms` (8G), `ai-tells`, `ccgram.pin`, `update-known-failures`. Excluded entirely: `resume.json` (the agent never edits it, it is the fact base of every gate, and the setup skill owns it), `learned-ats-platforms.json`, `injection-corpus/`, `runner/`, `setup-guide.json`. | The owner edits the excluded files by hand. Low. |
| D15 | Settings routes additionally require `Sec-Fetch-Site: same-origin` on writes (browsers send it; plain `curl` with a stolen cookie does not). Defence in depth, not a boundary; it is spoofable by a non-browser client. | A very old browser cannot save; all current browsers send it. Low. |
| D16 | Unknown keys in `.env` (present in the file, absent from the catalog) are listed by NAME only, never editable, always preserved byte for byte. Their values are never returned (an unknown key may be a secret). | A typo'd key cannot be fixed from the web. Low. |
| D17 | Blank versus reset: `clear` writes `KEY=` (blank means unset in every loader that Task 2 verifies; the catalog marks `blankMeansDefault` per key from a test over the real loaders); `reset` removes the active line for keys where blank is not equivalent. Secrets only support Replace and Clear. | A key whose loader treats blank differently is marked `blankMeansDefault: false` and offers only `reset`. Low. |
| D18 | Agent isolation is structural, in layers: (a) no MCP tool, agent, skill or script other than the web server imports `src/settings/`; an import-graph lint enforces it; (b) no write CLI (D9); (c) a new PreToolUse hook denies a tool call whose arguments mention `/api/settings` or the settings backup directory and, if Task 9 finds it missing, `Edit`/`Write` on `.env`; (d) the routes need a browser session cookie and CSRF that no agent holds; (e) the chat endpoint can only type text into a tmux pane and is unchanged. | Hook propagation into subagents is unverified (as for every hook here); layers (a), (b), (d) do not depend on it. Medium. |
| D19 | The mode banner is derived from the `.env` FILE (`currentMode(fileFlags(parseEnv(text)))`, read-only reuse of `src/stack/mode.ts`) on every `/api/session` and `/api/settings/meta`, and compared with a snapshot taken when the dashboard started; when they differ it adds "changed since the dashboard started, restart pending". It cannot see the environment of other running processes; the pending-restart list covers those. | The banner can say DRY RUN while an old window still runs LIVE until restarted. Mitigated by the restart badge and `npm run up -- --status`. Medium, stated on the page. |
| D20 | The setup wizard keeps writing `.env` through `writeEnvFile` unchanged. Only the validators are shared later. | Two writers exist (wizard, dashboard); both use `updateEnvText`. Low. |
| D21 | `JOBBER_KILL` and the STOP file are NOT editable here (`never`, "use `npm run jobber:control`"). A stop button is a separate, later decision (O9). | No panic button on the page yet. Low. |
| D22 | Classes of key are decided by RULES, not only a list, and a test enforces the rules over the whole catalog: a key ending `_DRY_RUN` is `safety`; type `path`, a key ending `_CMD`, `_PATH`, `_REMOTE`, `_DIR`, or a URL a secret is sent to is `never`; every `LIMITS` key with a `raiseNote` is at least `guarded`; every secret has `tier != 'never'` only when it is an API key for a fixed vendor host. This covers keys plan 8G adds (`WEB_DRY_RUN`, `APPLY_DRY_RUN`, `SCOUT_DRY_RUN`, `APPLY_ALLOW_ACCOUNT_CREATION`, ...). | A future key that fits no rule defaults to `normal`; the rule test lists the safety-relevant patterns so the reviewer catches it. Medium. |

## Edit tiers (the initial assignment Task 2 seeds; the rule tests in Task 2 guard it)

| Tier | Keys (initial) | Why |
|---|---|---|
| `never` (display only, reason shown) | `WEB_AUTH_MODE`, `WEB_AUTH_DB`, `WEB_BIND`, `WEB_PORT`, `WEB_ALLOW_REMOTE_BIND`, `WEB_ALLOWED_HOSTS`, `WEB_TRUST_PROXY`, `WEB_REAUTH_MAX_AGE_SEC`, `WEB_CHAT_ENABLED`, `WEB_TMUX_SESSION`, `WEB_TMUX_WINDOW`, `WEB_OIDC_ISSUER`, `WEB_OIDC_CLIENT_ID`, `WEB_OIDC_CLIENT_SECRET`, `WEB_OIDC_REDIRECT_URI`, `WEB_OIDC_REAUTH_PROMPT`, `WEB_GOOGLE_KEYS_PATH`, `WEB_GOOGLE_REDIRECT_SHAPE`, `DASHBOARD_ALLOWED_EMAIL`, `WEB_SETTINGS_EDIT`, `WEB_SETTINGS_REMOTE_SAFETY` | Sign-in, identity, bind address and exposure: a wrong edit locks the owner out (the page would stop answering) or exposes the dashboard; an attacker with one session must not be able to widen the door. Lockout recovery is `.env` by hand. |
| `never` | `JOBBER_KILL`, `JOBBER_NOTIFY_CMD`, `TELEGRAM_BOT_TOKEN`, `ALLOWED_USERS`, `CCGRAM_DAEMON_SESSION`, `MANAGER_TMUX_SESSION`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CLI_PATH`, `GMAIL_OAUTH_PATH`, `GMAIL_CREDENTIALS_PATH`, `JOBAPPLIER_USER_DATA`, `LAYOUT_DIR`, `SCHEDULER_NO_CLASSIFIER`, `AUTO_UPDATE_REMOTE`, `AUTO_UPDATE_BRANCH`, `AUTO_UPDATE_TAG_PATTERN`, `AUTO_UPDATE_REQUIRE_SIGNED`, `AUTO_UPDATE_SIGNERS_FILE`, `AUTO_UPDATE_REVIEW_PATHS`, `BACKUP_DIR`, `BACKUP_AGE_RECIPIENT`, `BACKUP_RCLONE_REMOTE`, `BACKUP_INCLUDE_SECRETS` | Command execution (`_CMD`, `CLAUDE_CLI_PATH`), traffic redirection with a credential (`ANTHROPIC_BASE_URL` + token), who may command the bridge (`ALLOWED_USERS`), where code or backups come from or go (update source, signing, recipient, remote), disabling a safety layer (`SCHEDULER_NO_CLASSIFIER`), kill switch (D21), paths to secrets. CLAUDE.md Safety rule 16 already says the agent never sets update and backup keys; a compromised dashboard must not either. |
| `safety` (re-auth + typed phrase when weakening) | `JOBBER_DRY_RUN`, `SCHEDULER_DRY_RUN`, `LINKEDIN_DRY_RUN` (+ every `*_DRY_RUN`), `FOLLOWUPS_AUTONOMOUS`, `SCHEDULER_ENABLED`, `AUTO_UPDATE`, `BACKUP_ENABLED`, `HUNTER_ENABLED`, `LINKEDIN_ACCEPT_UNKNOWN`, `LINKEDIN_ALLOWED_URLS`, `LINKEDIN_ALLOWED_EMAILS`, `CLASSIFIER_MODEL` (enum of ids in `config/classifier-models.json`; clearing weakens), `LAYOUT_ENFORCE` (leaving `enforce` weakens), and the 8G keys `APPLY_ALLOW_ACCOUNT_CREATION`, `SCOUT_ALLOW_SIGNUP`, `APPLY_ALLOW_UNKNOWN_HOSTS`, `APPLY_LINKEDIN_EASY`, `APPLY_SUBMIT_MODE`, `APPLY_ACCEPT_LEGAL_REQUIRED`, `SITE_MAIL_VERIFY`, `SITE_MAIL_SENDERS` | They decide whether real emails, messages, applications or account creations happen, or widen an output allow-list. The two account-creation flags are editable (not `never`) because 8G's supervised checks turn them on and off repeatedly (8G D11); they stay behind the phrase and behind dry run. |
| `guarded` (re-auth when weakening) | every `LIMITS` key (raising a cap, shortening a cooldown or gap, narrowing quiet hours; direction from the spec), `MATCH_THRESHOLD` (lowering), `RUN_MAX_*` (raising), `FOLLOWUP_CHECK_MAX_AGE_MIN` (raising), `HUNTER_MONTHLY_CAP`, 8G budgets (`SERPER_DAILY_BUDGET`, `SERPER_MONTHLY_BUDGET`, `DORK_DAILY_BUDGET`, `APPLY_MAX_*`, `SITE_MAX_ACCOUNTS_PER_DAY`) | Money, account-ban risk and volume. |
| `normal` | non-secret preferences and read-only-ish tuning (`LAYOUT_*` thresholds, `INBOX_EVERY_MIN`, pacing in the safe direction, `NAUKRI_HEADLESS`, retention counts, `DOCTOR_SKIP_SMOKE`, `BOOTSTRAP_MODEL_PROFILE`, model name keys), and vendor API keys `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `SERPER_API_KEY`, `HUNTER_API_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD` (write-only) | Replacing a key for a fixed vendor host cannot redirect anything. |

The initial assignment is a proposal the owner reviews (O2); the rule tests (D22) and the table test in Task 6 are what make it enforceable.

## Config file registry (explicit allowlist; the client sends an id, never a path)

| id | Path | Edit | Validator (reuse) | Tier and weakening rule | Form view | Restart |
|---|---|---|---|---|---|---|
| `portals` | `config/portals.json` | yes | `loadPortals` (via a temp copy) plus the slug rules in `src/sources/boards/filters.ts` | `normal`; cross-file warning when `location_filter.remote_anywhere` differs from `target-regions` | enable toggles per company, add company, aggregators | next fetch |
| `target-regions` | `config/target-regions.json` | yes | `loadTargetRegionsStatus` | `normal`; `remote_anywhere` false to true is `guarded` | home, targets list, flags | next run |
| `deal-breakers` | `config/deal-breakers.json` | yes | zod `{keywords: string[]}` (loader has no problem report) | removing a keyword is `guarded` | keyword list | next run |
| `replies` | `config/replies.json` | yes | zod `{auto_record_enabled: boolean}` | `auto_record_enabled` false to true is `safety` (CLAUDE.md: leave it off) | one switch | next run |
| `linkedin-discovery` | `config/linkedin-discovery.json` if present, else `config/discover-linkedin.json` | yes | own zod structural schema in `src/settings/schemas/discovery.ts` (the 8G loader does not exist yet) | `normal` | job search rows | next run |
| `languages` | `user-data/languages.json` | yes | `loadLanguageConfigStatus` | `confirmed` false to true is `guarded` (turns FLAG into FAIL exclusions) | declared list, confirmed | next run |
| `easy-apply-answers` | `user-data/easy-apply-answers.json` | yes | zod fixed fields + `custom` map; WARNING when `requires_sponsorship` is an object (known conflict, CLAUDE.md Naukri section) | `normal`; the agent also appends `custom` entries (Applying step 2a), so the etag check matters | fixed fields, custom Q and A | none (read per call) |
| `profile` | `user-data/profile.json` | yes | `validateProfile` | `normal` | roles, locations, salary bands | next run |
| `fact-gate` | `user-data/fact-gate.json` | yes | the `src/resumeFacts.ts` shape rules (extract a pure `validateFactGateObject`) | adding to `allow_facts` or `allow_metrics` is `safety` (widens the gate); other lists `normal` | four string lists | none (read per call) |
| `permission-sets`, `run-profiles`, `worker-tools`, `classifier-models`, `manager-windows`, `platforms`, `ai-tells`, `ccgram-pin`, `update-known-failures` | `config/*.json` | VIEW ONLY | n/a | n/a | JSON viewer with the reason "edit with the CLI named here" (`npm run permissions`, ...) | n/a |

User-data entries resolve through `userDataDir()` (`JOBAPPLIER_USER_DATA` may point outside the project): the directory is `realpath`ed once at start, only the exact filenames above are accepted under it, and a target that is a symlink is refused.

## Unverified (stated plainly)

- Which processes read which `.env` key and when (restart scope). Task 2 records the reader file per narrower-than-`stack` scope; anything not traced stays `stack`.
- That `npm run down && npm run up` restarts every consumer, including the Claude Code sessions that host the MCP servers. CLAUDE.md says a FULL Claude Code restart is needed for MCP changes; the badge text says so and does not claim `up` does it.
- Whether blank (`KEY=`) equals unset for every loader. Task 2 tests this over the real loaders where they are callable; others stay `blankMeansDefault: false`.
- How `scripts/auto-update.ts` behaves when `config/*.json` is locally modified (D11).
- Whether an interactive project session can `Edit` `.env` today (`block-outside-project.cjs` only blocks outside the project). Task 9 reads the hook and adds a deny if missing.
- `Sec-Fetch-Site` on a navigation inside a tmux-hosted browser or a webview; the page is used from desktop and phone browsers.
- That `fs.renameSync` over `.env` is atomic on the owner's filesystem (true on local APFS and ext4; unverified on network mounts).
- The 8G keys and file names used here (`WEB_DRY_RUN`, `APPLY_*`, `SCOUT_*`, `config/linkedin-discovery.json`, `config/platforms.json`) come from the 8G PLAN, not from merged code; Task 2 re-reads the merged `.env.example`.
- The `WEB_` prefix is shared by dashboard keys and 8G web-core keys (`WEB_DRY_RUN`, `WEB_MIN_GAP_SEC`, `WEB_MAX_CALLS_PER_JOB`, `WEB_MAX_JOB_MIN`, `WEB_IDLE_MS`, `WEB_SETTLE_MS`). The catalog is keyed by exact name and by `section`, never by prefix.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/settings/types.ts` (new) | `EnvSpec`, `EditTier`, `RestartScope`, `SectionId`, `ChangeOp`, `Plan`, `Friction` | 1 |
| `src/settings/valueCheck.ts` (new) | `validateEnvValue(spec, raw)`, cross-key rules (pairs, requirements), `weakens(spec, old, new)` | 1 |
| `tests/settings-value-check.test.ts`, `tests/settings-types-rules.test.ts` (new) | Type matrix and rule tests on a small fixture catalog | 1 |
| `src/settings/envCatalog.ts` (new), `src/settings/fromLimits.ts` (new), `scripts/seed-env-catalog.ts` (one-shot, deleted at the end of Task 3) | The catalog and its seed importer | 2 |
| `tests/settings-env-catalog.test.ts` (new) | Coverage, rules, composition | 2 |
| `src/settings/exampleGen.ts` (new), `scripts/gen-env-example.ts` (new), `.env.example` (regenerated), `tests/env-example-complete.test.ts` (modify), `tests/settings-example-gen.test.ts` (new), `package.json` (modify: `env:example`, `settings`) | Generated `.env.example` | 3 |
| `src/settings/fileRegistry.ts`, `src/settings/schemas/*.ts`, `src/settings/jsonStore.ts`, `src/settings/diff.ts` (new), `tests/helpers/noRealEnv.ts`, `tests/helpers/memFs.ts`, `tests/fixtures/settings/*` (new), tests | File allowlist, validators, read/plan/apply of JSON files | 4 |
| `src/settings/envEdit.ts`, `src/settings/atomic.ts`, `src/settings/backups.ts`, `src/settings/pendingRestart.ts` (new), tests | Env change plan, apply, backups, rollback | 5 |
| `src/settings/policy.ts` (new), `tests/settings-policy.test.ts` | Friction table | 6 |
| `src/web/settingsRoutes.ts` (new), `src/web/server.ts` (modify, additive), `src/dash/authStore.ts` (modify, additive), tests | API | 7 |
| `src/web/env.ts`, `scripts/web.ts`, `src/dash/configView.ts` (modify), `tests/web-env.test.ts`, `tests/dash-panels.test.ts` | Wiring, new keys, catalog-based config view | 8 |
| `.claude/hooks/settings-guard.cjs` (new), `.claude/settings.json` (modify), `tests/settings-isolation.test.ts` (new), `scripts/settings.ts` (new, read-only) | Agent isolation | 9 |
| `src/web/static/app.js`, `api.js`, `style.css`, `views/settings.js` (+ `settings-*.js`) (new/modify), `tests/web-frontend-lint.test.ts` | Banner and Settings shell | 10 |
| `src/web/static/views/settings-env.js` | Environment editor | 11 |
| `src/web/static/views/settings-files.js`, `settings-backups.js`, `settings-diff.js` | Files editor, backups, diff | 12 |
| `src/stack/up.ts` (modify, small), `src/settings/pendingRestart.ts` | Pending-restart tracking | 13 |
| `src/platform/checksSettings.ts` (new), `src/platform/doctor.ts` (modify, one registration), `tests/settings-e2e.test.ts` (new) | Doctor and end-to-end test | 14 |
| `CLAUDE.md`, `README.md`, docs (list in Task 15) | Docs truth pass | 15 |

## Overlap with plan 8G and build order

Plan 8G has no task on `src/web`, `src/dash`, `scripts/web.ts` or the auth store, so the dashboard half of this plan is conflict-free. The shared files are the env surface, hooks and registration points:

| File | 8G tasks that edit it | 8H tasks | Rule |
|---|---|---|---|
| `.env.example` | 3 (Serper relabel, `DORK_*`, `SEARCH_*`, `SERPER_*_BUDGET`), 4 (`WEB_DRY_RUN`, `APPLY_DRY_RUN`, `SCOUT_DRY_RUN`, `WEB_*` tuning, `APPLY_MAX_*`, `SITE_MAX_ACCOUNTS_PER_DAY`, `LINKEDIN_MAX_DISCOVER_PER_DAY`), 7, 8, 10, 11 (`SCOUT_*`, `GEN_PROVIDER_*`, `NAUKRI_DISCOVER_EVERY_HOURS`), 12 and 14 and 23 (removals: `LINKEDIN_LOGIN_ACCOUNT`, `NAUKRI_SEARCH_EVERY_HOURS`, hybrid fallback keys), 18 to 22 (`APPLY_*`, `SITE_MAIL_*`) | 2 (seed), 3 (generate and take ownership) | 8H Tasks 2 and 3 start AFTER all of 8G-1 is merged. From the merge of Task 3 on, a plan that adds or removes a key edits `src/settings/envCatalog.ts` and runs `npm run env:example`; 8G-2 (Tasks 16 to 25) must follow that rule. If 8G-2 is already merged first, Task 2 simply seeds from the larger file. |
| `src/setup/limitsCatalog.ts` | 3, 4 (new counters) | none (read-only composition) | Never edited by 8H. A new `LIMITS` entry shows up in the catalog automatically through `fromLimits`; the Task 2 test asserts it. |
| `tests/env-example-complete.test.ts` | 3, 4 (guard stays green) | 3 (rebase onto the catalog) | 8H Task 3 rewrites it after the 8G-1 merge; the `INTERNAL` map moves into `envCatalog.ts` as `INTERNAL_NAMES`. |
| `tests/setup-limits-catalog.test.ts` | 3, 4 | none | Untouched. |
| `src/platform/doctor.ts`, `src/platform/checks*.ts` | 24 (new `checksSources.ts`, `checksWeb.ts`) | 14 (new `checksSettings.ts` plus one registration line) | New files, one-line registration conflict at most. Build 14 after 8G Task 24 or resolve the registration list by hand. |
| `scripts/dry-run.ts` | 24 | none | 8H adds no dry-run stage; the e2e test in Task 14 covers the round trip hermetically. |
| `.claude/settings.json`, `.claude/hooks/*`, `tests/hook-tool-allowlist.test.ts` | 7, 14, 21 (tool lists, kill-switch matcher list) | 9 (a NEW hook file and one added matcher entry; no edit to `tool-allowlist.cjs` or `kill-switch.cjs`) | Conflict limited to the `hooks` array in `.claude/settings.json`. |
| `config/permission-sets.json`, `config/run-profiles.json`, `config/worker-tools.json`, `.mcp.json` | 7, 13, 14, 20, 21, 23 | none | 8H adds no MCP server and no tool; these appear only as view-only registry entries. |
| `package.json` | 12 (`naukri:login`), 8 (`providers`), 6 (`site:account`) | 3, 9 (`env:example`, `settings`) | Script lines only; trivial merge. |
| `CLAUDE.md`, `README.md`, `docs/config-reference.md`, `docs/dashboard-exposure.md`, `docs/operations.md` | 25 | 15 | Both are batch docs passes; do 8H's after 8G's, or merge by section (8H touches only dashboard, safety rule and env-source paragraphs). |
| `config/portals.json`, `target-regions.json`, `discover-linkedin.json` | 14 deletes `discover-linkedin.json`, 10 creates `linkedin-discovery.json` | registry resolves whichever exists | Registry test asserts exactly one of the two exists. |

**Proposed order.** (1) Build 8H Tasks 1, 4, 5, 6 (pure modules on a fixture catalog) in parallel with 8G-1. (2) 8H Tasks 7 to 10 (API, wiring, isolation, frontend shell) at any time; they use the fixture catalog until Task 2. (3) After 8G-1 is merged: 8H Task 2, then Task 3 (take ownership of `.env.example`). (4) 8G-2 then edits the catalog instead of `.env.example`. (5) 8H Tasks 11, 12, 13, 14 after Task 2 (they need the real catalog for UI tests), then 15 last, after 8G Task 25. Merge as two PRs if convenient: PR A = Tasks 1, 4 to 10 (no change to `.env.example`), PR B = Tasks 2, 3, 11 to 15.

---

### Task 1: Catalog types, value validation, direction semantics

**Why:** every later task depends on one definition of an env key and one validator. This task writes them against a tiny fixture catalog so it can start before 8G lands.

**Files:**
- Create: `src/settings/types.ts`, `src/settings/valueCheck.ts`, `tests/settings-value-check.test.ts`, `tests/settings-types-rules.test.ts`, `tests/fixtures/settings/catalog.fixture.ts`

**Interfaces:**
```ts
// src/settings/types.ts
export type EnvType = 'bool' | 'int' | 'enum' | 'string' | 'path' | 'url' | 'email' | 'list' | 'intList' | 'secret';
export type EditTier = 'never' | 'safety' | 'guarded' | 'normal';
export type RestartScope = 'none' | 'next_run' | 'dashboard' | 'scheduler' | 'mcp' | 'stack';
export type Weakens = 'true' | 'false' | 'increase' | 'decrease' | 'cleared' | 'any' | null;
export interface EnvSpec {
  key: string; section: SectionId; feature: string;          // 'email outreach', 'dashboard', ...
  type: EnvType; default: string | null;                     // what the code uses when blank/absent; null = no default
  exampleActive: boolean;                                    // listed as KEY= (true) or # KEY= (false) in .env.example
  required: 'required' | 'optional' | 'conditional'; requiredWhen?: string;
  min?: number; max?: number; allowed?: readonly string[]; maxLen?: number; itemCount?: number;
  secret: boolean; tier: EditTier; tierReason: string; weakens: Weakens;
  restart: RestartScope; restartEvidence?: string; blankMeansDefault: boolean;
  about: string;                                             // one to three sentences for the UI and the generated comment
  note?: string; docs?: string; auditValue: boolean;
}
export type ChangeOp = { key: string; op: 'set'; value: string } | { key: string; op: 'clear' } | { key: string; op: 'reset' };
export interface FieldDiff { key: string; before: string; after: string; secret: boolean }   // secret: 'set'|'not set' words only
export interface Friction { refuse?: string; reauth: boolean; phrase: string | null }
```
`validateEnvValue(spec, raw): string | null` (null = ok, else a reason that never echoes a secret): `bool` is exactly `true`/`false` (some keys use `1`/`0` or `1` only: the spec's `allowed` wins); `int` whole number inside min..max (same rule as `validateLimit`); `enum` in `allowed`; `list` and `intList` comma lists with `itemCount` and per-item range (`CADENCE_GAPS_DAYS`); `url` parses and is https or loopback http; `email` via `normaliseEmail`; `path` no NUL, no newline, at most 1024 chars; `string` and `secret` no CR or LF, at most `maxLen` (default 2000). Cross-key: `validateCross(values, catalog)` reuses `validatePairs` for the PACING pairs and returns messages.
`weakens(spec, before, after): boolean`: `'true'` means after is `true` (or in the live set) and before was not; `'false'` the reverse; `'increase'` and `'decrease'` compare ints (a missing value counts as the default); `'cleared'` means non-blank to blank; `'any'` any change; `null` never.

- [ ] **Step 1: Failing tests.** One `it` per type for accept and reject (including `1`/`0` flags, `true`/`false`, `007`, `1e3`, negative, over max, empty for required, enum miss, list wrong arity, list item out of range, URL with credentials rejected, path with NUL, value with a newline); no reason string contains the rejected value when `spec.secret`; `weakens` table (each mode, default fallback, blank before); `Friction` is not computed here.
- [ ] **Step 2: Run, confirm failure:** `npx vitest run tests/settings-value-check.test.ts tests/settings-types-rules.test.ts`.
- [ ] **Step 3: Implement.** Pure, no I/O.
- [ ] **Step 4: Verify:** the two test files and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(settings): env spec types, value validation and weakening semantics`

---

### Task 2: The real catalog (seeded from `.env.example`, composed with `LIMITS`) [after 8G-1 is merged]

**Why:** this is the single source of truth. The seed importer turns today's comment lines into reviewed `about` text so no key is lost.

**Files:**
- Create: `src/settings/envCatalog.ts`, `src/settings/fromLimits.ts`, `scripts/seed-env-catalog.ts` (one shot), `tests/settings-env-catalog.test.ts`
- Read-only: `.env.example`, `src/setup/limitsCatalog.ts`, `config/classifier-models.json`, the readers named below.

**Behaviour:**
- `scripts/seed-env-catalog.ts` reads `.env.example` (committed, no secrets), splits sections on the `# ====` banners, and for each `KEY=` or `# KEY=` line takes the comment block above it as `about` (stripping the leading `Default X.`, `Allowed: ...`, `Secret.`, `Optional.`, `Required...` sentences into structured fields where the regex is unambiguous, leaving the rest in `about`), `exampleActive` from the comment marker, and prints a TypeScript object literal to stdout. The builder pastes it into `envCatalog.ts` and edits by hand; the script is deleted at the end of Task 3 (kept only until the golden round trip passes).
- `fromLimits(spec: LimitSpec): EnvSpec` maps group to section, `default`/`min`/`max`/`unit`, `what` to `about`, `raiseNote` to `note`, tier `guarded` when `raiseNote` exists else `normal`, `weakens` from a small override map (`'decrease'` for `PACING_MIN_*`, `COOLDOWN_*`, `*_GAPS_DAYS`, `MATCH_THRESHOLD`; `'any'` for `QUIET_HOURS_*`; `'increase'` otherwise).
- Every entry gets `tier`, `tierReason`, `restart`, `blankMeansDefault`, `auditValue` set by hand following the "Edit tiers" table. **Restart evidence:** for each key the builder greps the reader (`src/outreach/config.ts`, `src/outreach/tuning.ts`, `src/layout/config.ts`, `src/web/env.ts`, `scripts/web.ts`, `src/scheduler/*`, the launchers, `scripts/run-claude.ts`) and records the narrowest honest scope with `restartEvidence: '<file>'`; anything not traced stays `stack`.
- `blankMeansDefault` is set from a test that runs the real loaders (`loadOutreachConfig({KEY: ''})`, `loadTuning`, `loadLayoutEnv`, `validateRunnerConfig`) for the keys they cover; uncovered keys are `false`.
- `INTERNAL_NAMES` (the current `INTERNAL` map, with its reasons) is exported from the same file for the completeness test.
- Section ids mirror today's headings: `credentials-sources`, `credentials-gmail`, `safety`, `classifier`, `limits`, `linkedin`, `naukri`, `scheduler`, `dashboard`, `telegram`, `layout`, `update-backup`, `advanced` (plus any section 8G-1 added, such as `web-core`, `search`, `apply`; Task 2 re-reads the merged file to name them).
- New keys introduced by this plan: `WEB_SETTINGS_EDIT` (`false`), `WEB_SETTINGS_REMOTE_SAFETY` (`false`), `SETTINGS_BACKUP_KEEP` (`10`, 1..100, tier `normal`), all section `dashboard` except the last (`advanced`).

- [ ] **Step 1: Failing tests (`tests/settings-env-catalog.test.ts`):**
  - keys unique; every spec passes its own `validateEnvValue(spec, spec.default)` when a default exists;
  - **coverage:** every `KEY=`/`# KEY=` in `.env.example` is in the catalog and vice versa (this test is replaced by the generation check in Task 3 but stays as a guard against a half-done Step 3);
  - **limits composition:** every `LIMITS` key is in the catalog and its default, min and max equal the `LIMITS` values (so a new limit appears automatically or fails here);
  - **rules (D22):** every key ending `_DRY_RUN` is `safety` with `weakens` set; every key of type `path` or ending `_CMD`, `_PATH`, `_REMOTE`, `_DIR` is `never`; every `LIMITS` key with `raiseNote` is `guarded` or stricter; the `never` set contains every key of the "Edit tiers" `never` rows; no `never` key has `weakens`; every `secret` key has `exampleActive` true or false but `default` null; secrets are exactly the keys the old regex masked plus `CLASSIFIER_MODEL` is NOT secret (assert both lists explicitly);
  - **restart:** any scope other than `stack` has `restartEvidence` naming an existing file; `WEB_*` dashboard keys are `dashboard`;
  - **text:** every entry has non-empty `about` (at most 600 characters), `feature`, `tierReason`; no em or en dashes; `about` of a secret never contains an example value;
  - **blank:** `blankMeansDefault` is true only for keys covered by a loader assertion in this file;
  - the `INTERNAL_NAMES` keys are not in the catalog;
  - **8G keys:** if any of `WEB_DRY_RUN`, `APPLY_DRY_RUN`, `SCOUT_DRY_RUN`, `APPLY_ALLOW_ACCOUNT_CREATION`, `SCOUT_ALLOW_SIGNUP` is present it has tier `safety` (skipped assertions when absent, so the test is valid before and after 8G).
- [ ] **Step 2: Run, confirm failure:** `npx vitest run tests/settings-env-catalog.test.ts`.
- [ ] **Step 3: Seed, review, write the catalog.** Review every `about` against the code once (stale comments are fixed here, reported in the commit body).
- [ ] **Step 4: Verify:** `npx vitest run tests/settings-env-catalog.test.ts tests/setup-limits-catalog.test.ts tests/env-example-complete.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(settings): single env catalog composed with the limits catalog`

---

### Task 3: Generated `.env.example` and the rebased completeness test [after Task 2]

**Files:**
- Create: `src/settings/exampleGen.ts`, `scripts/gen-env-example.ts`, `tests/settings-example-gen.test.ts`
- Modify: `.env.example` (regenerated), `tests/env-example-complete.test.ts`, `package.json` (`"env:example": "tsx scripts/gen-env-example.ts"`)
- Delete: `scripts/seed-env-catalog.ts`

**Interfaces:** `renderEnvExample(catalog: EnvSpec[], header: string): string`; `scripts/gen-env-example.ts` writes `.env.example` or, with `--check`, compares and exits 1 on difference. Rendering rules reproduce today's format: banner per section, comment lines above the key built from `about` plus a standard tail (`Default X.`, `Allowed: ...`, `Secret.`, `Optional.`/`Required...`), `KEY=value` for active keys, `# KEY=value` for optional keys, the value shown is the code default (active keys with a safe shipped value use `exampleValue`), no inline comments, no em or en dashes, the existing header block (format rules) copied verbatim.

**Migration (explicit):** (1) generate to a temp file and diff against the committed `.env.example`; (2) the diff must contain only reviewed wording changes (listed in the commit body), no added or removed key, no changed shipped value (dry-run flags, secrets blank); (3) commit the regenerated file; (4) rebase `tests/env-example-complete.test.ts` so its checks read the catalog (`INTERNAL_NAMES`, `LIMITS` check becomes "catalog contains every LIMITS key") and add `npm run env:example -- --check` equivalent as a test; (5) keep the safe-value test and the no-inline-comment test unchanged.

- [ ] **Step 1: Failing tests:** round trip (`renderEnvExample` over a fixture catalog equals a golden file); generated real file equals committed `.env.example`; hand-editing `.env.example` in a temp copy makes `--check` fail; every rule of the old completeness test still holds on the generated output; shipped safe values asserted (`JOBBER_DRY_RUN=1`, `SCHEDULER_DRY_RUN=true`, `LINKEDIN_DRY_RUN=true`, every `*_DRY_RUN` true, `WEB_SETTINGS_EDIT=false`, all secrets blank, `WEB_AUTH_MODE=token`).
- [ ] **Step 2 to 4:** run, implement, regenerate, verify: `npx vitest run tests/settings-example-gen.test.ts tests/env-example-complete.test.ts tests/setup-limits-catalog.test.ts tests/setup-env-empty-comment.test.ts tests/env-example-update-backup.test.ts` and tsc.
- [ ] **Step 5: Commit:** `feat(settings): generate .env.example from the catalog and guard it`

---

### Task 4: File registry, validators, JSON store (plan, apply, backup), diff, test helpers

**Files:**
- Create: `src/settings/fileRegistry.ts`, `src/settings/schemas/{discovery,answers,replies,dealBreakers,factGate}.ts`, `src/settings/jsonStore.ts`, `src/settings/diff.ts`, `src/settings/atomic.ts` (shared with Task 5), `tests/helpers/noRealEnv.ts`, `tests/helpers/memFs.ts`, `tests/fixtures/settings/{env.fixture,portals.json,target-regions.json,deal-breakers.json,replies.json,languages.json,easy-apply-answers.json,profile.json,fact-gate.json}`, `tests/settings-file-registry.test.ts`, `tests/settings-json-store.test.ts`, `tests/settings-diff.test.ts`
- Modify (only if needed, minimal): `src/resumeFacts.ts` to export a pure `validateFactGateObject(raw)` extracted from the existing loader (behaviour unchanged, existing tests green).

**Interfaces:**
```ts
export interface FileEntry {
  id: string; rel: string; area: 'config' | 'user-data'; edit: boolean; maxBytes: number;
  validate(text: string, ctx: ValidateCtx): { ok: boolean; errors: string[]; warnings: string[] };
  weakens?(before: unknown, after: unknown): string | null;   // reason, or null; drives tier
  tier: EditTier; restart: RestartScope; viewReason?: string;
}
export function resolveEntry(id: unknown): FileEntry | null;   // id must match ^[a-z0-9-]{1,40}$ and be in the Map
export interface JsonStore {
  read(id: string): { text: string; etag: string; exists: boolean };
  plan(id: string, newText: string, expectEtag: string): FilePlan;          // validates, diffs, tiers
  apply(plan: FilePlan, newText: string): { backupId: string; newEtag: string };
  list(): FileSummary[];
}
```
Validation adapters: for loaders that take a path (`loadPortals`, `loadTargetRegionsStatus`, `loadLanguageConfigStatus`), write the candidate text to a `0600` temp file under `os.tmpdir()` and call the loader, then delete it; for `profile` use `validateProfile(JSON.parse(text))`; for the rest use zod schemas written from the example files and from the reading of each consumer (Step 1 of this task records, per file, the consumer and what it accepts). `easy-apply-answers` returns a WARNING (not an error) for an object-valued `requires_sponsorship`. Cross-file check: saving `portals` or `target-regions` loads the other (through the same store) and warns when `remote_anywhere` differs. Size: reject `text.length > entry.maxBytes` (default 262144) before parsing; reject BOM, NUL and invalid UTF-8.

Path safety: `rel` values are constants; the full path is `join(root, rel)` or `join(userDataRealDir, basename)`; the target is `lstat`ed and refused when it is a symlink or not a regular file; for a missing file the parent must exist and be the expected directory; backups go to `backupDir/files/<id>/<stamp>-<etag8>.json` created with `mkdirSync(mode 0o700)` and `writeFile(mode 0o600)`.

- [ ] **Step 1: Failing tests:**
  - **allowlist:** `resolveEntry` rejects `''`, `'..'`, `'../.env'`, `'portals/../..'`, `'PORTALS'`, `'portals\0'`, `'%2e%2e'`, `'/etc/passwd'`, an id with 41 chars, a non-string; view-only ids return `edit:false`; `resume`, `env`, `secrets` are unknown; the registry contains exactly the D14 ids (a table test; adding a file needs a deliberate edit);
  - **path:** a symlink at the target is refused; a directory at the target is refused; a `JOBAPPLIER_USER_DATA` pointing at a temp dir resolves the three user-data files there and nothing else; a `rel` containing `..` cannot exist (constant check);
  - **validation:** each fixture validates; for each file one broken variant per rule (wrong type, unknown key where the consumer rejects it, bad slug in `portals`, `ats` unknown, `tracked_companies` missing, `confirmed` non-boolean, salary shape, `allow_facts` non-string array, `keywords` non-array); error text carries a JSON path, never the whole file;
  - **limits:** oversize text refused before parse; BOM and NUL refused; invalid JSON gives a line/column when available;
  - **apply:** backup created first with mode 0600 in a 0700 directory, then temp + rename; a failing rename leaves the original and removes the temp; stale etag returns `stale_etag` without writing; retention keeps the newest `SETTINGS_BACKUP_KEEP`; `memFs` is used so nothing touches disk; `noRealEnv` asserts no read of the repo `.env`;
  - **diff:** `diff.ts` is a line diff (LCS, no dependency, capped at 5000 lines, returns `truncated: true` beyond that); formatting-only changes are counted separately; unchanged text returns an empty diff.
- [ ] **Step 2: Run, confirm failure:** `npx vitest run tests/settings-file-registry.test.ts tests/settings-json-store.test.ts tests/settings-diff.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** those files, `npx vitest run tests/resume.test.ts tests/language-gate*.test.ts` (names via `ls tests | grep -i -E "language|facts|resume"`; only the 1 known failure may remain), tsc.
- [ ] **Step 5: Commit:** `feat(settings): file allowlist, validators, JSON store with backup and diff`

---

### Task 5: Env change plan, atomic apply, backups, rollback

**Files:**
- Create: `src/settings/envEdit.ts`, `src/settings/backups.ts`, `tests/settings-env-edit.test.ts`, `tests/settings-env-store.test.ts`
- Reuse (do not modify): `updateEnvText`, `envEntries`, `envFileValue`, `EnvFs`, `nodeEnvFs` from `src/setup/envWriter.ts`; `parseEnv` from `src/platform/envFile.ts`; `atomic.ts` from Task 4.

**Interfaces:**
```ts
export interface EnvState { text: string; etag: string; exists: boolean }
export function readEnvState(fs: EnvFs, path: string): EnvState;     // etag = sha256(bytes) first 32 hex
export interface EnvPlan {
  etag: string; changes: ChangeOp[]; diffs: FieldDiff[]; errors: string[]; warnings: string[];
  friction: Friction; restart: { key: string; scope: RestartScope }[]; unknownKeys: string[]; newText: string; modeAfter: 'DRY RUN' | 'LIVE';
}
export function planEnvChange(state: EnvState, changes: ChangeOp[], catalog: EnvSpec[], ctx: PolicyCtx): EnvPlan;
export function applyEnvPlan(plan: EnvPlan, deps: { fs: EnvFs; path: string; backupDir: string; keep: number; now: () => Date }): { backupId: string; newEtag: string };
export function listBackups(deps, target: 'env' | { file: string }): BackupInfo[];
export function planRollback(state: EnvState, backupId: string, deps): EnvPlan;      // diff current -> backup, same friction
```
Behaviour:
- Ops: `set` (validated with `validateEnvValue`, then `updateEnvText`), `clear` (`KEY=`), `reset` (remove the active line; keys with `blankMeansDefault` use `clear`). Refuses a key not in the catalog (`unknown_key`), a `never` key (`tier_never`), a secret with `reset`, two ops on one key, more than 50 ops, a value over `maxLen`, a value with CR or LF.
- Unknown keys, comments, blank lines, `export` prefixes and CRLF line endings are preserved byte for byte (golden test over `tests/fixtures/settings/env.fixture`, which contains all of them plus one inline-comment line). A commented optional key (`# KEY=`) is activated by APPENDING `KEY=value` under a `# set from the dashboard` marker comment (one marker, reused), never by rewriting the comment line.
- Diff for a secret is the words `set -> replaced`, `set -> cleared`, `not set -> set`; for non-secret keys the old and new value (cleaned, 200 chars). The `newText` field is for the server only and is never serialized to a response.
- Cross-key validation after applying the ops to the parsed map: `validatePairs`, the dashboard rules via `validateRunnerConfig(env, {accountStored: true})` for web keys (only reachable if a `never` rule is ever relaxed; kept as a guard), `required`/`conditional` rules (for example `HUNTER_ENABLED=true` with `HUNTER_API_KEY` unset is a warning).
- `applyEnvPlan`: re-read the file immediately before writing and require the same etag (`stale_etag` otherwise), write the backup (full copy, mode 0600, directory 0700) FIRST, then temp + rename + chmod 600, prune beyond `keep`, then return the new etag. A failed backup aborts before any change. A failed rename leaves the original untouched and removes the temp.
- `planRollback` loads the backup text, plans `current -> backup` through `planEnvChange`-equivalent friction (so going back to LIVE needs the same phrase as flipping it), and `applyEnvPlan` takes a backup of the current file first. Backup ids are validated against `^\d{8}T\d{6}Z-[0-9a-f]{8}$` and looked up by listing the directory, never joined from client text.
- `modeAfter` uses `currentMode(fileFlags(parseEnv(newText)))`.

- [ ] **Step 1: Failing tests (all with `memFs` and the fixture; `noRealEnv` imported):** every op; unknown/comment/CRLF/export preservation golden; quoting of values with spaces and `#`; blank vs reset; refusal rows; stale etag; rename failure; backup failure aborts; backups mode and directory mode; retention; rollback round trip (apply, rollback, text equals original), rollback of a rollback; backup ids with traversal characters refused; **leak:** run a full set/replace/rollback with `FIXTURE-SECRET-1` and `FIXTURE-SECRET-2` and assert neither appears in any plan field, error, warning, diff, backup FILE NAME or `console` call (spy), while the backup FILE CONTENT does contain the old secret (documented, D8); `modeAfter` flips on the three dry-run flags.
- [ ] **Step 2: Run, confirm failure:** `npx vitest run tests/settings-env-edit.test.ts tests/settings-env-store.test.ts`.
- [ ] **Step 3: Implement.** **Step 4: Verify:** those tests plus `tests/setup-env-writer.test.ts`, tsc.
- [ ] **Step 5: Commit:** `feat(settings): env change plans with atomic apply, backups and rollback`

---

### Task 6: Friction policy (tier x direction), remote exposure, preflight

**Files:**
- Create: `src/settings/policy.ts`, `tests/settings-policy.test.ts`

**Interfaces:**
```ts
export interface PolicyCtx { editEnabled: boolean; remoteExposure: boolean; remoteSafetyAllowed: boolean; sessionFresh: boolean; }
export function requiredFriction(changes: ResolvedChange[], ctx: PolicyCtx): Friction;
export function phraseFor(changes: ResolvedChange[], modeBefore: Mode, modeAfter: Mode): string | null;
export function preflight(modeAfter: Mode, env: ..., deps: ...): string[];   // warnings only
```
Rules (the table below is the test): the strictest result across all changes wins; a refusal anywhere refuses the whole set.

| tier | direction | edit disabled | remote exposure | result |
|---|---|---|---|---|
| any | any | yes | any | refuse `settings_disabled` |
| `never` | any | no | any | refuse `tier_never` |
| `safety` | weakening | no | yes, no override | refuse `remote_exposure` |
| `safety` | weakening | no | no | reauth + phrase |
| `safety` | strengthening | no | any | none |
| `guarded` | weakening | no | any | reauth |
| `guarded` | strengthening | no | any | none |
| `normal` | any | no | any | none |
| any secret | replace or clear | no | any | tier of the key (secrets are `normal` or `never` only) |

Phrase: `GO LIVE` when `modeBefore` is DRY RUN and `modeAfter` is LIVE; else `CHANGE <KEY>` for exactly one safety key; else `CHANGE <N> SAFETY SETTINGS`. Compared exactly (trimmed, case-sensitive) by constant-time compare. `preflight` returns warnings (never blocks): classifier not ready for a live flip (`launchCheck`-style readiness through an injected function), `.jobber/STOP` present ("the kill switch is engaged, nothing will run"), permission set is not `read_only` while chat is enabled, a live flip with `SEND_LIMIT_PER_RUN=0`.

- [ ] **Step 1: Failing tests:** the table, one `it` per row with a fixture catalog; multi-change sets (strictest wins; one `never` refuses all); phrase rows (including a three-flag flip that yields `GO LIVE`, a flip of only `JOBBER_DRY_RUN` to `0` while the others stay dry which does NOT change the file mode and yields `CHANGE JOBBER_DRY_RUN`); direction cases (`1` to `0` weakens; `0` to `1` strengthens; `LAYOUT_ENFORCE` enforce to warn weakens; `MATCH_THRESHOLD` 60 to 50 weakens); a key with `weakens: null` never reaches reauth; `sessionFresh` is NOT part of the result (the server decides what to do with `reauth`), so the policy stays pure.
- [ ] **Step 2 to 4:** run, implement, verify (`npx vitest run tests/settings-policy.test.ts tests/settings-env-edit.test.ts`, tsc).
- [ ] **Step 5: Commit:** `feat(settings): friction policy by tier and direction with phrase and remote rule`

---

### Task 7: API routes, one-time tokens, audit, rate limit

**Files:**
- Create: `src/web/settingsRoutes.ts`, `tests/web-settings-api.test.ts`, `tests/web-settings-leak.test.ts`
- Modify (additive only): `src/web/server.ts` (register the routes; `WebDeps.settings?: SettingsDeps`), `src/dash/authStore.ts` (`CREATE TABLE IF NOT EXISTS settings_pending (token_hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL, plan_hash TEXT NOT NULL, etag TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT)`; `AuditKind` gains `'settings_env_apply' | 'settings_file_apply' | 'settings_rollback' | 'settings_reject'`), `tests/dash-auth-store.test.ts` (old-schema open still works)

**Routes** (all non-open: they inherit session check, 120/min, `X-CSRF-Token` and exact `Origin` on POST; JSON only; GET and POST only):

| Route | Body | Result |
|---|---|---|
| `GET /api/settings/meta` | | `{editEnabled, remoteExposure, mode: {mode, flags}, modeChangedSinceStart, pendingRestart: [{key, scope, command}], restartCommands, reauthFresh, catalogVersion, backupKeep}` |
| `GET /api/settings/env?q=&section=` | | `{sections: [{id, title, items: [{key, about, feature, type, default, min, max, allowed, required, secret, tier, tierReason, restart, restartCommand, state: {set, value?, source, modified, shellOverride}}]}], unknownKeys: [names]}`; a secret item has `state.set` and no `value` |
| `POST /api/settings/env/preview` | `{etag, changes}` (at most 64 KiB) | `{plan: {etag, diffs, errors, warnings, friction: {reauth, phrase}, restart, modeAfter}, token, expiresInSec: 120}`; a refusal returns `403 {error: code}` |
| `POST /api/settings/env/apply` | `{token, etag, changes, phrase?}` | `{ok, backupId, newEtag, restart}` |
| `GET /api/settings/files` | | registry list with `edit`, `exists`, `etag`, `tier`, `restart` |
| `GET /api/settings/files/:id` | | `{text, etag, entry, warnings}` (the id goes through `resolveEntry`; 404 otherwise) |
| `POST /api/settings/files/:id/preview` and `.../apply` | `{etag, text}` / `{token, etag, text, phrase?}` | as env; a `text` cap per entry |
| `GET /api/settings/backups?target=env\|file:<id>` | | `[{id, at, size}]` |
| `POST /api/settings/rollback/preview` and `.../apply` | `{target, backupId}` / `{token, target, backupId, phrase?}` | as env |

Order of checks on every write: (1) route auth (generic gate); (2) `Sec-Fetch-Site: same-origin` else `403 forbidden`; (3) `deps.settings` present else 404; (4) `editEnabled` else `403 settings_disabled`; (5) per-session settings limit 10 writes per minute and a lock of 5 minutes after 5 failed applies in 10 minutes (`429`, audited once); (6) body parse and size; (7) plan (validation errors are `422 {errors}` with key names and reasons, no values); (8) friction: `refuse` gives `403 code`; `reauth` and not `isFresh` gives `401 {error: 'reauth_required', url}` exactly like chat; a wrong or missing phrase gives `403 phrase_mismatch`; (9) token: the preview inserts the row; the apply loads it by `sha256(token)`, requires the same session hash, not used, not expired, `plan_hash` equal to `sha256(token + canonical(changes, etag))` (constant-time), marks it used even on a later mismatch; (10) apply; (11) audit. Audit rows: kind, ip, `note` = comma list of key names or the file id plus `n=<changed paths>`, plus non-secret `bool|int|enum` before->after pairs (D10), `textHash` = plan hash, `idHint` as elsewhere. Rejections are audited as `settings_reject` with a short code only.

After a successful env apply, any secret value just written is appended to `deps.secrets` (the redaction list) and the pending-restart file is updated (Task 13).

- [ ] **Step 1: Failing tests** (in-process server, `openAuthStore(tmp)`, a fake clock, `memFs` env and fixture files): 401 without a session; missing CSRF 403; wrong Origin 403; missing or cross `Sec-Fetch-Site` 403; `GET` on a write route 405; wrong content type 415; body over 64 KiB 413; `editEnabled=false` makes every write 403 and reads still work and `meta.editEnabled` false; preview then apply happy path for a `normal` key, a `guarded` key (needs fresh auth: with a stale session 401 `reauth_required`, after `refreshAuth` passes), a `safety` key (wrong phrase 403, right phrase passes), a `never` key (403 `tier_never`), a strengthening safety change (no phrase), remote exposure refusal and its override; token reuse 403; token from another session 403; token expired; changed changes between preview and apply 403 `plan_mismatch`; etag changed on disk between preview and apply 409 `stale_etag`; rate limit and failed-apply lock; unknown file id 404; traversal ids 404; rollback preview/apply; every response has the security headers; **audit:** one row per apply with key names and no secret; no row contains `FIXTURE-SECRET-`.
- [ ] **Step 2: Leak tests (`tests/web-settings-leak.test.ts`):** run list, preview, apply, rollback, files read and apply with fixture secrets; scan every response body, every audit row, the `settings_pending` rows, captured `console.log/error/warn`, and thrown error messages for `FIXTURE-SECRET-`; assert `GET /api/settings/env` and `GET /api/config` contain no secret value and that an unknown key listed by name carries no value.
- [ ] **Step 3: Implement** (route factory taking deps, no new HTTP framework; reuse `readJson`, `json`, `HttpError`).
- [ ] **Step 4: Verify:** `npx vitest run tests/web-settings-api.test.ts tests/web-settings-leak.test.ts tests/web-server.test.ts tests/web-token-login.test.ts tests/web-chat.test.ts tests/dash-auth-store.test.ts tests/dash-sessions.test.ts` and tsc.
- [ ] **Step 5: Commit:** `feat(web): settings API with two-step apply, reauth, phrase, audit and rate limit`

---

### Task 8: Wiring (`scripts/web.ts`, `web/env.ts`, config view on the catalog, banner data)

**Files:**
- Modify: `src/web/env.ts` (`settingsEdit: boolean`, `settingsRemoteSafety: boolean`, `settingsBackupKeep: number`; `bool()` rule and 1..100 range; errors under scope `web`), `scripts/web.ts` (build `SettingsDeps`: `root`, `.env` path, `userDataDir`, backup dir `.jobber/settings-backups`, catalog, `nodeEnvFs`, `remoteExposure = !isLoopbackBind(cfg.bind) || cfg.trustProxy`, startup mode snapshot; push new secrets into `secrets`), `src/dash/configView.ts` (env list from the catalog: names, `secret` flag, non-secret values only for non-secret keys; `SECRET_RE` and the prefix allow-list removed), `src/web/server.ts` (`/api/session` adds `mode`), `tests/web-env.test.ts`, `tests/dash-panels.test.ts` (find the config view test with `grep -l buildConfigView tests/*.ts`)

- [ ] **Step 1: Failing tests:** `validateRunnerConfig` accepts and rejects the three new keys; defaults false/false/10; `buildConfigView` marks exactly the catalog's secret keys as masked, never shows a secret, shows values for non-secret keys (not only the old allow-list) and lists unknown `.env.example`-less names by name only; `/api/session` carries `mode: {mode, flags}` and nothing else new; existing OIDC and token tests stay green.
- [ ] **Step 2 to 4:** run, implement, verify (`npx vitest run tests/web-env.test.ts tests/dash-panels.test.ts tests/web-api.test.ts tests/web-server.test.ts tests/web-auth-migration.test.ts`, tsc).
- [ ] **Step 5: Commit:** `feat(web): settings wiring, catalog-based config view and mode in the session payload`

---

### Task 9: Agent and chat isolation, read-only CLI

**Files:**
- Create: `.claude/hooks/settings-guard.cjs`, `scripts/settings.ts` (read-only: `list`, `get <KEY>` for non-secret keys, `check`, `backups`, `diff <backupId>`), `tests/settings-isolation.test.ts`, `tests/hook-settings-guard.test.ts`
- Modify: `.claude/settings.json` (one added PreToolUse matcher entry for `settings-guard.cjs`, `onFailure: block`), `package.json` (`"settings": "tsx scripts/settings.ts"`)

**Behaviour:**
- `settings-guard.cjs` is a standalone CommonJS hook (the `kill-switch.cjs` pattern) that denies any tool call whose serialized input contains `/api/settings`, `.jobber/settings-backups`, `.jobber/settings/`, or `settings_pending`, and ALSO denies `Edit`, `Write`, `NotebookEdit` and Bash redirections targeting a file whose basename is exactly `.env` or matches `^\.env\.(?!example$)` (this covers the interactive-session gap if Step 1 confirms it). It fails closed on a parse error. It does not touch `tool-allowlist.cjs` (D18, avoids 8G conflicts).
- Step 1 of this task READS `block-outside-project.cjs` and `tool-allowlist.cjs` and records in the commit body what they already deny for `.env`; if an interactive session could edit `.env`, the new deny is the fix, otherwise it is a belt-and-braces duplicate. `scripts/settings.ts` never writes anything and never prints a secret (`get` refuses a secret key with `secret: set|not set`).

- [ ] **Step 1: Failing tests:**
  - **import graph:** a test walks `src/**`, `scripts/**`, `.claude/**` and asserts the only importers of `src/settings/*` are `src/web/settingsRoutes.ts`, `src/web/server.ts`, `scripts/web.ts`, `scripts/gen-env-example.ts`, `scripts/settings.ts`, `src/platform/checksSettings.ts`, `src/stack/up.ts` (pending-restart clear) and tests; nothing under `src/mcp/`, `src/scheduler/`, `src/outreach/`, `src/linkedin/`, `src/naukri/`, `scripts/run-claude.*`, `scripts/scheduler.ts`;
  - **no write path from agents:** `config/permission-sets.json`, `config/run-profiles.json` and `config/worker-tools.json` contain no tool, Bash string or path that mentions `settings` or `/api/settings`; no agent or skill markdown mentions the settings API; `scripts/settings.ts` source contains no `writeFileSync`, `renameSync`, `applyEnvPlan`, `applyJson` (grep test);
  - **chat:** `validateChatText` is unchanged and still rejects any slash text other than the three status commands; add a test that a chat prepare/confirm cannot cause a call to the settings module (the chat dependency is an injected `send(text)` only; the test asserts the server's chat route never receives `deps.settings`);
  - **hook:** table test over `settings-guard.cjs` with Bash `curl http://127.0.0.1:8787/api/settings/env/apply`, Write to `.env`, Edit of `.env.local`, Edit of `.env.example` (allowed), Read of `.env.example` (allowed), Bash `echo x >> .env` (denied), a path mentioning `.jobber/settings-backups`, malformed input (denied), unrelated Bash (allowed);
  - **route reachability:** with a valid session but WITHOUT `Sec-Fetch-Site: same-origin`, every write route is 403 (the browserless `curl` case);
  - **CLI:** `list` prints names and set/unset only; `get ADZUNA_APP_KEY` prints `secret: set`; `check` exits non-zero on an unknown-key-free but invalid fixture; no output contains a fixture secret.
- [ ] **Step 2 to 4:** run, implement, verify (`npx vitest run tests/settings-isolation.test.ts tests/hook-settings-guard.test.ts tests/hook-tool-allowlist.test.ts tests/agents-lint.test.ts` and tsc).
- [ ] **Step 5: Commit:** `feat(settings): isolate the settings API from agents, chat and CLI writes`

---

### Task 10: Frontend shell: always-visible mode banner and Settings view skeleton

**Files:**
- Modify: `src/web/static/app.js` (sticky `#banner` outside the view root, rendered from the session payload on every navigation and every 60 s; new nav entry `settings`), `src/web/static/api.js` (`getSettingsMeta`, `postSettings` using the existing CSRF wrapper), `src/web/static/style.css`, `tests/web-frontend-lint.test.ts`
- Create: `src/web/static/views/settings.js` (tabs Environment, Files, Backups; reads `meta`; when `editEnabled` is false shows "Read only. To enable editing set WEB_SETTINGS_EDIT=true in .env and restart the dashboard." and no write controls), `tests/web-frontend-settings-lint.test.ts`

Banner: text `DRY RUN` or `LIVE` with an icon character and a distinct border style (never colour alone), `role="status"`, `aria-live="polite"`, plus "N changes need a restart" and "changed since the dashboard started" when present; it needs a session, so it shows after sign-in on every view including Overview (not on the login page). CSS uses the existing custom properties and adds dark/light variants; minimum 44 px targets; layout works at 360 px width with no horizontal scroll.

- [ ] **Step 1: Failing lint tests:** `settings*.js` and `app.js` use no forbidden DOM sink; no `localStorage`/`sessionStorage` reference in `views/settings*.js` (the remembered tab in `app.js` stays); the banner element exists in `app.js` and is outside the view root (so a view render cannot remove it); every `<input>` created in settings views has an associated `<label>` (grep for `setAttribute('for'`/`aria-label`); secret inputs use `type = 'password'` and `autocomplete = 'new-password'` (checked in Task 11).
- [ ] **Step 2: Implement.** **Step 3: Verify:** `npx vitest run tests/web-frontend-lint.test.ts tests/web-frontend-settings-lint.test.ts tests/web-server.test.ts` and tsc.
- [ ] **Step 4: Commit:** `feat(web): mode banner on every page and a read-only Settings shell`

---

### Task 11: Environment editor (search, groups, about text, staged changes, diff, confirm)

**Files:**
- Create: `src/web/static/views/settings-env.js`, `src/web/static/views/settings-diff.js`
- Modify: `src/web/static/views/settings.js`, `style.css`, `tests/web-frontend-settings-lint.test.ts`

Behaviour:
- One search box (matches key, about text, feature; `/` focuses it); a section filter; sections as `<details>` groups, open when they contain a match. Each row: key in monospace, `about` text inline (not a tooltip), badges with TEXT (secret, required or optional, tier lock with the reason in text for `never`, restart scope with the exact command from `restartCommand`, "modified from default" when `state.modified`, "set in shell, ignored by launchers" when `shellOverride`), default and range line, and a control by type: switch for `bool` (labelled `true`/`false`), number input with `min`, `max`, `step=1` for `int`, select for `enum`, text input for `string`, `path`, `url`, `email`, `list`; secret rows show `set` / `not set`, a **Replace** button (reveals a `type=password` input, `autocomplete=new-password`, `spellcheck=false`) and a **Clear** button; `never` rows are read-only with the reason.
- Staging: changes accumulate in a list ("3 pending changes", each removable); a staged secret is kept in a closure variable, shown as "new value staged (hidden)", cleared on apply, on navigation and on a failed apply never echoed. "Review changes" calls `preview`, renders the server diff (secret rows as words), warnings, errors (field-level, linked to the row), restart badges, and the required friction in plain words: "Needs a fresh sign-in" (button to the existing reauth view, returning to the same hash) and "Type `GO LIVE` to confirm" (input compared by the server, not trusted client-side). Apply calls `apply`; success shows the backup id, the restart commands and a Rollback link; a `stale_etag` shows "The file changed on disk since you opened this page" with a Reload button.
- Accessibility: all controls labelled; the about text linked with `aria-describedby`; status and errors in an `aria-live` region; full keyboard operation; focus moves to the diff heading on review and to the status on apply; no information by colour alone; phone layout is a single column with sticky "Review changes" bar.

- [ ] **Step 1: Failing tests:** lint (secret input type and autocomplete, no `value` attribute set from a secret state, no staged secret written to the DOM as text, no `innerHTML`); a jsdom-free structural test of the pure helper functions exported from the view (`groupBySection`, `matchesQuery`, `controlKindFor(spec)`, `buildChanges(staged)`, `redactStagedForRender`) with fixture specs: every `EnvType` maps to a control, a `never` spec maps to read-only, a secret spec never yields a value, search ranks key matches before about matches.
- [ ] **Step 2: Implement.** **Step 3: Verify:** `npx vitest run tests/web-frontend-settings-lint.test.ts tests/web-frontend-lint.test.ts` and tsc.
- [ ] **Step 4: Commit:** `feat(web): environment editor with about text, staged changes, diff and confirmation`

---

### Task 12: Files editor, backups and rollback UI

**Files:**
- Create: `src/web/static/views/settings-files.js`, `src/web/static/views/settings-backups.js`
- Modify: `src/web/static/views/settings.js`, `settings-diff.js`, `style.css`, lint test

Behaviour:
- File list with badges (editable, view only with the reason and the command that does edit it, missing). Opening a file shows a **form view** where the file has simple fields (`replies`: one switch; `target-regions`: home and targets as list editors plus the two flags; `deal-breakers`: keyword list; `languages`: declared rows with a level select and the `confirmed` switch with its warning text; `portals`: per-company enabled toggles and an add-company row; `profile`: roles, locations, salary bands; `fact-gate`: four string lists with the allow-list warning; `easy-apply-answers`: fixed fields and the custom Q and A list, and a banner when `requires_sponsorship` is an object) and a **raw JSON editor** tab (monospace textarea, line/column of the first parse error, server schema errors listed by JSON path). Form edits regenerate the text client-side (2-space JSON) and go through the same `preview` call, so the server is the only validator.
- Diff view shows the server line diff, "N formatting-only lines", truncated notice, schema warnings (cross-file `remote_anywhere` mismatch, object `requires_sponsorship`), the friction needed, and the restart/effect text ("read on next run").
- Backups tab: per target list (time, size, id), "Compare with current" (calls `rollback/preview`), "Restore" (apply with the same friction); an env rollback that would flip to LIVE shows the phrase prompt.

- [ ] **Step 1: Failing tests:** pure helper tests (form-to-text round trip for every form view on the fixture files, parse error position, `controlKindFor` for file fields); lint extensions; every form view only edits keys its schema knows (unknown keys in the loaded file are preserved in the regenerated text, asserted on a fixture with an extra key).
- [ ] **Step 2: Implement.** **Step 3: Verify:** `npx vitest run tests/web-frontend-settings-lint.test.ts tests/web-frontend-lint.test.ts tests/settings-json-store.test.ts` and tsc.
- [ ] **Step 4: Commit:** `feat(web): config file editor with form and raw views, backups and rollback`

---

### Task 13: Pending-restart tracking and the exact restart commands

**Files:**
- Create: `src/settings/pendingRestart.ts`, `tests/settings-pending-restart.test.ts`
- Modify: `src/stack/up.ts` (after a successful start of a component, clear the pending entries whose scope that start covers; read-only otherwise, no flag logic), `tests/stack-up*.test.ts` (find with `ls tests | grep -i stack`), `src/web/settingsRoutes.ts` (write on apply, return in `meta`)

**Behaviour:** `.jobber/settings/pending-restart.json` holds `{entries: [{key, scope, at}]}` (key names only, atomic write, mode 0600, size capped); `markPending(keys)` after every env apply or rollback whose scope is not `none`/`next_run`; `clearForScopes(scopes)` called by `up`; `commandFor(scope)` returns the text shown in the UI. Constant table (the text is a claim the docs pass re-checks; U-note in Unverified):

| scope | command shown |
|---|---|
| `none` | no restart needed (read on every call) |
| `next_run` | takes effect on the next scheduler wake or hunt run |
| `dashboard` | restart the dashboard (stop the `web` window, then `npm run web`, or `npm run down && npm run up`) |
| `scheduler` | `npm run down && npm run up` |
| `mcp` | fully quit and restart Claude Code sessions (MCP servers keep old code and env) |
| `stack` | `npm run down && npm run up`, then fully restart Claude Code sessions |

The banner and `meta.modeChangedSinceStart` use the same state.

- [ ] **Step 1: Failing tests:** mark, de-duplicate by key, clear by scope, corrupt file is treated as empty and rewritten, size cap, no value in the file, `up` clears only what it restarts (fake stack deps), file mode.
- [ ] **Step 2 to 4:** run, implement, verify (`npx vitest run tests/settings-pending-restart.test.ts` and the stack tests, tsc).
- [ ] **Step 5: Commit:** `feat(settings): pending-restart tracking cleared by npm run up`

---

### Task 14: Doctor checks and the end-to-end hermetic test

**Files:**
- Create: `src/platform/checksSettings.ts`, `tests/platform-checks-settings.test.ts`, `tests/settings-e2e.test.ts`
- Modify: `src/platform/doctor.ts` (register the new checks; one line), `tests/platform-doctor*.test.ts` (if the check list is asserted)

Doctor checks (never print a value; fix text names the command):

| id | pass | warn | fail |
|---|---|---|---|
| `settings_catalog` | every key in `.env` is in the catalog or counted as unknown (count shown); generated `.env.example` matches | unknown keys present (names listed) | catalog fails its own rules |
| `settings_store` | backup directory exists with mode 0700, files 0600, `.jobber/` ignored by git, count within `SETTINGS_BACKUP_KEEP` | no backups yet | directory or file mode too open |
| `settings_exposure` | `WEB_SETTINGS_EDIT` false, or true on loopback | edit enabled with `WEB_TRUST_PROXY=true` or a non-loopback bind; edit enabled with `WEB_CHAT_ENABLED=true` | `WEB_SETTINGS_REMOTE_SAFETY=true` without `WEB_ALLOWED_HOSTS` |
| `settings_files` | every editable file present validates | a file missing or invalid (names only); count of locally modified committed config files (via an injected git status function, skipped when none) | none |

**End-to-end test (`tests/settings-e2e.test.ts`, fully in process, memFs, fixture `.env`, temp auth store, fake clock):** sign in with token mode; open meta; read the env list; preview and apply a normal change; preview a `JOBBER_DRY_RUN` flip without fresh auth (401), refresh auth, wrong phrase (403), right phrase (200, banner mode data now reflects the file); verify the backup and the audit rows; roll back; verify the original text byte for byte; edit a config file through preview/apply and roll it back; then the leak scan over everything captured. Also asserts the real `.env` was never opened (`noRealEnv`).

- [ ] **Step 1 to 4:** failing tests, implement, verify (`npx vitest run tests/platform-checks-settings.test.ts tests/settings-e2e.test.ts tests/platform-doctor*.test.ts`, tsc).
- [ ] **Step 5: Commit:** `feat(doctor): settings checks and an end-to-end hermetic settings test`

---

### Task 15: Docs truth pass (single batch edit)

**Files:** `CLAUDE.md`, `README.md`, `docs/dashboard-exposure.md`, `docs/dashboard-login.md`, `docs/config-reference.md`, `docs/operations.md`, `docs/index.md`, new `docs/dashboard-settings.md`, `.env.example` header note (via the generator, Task 3), `tests/dash-docs.test.ts` (extend)

Required content:
- `CLAUDE.md`: Platform and sessions gains one paragraph "Dashboard settings editor (plan 8H)": the master switch `WEB_SETTINGS_EDIT` (default false), the four tiers, secrets write-only, two-step apply, backups under `.jobber/settings-backups/`, rollback, `npm run env:example`, `npm run settings -- list|get|check|backups|diff` (read-only). The "Preferences" intro stays ("edit these lines") with a pointer. Safety gains rule 17: the settings API is the only web write path, unreachable from chat, MCP tools, agents and restricted profiles; no CLI writes; dry-run flags are flipped only by the authenticated owner with a fresh re-authentication and a typed phrase; `never` keys are hand-edited. Rule 14/15 text ("only the owner flips dry-run flags") gains "or the owner through the dashboard under rule 17". The Commands table is unchanged (no new command).
- `docs/dashboard-exposure.md`: new section "Editing settings from the dashboard": enabling, the remote rule (D6), what is never editable and why (table copied from this plan), backup and rollback, the lockout recovery (edit `.env` by hand).
- `docs/config-reference.md`: replace the hand-maintained env table with a pointer to `.env.example` (generated) and the catalog; add the config-file registry table.
- `docs/dashboard-settings.md`: owner guide with the banner, search, about text, badges, the restart commands table, the diff and apply flow, rollback, and the phrase list.
- `docs/operations.md`: "A setting did not take effect" and "I locked myself out of the dashboard" entries.
- Tests: `.env.example` header says generated and names `npm run env:example`; docs mention `WEB_SETTINGS_EDIT`, `never`, `rollback`; no em or en dashes.

- [ ] **Step 1: Failing doc tests.** **Step 2: Write the docs** (owner-facing, plain wording). **Step 3: Verify:** `npx vitest run tests/dash-docs.test.ts tests/settings-example-gen.test.ts` and tsc.
- [ ] **Step 4: Commit:** `docs(dashboard): settings editor, exposure rule and generated env example`

---

## Final verification (after Task 15)

```bash
npx tsc -p . --noEmit
npx vitest run
npm run env:example -- --check
git grep -nE "FIXTURE-SECRET" -- src scripts .claude config     # expect nothing (fixtures live under tests/)
git grep -nE "src/settings" -- src/mcp src/scheduler src/outreach src/linkedin src/naukri .claude   # expect nothing
git grep -nE "writeFileSync|renameSync" -- scripts/settings.ts   # expect nothing
git status --short                                              # only intended paths
```
Expected: exactly the 5 known failures; `.env.example` equals the generated output; no file under `secrets/`, `user-data/`, `.env*`, `.dashboard/`, `.jobber/` touched.

## Hard limits for the builder

1. Do not read, print, write or commit `secrets/`, `user-data/`, `.env*` (except `.env.example`), `.dashboard/`, `.jobber/`, `generated/`, `data.sqlite`. Fixtures and `user-data.example/` only. `tests/helpers/noRealEnv.ts` must be imported by every settings test.
2. No network, no `npm install`, no new dependency, no browser, no tmux, no MCP server, no real `claude`.
3. Do not modify `src/setup/envWriter.ts`, `src/platform/envFile.ts`, `src/setup/limitsCatalog.ts`, `src/dash/sessions.ts`, `src/dash/accessToken.ts`, `src/dash/oidc.ts`, `.claude/hooks/tool-allowlist.cjs`, `.claude/hooks/kill-switch.cjs`. Additive changes only to `authStore.ts` and `server.ts`.
4. No tool, MCP server, agent, skill, run profile or permission-set entry for settings. No write CLI. No code outside the listed importers may import `src/settings/`.
5. Never return, log, audit, hash-store (unsalted) or put in a file name a secret value. Never add a "show secret" path.
6. Do not make any `never` key editable, do not default `WEB_SETTINGS_EDIT` or `WEB_SETTINGS_REMOTE_SAFETY` to true, do not lower the friction table, do not skip the phrase for a weakening safety change.
7. Never flip a dry-run flag, a halt, a permission set or the STOP file, in code, tests against real files, or live; tests use the in-memory fs only.
8. Do not edit `CLAUDE.md` or `README.md` before Task 15. Commit only listed paths. Never push, never `--no-verify`.
9. If a step needs a decision this plan does not make, stop and ask.

## Owner decisions (recommended defaults)

| # | Question | Recommended |
|---|---|---|
| O1 | Accept a web write path at all (an exception to the read-only dashboard spec) | yes, behind `WEB_SETTINGS_EDIT=false` by default and the tiers (D3, D4) |
| O2 | The initial tier assignment ("Edit tiers" table), especially `APPLY_ALLOW_ACCOUNT_CREATION` and `SCOUT_ALLOW_SIGNUP` as editable-with-phrase, `AUTO_UPDATE` and `BACKUP_ENABLED` as `safety`, and `CLASSIFIER_MODEL` as `safety` | as listed |
| O3 | Allow `safety` weakening edits over a remote exposure (Tailscale from a phone) | no (D6); set `WEB_SETTINGS_REMOTE_SAFETY=true` by hand if wanted |
| O4 | Backups: full copies with secrets, newest 10 | yes (D8) |
| O5 | Generate `.env.example` from the catalog and fail the tests on hand edits | yes (D2) |
| O6 | A write CLI for headless use | no (D9) |
| O7 | Edit committed `config/*.json` in place (git shows them modified) | yes (D11); revisit a local-override layer only if auto-update conflicts appear |
| O8 | Exclude `resume.json` and the view-only config files | yes (D14) |
| O9 | A "Stop everything" button (writes the STOP file) on the dashboard | not in this plan; decide after the editor has run a month |
| O10 | Audit string-valued settings values | no, names only for strings, paths, lists, emails (D10) |
| O11 | Phrase wording (`GO LIVE`, `CHANGE <KEY>`) | as proposed |

## Owner-only live checks (after merge; the builder cannot do these)

- **L1 (enable and read-only, 5 minutes):** set `WEB_SETTINGS_EDIT=false`, restart, open Settings: banner shows DRY RUN, rows and about text render, a write attempt (browser devtools `fetch` POST with the CSRF token) answers `settings_disabled`. Set `true`, restart, confirm the edit controls appear.
- **L2 (normal edit and rollback):** change `MATCH_THRESHOLD` 60 to 65, review the diff, apply; `diff .env .jobber/settings-backups/env/<newest>` shows only that line; restore from the Backups tab and confirm the file is byte-identical to the original (`shasum` before and after).
- **L3 (secret):** replace `ADZUNA_APP_KEY` with a throwaway; confirm the page, the network tab, `npm run dashboard -- audit` and the dashboard terminal never show it; clear it again.
- **L4 (safety flag):** with all three dry flags set, try flipping `SCHEDULER_DRY_RUN` to `false` after waiting more than `WEB_REAUTH_MAX_AGE_SEC`: expect the re-auth prompt, then the phrase prompt; confirm a wrong phrase is refused; DO NOT leave it live: flip it back (no phrase needed) and check the banner returns to DRY RUN.
- **L5 (never keys):** confirm `WEB_BIND`, `WEB_AUTH_MODE`, `ALLOWED_USERS` and `AUTO_UPDATE_REMOTE` are shown read-only with a reason.
- **L6 (concurrent edit):** open the editor, change `.env` by hand in a shell, then apply from the page: expect the stale-file message and no write.
- **L7 (agent isolation):** from a Claude Code session in this project try `curl` against `/api/settings/env` and an `Edit` of `.env`: expect the hook to deny both (hook propagation into subagents remains unverified; try once from a subagent too).
- **L8 (phone):** open the dashboard over your tunnel on a phone: banner visible, search works, the staged-changes bar is reachable one-handed, dark mode readable.
- **L9 (restart text):** after changing a `stack`-scope key run exactly the command shown, then confirm the pending-restart banner clears and the new value is in effect (`npm run status -- limits`).

## Self-review checklist (planner)

- Owner request coverage: (a) env editing with about text for every variable: Tasks 2, 7, 11; (b) config and user-data editing with validation, diff, backup, rollback: Tasks 4, 7, 12; single catalog shared by dashboard, `.env.example`, completeness test and setup limits: Tasks 1 to 3 (D1, D2); drift guard and migration: Task 3; secrets write-only: D5 and the leak tests in Tasks 5, 7; safety-critical classification with reasons: "Edit tiers"; re-auth plus phrase: D4 and Task 6; agent and chat unreachable: D18 and Task 9; atomic writes, mode 600, timestamped backups in `.jobber/`, etag, unknown-key and comment preservation, diff, explicit apply, rollback, audit, CSRF and Origin, rate limit, restart badges with exact commands: Tasks 5, 7, 13; JSON schema validation per file with form and raw views, allowlist, path traversal and size tests: Tasks 4, 12; no-build accessible phone-friendly frontend with search, grouping, modified markers and an always-visible banner: Tasks 10 to 12; doctor: Task 14; docs list: Task 15; decisions, unverified, hard limits, live checks: sections above; overlap with 8G and order: its own section.
- No placeholder steps: every task names files, tests, a verify command and a commit message.
- Names used consistently: `EnvSpec`, `EditTier`, `RestartScope`, `ChangeOp`, `EnvPlan`, `Friction`, `FileEntry`, `planEnvChange`, `applyEnvPlan`, `planRollback`, `requiredFriction`, `phraseFor`, `resolveEntry`, `WEB_SETTINGS_EDIT`, `WEB_SETTINGS_REMOTE_SAFETY`, `SETTINGS_BACKUP_KEEP`, `settings_pending`, `.jobber/settings-backups/`, `.jobber/settings/pending-restart.json`.
