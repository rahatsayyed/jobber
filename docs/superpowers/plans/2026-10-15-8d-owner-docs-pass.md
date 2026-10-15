# Plan 8D: Owner docs pass (set up and run the system from docs alone)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per project preference, dispatch every subagent with `model: sonnet`.

**Goal:** Three months from now the owner can set up, run, watch, stop and repair Jobber using only `docs/` (plus `README.md`), without reading `CLAUDE.md` (which is the agent's spec, not an owner manual) or plan files. Today the owner knowledge is spread over a 1000-line `CLAUDE.md`, a README quick start, and eleven topic docs; there is no ordered path, no prerequisites page, no operations page, no config reference, and no check that docs stay true.

**Architecture:** Eleven new owner docs plus an index, each written by a fresh sonnet subagent from a **fact sheet** the task lists (source files to read, facts to extract), never from memory or from other docs' prose. A docs lint test (`tests/docs-owner.test.ts`, Task 1) fails on a documented `npm run` script that does not exist, a documented env var that is in neither `.env.example` nor the limits catalog, a documented config file that does not exist, a dead relative link, or a missing "Last verified against" marker. A final truth pass (Task 13) re-derives every claim from code with a different agent than the writer, and a cold read (Task 14) has an agent with no repo knowledge follow `00-start-here.md` literally. Existing topic docs are linked, not copied and not edited (except Task 12 pointers).

**Tech Stack:** Markdown, vitest (existing), Node `fs`. No new dependencies, no code under `src/`.

**Spec:** the owner request quoted in the task prompt for this plan (docs set approved by the owner). Source of truth for behaviour is code and `.env.example`; `CLAUDE.md` is a pointer target, never a fact source on its own (it contains known stale statements; the 8A truth pass fixed some).

## Global Constraints

- **Ordering gate:** do not start until plan 8B is merged (layout memory, `scripts/layout.ts`, `LAYOUT_*` keys, operators exist). Task 10 additionally waits for plan 8C (dashboard simple login) to merge. If 8C is not merged, skip Task 10, keep its link out of Tasks 11 and 12 (the lint's planned-docs allowance in Task 1 covers this), and ship the rest.
- Test baseline before and after EVERY task: `npx tsc -p . --noEmit` clean and `npx vitest run` shows exactly the 5 known failures (`tests/renderChecked.test.ts` x4, `tests/resume.test.ts` x1) and nothing else. The only new test file is `tests/docs-owner.test.ts`.
- Never read, print or write `user-data/`, `secrets/`, `.env*` (except `.env.example`, committed), `data.sqlite` or `.jobber/`. Docs use synthetic example values only (`user-data.example/` shapes, `you@example.com`). No network, no `npm install`, no starting a browser, tmux, MCP server or `claude` while writing docs.
- **Docs state facts the code states.** Every number (default, cap, timeout, version) is either read from code/config in the same task or written as a pointer ("see `npm run status -- limits`" or "default in `src/setup/limitsCatalog.ts`"). Do not copy limit values into docs (CLAUDE.md rule). Anything about a third party (provider free tiers, prices, install commands, terms) that is not verifiable from the repo is marked `check upstream: <url or provider name>` and carries no number.
- Mark known-unverified behaviour as unverified, using the repo's own wording ("live-unverified", "unit-tested with fakes"). Never write "works" for something `CLAUDE.md` "Known limits" says has not run live.
- Style: second person, imperative, short; one task per `##` heading; every command in a fenced `bash` block with the expected result in one sentence under it; no emojis; no em or en dashes (the project style gate bans them in outreach text; keep docs consistent); ASCII only.
- Every owner doc has this header block (exact field names, lint-checked):
  ```
  Audience: owner
  Last verified against: <fill at merge>
  Source files: <comma list of repo paths the facts came from>
  ```
  `<fill at merge>` is replaced by the short commit hash of the merge base in Task 13. Do not invent a hash.
- Do not edit `CLAUDE.md` or `README.md` before Task 12 (project preference: batch doc edits). Task 12 adds pointers only, never moves rules out of `CLAUDE.md`.
- Commit per task with the message given; one task per commit; check `git status` before each commit (nothing under `user-data/`, `secrets/`, `.env*`, `.jobber/`).

## Review Focus

1. **Lint is the guard, not the prose** (Task 1): reviewers read `tests/docs-owner.test.ts` and its negative cases first; every later task must pass it unmodified (a task may add a doc to the lint's `OWNER_DOCS` list, nothing else).
2. **No duplicated rules** (Tasks 4, 5, 8): safety rules, caps and gate behaviour are linked to their `CLAUDE.md` section or doc, not restated; a duplicate will drift.
3. **Fact sheets are real** (every writer task): each listed source file exists on the branch (checked by Step 1 of the task before writing).
4. **Owner-only vs agent steps are explicit** (Tasks 9, 11): a reader can see which steps only a human can do (OAuth consent, QR or password login, bot creation, key creation, sudo installs).
5. **Honesty pass** (Task 13): sampled claims are re-derived by a different agent; unverifiable claims are labelled `check upstream` or "live-unverified".

## Decisions (accepted here, with cost if wrong)

| # | Decision | Recommended default | Cost if wrong |
|---|---|---|---|
| D1 | Docs live flat in `docs/` (new files at top level, existing topic docs stay) with `docs/index.md` as the map. | Flat, `00-start-here.md` sorts first. | Slightly crowded folder; moving later breaks links, which the lint catches. Low. |
| D2 | Owner docs are written for macOS first, VPS (Linux) as a marked variant; Windows is not covered. | macOS primary, Ubuntu variant lines. | A Linux-only owner needs extra reading; the launchd/systemd split in Task 7 already covers both. Low. |
| D3 | Free-tier and pricing facts for Adzuna, Serper, Hunter are NOT written; the page says `check upstream` and links the provider site. Only repo facts (what each key does, what degrades, env names, any in-repo cap such as `HUNTER_MONTHLY_CAP`) appear. | No provider numbers. | Owner must open a provider page once; an invented number would be worse. Low. |
| D4 | The lint reads `.env.example` and `src/setup/limitsCatalog.ts` keys as the env-var universe; a small allowlist in the test covers external variables (`HOME`, `PATH`, `NODE_ENV`, `ANTHROPIC_*`, `CLAUDE_*`). | Allowlist in the test, reviewed in code review. | A doc may name a real var the allowlist lacks: the test fails, the fix is one line. Low. |
| D5 | `Last verified against` holds a commit hash filled in Task 13; before that it holds the literal `<fill at merge>`, accepted by the lint unless `DOCS_STRICT=1`. | Strict mode used by Task 13 and by the owner before a release. | A stale hash looks verified. Mitigation: Task 13 re-derives claims, not just the hash. Medium. |
| D6 | Docs do not duplicate the setup wizard prompts; `00-start-here.md` names the wizard step ids (`npm run setup -- --list`) and says what the owner needs ready before each. | Reference step ids, never screens. | Wizard wording changes silently; step ids are stable and lint-checked against `scripts/setup.ts --list` text in the file. Low. |
| D7 | Dashboard login doc is written against 8C's merged behaviour (token default, optional Google sign-in reusing the Gmail Desktop OAuth client, OIDC advanced) and `docs/dashboard-exposure.md` gets a one-line pointer only. | Wait for 8C. | If 8C changes after Task 10, the doc is stale; Task 13 re-checks it last. Medium. |
| D8 | `docs/architecture.md` uses Mermaid fenced blocks plus a plain ASCII fallback of the same diagram, so it reads in a terminal. | Both. | Two diagrams to keep in step; the "when X breaks" table is the part that matters. Low. |

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `tests/docs-owner.test.ts` (new) | Docs lint: scripts, env vars, files, links, marker | 1 |
| `docs/prerequisites.md` (new) | Tools, versions, how to verify each | 2 |
| `docs/api-keys.md` (new) | Adzuna, Serper, Hunter, Gmail, where each goes | 3 |
| `docs/config-reference.md` (new) | Every owner-edited file in `config/` and `user-data/` | 4 |
| `docs/operations.md` (new) | Stop, resume, halts, dry run, status, logs, failure table | 5 |
| `docs/rollout.md` (new) | Five rollout phases as checklists with exit criteria | 6 |
| `docs/scheduler-install.md` (new) | launchd and systemd units: install, check, uninstall | 7 |
| `docs/architecture.md` (new) | Diagram, state stores, "when X breaks look here" | 8 |
| `docs/layout-memory.md` (new) | Owner page for `npm run layout` (8B) | 9 |
| `docs/dashboard-login.md` (new) | Token default, Google sign-in, OIDC advanced, recovery (8C) | 10 |
| `docs/00-start-here.md` (new) | Ordered path clone to first supervised send | 11 |
| `docs/index.md` (new), `README.md`, `CLAUDE.md`, `docs/dashboard-exposure.md` (pointer lines only) | Map and pointers | 12 |
| the eleven docs above, `tests/docs-owner.test.ts` (modify if a false positive) | Truth pass, commit markers | 13 |
| (no file) | Cold read | 14 |

## Common writer brief (pasted into every writer task's subagent prompt)

> You are writing ONE owner doc for the Jobber repo. Read ONLY the source files listed in your task, plus `docs/superpowers/plans/2026-10-15-8d-owner-docs-pass.md` "Global Constraints". Extract each listed fact from code; if a fact cannot be found in the listed files, write `check upstream: <what>` or `unverified: <what>`, never guess. Use the required header block. Do not copy numbers (defaults, caps) unless the task says to read them from a named file in the same session. Do not read `.env`, `secrets/`, `user-data/`, `.jobber/` or `data.sqlite`. Run `npx vitest run tests/docs-owner.test.ts` and fix every failure it reports for your file. Report: the facts you could not verify.

---

### Task 1: Docs lint test

**Files:**
- Create: `tests/docs-owner.test.ts`

**Interfaces (all inside the test file):**
```ts
const OWNER_DOCS: string[] = [
  'docs/00-start-here.md', 'docs/prerequisites.md', 'docs/api-keys.md', 'docs/operations.md',
  'docs/rollout.md', 'docs/scheduler-install.md', 'docs/config-reference.md',
  'docs/architecture.md', 'docs/layout-memory.md', 'docs/dashboard-login.md', 'docs/index.md',
];
const PLANNED_ONLY: string[] = []; // docs allowed to be absent until their task lands; emptied in Task 13
const ENV_ALLOWLIST = /^(HOME|PATH|NODE_ENV|TMPDIR|SHELL|USER|ANTHROPIC_[A-Z_]+|CLAUDE_[A-Z_]+|CI|TERM)$/;
function envUniverse(): Set<string>; // keys of .env.example (commented or not) + LIMITS keys from src/setup/limitsCatalog.ts
function documentedEnvVars(text: string): string[]; // backticked or code-fenced tokens matching /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/ that look like assignments or are in backticks
```

Rules (one `describe` each; each runs over every doc in `OWNER_DOCS` that exists):
1. **Scripts:** every `npm run <name>` and `npm run <name> --` in the text is a key of `package.json` `scripts`. `npx tsx scripts/<file>` must name an existing file.
2. **Env vars:** every documented env var is in `envUniverse()` or matches `ENV_ALLOWLIST`.
3. **Files:** every backticked token that starts with `config/`, `docs/`, `scripts/`, `src/`, `.claude/`, `tests/` and has an extension or ends with `/` exists in the repo; a backticked `user-data/<file>` must exist as `user-data.example/<file>` (user-data is git-ignored, so the example directory is the checkable shape) or appear in a `LOCAL_ONLY_FILES` allowlist inside the test (`user-data/resume.json`, `user-data/profile.json`); `secrets/`, `.jobber/`, `.env` and `data.sqlite` are runtime paths and exempt.
4. **Links:** every markdown link `[x](relative/path#anchor)` resolves to an existing file (anchors are not checked); `http(s)` links are not fetched. A link to a doc in `PLANNED_ONLY` is allowed while that doc is absent.
5. **Marker:** the first 12 lines contain `Audience: owner`, `Last verified against: <value>` and `Source files: <list>`. `<value>` is `<fill at merge>` or a 7 to 40 hex hash; with `DOCS_STRICT=1` only a hash passes, and the hash must resolve with `git cat-file -e <hash>^{commit}` (skipped when `.git` is absent).
6. **Existence:** each doc in `OWNER_DOCS` not in `PLANNED_ONLY` exists.
7. **Secrets hygiene:** no doc matches `/AKIA[0-9A-Z]{16}|-----BEGIN|sk-[A-Za-z0-9]{20,}|xox[bp]-/` and no doc contains an absolute `/Users/` path.

- [ ] **Step 1: Write the test with negative fixtures:** an in-test table of bad snippets (`npm run nope`, `` `FAKE_VAR_X` ``, `` `config/missing.json` ``, `[x](./nowhere.md)`, a header without the marker) each asserting the matching checker function reports an error, so the guard itself is proven.
- [ ] **Step 2: Run:** `npx vitest run tests/docs-owner.test.ts` (passes with zero docs present except existence, which lists absent docs via `PLANNED_ONLY` set to all eleven for now).
- [ ] **Step 3:** `npx tsc -p . --noEmit` and the full-suite baseline.
- [ ] **Step 4: Commit:** `test(docs): add owner docs lint (scripts, env vars, files, links, commit marker)`

---

### Task 2: `docs/prerequisites.md`

**Fact sheet (read these, extract these):**
- `package.json` `engines`, `dependencies` (patchright, playwright): Node range, browser binaries.
- `src/setup/steps/` (the `prereqs` step) and `src/platform/checks.ts`, `src/platform/doctor.ts`: the exact things the wizard and doctor check, and the fix text they print.
- `config/ccgram.pin.json`, `scripts/ccgram/start.sh`: pinned ccgram version, tmux requirement, how the start script verifies the version.
- `docs/backup-and-restore.md`, `src/backup/` or `scripts/backup.ts` (`--plan`): age and rclone requirement, how the script finds them.
- `config/update-known-failures.json` and the CLAUDE.md "Test baseline" paragraph: the 5 baseline failures and the one-line fix (`npx playwright install --with-deps chromium`).
- `README.md` "Prerequisites": existing list to reconcile, not copy.

**Content:** table per tool (purpose, needed for which feature, minimum version taken from code, "how to verify" command, "if missing"): Node, git, Claude Code CLI (`claude`, logged in), Google Chrome (Naukri headless uses `channel: 'chrome'`), Playwright chromium (what breaks without it: PDF render and the 5 baseline failures), patchright browser, uv, ccgram (pinned, never use its upgrade command), tmux, age and rclone (backup only), `launchctl` or `systemctl` (scheduler units only). Which items are optional and which feature each unlocks. Install commands only where the repo already prints one; everything else `check upstream: <tool site>`.

- [ ] **Step 1:** verify every listed source file exists (`ls`); write the doc per the common brief.
- [ ] **Step 2:** `npx vitest run tests/docs-owner.test.ts` and baseline.
- [ ] **Step 3: Commit:** `docs: add prerequisites page (tools, versions, verification)`

---

### Task 3: `docs/api-keys.md`

**Fact sheet:**
- `.env.example` (comments around `ADZUNA_*`, `SERPER_API_KEY`, `HUNTER_*`, `GMAIL_*`, `TELEGRAM_BOT_TOKEN`, `ALLOWED_USERS`): names and in-repo explanations.
- `src/sources/` (Adzuna client), `src/mcp/job-fetch.ts`, `src/mcp/contacts.ts`, `src/contacts/` (Serper and Hunter use, `HUNTER_ENABLED`, `HUNTER_MONTHLY_CAP`): exactly which function reads which key and what it does when the key is empty (skip, degrade, error).
- `docs/gmail-mcp-setup.md`, `docs/telegram-bot-setup.md`: link targets for the two non-key credentials.
- `src/setup/steps/` (any step that writes these keys) so the doc says whether the wizard or a manual edit sets each.

**Content:** one section per key: what it is for in this system, which pipeline stage uses it, "what breaks or degrades without it" (from the code path, one sentence), where it goes (`.env` name, mode 600, never committed), whether the wizard asks for it, how to verify (a doctor check name if one exists, else "run a hunt in dry run and read the discoverer or contact-finder note"), provider page link, and `check upstream: free tier, limits and price` (D3). Include a "minimum viable set" table: which keys can be left empty for a first dry run.

- [ ] **Step 1 to 2:** as Task 2 (write, lint, baseline).
- [ ] **Step 3: Commit:** `docs: add API keys page (Adzuna, Serper, Hunter, Gmail, Telegram)`

---

### Task 4: `docs/config-reference.md`

**Fact sheet (one row per file; for each: purpose, who reads it, schema source, reload behaviour, safe-to-edit?):**
- `config/portals.json`, `config/target-regions.json`, `config/discover-linkedin.json`, `config/deal-breakers.json`, `config/replies.json`, `config/permission-sets.json`, `config/run-profiles.json`, `config/worker-tools.json`, `config/manager-windows.json`, `config/classifier-models.json`, `config/ai-tells.json`, `config/ccgram.pin.json`, `config/update-known-failures.json`, `config/runner/`: read the loader module of each (`git grep -ln "<filename>" src scripts`) for the schema and the validation error text.
- `user-data.example/` (list the files), `src/userData*.ts` or `scripts/user-data.ts` (`init|migrate`): the shapes of `resume.json`, `profile.json`, `languages.json`, `easy-apply-answers.json`, `fact-gate.json`, `hard-stops` file if present.
- `CLAUDE.md` Preferences paragraph for portals, target regions and languages semantics (read, then verify against the loader, because it is long and partly historic).
- `.env.example` and `src/setup/limitsCatalog.ts` for the env catalog pointer.

**Content:** a "files you edit" table first (day-to-day), then a "files you rarely touch" table, then a "never edit" list (`config/ccgram.pin.json` by hand, `config/classifier-models.json` pins except via `npm run models -- pin`, `config/learned-ats-platforms.json` is written by the system). Each edited file: purpose, schema pointer (loader path), one synthetic example of 3 to 8 lines, validate command if one exists (`npx tsx scripts/check-portal.ts <ats> <slug>`; `npm run doctor`; `npm run permissions -- --status`), whether an MCP restart is needed (from code: file re-read per call vs loaded at start). A final "environment variables" section that says: the catalog is `.env.example` plus `src/setup/limitsCatalog.ts` (shown by `npm run setup -- --step limits`), lists the groups with one line each, and copies no default values.

- [ ] **Step 1 to 2:** as Task 2.
- [ ] **Step 3: Commit:** `docs: add config reference (config/, user-data/, env catalog pointer)`

---

### Task 5: `docs/operations.md`

**Fact sheet:**
- `scripts/jobber-control.ts`, `src/scheduler/control.ts` (`stop`, `resume`, `status`, `applyResume` semantics), `.claude/hooks/kill-switch.cjs`, `run-hunt.sh` (exit 4).
- `scripts/linkedin-clear-halt.ts` and (after 8B) `scripts/layout.ts` `clear-halt`, `src/platform/` halt flag names (`halt_flags` scopes `all`, `linkedin`, `naukri`).
- `scripts/dry-run-report.ts`, `src/safety/dryRun.ts` (`isDryRun` rules, the three flags).
- `scripts/status.ts` and `src/platform/` status builders: the fields of `limits`, `working`, `health` output, with a real section list taken from the code, not an invented sample.
- `src/scheduler/plan.ts` (`planWake` skip reasons), `src/scheduler/runLog.ts`, `src/scheduler/notify.ts` (where `scheduler_runs`, `.jobber/notify.jsonl`, `JOBBER_NOTIFY_CMD` go).
- Log locations: `git grep -n "\.jobber/\|logs\?/\|\.log" src scripts run-hunt.sh` for every file the system writes (hunt log redirect, scheduler window output, `reports/`, `.jobber/units`, `.jobber/layout/` after 8B, `dry_run_actions`). List them with the writer module.
- `src/platform/checks*.ts` check ids and fix messages (for the failure table), `docs/phase2-known-issues.md`.

**Content sections:** (1) Emergency stop in 20 seconds (copy-paste commands, what stops and what does not, from CLAUDE.md layer 6 "Not covered" restated as a short list with a link). (2) Resume and clearing halts (which command clears which halt; never hand-edit SQLite). (3) Dry run: the three flags, how to tell whether a session is dry, `npm run dry-run:report`. (4) Scheduler skip reasons table (reason, meaning, what to do). (5) Reading `limits`, `working`, `health`. (6) Where logs and state live (table: path, written by, safe to delete?). (7) Daily and weekly routine (10 minutes). (8) Common failures table (symptom, likely cause, check, fix, doc link) seeded from doctor check ids, `session_locked`, `classifier_unavailable`, `unknown_recipient`, `no_clean_reply_check`, `stuck_sending`, expired LinkedIn session, Gmail token expiry, usage-limit backoff, MCP servers on old code after an update.

- [ ] **Step 1 to 2:** as Task 2.
- [ ] **Step 3: Commit:** `docs: add operations page (stop, halts, dry run, status, logs, failure table)`

---

### Task 6: `docs/rollout.md`

**Fact sheet:**
- `CLAUDE.md` "Scheduler" Rollout paragraph and `docs/superpowers/plans/2026-10-14-6d-scheduler-agents-naukri.md` rollout/owner checklist sections (read those sections only): phase names, durations, flags, exit criteria.
- `docs/superpowers/plans/2026-10-15-8a-wiring-and-legacy-removal.md` "Owner-only checklist", `2026-10-14-6b2-open-model-and-setup-download.md` and `2026-10-14-7d-auto-update-and-backup.md` owner checklists.
- `src/safety/dryRun.ts`, `.env.example` for the flag names; `scripts/linkedin-seed-person.ts` header (canary seed).
- 8B plan Task on `LAYOUT_ENFORCE` and the supervised learning run.

**Content:** five phases, each a checklist: entry conditions, flags to set (names only, values from `.env.example` semantics), commands, what to look at (`dry-run:report`, `status`), time box, exit criteria written as observable facts (for example "48 hours dry covering one night, zero unexpected `dry_run_actions` kinds, kill switch tested before start"), and "stop and go back to the previous phase if". Phase 5 (VPS) lists what must be redone (sessions, Naukri headless IP check). A final "after a long break" mini-path: what to re-verify after 3 months (sessions, classifier, `npm run doctor`, update state, a dry wake). Mark owner-only steps `[owner]`. Items that no run has ever exercised are marked `unverified` per CLAUDE.md Known limits.

- [ ] **Step 1 to 2:** as Task 2.
- [ ] **Step 3: Commit:** `docs: add rollout checklist (five phases with exit criteria)`

---

### Task 7: `docs/scheduler-install.md`

**Fact sheet:** `scripts/scheduler-units.ts`, `src/scheduler/units.ts` (what files it writes, names, labels, paths, what it prints), `scripts/scheduler.ts` (`--daemon|--once|--status|--dry-run-plan`), `src/scheduler/driver.ts`, `.env.example` scheduler keys, `src/platform/checksScheduler.ts` (doctor checks and fix text).

**Content:** generate (`npm run scheduler:units`, nothing installs itself), review generated files, install on macOS (launchd: copy, load, check, unload, uninstall using the exact commands the generator prints) and Linux (systemd user units, `loginctl enable-linger` only if the generator or code says so, else `check upstream`), verify (`npm run scheduler -- --status`, `--dry-run-plan`, `npm run doctor`), start in dry mode first (link to `rollout.md`), logs, upgrade (regenerate, reload), uninstall and the kill switch interplay (stop writes STOP, scheduler obeys within one poll). Prefer quoting generator output over restating it; if the generator prints the install commands, the doc says "run them as printed" and shows the shape with placeholders.

- [ ] **Step 1 to 2:** as Task 2.
- [ ] **Step 3: Commit:** `docs: add scheduler install page (launchd and systemd units)`

---

### Task 8: `docs/architecture.md`

**Fact sheet:**
- `.mcp.json` (server list and commands), `src/mcp/*.ts` file list (one server per file), `.claude/agents/*.md` frontmatter (names, tools), `config/worker-tools.json`, `config/run-profiles.json` profile names.
- `src/db.ts` table list (`git grep -n "CREATE TABLE" src/db.ts src/**/*.ts`), `src/scheduler/`, `src/outreach/limits.ts`, `src/safety/` file list, `.claude/hooks/*.cjs` names, `.claude/settings.json` hook matchers.
- `CLAUDE.md` "Running the hunt" step names and "Outreach safety layers" layer names (for labels only).
- After 8B: `src/layout/` module names, the operators' agent files, `.jobber/layout/`.

**Content:** (1) one-page Mermaid diagram plus ASCII twin: owner and Telegram/ccgram/dashboard on the left; hunt pipeline (orchestrator, seven stage agents); scheduler (wake, operators, worker agents); MCP servers (each named once, with the platform it touches); safety layers as a band (runner, hooks, input gate, classifier, output gate, ceilings, kill switch, dry run); state stores (SQLite tables grouped, `.jobber/`, `secrets/`, `user-data/`, `.env`, `reports/`). (2) A one-paragraph "two entry paths" explanation (hunt vs scheduler) with the run-lock difference. (3) "Which account does what" (burner vs main) from Safety rule 6. (4) **"When X breaks, look here"** table with 20 or more rows: symptom or subsystem, first file or command, second place, doc link (examples: no jobs found, all jobs excluded, no contacts, email not sent, LinkedIn action refused, classifier blocked, scheduler never wakes, tool denied by hook, resume blocked by fact gate, replies not detected, follow-up not claimed, dashboard login fails, layout drift halt). Every path in the table must exist (lint).

- [ ] **Step 1 to 2:** as Task 2; add a manual render check of the Mermaid syntax by reading it once (no tool installs).
- [ ] **Step 3: Commit:** `docs: add architecture page (diagram, state stores, break-glass table)`

---

### Task 9: `docs/layout-memory.md` (plan 8B output)

**Fact sheet (after 8B is merged):** `scripts/layout.ts` (subcommands `status`, `show`, `reset`, `clear-halt`, `learn`, their flags, exit codes, output fields), `src/layout/` (verdict names `match|partial|drift|blocked|logged_out|unloaded`, promotion rule, store path, size bounds), `.env.example` `LAYOUT_*` keys, 8B plan sections "Decisions" (enforce mode, halt after N drifts) and the operator agents' escalation wording, `docs/superpowers/plans/2026-10-15-8b-platform-operators-and-layout-memory.md` owner checklist.

**Content:** what layout memory is in one paragraph (not HTML, not model-written; closed vocabulary); the verdicts and what the owner should do for each; each `npm run layout -- <sub>` command with a synthetic example output block taken from the code's formatter; `LAYOUT_ENFORCE` off/warn/enforce with the recommended path (stay on `warn` until the supervised learning run, then `enforce`; how to roll back); the supervised learning run as a numbered checklist (`[owner]` where a human watches); drift escalation and halt: how to read it, `clear-halt` versus `linkedin:clear-halt`, how to reset a corrupt store (`.corrupt-<ts>` files); limits and the "unverified against live sites" statement.

- [ ] **Step 1 to 2:** as Task 2.
- [ ] **Step 3: Commit:** `docs: add layout memory owner page (status, show, reset, clear-halt, learn, enforce modes)`

---

### Task 10: `docs/dashboard-login.md` (after plan 8C)

**Fact sheet (after 8C is merged):** `scripts/web.ts`, `scripts/dashboard.ts` (subcommands and output), `src/web/server.ts` and the session/token module 8C adds, `src/dash/oidc.ts` (advanced mode), `.env.example` `WEB_*` and `DASHBOARD_*` keys, the 8C plan's decisions and owner checklist, `docs/gmail-mcp-setup.md` (which Desktop OAuth client the Google sign-in reuses, redirect URIs it needs), `docs/dashboard-exposure.md`.

**Content:** default (local access token: where it is created and shown, how to rotate, what it protects, what it does not), optional Google sign-in (what must exist first: the Gmail Desktop OAuth client; exact `.env` keys; the consent step is `[owner]`), OIDC advanced mode (when to prefer it, link to exposure doc), `WEB_CHAT_ENABLED` warning, recovery (lost token, changed Google address, locked out: commands that run on the machine only), and a diagnostic table (symptom, check, fix). Does not duplicate the exposure options; links to `docs/dashboard-exposure.md`.

- [ ] **Step 1:** confirm 8C is merged (`git log --oneline main | grep -i 8c` or the plan's merge note); if not, stop this task and record "deferred" in the final report.
- [ ] **Step 2 to 3:** as Task 2.
- [ ] **Step 4: Commit:** `docs: add dashboard login page (token default, Google sign-in, OIDC advanced, recovery)`

---

### Task 11: `docs/00-start-here.md`

**Fact sheet:** `scripts/setup.ts --list` text and `src/setup/steps/*` (step ids in order, what each needs from the owner, what it writes), `README.md` Quick start and "Before going live" sections, the docs written in Tasks 2 to 10 (link targets, step order), `docs/telegram-bot-setup.md`, `docs/gmail-mcp-setup.md`, `docs/linkedin-sessions-setup.md`, `docs/naukri-session-setup.md`, `docs/classifier-models.md`, `scripts/linkedin-seed-person.ts` header, `.claude/commands/` and `docs/telegram-slash-commands.md` for the first-run commands.

**Content:** a numbered path with a table: step, what you do, command, time estimate, who (`owner only` | `agent can run`), done when. Order: prerequisites, clone and `npm install`, `npm run setup` (steps by id; estimates for the 750 MB classifier download as `depends on network`), doctor, API keys, config edits (portals, target regions, languages confirm), first dry-run hunt, read the dry-run report, classifier fit, enable sessions, canary send (`linkedin:seed`, supervised, low ceilings), first supervised `/runhunt`, scheduler install, rollout phases. Time estimates are the author's rough ranges, labelled `estimate, not measured`, never presented as measured. Ends with "if something is red" pointing to `operations.md`, and a one-line map of the other docs.

- [ ] **Step 1 to 2:** as Task 2.
- [ ] **Step 3: Commit:** `docs: add 00-start-here (ordered path from clone to first supervised send)`

---

### Task 12: Index and pointers

**Files:** Create `docs/index.md`; Modify `README.md`, `CLAUDE.md`, `docs/dashboard-exposure.md` (one pointer line each).

- [ ] **Step 1: `docs/index.md`:** header block; a "read in this order" list (start-here, prerequisites, api-keys, config-reference, rollout, operations, scheduler-install, layout-memory, dashboard-login, architecture), then a "topic docs" list of the existing eleven docs and `docs/phase2-known-issues.md`, each with one line; a "for developers" line linking `docs/superpowers/plans/` and `specs/`; a staleness note explaining the commit marker and the `DOCS_STRICT=1` check.
- [ ] **Step 2: `README.md`:** add to "Links" the new docs (a short list under a "Owner docs" bullet group, first item `docs/00-start-here.md`); change the Quick start sentence to point at it. Do not delete existing README content.
- [ ] **Step 3: `CLAUDE.md`:** add ONE short "Owner docs" paragraph near "Platform and sessions" listing the new pages as pointers ("operations, rollout, config reference, architecture: see `docs/index.md`"); do not move or duplicate any rule; in "After merge: user checklist" item 0 replace "the README.md quick start" with a pointer to `docs/00-start-here.md`.
- [ ] **Step 4: `docs/dashboard-exposure.md`:** one line under section 2: "Login options: see `docs/dashboard-login.md`" (only if Task 10 ran).
- [ ] **Step 5:** `PLANNED_ONLY` stays as is until Task 13; run `npx vitest run tests/docs-owner.test.ts tests/dash-docs.test.ts` and baseline.
- [ ] **Step 6: Commit:** `docs: add docs index and pointers from README and CLAUDE.md`

---

### Task 13: Truth pass and commit markers

**Rule:** a different subagent than each doc's writer does this task (sonnet), one subagent per two docs, in parallel.

- [ ] **Step 1: Claim extraction.** For each doc, list every checkable claim (command, flag, env var, default, file path, check id, error string, behaviour sentence). Target at least 15 claims per doc.
- [ ] **Step 2: Re-derive each claim from code** with `git grep` and by reading the named module, never from another doc. Classify: `true`, `false` (fix the doc), `unverifiable` (rewrite as `check upstream` or `unverified`). Record the table in the task report (not committed).
- [ ] **Step 3: Command dry check, no execution of side effects:** for each documented `npm run` line confirm the script file exists and its argument parser accepts the documented subcommand (`git grep` the parser). Commands that are safe and read-only may be run if they need no secrets and no network: `npm run status -- health` is NOT run (reads state); only `npx tsc -p . --noEmit`, `npx vitest run tests/docs-owner.test.ts` and `npm run setup -- --list` (verify it does not need a TTY for `--list` in `scripts/setup.ts` first) are allowed.
- [ ] **Step 4: Cross-doc consistency:** the same fact (for example the permission set names, the kill-switch command, the five rollout phase names) is identical in every doc that states it; where two docs differ, one links to the other.
- [ ] **Step 5: Fill markers:** replace `<fill at merge>` in every doc with `git rev-parse --short HEAD` of the commit being verified (the owner reruns this at merge time if more commits land); set `PLANNED_ONLY = []` (if Task 10 was deferred, keep `docs/dashboard-login.md` in `PLANNED_ONLY` and remove it from every link).
- [ ] **Step 6: Strict lint:** `DOCS_STRICT=1 npx vitest run tests/docs-owner.test.ts`, then full `npx vitest run` and `npx tsc -p . --noEmit` against the baseline.
- [ ] **Step 7: Commit:** `docs: truth pass, fill verified-against commit markers`

---

### Task 14: Cold read

- [ ] **Step 1:** dispatch a fresh sonnet subagent with ONLY these inputs: the path to `docs/00-start-here.md` and permission to follow its links, no `CLAUDE.md`, no plans, no source files. Prompt: "Pretend you are the owner who has not touched this project for three months. Follow the document literally, step by step. For each step write what you would type, what you expect, and whether anything was ambiguous, missing, or points to a file that does not exist. Do not run commands. Report a list of gaps, ordered by severity."
- [ ] **Step 2:** a second cold-read subagent does the same for the failure path: starting from `docs/operations.md` with the scenarios "scheduler did nothing for two days", "LinkedIn session expired", "I want to stop everything now", "a send was refused with `classifier_unavailable`".
- [ ] **Step 3:** fix every gap rated blocking or confusing in the owning doc (docs only), rerun the strict lint and baseline.
- [ ] **Step 4: Commit:** `docs: fix gaps found by cold read of start-here and operations`

---

## Task summary

| # | Task | Gate | Commit |
|---|---|---|---|
| 1 | Docs lint test | 8B merged | `test(docs): add owner docs lint ...` |
| 2 | prerequisites.md | 1 | `docs: add prerequisites page ...` |
| 3 | api-keys.md | 1 | `docs: add API keys page ...` |
| 4 | config-reference.md | 1 | `docs: add config reference ...` |
| 5 | operations.md | 1 | `docs: add operations page ...` |
| 6 | rollout.md | 1 | `docs: add rollout checklist ...` |
| 7 | scheduler-install.md | 1 | `docs: add scheduler install page ...` |
| 8 | architecture.md | 1, 8B | `docs: add architecture page ...` |
| 9 | layout-memory.md | 8B | `docs: add layout memory owner page ...` |
| 10 | dashboard-login.md | 8C merged | `docs: add dashboard login page ...` |
| 11 | 00-start-here.md | 2 to 10 | `docs: add 00-start-here ...` |
| 12 | index and pointers | 2 to 11 | `docs: add docs index and pointers ...` |
| 13 | truth pass, markers | 12 | `docs: truth pass, fill verified-against commit markers` |
| 14 | cold read | 13 | `docs: fix gaps found by cold read ...` |

14 tasks, 12 commits that add or change docs plus 1 test commit and 1 fix commit. Tasks 2 to 10 are independent of each other and may run as parallel sonnet subagents on separate files (each owns exactly one file; only Task 1's test is shared and read-only to them). Tasks 11 to 14 are sequential.

## Hard limits for the builder

- Only create or edit the files named in the File Structure table. No change under `src/`, `scripts/`, `config/`, `.claude/`, `package.json` or `.env.example`. If a doc reveals a code bug or a missing `.env.example` key, record it in the task report as a finding; do not fix it here.
- No invented facts: no numbers, versions, prices, URLs or error strings that were not read from a file in the same task. Third-party facts are `check upstream`.
- No restating of safety rules or caps; link to `CLAUDE.md` section names or topic docs.
- Never read or print `.env`, `secrets/`, `user-data/`, `.jobber/`, `data.sqlite`. Never run any command that contacts a network, starts a browser, tmux, MCP server or `claude`, sends anything, or changes a halt, a dry-run flag or a permission set.
- Do not touch `docs/superpowers/` (plans and specs) and do not edit existing topic docs except the one pointer line in Task 12.
- One task per commit with the message given; do not commit the plan file itself from a docs task; never push or merge.
- A doc is not done until `npx vitest run tests/docs-owner.test.ts` passes for it and the full-suite baseline is unchanged.

## Owner-only checklist

- [ ] Confirm plan 8B (and 8C for Task 10) are merged before the builder starts; state the merge commit in the builder's prompt.
- [ ] Decide D1 to D8 (recommended defaults are listed) or reply "defaults".
- [ ] After Task 13, skim `docs/00-start-here.md` and `docs/operations.md` yourself once; they are the two you will use at 2 a.m.
- [ ] Before each release or after 3 months: `DOCS_STRICT=1 npx vitest run tests/docs-owner.test.ts` and re-run Task 13 if the repo moved.
- [ ] Provider facts (free tiers, install commands) marked `check upstream`: fill them yourself once if you want them in the docs.

## Open risks

- **Docs drift** is the main risk. The lint catches names and links, not meaning; the commit marker only says when a human or agent last checked. Mitigation: Task 13 re-derives claims, and the index tells the owner to rerun it.
- **8B/8C naming:** `scripts/layout.ts` subcommands, `LAYOUT_*` keys and the login env keys are taken from plan text until merge; Tasks 9 and 10 read the merged code and win over the plan text.
- **Env-var lint false positives:** uppercase tokens such as `STOP`, `OK` or tool names can match the pattern. The pattern requires an underscore and a backticked or fenced context; the allowlist handles the rest (D4).
- **`CLAUDE.md` contains stale text** (it is long and was patched many times). Writers are told to verify against code; the truth pass is the backstop.
- **Time estimates** are not measured; they are labelled as such. Wrong estimates are an annoyance, not a safety issue.
- **Cold read is model-simulated,** not a real human; it finds missing steps, not every confusing phrase. The owner skim in the checklist is the real test.

## Self-review

- **Spec coverage:** every approved doc maps to a task (start-here 11, prerequisites 2, api-keys 3, operations 5, rollout 6, scheduler-install 7, config-reference 4, architecture 8, layout-memory 9, dashboard-login 10, index 12, README and CLAUDE pointers 12); lint 1; commit-marker field 1 and 13; truth pass 13; subagent method and fact sheets in the brief and each task; "check upstream" in Global Constraints and D3; owner decisions D1 to D8; hard limits section; task list with commit messages.
- **Ordering:** 1 first; 2 to 10 independent; 11 needs 2 to 10 for links; 12 needs 11; 13 needs all; 14 last. Task 10 may be deferred without blocking others (lint's `PLANNED_ONLY`).
- **Placeholder scan:** no TBD in tasks; the only literal placeholder is the lint-recognized `<fill at merge>`, resolved in Task 13.
