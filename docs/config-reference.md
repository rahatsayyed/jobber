# Config reference

Audience: owner
Last verified against: 21e67ef
Source files: src/sources/boards/filters.ts, src/targetRegions.ts, src/vetoes.ts, src/replies.ts, src/linkedin/discoveryConfig.ts, src/safety/styleGate.ts, src/lib/userData.ts, src/languageGate.ts, src/resumeFacts.ts, src/platform/permissions.ts, scripts/permissions.ts, scripts/models.ts, scripts/check-portal.ts, scripts/user-data.ts, .env.example, src/setup/limitsCatalog.ts, src/sources/registry.ts, src/sources/runner.ts

This page lists every file you may edit in `config/` and `user-data/`, what reads it, whether a restart is needed, and how to check an edit. It does not repeat safety rules or caps: those live in `CLAUDE.md` (sections "Safety" and "Outreach safety layers"). All example values below are synthetic.

Restart rule of thumb: an MCP server keeps what it loaded at start. After you change a file marked "restart", fully quit and restart Claude Code (see "After merge: user checklist" in `CLAUDE.md`). A file marked "per call" is read again on every call and needs no restart.

## Files you edit day to day

| File | Purpose | Read by | Reload | Validate |
|---|---|---|---|---|
| `config/platforms.json` | The platform registry: every job source, whether it is on, how far it was verified, attribution for imported feeds | `src/sources/registry.ts` (`loadRegistry`), used by the code pass and `source_status` | per code pass | `npm run doctor` check `source_status`; see [sources-and-platforms.md](sources-and-platforms.md) |
| `config/portals.json` | Which company boards and aggregator feeds to fetch, plus the title and location filters | `src/sources/boards/filters.ts` (`loadPortals`), used by the code pass and `job-fetch.list_new_jobs` | per fetch; a restart is needed only if the server was started before the file existed (unverified) | `npm run doctor` check `config-files` (parses and needs a `tracked_companies` array); slugs: `npx tsx scripts/check-portal.ts` |
| `config/target-regions.json` | Home region, target regions (Gulf), remote and `remote_anywhere` switches for the location gate | `src/targetRegions.ts`, called by `gates.apply_vetoes` | per call | `npm run doctor` check `config-files` (needs `home` and `targets` arrays) |
| `config/linkedin-discovery.json` | Named LinkedIn job searches and hiring-post searches | `src/linkedin/discoveryConfig.ts` | read with each search call (unverified for posts) | `npm run doctor` check `config-files` (parses, must be a JSON object only) |
| `config/naukri-discovery.json` | Named Naukri searches (`searches[]`: `name`, `query`, optional `location`, `limit` 1 to 40, default 20); the `naukri-operator` runs them by name, with a random 2 to 5 second pause before every search after the first | `src/naukri/discover.ts` (`loadNaukriDiscoveryConfig`), `scripts/scheduler.ts` (names only) | read when the scheduler starts a wake and by each `naukri_discover` call | an invalid file yields no searches and a note on stderr |
| `config/wellfound-discovery.json` | Named Wellfound searches (`searches[]`: `name`, `role`, optional `location`, `remote`, `limit` 1 to 40, default 20); the planner schedules Wellfound only when this names a search AND `secrets/wellfound-state.json` exists | `src/wellfound/discover.ts` (`loadWellfoundDiscoveryConfig`), `scripts/scheduler.ts` | as the Naukri file | an invalid file yields no searches (and no Wellfound task) |
| `config/deal-breakers.json` | Keywords that exclude a job | `src/vetoes.ts` (`loadDealBreakers`) | per call | `npm run doctor` check `config-files` (parses, must be a JSON object; it does not check `keywords`) |
| `config/replies.json` | Whether detected replies may be auto-recorded | `src/replies.ts` (`loadRepliesConfig`) | per call | `npm run doctor` check `config-files` (parses, must be a JSON object) |
| `user-data/resume.json` | Base resume the agent tailors (the agent never edits it) | resume MCP, matcher | restart after a change (unverified inference: MCP servers keep what they loaded) | none found |
| `user-data/profile.json` | Roles, locations, salary floors, notice period, work authorization | setup wizard (`profile` step) | per use (unverified inference) | `npm run doctor` check `profile-valid` |
| `user-data/account.json` | Your LinkedIn plan (`free`, `premium`, `unknown`) | `src/accountPlan.ts` | per call | none (optional) |
| `user-data/languages.json` | Languages you speak and whether you confirmed the list | `src/languageGate.ts` | per call | `npm run doctor` check `languages-confirmed` (parse and `confirmed` only) |
| `user-data/easy-apply-answers.json` | Answers to common screening questions | `src/apply/answers.ts` | per apply call, no restart | none found |
| `user-data/fact-gate.json` | Facts you confirmed, plus phrases to block or warn on | `src/resumeFacts.ts` (`loadFactGateConfig`) | per render or check call | none found; a bad file blocks with the `unknown key` error |

The `user-data/` files do not exist on a fresh clone. Copy the synthetic templates from `user-data.example/` with:

```bash
npm run user-data -- init
```

This copies each missing template into `user-data/` and prints one line per file. `npm run user-data -- migrate` instead copies files from their pre-8D legacy locations (the old input and config folders, listed in `src/lib/userData.ts`) when the new file is absent. Never paste real personal data into a doc, a commit or a chat that is not the setup wizard.

### config/portals.json

Purpose: board-wide discovery. Board jobs are filtered ONLY by this file, not by the Role and Location preferences.

Schema pointer: `loadPortals` in `src/sources/boards/filters.ts`. Required: `tracked_companies` (array), `title_filter.positive` and `title_filter.negative` (arrays, positive not empty), `location_filter.allow` (array, not empty), `location_filter.global` (array if present). An entry with a bad slug, unknown `ats` or no name is skipped and reported as a warning; the rest still run. The error text starts with `config/portals.json:`.

```json
{
  "tracked_companies": [
    { "name": "Example Co", "ats": "greenhouse", "slug": "example-co", "enabled": true }
  ],
  "title_filter": { "positive": ["word:developer"], "negative": ["word:intern"] },
  "location_filter": { "allow": ["India"], "global": ["remote"] }
}
```

`enabled` must be exactly the boolean `true`. Check a slug before adding it (this uses the network, so it is a step you run yourself):

```bash
npx tsx scripts/check-portal.ts greenhouse example-co
```

It prints how many jobs the board returned and how many pass your filters; exit code 0 is ok, 1 a fetch failure, 2 a usage or slug problem. For Workday add `--wd <wdN> --site <site>`; the aggregators (`hackernews`, `himalayas`, `weworkremotely`) take no slug. The full rule syntax (`word:`, `lead:`, `stem:`, `a + b`) and the aggregator terms are described in the "Preferences" section of `CLAUDE.md`. Himalayas and We Work Remotely terms: check upstream before enabling. Keep the Gulf terms in `location_filter.allow` in step with `config/target-regions.json` (a test checks the `remote_anywhere` pair).

### config/target-regions.json

Purpose: the deterministic location backstop. A matcher location FAIL for a posting that names a target region becomes a visible FLAG, never a silent pass.

Schema pointer: `loadTargetRegionsStatus` in `src/targetRegions.ts`. Missing file means built-in defaults. Invalid file is flagged as `target regions config invalid: <why>` with one of: `home must be a non-empty array of short strings`, `targets must be an array of at most 100 short strings`, `remote must be true or false`.

```json
{
  "home": ["India"],
  "targets": ["UAE", "Dubai", "Qatar"],
  "remote": true,
  "remote_anywhere": false
}
```

`remote_anywhere` is on only for the boolean `true`; anything else is off. Its meaning (and the restriction markers that override it) is in `CLAUDE.md` "Target regions". The same switch also lives under `location_filter` in `config/portals.json`; keep both equal.

### config/linkedin-discovery.json

Purpose: named LinkedIn job searches (`jobs[]`) and hiring-post searches (`posts[]`) for the `linkedin_search_jobs` and `linkedin_search_posts` tools (main account, extraction selectors live-unverified). It replaced the old discover config file (plan 8G Task 14); the typed tools take only a search name and the URL is built in code.

Schema pointer: `src/linkedin/discoveryConfig.ts`. A job entry is `name`, `keyword`, plus optional `location`, `posted_within_seconds`, `remote_only`, `easy_apply_only`, `experience_level` and `limit`; a post entry is `name`, `role`, `geo` and `limit`.

### config/deal-breakers.json

Purpose: a posting containing one of these keywords is excluded by `gates.apply_vetoes`.

Schema pointer: `loadDealBreakers` in `src/vetoes.ts`. A missing, unparsable or non-array `keywords` value yields an empty list, which silently disables the check. Validate the JSON yourself after editing.

```json
{ "keywords": ["unpaid", "commission only"] }
```

The shipped list includes a `no sponsorship` keyword that excludes Gulf postings which ask for an existing work permit; see "Gulf targeting" in `CLAUDE.md` before changing it.

### config/replies.json

Purpose: one switch, `auto_record_enabled`. It ships `false` and should stay `false`: with it off, every detected interview or rejection is a proposal you approve.

Schema pointer: `loadRepliesConfig` in `src/replies.ts`. A missing, unreadable, invalid or non-boolean value means off.

```json
{ "auto_record_enabled": false }
```

### user-data/languages.json

Purpose: input for the deterministic language gate.

Schema pointer: `loadLanguageConfigStatus` in `src/languageGate.ts`. Each `declared` entry needs a non-empty `language` and a `level` of `basic`, `professional`, `fluent` or `native`. A bad entry makes the whole file invalid (the gate then reports `language gate config invalid: ...`); a missing or empty list reports `language gate config missing`.

```json
{
  "confirmed": false,
  "declared": [
    { "language": "English", "level": "fluent" }
  ]
}
```

While `confirmed` is not exactly `true`, an undeclared required language is only a FLAG. Add a language only if you really speak it.

### user-data/account.json

Purpose: your LinkedIn plan, read by `outreach.list_due_touches` (top-level `linkedin_plan`) so the operator and skills can see it. Optional.

Schema pointer: `loadLinkedinPlan` in `src/accountPlan.ts`. `linkedin_plan` is `free`, `premium` or `unknown`; a missing file, bad JSON or any other value means `unknown`. Nothing in code branches on it (the monthly note quota is still detected at runtime). Template: `user-data.example/account.json`.

```json
{ "linkedin_plan": "unknown" }
```

### user-data/profile.json

Written by the setup wizard (`profile` step; `npm run setup -- --step profile`). Shape comes from `user-data.example/profile.json`: `version`, `roles`, `locations`, `remote_ok`, `remote_anywhere`, `salary` (per currency `floor` and `target`), `notice_period_days`, `work_authorization` (`india`, `other`), `languages`. Prefer the wizard over hand edits; the loader is `src/setup/steps/profile.ts`.

### user-data/easy-apply-answers.json

Purpose: truthful answers for LinkedIn Easy Apply screening questions. Shape: see `user-data.example/easy-apply-answers.json` (fixed fields plus a `custom` object keyed by the question text verbatim). Re-read from disk on every `applier` answer lookup (`src/apply/answers.ts`), so no restart.

Never invent a value. Rules for filling `custom` are in `CLAUDE.md` "Applying", step 2a.

Known limit (also noted in `CLAUDE.md`, section "Naukri"): the template and the setup `profile` step write `requires_sponsorship` as an object (`india`, `other`), but `src/apply/answers.ts` only maps a boolean answer to a Yes/No radio, so an object value fails closed to `needs_answer`. Check the file before any automated apply flow reads it. Do not fix this by hand-editing around it without checking `src/apply/answers.ts` first.

### user-data/fact-gate.json

Purpose: an escape hatch for facts the resume gate wrongly blocks.

Schema pointer: `loadFactGateConfig` in `src/resumeFacts.ts`. The top level must be an object and unknown keys are rejected (`user-data/fact-gate.json: unknown key "<name>"`). Keys: `allow_facts`, `allow_metrics`, `forbidden_phrases`, `warn_phrases`.

```json
{
  "allow_facts": [],
  "allow_metrics": [],
  "forbidden_phrases": ["example banned phrase"],
  "warn_phrases": []
}
```

Add an allow entry only for a fact you confirmed, and add that fact to `user-data/resume.json` first.

## Files you rarely touch

| File | Purpose | Read by | Reload | Validate |
|---|---|---|---|---|
| `config/ai-tells.json` | Style gate for outbound LinkedIn and Naukri text: banned phrases, dash bans, markdown ban, word limits per kind | `src/safety/styleGate.ts` (`loadStyleConfigSafe`), cached by `src/mcp/linkedin.ts` and `src/mcp/naukri.ts` | restart | a bad value falls back to the built-in default and a note is logged; Naukri sends refuse with `style_config_unavailable` when a note exists |
| `config/permission-sets.json` | The three permission sets `read_only`, `outreach_send`, `full` | `scripts/permissions.ts`, launchers | read when the command or launcher starts | `npm run permissions -- --status` |
| `config/run-profiles.json` | Restricted-run profiles: `outreach_wake` (every wake), `mail_drip` (one run per email in the mail drip lane), `setup_guide` (tools, env, turn limits) | `scripts/run-claude.ts`, `src/platform/checks.ts` | read at each launch | `npm run doctor` |
| `config/worker-tools.json` | Exact tool list per operator agent (`linkedin-operator`, `naukri-operator`, `wellfound-operator`, `source-operator`, `mail-operator`, `apply-operator`) | `src/platform/checksScheduler.ts` (doctor check `agents-worker-tools`) | read at launch and by doctor | `npm run doctor` |
| `config/manager-windows.json` | Named tmux windows the manager can start (`hunt`, `followups`) and the protected ones | `scripts/manager.ts`, `src/stack/up.ts`, `src/stack/down.ts` | read when the command runs | `npm run doctor` |
| `config/setup-guide.json` | Step text for the guided setup session | the `setup-guide` skill (`.claude/skills/setup-guide/SKILL.md`); shape checked by `tests/setup-guide.test.ts` | read by the guide session when it starts (from the skill text) | `npm run doctor` check `setup_guide_ready` covers the profile and skill, not this file |
| `config/update-known-failures.json` | Known failing test files and counts for the auto-update test gate | `scripts/auto-update.ts` | read per update run | keep in step with the test baseline in `CLAUDE.md` |
| `config/runner/` | MCP config files for restricted runs (`mcp.platform.json`, `mcp.mail.json` for the drip lane, `mcp.none.json`) and a probe settings file | `src/platform/runner.ts`, `src/platform/checks.ts` | read at launch | `npm run doctor` |

Notes:
- The `outreach_wake` tool list must stay a subset of `config/worker-tools.json` and the servers in `config/runner/mcp.platform.json`; the doctor warns on an unconfigured server. Wildcards are rejected.
- A permission set applies to the git-ignored `.claude/settings.local.json`. Changing which set is active is an owner action, never an agent action (see "Platform and sessions" in `CLAUDE.md`).
- A sample edit that only touches the style gate (text limits) needs one restart, because the MCP servers cache the parsed file.

```json
{ "max_exclamations": 0, "forbid_markdown": true }
```

That snippet shows two keys of `config/ai-tells.json` only; the real file needs every key (`banned_phrases`, `forbid_em_dash`, `forbid_en_dash`, `max_exclamations`, `forbid_markdown`, `max_words`) to pass strict parsing.

## Never edit by hand

| File | Why | How it changes |
|---|---|---|
| `config/ccgram.pin.json` `version` | The start script refuses any other ccgram version; ccgram's own upgrade command is never used | the version changes only by editing the pin after review (doctor check `upgrade-policy`); nothing in code writes the file. The one hand edit that is expected is setting `installed` to `true` after installing the pinned version, when doctor check `ccgram-pin-state` warns (see [Prerequisites](prerequisites.md)) |
| `config/classifier-models.json` pins (`revision`, checksums) | A wrong pin makes the classifier unavailable, and live reads and sends then fail closed | `npm run models -- fetch` then `npm run models -- pin <profile>`; read by `loadRegistry` in `src/safety/classifierRegistry.ts`; check with `npm run doctor` checks `classifier_model` and `classifier_smoke` |
| the retired learned ATS platforms file in `config/` (`learned-ats-platforms` with a `.json` extension; not written as a path here because the docs lint rejects a path that does not exist) | No longer written or read (the scripted bootstrap was removed in plan 8G-2 task 23); `scripts/migrate-learned-ats.ts` converts an old copy into applier recipes | `scripts/migrate-learned-ats.ts`. May not exist |
| `.jobber/layout/` | Layout memory, machine-written, git-ignored | `npm run layout -- reset <platform>` (see `CLAUDE.md` "Layout memory") |
| `data.sqlite` | The application database | tools only |

## Environment variables

Secrets and tuning values live in one git-ignored `.env` (mode 600). The catalog is `.env.example` (every key, commented) plus `src/setup/limitsCatalog.ts` (defaults, ranges and explanations of every limit). Show the live values with:

```bash
npm run status -- limits
```

This prints today's limits and usage. To walk the limits interactively use `npm run setup -- --step limits`. Do not copy default values into notes; they change in code and a test fails on drift.

Groups in `.env.example` (one line each):

- Job sources: none needs a key (Remotive and RemoteOK are keyless); the optional Serper and Hunter keys below are for contact finding. See [api-keys](api-keys.md) and `.env.example`.
- Contact finding: Serper and Hunter keys, the dork and search budgets, the Hunter enable switch and monthly cap.
- Browser apply and web: `APPLY_SUBMIT_MODE`, the per-host caps and the account flags; see [apply.md](apply.md).
- Email: Gmail OAuth paths and the legacy SMTP fallback.
- Telegram: bot token and allowed user ids for the ccgram bridge.
- Platform ceilings: the daily caps per platform, all rolling 24 hours (LinkedIn `LINKEDIN_MAX_INVITES_PER_DAY` default 40, `LINKEDIN_MAX_MESSAGES_PER_DAY` default 100 and `LINKEDIN_MAX_DISCOVER_PER_DAY`; the old weekly LinkedIn keys are gone, and the wake pacing keys (random burst size) were removed too; Naukri and the Wellfound `WELLFOUND_MAX_APPLIES_PER_DAY`, `WELLFOUND_MAX_MESSAGES_PER_DAY`, `WELLFOUND_MAX_DISCOVER_PER_DAY`); `npm run status -- limits` prints them.
- Email drip lane (all optional, commented in `.env.example`; read by the scheduler daemon at start, so restart it after a change): `EMAIL_SEND_WINDOW_START` / `EMAIL_SEND_WINDOW_END` (HH:MM, IST), `EMAIL_DRIP_MIN_BATCH` / `EMAIL_DRIP_MAX_BATCH`, `EMAIL_DRIP_MIN_GAP_MIN` / `EMAIL_DRIP_MAX_GAP_MIN`, `EMAIL_DRIP_INTRA_PAUSE_MIN_SEC` / `EMAIL_DRIP_INTRA_PAUSE_MAX_SEC` and `EMAIL_MAX_PER_DAY` (`0` or unset means no daily cap). The defaults are in `src/setup/limitsCatalog.ts` and `.env.example`. An invalid value stops the lane and the doctor check `mail-drip-config` says why.
- Agent tuning: `MATCH_THRESHOLD`, `SEND_LIMIT_PER_RUN` (the daily email limit for `/followups` sessions; the drip lane uses `EMAIL_MAX_PER_DAY` instead), `MAX_APPLIES_PER_DAY`, `MAX_LINKEDIN_SEARCHES_PER_DAY`, and the follow-up switches (`FOLLOWUPS_AUTONOMOUS`, `EMAIL_FOLLOWUP_GAPS_DAYS`).
- Dashboard: `WEB_PORT`, `WEB_AUTH_MODE` and the other `WEB_*` keys; see `docs/dashboard-exposure.md`.
- LinkedIn tools: accept limits, allow-lists for URLs and emails, idle time, and the on-by-default (set `false` to disable) `LINKEDIN_SCREENSHOT`, `NAUKRI_SCREENSHOT`, `WELLFOUND_SCREENSHOT` and `SCOUT_SCREENSHOT` flags (screenshot and pointer-click tools; the pixels are not screened by the classifier).
- Dry run: the single flag `JOBBER_DRY_RUN` (`true` or `1` = dry; unset, `false` or anything else = LIVE). The old per-area dry-run keys (one each for the scheduler, LinkedIn, web, apply and scout) are ignored.
- Scheduler: enable flag, run budgets (`RUN_MAX_WALL_SEC` and `RUN_MAX_TOKENS_APPROX`, defaults 3600 s and 1000000 approximate tokens; the number of tool calls is reported, never limited), inbox, Naukri and Wellfound search cadence (`INBOX_EVERY_MIN`, `NAUKRI_DISCOVER_EVERY_HOURS`, `WELLFOUND_DISCOVER_EVERY_HOURS`), `USAGE_LIMIT_BACKOFF_MIN`, kill switch `JOBBER_KILL`.
- Auto-update and backup: `AUTO_UPDATE*` and `BACKUP_*`; see `docs/backup-and-restore.md`.
- Layout memory: `LAYOUT_ENFORCE` and the other `LAYOUT_*` keys, all optional and commented.
- Stack and bootstrap: `STACK_TMUX_SESSION`, `STACK_DOWN_WAIT_SEC`, `BOOTSTRAP_MODEL_PROFILE`.

After any `.env` change, run:

```bash
npm run doctor
```

This prints an ok, warn, fail or skip line per check and never prints secret values. MCP servers read the environment at start, so restart Claude sessions after an edit.
