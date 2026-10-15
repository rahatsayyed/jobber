# Plan 8E: bootstrap, guided setup, dry-run verify and run-all (four commands)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per project preference, dispatch every subagent with `model: sonnet`, one task at a time, review gate after each task.

**Goal:** a new owner (or the same owner on a new machine) gets from a fresh clone to a running, observable, still-dry system with four idempotent, resumable commands and nothing else to remember:

```
bash scripts/bootstrap.sh        # 1. install and validate everything missing (asks before each action)
npm run setup                    # 2. keys, accounts, sessions, limits; optional guided Claude session
npm run dry-run                  # 3. end-to-end smoke in dry mode only, PASS/FAIL per stage
npm run up                       # 4. start bridge, windows, scheduler, dashboard (and: npm run down)
```

None of the four changes a dry-run flag, a permission set, the allow list, a halt or the kill switch. The owner's `.env` decides live versus dry, and `up` prints the mode loudly.

**Architecture:** four thin CLIs over pure, injectable cores, so every decision is a unit test with fakes and no test installs, spawns tmux, opens a browser or calls `claude`.

1. `src/bootstrap/` (new): a catalog of items (`detect`, `plan`, `required`), an executor that enforces the consent rules (print the action, ask once, `--yes` for non-sudo, sudo and downloaded scripts always shown), and a result table. Entry: `scripts/bootstrap.sh` (bash, runs on a machine with only git and a shell: it can install Node, then hands over to `scripts/bootstrap.ts`). Reuses `scripts/models.ts` `runCli` for the classifier download and `config/ccgram.pin.json` for the ccgram version.
2. `scripts/setup.ts` (modify) stays the wizard. A new run profile `setup_guide` in `config/run-profiles.json`, started by the restricted launcher in a new INTERACTIVE mode, runs a project skill `.claude/skills/setup-guide/SKILL.md`. The guide coaches and runs the doctor; it never sees `.env`, `secrets/` or `user-data/`, never receives a secret in chat, and its Bash is an exact-string allowlist enforced by the PreToolUse hook. The wizard's TTY prompts stay in the owner's terminal (safe split, see D3).
3. `src/verify/` (new): ordered stages (env guard, doctor, classifier smoke, launcher args, scheduler plan, fixture pipeline, kill-switch drill, status render, dashboard login page) against a temp database and temp stop file; every stage returns `pass | fail | skip` with a fix hint; any `fail` exits 1.
4. `src/stack/` (new): `up` (preflight with doctor, then bridge, named windows, scheduler daemon, dashboard, idempotent), `down` (graceful, never touches data), `up --status` (read-only). The scheduler daemon and the dashboard run as windows of one tmux session; launchd or systemd units, if installed through the existing `scheduler:units`, are detected and respected, not reimplemented.

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffixes), vitest, `node:child_process` through the existing injectable `Run` (`src/platform/tmux.ts`), plain bash for `scripts/bootstrap.sh`. No new dependency.

**Builds on:** `2026-10-15-8a-wiring-and-legacy-removal.md` (merged), `2026-10-15-8b-platform-operators-and-layout-memory.md` and `2026-10-15-8c-dashboard-simple-login.md` (**this plan merges after both**; Tasks 5, 8, 11 and 14 touch `src/platform/checks*.ts`, `.claude/settings.json`-adjacent hooks, `README.md` and `CLAUDE.md`, the same files 8B and 8C edit: cut the 8E branch from main after 8C is merged and rebase before Task 5). **Plan 8D (owner docs pass) merges after this plan** and describes whatever 8E ships: see "Handoff to 8D".

**Spec:** `docs/superpowers/specs/2026-10-14-platform-sessions-dashboard-setup-requirements.md` (setup, sessions, one credentials file stay binding), `docs/superpowers/specs/2026-10-13-adr-agent-driven-browser-runtime.md`. Format follows `2026-10-15-8a-wiring-and-legacy-removal.md` and `2026-10-15-8c-dashboard-simple-login.md`.

## What exists today (read from the repo, not assumed)

| Piece | Today | Gap this plan closes |
|---|---|---|
| Prerequisites | `npm run setup` step `prereqs` (`src/setup/steps/prereqs.ts`) prints each failing doctor check's fix verbatim and "never runs an installer"; checks `node-version`, `tmux`, `chrome`, `browser-binaries`, `ccgram-version` | Nothing installs anything; a machine without Node cannot even run `npm run setup` |
| Wizard | `scripts/setup.ts`, 12 resumable steps (`ALL_STEPS`: prereqs, claude, telegram, gmail, sessions, resume, profile, limits, access, classifier, dashboard, final), needs a TTY, `--step`, `--redo`, `--list` | No guided coaching; no per-step explanation of every `.env` key; owner reads three runbooks |
| Doctor | `npm run doctor [-- --json]` over `ccgramChecks`, `restrictedChecks`, `setupChecks`, browser, scheduler, update/backup checks; JSON has `id, title, status, detail` only | No "is this machine bootstrapped" check; no single start command refuses on a failing doctor |
| Classifier | `npm run models -- list|verify|fetch [--yes]|pin`; `config/classifier-models.json` pins `model.onnx` by sha256 and the other files by git blob sha1 | Download is only inside the wizard step |
| Sessions | `scripts/ccgram/start.sh|stop.sh` (bridge in tmux session `ccgram-daemon`), `scripts/manager.ts start|stop|restart <window>` over `config/manager-windows.json` (`hunt`, `followups`; `manager` and `ccgram-daemon` protected), `scripts/scheduler.ts --daemon|--once|--status|--dry-run-plan`, `scripts/web.ts` | Four things to start by hand, in an order only the README states |
| Restricted launcher | `scripts/run-claude.ts <profile>`: always `-p`, `--permission-mode dontAsk`, `--permission-prompts none`, `--strict-mcp-config`, no Bash ever (`DANGEROUS_BUILTINS` rejects it in a profile), exits 3 when the classifier is not ready | No interactive mode; no profile can hold a command allowlist; a profile for setup could not start before the classifier exists |
| Kill switch, dry run | `.jobber/STOP`, `scripts/jobber-control.ts stop|resume|status`, `src/safety/dryRun.ts` `isDryRun` (unset means dry) | Unchanged; this plan only reads them |

## Global Constraints

- **Branch:** `plan-8e` (worktree plan); the build branch is cut from main after 8C is merged. Commit per task with explicit paths, never `git add -A`, never `--no-verify`, never push.
- Never read, print, write or commit `user-data/`, `secrets/`, `.env*` (except `.env.example`, committed), `.dashboard/`, `.jobber/` contents, `data.sqlite`. Tests use temp directories (`fs.mkdtempSync(path.join(os.tmpdir(), 'jobber-'))`), `JOBAPPLIER_DB` pointed at a temp file or `:memory:`, and synthetic fixtures with invented values.
- **No test, and no step in this plan, installs a package, runs `brew`, `apt`, `uv`, `npm install|ci`, `npx playwright install`, downloads a file, opens a browser, starts tmux or an MCP server, or runs a real `claude`.** Every external effect goes through an injected `Run`, `Fetch`, `Fs` or `Clock`. The builder runs `npx tsc -p . --noEmit` and `npx vitest run`, nothing else with side effects.
- **Test baseline before and after EVERY task:** `npx tsc -p . --noEmit` clean; `npx vitest run` shows exactly the 5 known failures (4 in `tests/renderChecked.test.ts`, 1 in `tests/resume.test.ts`) and nothing else.
- **Secrets never reach the guided session.** Not through `.env`, the child environment, a file the guide can Read, a command output, or the chat. Secrets are typed only into the wizard's TTY prompts (`askSecret`) or written by CLI helpers that print them once to a TTY (`npm run dashboard -- token`). The guide sees doctor JSON (`id, title, status, detail`), which never prints values (Task 8 adds a corpus test that proves it).
- **No bypassPermissions, no skip-permissions, no `IS_SANDBOX`**, in any new launcher path (existing `assertSafeArgs` covers it; the new interactive builder must call it).
- The guide's tool allowlist is minimal and enforced by the PreToolUse hook, fail closed: `Skill`, `Read` limited to `docs/`, `config/`, `user-data.example/` and the skill folder, and `Bash` limited to an exact list of command strings. No `Write`, `Edit`, `WebFetch`, `WebSearch`, `Agent`, no MCP tools.
- `up`, `down`, `dry-run` and `bootstrap` never set or clear `JOBBER_DRY_RUN`, `SCHEDULER_DRY_RUN`, `LINKEDIN_DRY_RUN`, `JOBBER_KILL`, a halt row, `.jobber/STOP`, a permission set, `.claude/settings.local.json` or the allow list. They may READ them. Only the owner changes them (CLAUDE.md Safety rules 14 and 15).
- Every install action prints exactly what it will run (argv, whether it needs sudo, whether it touches the network, the URL) and asks once. `--yes` covers non-sudo actions only. A sudo action always asks unless `--yes --allow-sudo` is passed, and then still prints the command. Never `curl | sh`: a downloaded installer is saved to a temp file, its URL, size and sha256 are shown, and it runs only after a separate yes.
- Pin versions where the repo already pins: ccgram (`config/ccgram.pin.json`), classifier files (`config/classifier-models.json`), Node range (`package.json` `engines`), npm packages (`package-lock.json`, `npm ci`). Where upstream pins do not exist in the repo, the plan does not invent one: it says `check upstream`.
- Fail closed: `up` refuses on any doctor `fail`; `dry-run` exits 1 on any stage `fail` and on any internal error; an unknown flag is a usage error, not ignored.
- Do not edit `CLAUDE.md` or `README.md` before Task 14 (project preference: batch doc edits). Config, skills, hooks and `.env.example` changes ARE behaviour and go in the task that changes behaviour.
- No new daily counter or rate limit is added. New env keys are limited to the three in D12 and each appears in `.env.example` (the existing env-example test fails on drift).
- Match surrounding style: file header comment `// src/...`, `.js` import suffixes, tests in `tests/*.test.ts`, one file with `npx vitest run <file>`.

## Review Focus

1. **Consent rules are code, not prose (Task 2):** one table test per action class (non-sudo, sudo, downloaded script, network, optional) times `--yes`, `--allow-sudo`, non-TTY. A non-TTY run without `--yes` refuses with exit 3 and changes nothing.
2. **Idempotence (Tasks 1, 2, 10, 12):** every stage and install detects first and acts only on the missing part; the second run of each command on a finished machine performs zero actions (asserted by a fake `Run` that records calls).
3. **The guide cannot see a secret (Tasks 6 to 8):** hook decisions are tested against adversarial Bash strings (chaining, redirection, substitution, trailing arguments, unicode lookalikes, newlines), Read paths (`.env`, symlinks, `..`, `user-data/`, `secrets/`, `.git`), and a prompt-secret guard; the doctor-output corpus test is the third layer.
4. **Interactive launcher is not weaker than the print launcher (Task 6):** same env scrubbing, same `assertSafeArgs`, same kill-switch exit 4; classifier readiness is skipped ONLY for a profile that has no MCP tools and no untrusted-text surface (validated, not trusted).
5. **`dry-run` writes nothing live (Tasks 10, 11):** temp DB, temp stop file, port 0, no real `.jobber/STOP` touched; a test asserts the real stop path is never passed to `applyStop`/`applyResume`.
6. **`up` never changes mode (Tasks 12, 13):** grep-style test that `src/stack/**` and `scripts/stack.ts` contain no write to any dry flag or halt API; env passed to windows is built from an allowlist.
7. **tmux environment inheritance (Task 12):** windows are started with an explicit clean environment so a stale server environment cannot override `.env` (the scheduler lets `process.env` win over `.env`).
8. **README quick start lint (Task 14):** every command in the three lines exists.

## Decisions (accepted here, with cost if wrong)

| # | Decision | Cost if wrong |
|---|---|---|
| D1 | The install entry is `bash scripts/bootstrap.sh` (bash, because a fresh Mac has bash 3.2 and zsh, no Node); it handles only "get Node >= 20 and `npm ci`", then `exec`s `npx tsx scripts/bootstrap.ts "$@"`. `npm run bootstrap` is the same TypeScript CLI once Node exists. All logic beyond Node lives in TypeScript so it is unit tested. | The shell half is only lint- and fake-PATH-tested, not exercised against a real Homebrew or apt. Medium; contained by `--check` and by printing every command first. |
| D2 | Homebrew itself is never installed by bootstrap. If `brew` is missing on macOS the run stops with the install URL and "run this yourself, then rerun". | One manual step on a bare Mac. Chosen because the Homebrew installer asks for sudo and changes shell profiles. Low. |
| D3 | The guide and the wizard are two processes. The wizard's prompts (secrets, confirms) stay in the owner's terminal; the guide runs in a second terminal or tmux window (`jobber-setup:guide`), coaches, reads doctor JSON, and tells the owner which `npm run setup -- --step <id>` to run. The guide never drives a TTY, never types into another pane, never launches the wizard. | The owner switches windows. Chosen because an agent driving a TTY wizard would see every secret the owner types (or require key injection into a pane, which `manager` forbids). Low. |
| D4 | The guide's Bash allowlist is a list of EXACT command strings in the run profile (`bash_exact`), compared for equality by the hook after `trim()`. No globs, no arguments beyond the listed string, no shell metacharacters (validated at profile load). | An owner wanting the guide to run a new command edits `config/run-profiles.json` (committed, reviewed). Intended. |
| D5 | The guide profile is `interactive: true`, `classifier: "not_required"` (valid only with an empty MCP config and no MCP allow entries, so no third-party text surface), env mode `allowlist` with no keys beyond `TERM` and the base set. The launcher still exits 4 on STOP and still runs `assertSafeArgs`. | A profile that is later given MCP tools while still marked `not_required` would skip the classifier gate; the profile validator rejects that combination and a test pins it. Low. |
| D6 | `npm run setup` offers the guide once at the start (default yes if `claude-cli` and `claude-login` pass and tmux exists), never auto-starts it, and `--no-guide` skips the offer and any guide mention. `--guide-only` starts only the guide. | An owner who ignores the offer gets today's wizard unchanged. Low. |
| D7 | `npm run dry-run` is the name (not `verify`): `models -- verify` and `dry-run:report` already exist and `verify` is ambiguous next to them. | Two near names (`dry-run`, `dry-run:report`); README says which is which. Low. |
| D8 | `dry-run` never launches a real LLM run by default. The "hunt in dry mode" stage is a code-level fixture pipeline (vetoes, enqueue, dry-run action record, hook decision) against a temp DB. `--llm` additionally runs `./run-hunt.sh` with every dry flag forced on; it uses subscription usage and is off by default. | A prompt or agent-definition regression is not caught by the default run. Mitigated by `--llm` and by the existing definitions lint. Medium. |
| D9 | The kill-switch drill uses a temp stop file and temp DB through `applyStop`/`applyResume` and `kill-switch.cjs` `decide` with a temp root. It never stops or resumes the real project. A real STOP that is already on is reported as `info`, and `up` refuses to start while it is on (exit 4). | The drill proves the code path, not the owner's real files. Owner live check L5 covers the real one. Low. |
| D10 | `up` refuses when the doctor has any `fail` (no override flag) and when `.jobber/STOP` or `JOBBER_KILL=1` is active; warnings are listed and do not block. | A doctor false-fail blocks start; the fix hint names the check, and `npm run doctor` is one command. Intended (fail closed). |
| D11 | The scheduler daemon and the dashboard run as windows `scheduler` and `web` of one tmux session (`jobber-stack` by default). If a launchd or systemd unit for the scheduler is loaded (macOS: `launchctl list` contains `dev.jobber.scheduler`; Linux: `systemctl --user is-active jobber-scheduler.service`), `up` does not start a second daemon and says so. | Detection is by command output; an unrecognised unit manager could double-start. The daemon's own single-instance behaviour is unverified (U9). Medium. |
| D12 | New env keys: `STACK_TMUX_SESSION` (default `jobber-stack`), `STACK_DOWN_WAIT_SEC` (default 60, clamp 5..600), `BOOTSTRAP_MODEL_PROFILE` (default: the registry's `default_profile`). All documented in `.env.example`. No new counters. | An env key read by a launcher that is not in the child allowlist is ignored; tested. Low. |
| D13 | `down` stops, in order: dashboard, scheduler (SIGINT first, wait `STACK_DOWN_WAIT_SEC`, then leave it running and say so; `--force` kills the window), `hunt` and `followups` windows, bridge (`--keep-bridge` skips). It never stops `manager` (protected) and never touches STOP, halts, `.env`, `secrets/`, `data.sqlite`. | A window killed with `--force` mid-wake can leave a half-finished run; existing stale-run handling in the scheduler applies. Low to medium. |
| D14 | `bootstrap_complete` is a doctor check with three outcomes: pass (all required items present), fail (a required item missing: Node, npm deps, tmux, uv, pinned ccgram, claude CLI), warn (optional missing: Chrome, Playwright Chromium, classifier model, age, rclone). It re-detects with the same pure functions; the state file `.jobber/bootstrap.json` only records when the last run happened and what the owner declined. | Two sources (detect and state) can disagree; detect wins, state is informational. Low. |
| D15 | The guided skill reads its per-step explanations from `config/setup-guide.json` (committed, non-secret: key names, purpose, where to get it, which wizard step enters it), not from `.env.example` (the hook's path rule denies `.env*`). A lint test keeps it in step with `.env.example`. | One more file to keep in step; the lint is the guard. Low. |

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/bootstrap/types.ts` (new) | `Platform`, `Item`, `Detection`, `Action`, `Outcome`, `BootstrapDeps` | 1 |
| `src/bootstrap/catalog.ts` (new) | Item catalog: detect and plan per platform, required or optional, pins | 1 |
| `src/bootstrap/exec.ts` (new) | Consent, sudo and download rules, result table, exit codes | 2 |
| `src/bootstrap/model.ts` (new) | Classifier download item over `scripts/models.ts` `runCli` | 4 |
| `src/bootstrap/state.ts` (new) | `.jobber/bootstrap.json` read and write (mode 600, ids and statuses only) | 5 |
| `scripts/bootstrap.sh` (new) | Node bootstrap and hand-over (bash 3.2 compatible) | 3 |
| `scripts/bootstrap.ts` (new) | CLI: `--yes`, `--allow-sudo`, `--check`, `--plan`, `--only`, `--skip-model`, `--with-optional`, `--json` | 3 |
| `src/platform/checksBootstrap.ts` (new), `scripts/doctor.ts` (modify) | Doctor `bootstrap_complete`, `setup_guide_ready` | 5, 8 |
| `src/platform/runner.ts`, `scripts/run-claude.ts` (modify) | Interactive profile mode, `bash_exact`, `classifier: not_required` validation | 6 |
| `.claude/hooks/tool-allowlist.cjs` (modify), `.claude/hooks/prompt-secret-guard.cjs` (new) | Exact Bash allowlist; owner-prompt secret guard | 7 |
| `.claude/skills/setup-guide/SKILL.md`, `config/setup-guide.json`, `config/runner/mcp.none.json` (new), `config/run-profiles.json` (modify), `tests/definitions-lint.test.ts` (modify) | The guide, its facts, its profile | 8 |
| `scripts/setup.ts`, `src/setup/cli.ts` (modify), `src/setup/guide.ts` (new) | `--no-guide`, `--guide-only`, `--status`, one-time offer, tmux spawn | 9 |
| `src/verify/*.ts` (new) | Stage engine and stages | 10 |
| `scripts/dry-run.ts`, `src/verify/fixtures/*.json` (new) | CLI, fixtures, result file | 11 |
| `src/stack/*.ts` (new), `scripts/stack.ts` (new) | `up`, `down`, `up --status` | 12, 13 |
| `package.json`, `.env.example` (modify) | Script names, three env keys | 3, 11, 13 |
| `README.md`, `tests/readme.test.ts` (modify) | Quick start rewrite and lint | 14 |
| `CLAUDE.md`, `docs/telegram-bot-setup.md`, `docs/gmail-mcp-setup.md` (pointer lines only) | Docs truth pass | 15 |

## package.json script names (added or changed)

| Script | Command | Notes |
|---|---|---|
| `bootstrap` | `tsx scripts/bootstrap.ts` | `npm run bootstrap -- --check` is read-only and runs anywhere |
| `setup` | `tsx scripts/setup.ts` | unchanged name; new flags `--no-guide`, `--guide-only`, `--status` |
| `dry-run` | `tsx scripts/dry-run.ts` | flags `--llm`, `--skip <stage>`, `--json`, `--list` |
| `up` | `tsx scripts/stack.ts up` | `npm run up -- --status` is read-only |
| `down` | `tsx scripts/stack.ts down` | flags `--keep-bridge`, `--force`, `--yes` |

Existing `dry-run:report`, `scheduler`, `scheduler:units`, `web`, `jobber:control`, `doctor` are untouched.

## The guide: allowlist, files and what it may say

**Profile (`config/run-profiles.json`, new entry):**
```json
"setup_guide": {
  "description": "Interactive setup coach: reads docs and doctor output only; no MCP tools, no secrets in env.",
  "interactive": true,
  "classifier": "not_required",
  "mcp_config": "config/runner/mcp.none.json",
  "builtin_tools": ["Skill", "Read"],
  "allow": [],
  "bash_exact": [
    "npm run doctor -- --json",
    "npm run doctor",
    "npm run setup -- --list",
    "npm run setup -- --status",
    "npm run models -- list",
    "npm run models -- verify",
    "npm run permissions -- --status",
    "npm run dashboard -- status",
    "npm run jobber:control -- status",
    "npm run scheduler -- --status",
    "npm run bootstrap -- --check",
    "npm run dry-run"
  ],
  "path_rules": { "Read": { "prefixes": ["docs/", "config/", "user-data.example/", ".claude/skills/setup-guide/"] } },
  "screen_args": [],
  "env_mode": "allowlist",
  "env_keys": ["TERM", "COLORTERM"],
  "max_turns": 200
}
```
The list above is the recommended default (owner decision O3). Deliberately absent: `npm run setup` (needs a TTY, owner runs it), `npm run models -- fetch|pin`, `npm run permissions -- <set>`, `npm run dashboard -- token|rotate|allow`, `npm run jobber:control -- stop|resume`, `npm run linkedin:*`, `npm run up|down`, `npm run bootstrap` without `--check`, anything with `--yes`. Running those is the owner's act, in the owner's terminal.

**What the guide does, in this order** (its skill, `.claude/skills/setup-guide/SKILL.md`): (1) `npm run doctor -- --json`, summarise counts; (2) walk the steps in the order of `config/setup-guide.json`: key overview (names and purpose only, no values), prereqs, claude, gmail, telegram (threaded mode), classifier, sessions (LinkedIn main, LinkedIn burner, Naukri), dashboard login (token default from 8C), permission set (explain `read_only`, recommend keeping it), limits (point at `npm run status -- limits` and the catalog, never invent numbers); (3) for each step: say what it is and where to get the thing (link to the runbook in `docs/`), say the exact owner command (`npm run setup -- --step <id>`), wait for the owner to say "done", rerun `npm run doctor -- --json`, translate each `fail` and `warn` of that step's `doctor_checks` into plain words with the `fix` text from `config/setup-guide.json`; (4) at the end run `npm run dry-run` and read its PASS/FAIL table. **It never**: reads or asks to read `.env`, `secrets/`, `user-data/`, `.dashboard/`, `.jobber/`, `data.sqlite`; asks the owner to paste a key, token, URL fragment or cookie; types into another pane; flips a dry flag, clears a halt, resumes, or changes a permission set; fetches the web.

**If the owner pastes a secret anyway:** the `prompt-secret-guard` hook (Task 7) blocks the prompt from reaching the model when it matches a secret shape; the skill also instructs the guide to say "that looks like a secret; do not paste it; rotate it" and not to repeat it.

---

### Task 1: Bootstrap catalog and detection (pure)

**Why:** the install logic must be testable without installing. This task defines what "present" means for each item and what an install would run, with no execution.

**Files:**
- Create: `src/bootstrap/types.ts`, `src/bootstrap/catalog.ts`, `tests/bootstrap-catalog.test.ts`
- Modify: `src/platform/checks.ts` (the `ccgram-version` fix hint is built by one exported helper `ccgramInstallHint(pin)` that `catalog.ts` also uses, so the doctor hint and the bootstrap action cannot drift; the printed hint text stays identical, a test pins it)

**Interfaces:**
```ts
export type Platform = 'darwin' | 'linux' | 'unsupported';
export type ItemId = 'git' | 'build-tools' | 'node' | 'npm-deps' | 'renderer-deps' | 'playwright-chromium'
  | 'chrome' | 'tmux' | 'uv' | 'ccgram' | 'claude-cli' | 'age' | 'rclone' | 'classifier-model';
export interface Detection { present: boolean; version?: string; detail: string }
export interface Action {
  id: string;            // stable id, e.g. 'tmux:brew'
  summary: string;       // one line for the owner
  argv: string[];        // never a shell string; executed without a shell
  cwd?: string;
  needsSudo: boolean;
  network: boolean;
  url?: string;          // shown when a URL is involved
  downloadsScript?: boolean; // true: fetch to a temp file first, show url/size/sha256, ask again
}
export type Plan =
  | { kind: 'actions'; actions: Action[] }
  | { kind: 'owner'; message: string; url?: string }   // "needs the owner": printed, never run
  | { kind: 'none'; why: string };
export interface BootstrapDeps {
  platform: Platform; root: string; env: NodeJS.ProcessEnv;
  run: Run;                                  // src/platform/tmux.ts Run (argv, no shell)
  fs: { exists(p: string): boolean; read(p: string): string; list(p: string): string[] };
  now: () => Date;
}
export interface Item {
  id: ItemId; title: string; required: boolean; optionalKind?: 'report_only' | 'consent';
  detect(d: BootstrapDeps): Promise<Detection>;
  plan(d: BootstrapDeps, det: Detection): Plan;
}
export function buildCatalog(input: { pin: CcgramPin; engines: string; hasRenderer: boolean; modelProfile: string }): Item[];
```

Item rules (this table IS the test; one `it` per row and platform):

| id | required | detect | plan, macOS | plan, Linux (apt) |
|---|---|---|---|---|
| `git` | yes | `git --version` | owner: `xcode-select --install` (also provides build tools) | apt `git` (sudo) |
| `build-tools` | yes | macOS `xcode-select -p` code 0; Linux `cc --version` | owner: `xcode-select --install` | apt `build-essential` (sudo) |
| `node` | yes | `node -v` major >= major of `engines` | brew `node` (check upstream for formula/LTS, U5) | apt `nodejs` only if the candidate major satisfies engines (`apt-cache policy`), else owner message with the nvm or NodeSource URL (check upstream), never auto |
| `npm-deps` | yes | `node_modules/.package-lock.json` exists AND `node_modules/tsx`, `better-sqlite3`, `patchright`, `playwright` exist | `npm ci` (network, no sudo) | same |
| `renderer-deps` | yes if `hasRenderer` | `renderer/node_modules/handlebars` exists | `npm ci --prefix renderer` | same |
| `playwright-chromium` | no (consent) | same probe as the existing `browser-binaries` check (`chromiumPresent`) | `npx playwright install chromium` (network) | same plus separate owner-visible sudo action `npx playwright install-deps chromium` (check upstream, U6) |
| `chrome` | no (report) | `/Applications/Google Chrome.app` or `google-chrome --version` (same as `chrome` check) | brew `--cask google-chrome` offered (consent, check upstream) | owner message only (download page, check upstream) |
| `tmux` | yes | `tmux -V` | brew `tmux` | apt `tmux` (sudo) |
| `uv` | yes | `uv --version` | brew `uv` | owner message: official installer URL (check upstream), `downloadsScript` action offered with show-and-ask |
| `ccgram` | yes | `ccgram --version` last token equals pin version | `uv tool install --python 3.14 "ccgram==<pin>"` (exact string from `ccgramInstallHint`) | same |
| `claude-cli` | yes | `claude --version` | owner message: "install Claude Code, then run: claude" with the upstream URL marked check upstream; optional action `npm install -g @anthropic-ai/claude-code` ONLY when npm's global prefix is writable by the user (U1) | same |
| `age`, `rclone` | no (report) | `age --version`, `rclone version` | report line with `brew install age rclone`, never run | report line with `apt install age rclone` |
| `classifier-model` | no (consent) | `verifyProfile` ok for `modelProfile` (Task 4) | see Task 4 | same |

- [ ] **Step 1: Failing tests** with a fake `Run` map (`argv joined -> {code, stdout}`) and a fake `fs`: every detect row for present, absent and wrong-version; every plan row for both platforms; `ccgram` plan argv equals the doctor hint's command; `node` plan on Linux with an old candidate returns `kind: 'owner'`; `unsupported` platform returns `owner` for every item; a plan never contains `sudo` inside `argv` (sudo is a flag, the executor adds it visibly); no `argv` element contains a shell metacharacter; `renderer-deps` absent from the catalog when `hasRenderer` is false.
- [ ] **Step 2: Run, confirm failure:** `npx vitest run tests/bootstrap-catalog.test.ts`.
- [ ] **Step 3: Implement** `types.ts`, `catalog.ts`; export `ccgramInstallHint` from `checks.ts` and use it in the `ccgram-version` check (message unchanged).
- [ ] **Step 4: Verify:** `npx vitest run tests/bootstrap-catalog.test.ts tests/platform-doctor.test.ts tests/platform-checks-setup.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(bootstrap): item catalog with detection and install plans (no execution)`

---

### Task 2: Executor, consent rules and result table

**Files:**
- Create: `src/bootstrap/exec.ts`, `tests/bootstrap-exec.test.ts`

**Interfaces:**
```ts
export type Outcome = 'ok' | 'installed' | 'skipped' | 'needs_owner' | 'failed' | 'unsupported';
export interface ItemResult { id: ItemId; title: string; required: boolean; outcome: Outcome; version?: string; note: string }
export interface ExecOptions {
  yes: boolean; allowSudo: boolean; checkOnly: boolean; planOnly: boolean;
  only?: ItemId[]; withOptional: boolean; skipModel: boolean; interactive: boolean; // interactive = stdin and stdout are TTYs
}
export interface ExecDeps extends BootstrapDeps {
  ask(prompt: string): Promise<boolean>; say(line: string): void;
  download(url: string, destDir: string): Promise<{ path: string; bytes: number; sha256: string }>;
  mkTempDir(): string;
}
export function runBootstrap(items: Item[], deps: ExecDeps, opts: ExecOptions): Promise<ItemResult[]>;
export function exitCodeFor(results: ItemResult[]): 0 | 1;   // 1 when a required item is failed or needs_owner
export function renderTable(results: ItemResult[]): string;   // fixed columns: item, required, result, version, note
```
Rules (table test, one `it` per row):

| action class | `--yes` | `--allow-sudo` | TTY | behaviour |
|---|---|---|---|---|
| non-sudo, no download | no | n/a | yes | print the action, ask once, run on yes |
| non-sudo, no download | yes | n/a | any | print the action, run without asking |
| non-sudo, no download | no | n/a | no | print, do not run, outcome `skipped`, note "needs --yes", overall exit 3 handled by the CLI |
| sudo | yes | no | any | print "needs sudo", ask on a TTY, refuse without TTY (`needs_owner`) |
| sudo | yes | yes | any | print the full command, run with `sudo` as the first argv, no extra prompt |
| `downloadsScript` | any | any | any | download to a temp dir (mode 700), print URL, bytes, sha256 and the first 40 lines, ask a SECOND time even with `--yes` (there is no flag that skips this; on a non-TTY the outcome is `needs_owner`), run only on yes; never piped |
| `owner` plan | any | any | any | printed with its URL, outcome `needs_owner`, never run |
| optional (`optionalKind: 'report_only'`) | any | any | any | report only unless `--with-optional` AND an install action exists, then the non-sudo rules above |

Other rules: detection runs first for every item and an `ok` item performs ZERO actions; a failed action marks the item `failed` with the last output line (redacted through `redactPane`), and later items still run unless they depend on it (`ccgram` depends on `uv`, `npm-deps` depends on `node`, `renderer-deps` on `npm-deps`; a dependent of a non-present item is `skipped` with "waiting for <id>"); after each successful action the item is re-detected and only a present result counts as `installed`; `checkOnly` runs detection only and never calls `ask`, `download` or an action; `planOnly` prints every action that would run and exits 0.

- [ ] **Step 1: Failing tests** for each row above with a recording fake `Run`; assert (a) second run on an all-present fake machine records zero `run` calls beyond detection, (b) `sudo` appears only as `argv[0]` of an action the table allows, (c) no `argv` is ever executed through a shell (the fake `Run` rejects a single-string command), (d) `checkOnly` calls neither `ask` nor `download`, (e) result table text contains no environment values.
- [ ] **Step 2: Run, confirm failure:** `npx vitest run tests/bootstrap-exec.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** `npx vitest run tests/bootstrap-exec.test.ts tests/bootstrap-catalog.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(bootstrap): consent-gated executor with sudo and download rules and a result table`

---

### Task 3: CLI and `scripts/bootstrap.sh`

**Files:**
- Create: `scripts/bootstrap.sh`, `scripts/bootstrap.ts`, `tests/bootstrap-cli.test.ts`, `tests/bootstrap-sh.test.ts`
- Modify: `package.json` (`"bootstrap": "tsx scripts/bootstrap.ts"`)

**`scripts/bootstrap.ts`:** parses flags (`--yes`, `--allow-sudo`, `--check`, `--plan`, `--only <id>[,<id>]`, `--with-optional`, `--skip-model`, `--json`, `--help`); builds `BootstrapDeps` from real `fs` and `defaultRun`; reads `config/ccgram.pin.json` and `package.json` `engines`; exit codes: 0 all required present, 1 a required item failed or needs the owner, 2 usage error, 3 non-interactive without `--yes` and an action was needed, 4 unsupported platform and nothing could be checked. Never prints `process.env`. `--json` prints `ItemResult[]` only.

**`scripts/bootstrap.sh` (bash, `set -euo pipefail`, bash 3.2 compatible: no associative arrays, no `${v,,}`, no `mapfile`):**
1. `cd "$(dirname "$0")/.."`; refuse to run as root (`id -u` is 0) with a message (npm and Homebrew do not support it).
2. Check `git` and a `bash` of any version; detect `uname -s` (`Darwin`, `Linux`, else exit 4 "unsupported platform").
3. If `node` exists and `node -p 'process.versions.node.split(".")[0]'` >= the major read from `package.json` `engines` with `sed`, skip to step 5.
4. Node missing or too old: macOS requires `brew` (else print the Homebrew URL, exit 1, D2); print `brew install node`, ask once (`read -r` from `/dev/tty`; no TTY and no `--yes` means exit 3), run it. Linux: apt candidate check via `apt-cache policy nodejs`; on a satisfying candidate print `sudo apt-get install -y nodejs npm`, ask, run (sudo visible; `--yes` does not imply sudo unless `--allow-sudo`); otherwise print the nvm or NodeSource URL (check upstream), exit 1 without running anything.
5. `node_modules/.bin/tsx` missing: print `npm ci`, ask (or `--yes`), run it.
6. `exec npx tsx scripts/bootstrap.ts "$@"`.

- [ ] **Step 1: Failing tests:** `bootstrap-cli.test.ts` covers `parseArgs` (every flag, bad arities, unknown flag exit 2), exit code mapping, `--json` shape, and that `--check` never reaches `ask`. `bootstrap-sh.test.ts` is hermetic: it runs `bash scripts/bootstrap.sh --check` with `PATH` set to a temp directory of stub executables (`node`, `git`, `npm`, `npx`, `uname`, `brew`) that only print and exit; asserts no stub other than `uname`, `node`, `git` was invoked when Node is present; with a stub `node` reporting v18 and no `brew` stub, the script exits 1 and prints the Homebrew URL and runs no installer; with `--check` (read-only) it never prompts. A second test greps the script: no `curl`, no `wget`, no `| sh`, no `| bash`, no `sudo` without a preceding `echo` of the command, no `rm -rf` outside a `mktemp -d` path.
- [ ] **Step 2: Run, confirm failure:** `npx vitest run tests/bootstrap-cli.test.ts tests/bootstrap-sh.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** the two test files, `npx tsc -p . --noEmit`, and `bash -n scripts/bootstrap.sh` (syntax only, no execution).
- [ ] **Step 5: Commit:** `feat(bootstrap): bootstrap.sh and npm run bootstrap with check, plan and consent flags`

---

### Task 4: Classifier model item (consent, size shown, hash verified)

**Files:**
- Create: `src/bootstrap/model.ts`, `tests/bootstrap-model.test.ts`
- Modify: `src/bootstrap/catalog.ts` (wire `classifier-model`), `scripts/models.ts` (export `describeProfile` already exported; no behaviour change)

**Behaviour:** reuses `runCli(['verify', id])` and `runCli(['fetch', id, '--yes'], deps)` through an injected `CliDeps`; never reimplements download or hashing. Sequence: (1) detect: `verify` ok means present; (2) plan: print `describeProfile` lines (title, licence, attribution, limitations, approx size in MB) and the sentence "Weights download from Hugging Face (about <N> MB); each file is hash-checked after download"; (3) ask once (`--yes` accepts; `--skip-model` skips with `skipped`); (4) fetch then verify; (5) report `pinned: model.onnx sha256; others git blob sha1` from the registry (so the owner sees which files are strongly pinned), and ALWAYS end with "needs the owner: `npm run models -- pin <id>`, `npm run classifier:fit -- --profile <id> --write`, set `CLASSIFIER_MODEL` (the setup `classifier` step does this)". Bootstrap never runs `pin` (it writes `config/classifier-models.json`, a reviewed diff), never runs `classifier:fit`, never writes `.env`. A gated or non-fetchable profile prints its `manual_steps` and is `needs_owner`.

- [ ] **Step 1: Failing tests** with a fake `FetchDeps` (no network): present and verified is `ok` with zero fetch calls; absent plus `--yes` fetches then verifies; absent without `--yes` on a non-TTY is `skipped`; a verification FAILED after fetch is `failed` and the note names the problem count, not file contents; gated profile (`llama-prompt-guard-2-22m`) is `needs_owner` and never calls fetch; the printed lines include the size and licence id; the item never calls `pinProfile`.
- [ ] **Step 2 to 4:** run, implement, `npx vitest run tests/bootstrap-model.test.ts tests/bootstrap-exec.test.ts tests/safety-classifier-registry.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(bootstrap): consent-gated classifier model download over the models machinery`

---

### Task 5: `.jobber/bootstrap.json` and doctor `bootstrap_complete`

**Files:**
- Create: `src/bootstrap/state.ts`, `src/platform/checksBootstrap.ts`, `tests/bootstrap-state.test.ts`, `tests/platform-checks-bootstrap.test.ts`
- Modify: `scripts/doctor.ts` (add `bootstrapChecks()` to the list), `src/setup/steps/prereqs.ts` (the `prereqs` message adds "or run bash scripts/bootstrap.sh" to the fix text only; check ids unchanged)

**State file** (`.jobber/bootstrap.json`, mode 600, directory 700, atomic write, never any env value or path outside the project): `{ version: 1, last_run_at, platform, items: { <id>: { outcome, version?, at } }, declined: [<id>] }`.

**Doctor check `bootstrap_complete`** (reuses `buildCatalog` detections over the doctor's `ctx.run` and `ctx.fs`):

| condition | result |
|---|---|
| a required item absent (`node`, `npm-deps`, `renderer-deps` if present in repo, `tmux`, `uv`, `ccgram` at the pinned version, `claude-cli`) | fail, fix `bash scripts/bootstrap.sh` |
| required all present, an optional absent (`chrome`, `playwright-chromium`, `classifier-model`) | warn naming each, fix `npm run bootstrap` |
| everything present | pass, detail lists item ids only |
| `.jobber/bootstrap.json` missing but everything present | pass (state is informational, D14) |
| platform `unsupported` | warn |

- [ ] **Step 1: Failing tests:** table above with fake `ctx`; state module: round trip, unknown version rejected, corrupt JSON returns `null` and does not throw, file mode 600 and dir mode 700 asserted on a temp dir, the written text contains none of a set of invented secret values passed through env.
- [ ] **Step 2 to 4:** run, implement, `npx vitest run tests/bootstrap-state.test.ts tests/platform-checks-bootstrap.test.ts tests/platform-doctor.test.ts tests/doctor-json.test.ts tests/setup-steps-basic.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(doctor): bootstrap_complete check and bootstrap state file`

---

### Task 6: Interactive restricted launcher and the exact-command allowlist (runner)

**Why:** today a profile cannot hold Bash and the launcher is `-p` only. The guide needs both, without weakening the existing profiles.

**Files:**
- Modify: `src/platform/runner.ts`, `scripts/run-claude.ts`, `tests/platform-runner.test.ts`, `tests/platform-run-claude.test.ts`, `tests/platform-runner-lint.test.ts`
- Create: `config/runner/mcp.none.json` (`{"mcpServers":{}}`)

**Interfaces (additions to `RunProfile`):**
```ts
interactive?: boolean;                 // true: no -p, no --output-format, no --max-turns
classifier?: 'required' | 'not_required';   // default 'required'
bash_exact?: string[];                 // exact command strings; only valid when interactive
```
`loadProfiles` validation (each a test):
- `bash_exact` entries must match `^(npm run [a-z0-9:-]+( -- [a-z0-9 :._=-]+)?|npx tsx scripts/[A-Za-z0-9_./-]+\.ts( [a-z0-9 :._=-]+)?)$`, at most 40 entries, no duplicates, none containing `;`, `&`, `|`, `<`, `>`, `` ` ``, `$`, `(`, `)`, `\`, quotes, `*`, `?`, `~`, newline or `..`.
- `bash_exact` is allowed only when `interactive: true` AND the profile name is not `hunt` or `outreach_wake` (those stay Bash-free).
- `builtin_tools` still may not list `Bash` (existing rule stays; Bash enters only through `bash_exact`).
- `classifier: 'not_required'` is valid only when `allow` is empty, `allow_from_permission_set` and `allow_extra` are absent, and `mcp_config` is `config/runner/mcp.none.json`; otherwise `loadProfiles` throws.
- `interactive: true` requires `env_mode: 'allowlist'` (never `dotenv_all`: the guide process never receives `.env`).

**Launcher changes (`scripts/run-claude.ts`):**
- `buildInteractiveArgs(name, profile, { settingsPath }, initialPrompt)`: `--permission-mode dontAsk`, `--setting-sources project`, `--strict-mcp-config --mcp-config <file>`, `--settings <file>`, `--tools <builtin_tools + Bash if bash_exact>`, `--allowedTools <Skill,Read, and each Bash(<exact>)>`, `--disallowedTools Write,Edit,NotebookEdit,WebFetch,WebSearch` (Bash removed from the disallow list only when `bash_exact` is non-empty), then the initial prompt as the final positional argument. No `-p`, no `--max-turns`, no `--output-format`. Calls `assertSafeArgs`.
- `--interactive` flag: required for an `interactive` profile and refused for a non-interactive one (exit 2); refused when stdin or stdout is not a TTY (exit 2, "needs a terminal"); spawns with `stdio: 'inherit'`.
- STOP (exit 4) is checked first, as today. The classifier launch check is skipped only when `profile.classifier === 'not_required'` and the profile validated; the skip is printed on stderr as one fixed line.
- `renderSettings` for an interactive profile adds the new hook `prompt-secret-guard.cjs` (Task 7) under `UserPromptSubmit`; `renderPolicy` carries `bash_exact` and `interactive` so the hook can read them.

- [ ] **Step 1: Failing tests:** each validation rule (accept and reject cases); `buildInteractiveArgs` snapshot with and without Bash, asserting no `-p`, no `--max-turns`, `--permission-mode dontAsk`, no `bypass` anywhere, and that every `Bash(` entry equals an entry of `bash_exact` (no wildcard); `hunt` and `outreach_wake` args are byte-identical to before (golden test, so the existing launcher is provably unchanged); `--interactive` on `hunt` exits 2; interactive without a TTY exits 2; STOP exits 4 before anything else; `--print-args` for `setup_guide` prints argv and env key NAMES only.
- [ ] **Step 2: Run, confirm failure:** `npx vitest run tests/platform-runner.test.ts tests/platform-run-claude.test.ts`.
- [ ] **Step 3: Implement.** Existing exported names keep their signatures.
- [ ] **Step 4: Verify:** `npx vitest run tests/platform-runner.test.ts tests/platform-run-claude.test.ts tests/platform-runner-lint.test.ts tests/platform-launch-check.test.ts tests/agents-lint.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(runner): interactive restricted profiles with an exact Bash allowlist`

---

### Task 7: Hook enforcement (exact Bash) and the prompt secret guard

**Files:**
- Modify: `.claude/hooks/tool-allowlist.cjs`, `tests/hook-tool-allowlist.test.ts`
- Create: `.claude/hooks/prompt-secret-guard.cjs`, `tests/hook-prompt-secret-guard.test.ts`

**`tool-allowlist.cjs` `decide` additions:** when `event.tool_name === 'Bash'`: allow only if `profile.interactive === true`, `Array.isArray(profile.bash_exact)`, every entry passes the same validator the loader uses (re-implemented in CJS, kept in step by a test that runs both on one corpus), `typeof event.tool_input.command === 'string'`, `event.tool_input.command.trim()` equals one entry exactly, and `tool_input.run_in_background` is falsy and `tool_input.dangerouslyDisableSandbox` is falsy. Anything else is a deny with a fixed reason. Subagent events keep today's rule (the intersection with the agent's `tools:` line; the guide has no `Agent` tool anyway). The kill-switch decision still runs first.

**`prompt-secret-guard.cjs`:** a `UserPromptSubmit` hook reading `{prompt}` from stdin; if it matches any pattern in a fixed list it returns the hook JSON that blocks the prompt with the fixed message "That looks like a secret. Do not paste secrets here. Rotate it if it was real, and enter it in the setup wizard instead." The message never echoes the match. Patterns (anchored to shapes, not to words): Telegram bot token `\b\d{8,10}:[A-Za-z0-9_-]{35}\b`; Google OAuth `GOCSPX-[A-Za-z0-9_-]{20,}` and `AIza[0-9A-Za-z_-]{35}`; OpenAI/Anthropic-like `\bsk-[A-Za-z0-9_-]{20,}`; Slack `xox[abprs]-`; AWS `AKIA[0-9A-Z]{16}`; PEM `-----BEGIN`; a 43-character base64url run (dashboard token shape from 8C, `\b[A-Za-z0-9_-]{43}\b`) and a 64-hex run (a hash is public, but the dashboard token's hash is not meant for chat either); `#token=`; an `Authorization: Bearer` header; an `.env`-style assignment of a key whose name matches `KEY|SECRET|TOKEN|PASSWORD|PASS|COOKIE` followed by a non-empty value. Fail closed: a parse error blocks.

- [ ] **Step 1: Failing tests (hook-tool-allowlist):** allow each profile string exactly, with surrounding whitespace; deny every one of: `npm run doctor -- --json; cat .env`, `npm run doctor -- --json && id`, `npm run doctor -- --json | tee x`, `npm run doctor -- --json > secrets/x`, `$(cat .env)`, backticks, `npm run doctor -- --json\ncat .env`, `npm run doctor -- --json ` plus a trailing `#`, a Cyrillic homoglyph `npm run dосtor`, `npm  run doctor` (two spaces), `npm run doctor -- --json --foo`, `cat .env`, `env`, `printenv`, `bash -c ...`, `node -e ...`, an empty string, a non-string, an array, `run_in_background: true`; Bash denied under `hunt` and `outreach_wake` even with a crafted `bash_exact` in a tampered policy file only if the profile name is not interactive (the hook reads the rendered policy, so also assert a tampered policy that adds `cat .env` is refused by the validator). Read: allowed `docs/telegram-bot-setup.md`, `config/setup-guide.json`; denied `.env`, `.env.example`, `./.env`, `secrets/x`, `user-data/resume.json`, `.dashboard/auth.sqlite`, `.jobber/bootstrap.json`, `data.sqlite`, `docs/../.env`, a symlink inside `docs/` pointing at `.env` (created in a temp project root), `/etc/passwd`, `~/.ssh/id_rsa`. Tools denied: `Write`, `Edit`, `WebFetch`, `WebSearch`, `Agent`, any `mcp__*`.
- [ ] **Step 2: Failing tests (prompt guard):** each pattern with an invented value is blocked and the output does not contain the value; ordinary prose, a 40-character hex git hash, `npm run setup -- --step gmail`, a bot username, and a Gmail address are allowed; malformed stdin blocks; the 43-char rule has an explicit false-positive test (a 43-char identifier-looking path is blocked, documented as accepted noise).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** `npx vitest run tests/hook-tool-allowlist.test.ts tests/hook-prompt-secret-guard.test.ts tests/hook-kill-switch.test.ts tests/hook-block-outside-project.test.ts tests/platform-runner.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(hooks): exact Bash allowlist for interactive profiles and a prompt secret guard`

---

### Task 8: The setup-guide skill, its facts file, and the secrecy corpus

**Files:**
- Create: `.claude/skills/setup-guide/SKILL.md`, `config/setup-guide.json`, `tests/setup-guide.test.ts`, `src/platform/checksGuide.ts`
- Modify: `config/run-profiles.json` (the `setup_guide` entry above), `tests/definitions-lint.test.ts`, `scripts/doctor.ts` (add `setup_guide_ready`)

**`config/setup-guide.json` shape** (no values, ever):
```json
{ "version": 1,
  "steps": [ { "id": "gmail", "title": "Gmail sending", "owner_command": "npm run setup -- --step gmail",
      "doctor_checks": ["gmail-oauth"],
      "keys": [ { "name": "GMAIL_OAUTH_PATH", "secret": false, "purpose": "path of the Google OAuth client file",
                  "where": "docs/gmail-mcp-setup.md, section One-time setup", "entered_in": "wizard" } ],
      "explain": "plain words, 2 to 4 sentences",
      "fixes": { "gmail-oauth": "plain-words fix text" } } ],
  "ignore_keys": ["ANTHROPIC_DEFAULT_OPUS_MODEL"] }
```
Order: `overview` (every key, grouped, no entering), `prereqs`, `claude`, `gmail`, `telegram`, `classifier`, `sessions`, `dashboard`, `access`, `limits`, `resume` and `profile` (the guide says what they are; it never reads `user-data/`), `final`. The wizard's `ALL_STEPS` order is NOT changed; the guide names `--step <id>` so the owner can follow the guide's order (D15 note: the wizard skips a finished step on its own).

**Skill file:** frontmatter `name: setup-guide`, `description`, `allowed-tools:` listing exactly `Read` and one `Bash(<exact>)` per `bash_exact` entry (a lint test asserts the two lists are equal, so there is one source of truth); body sections Role, Hard rules (the "never" list from "The guide" above, verbatim), Order, Per-step protocol, Doctor translation (id to plain words comes from `config/setup-guide.json`, never improvised), "If the owner pastes a secret", "What to do when a command is refused" (report the one-line refusal and stop, no workaround), Owner-only steps (OAuth consent, QR or password logins, bot creation, any key creation, any sudo).

**Tests (`tests/setup-guide.test.ts`):**
1. `config/setup-guide.json` parses; every step id exists in `ALL_STEPS` or is `overview`; every `doctor_checks` id exists in a real check list (`ccgramChecks`, `restrictedChecks()`, `setupChecks`, browser, scheduler, update, bootstrap); every non-comment key in `.env.example` appears under some step or in `ignore_keys`; every key with `secret: true` matches `/KEY|SECRET|TOKEN|PASS|PASSWORD|COOKIE/` or is in an explicit allowlist in the test; no `value`, `default` or `example` field anywhere (schema allowlist).
2. Skill `allowed-tools` equals `bash_exact` plus `Read`; the body contains no `.env` reading instruction (grep for "cat .env", "open .env", "paste"); it contains each hard rule line.
3. **Secrecy corpus:** build a fake `DoctorContext` whose `.env` text, `secrets/` file names and `user-data/` files carry synthetic secret values (`TELEGRAM_BOT_TOKEN=123456789:AAFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK`, a Google client secret `GOCSPX-FAKE...`, an `ADZUNA_APP_KEY`, a Serper key, a dashboard token shape, an OIDC client secret), run EVERY check list in the repo through `runChecks`, and assert `formatJson` and `formatReport` output contain none of those values nor any substring of 12 or more characters of them. A failing check here is a doctor bug to fix in this task (finding, then fix the one check).
4. Profile: `loadProfiles` accepts `setup_guide`; `bash_exact` contains no entry outside the owner's recommended list unless the test's list is updated in the same commit (a deliberate speed bump).
- [ ] **Step 1: Write the failing tests, run, confirm failure:** `npx vitest run tests/setup-guide.test.ts tests/definitions-lint.test.ts`.
- [ ] **Step 2: Implement** files and the doctor check `setup_guide_ready` (pass when the profile loads, the skill's tool list equals the profile, the three hook files exist, `mcp.none.json` has no servers; fail otherwise, fix "restore from git").
- [ ] **Step 3: Verify:** `npx vitest run tests/setup-guide.test.ts tests/definitions-lint.test.ts tests/agents-lint.test.ts tests/platform-doctor.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 4: Commit:** `feat(setup): guided setup skill, facts file and profile; doctor output proven free of secrets`

---

### Task 9: `npm run setup` integration (offer, `--no-guide`, `--guide-only`, `--status`)

**Files:**
- Create: `src/setup/guide.ts`, `tests/setup-guide-offer.test.ts`
- Modify: `scripts/setup.ts`, `src/setup/cli.ts` (`parseArgs`, `USAGE`), `tests/setup-final-and-cli.test.ts`

**Flags:** `--no-guide` (skip the offer), `--guide-only` (start only the guide in the current terminal: `bash scripts/run-claude.sh setup_guide --interactive` with the fixed initial prompt "Use the setup-guide skill. Start by running the doctor."), `--status` (print each step id with `done|skipped|pending` and its time from `user-data/.setup-state.json`; step ids and statuses only, no values; works without a TTY), plus the existing `--step`, `--redo`, `--list`, `--help`. `--guide-only` and `--no-guide` together is a usage error.

**Offer (`src/setup/guide.ts`, pure over a `GuideDeps`):** runs once at wizard start when ALL hold: not `--no-guide`; stdin and stdout TTY; doctor `claude-cli` and `claude-login` pass; `setup_guide_ready` passes; not already offered in this state file (`state.guide_offered`); the owner confirms. Then: if tmux is present and session `jobber-setup` has no `guide` window, create it detached with `tmux new-session -d -s jobber-setup -n guide -c <root> bash scripts/run-claude.sh setup_guide --interactive` and print `Open another terminal and run: tmux attach -t jobber-setup` plus "Keep entering keys in THIS window; the guide never sees them". Without tmux: print `Open a second terminal here and run: npm run setup -- --guide-only`. The wizard then continues normally in this terminal; it never waits for the guide and never reads it. Declining records `guide_offered` and never asks again (`--redo` resets it).

- [ ] **Step 1: Failing tests** with the existing fake `SetupContext`: offer skipped for each failing condition; accepted path calls `run('tmux', ['new-session', '-d', '-s', 'jobber-setup', ...])` exactly once with the launcher command and never `send-keys`; no tmux prints the second-terminal command; decline persists; `--no-guide` makes zero `ask` calls about the guide; `--status` output matches a snapshot and contains no env value; `parseArgs` rejects `--guide-only --no-guide`; the existing wizard tests are untouched and still pass (non-AI path unchanged).
- [ ] **Step 2 to 4:** run, implement, `npx vitest run tests/setup-guide-offer.test.ts tests/setup-final-and-cli.test.ts tests/setup-runner.test.ts tests/setup-suspend.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(setup): offer the guided session, add --no-guide, --guide-only and --status`

---

### Task 10: Dry-run stage engine and stages (no I/O of its own)

**Files:**
- Create: `src/verify/engine.ts`, `src/verify/stages.ts`, `tests/verify-engine.test.ts`, `tests/verify-stages.test.ts`

**Interfaces:**
```ts
export type StageStatus = 'pass' | 'fail' | 'skip';
export interface StageResult { id: string; title: string; status: StageStatus; detail: string; fix?: string; ms: number }
export interface Stage { id: string; title: string; skippable: boolean; run(ctx: VerifyCtx): Promise<Omit<StageResult, 'id' | 'title' | 'ms'>> }
export interface VerifyCtx {
  root: string; env: NodeJS.ProcessEnv;       // env already forced dry (see engine)
  tmp: string;                                // temp dir created by the engine
  tempDbPath: string; tempStopFile: string;
  run: Run; fs: ...; now: () => Date;
  doctor(): Promise<CheckOutcome[]>;
  openDb(path: string): Db;                   // src/db.ts openDb
  startWeb(opts: { port: 0; ... }): Promise<{ url: string; close(): Promise<void> }>;
}
export function forceDryEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;  // JOBBER_DRY_RUN=1, SCHEDULER_DRY_RUN=true, LINKEDIN_DRY_RUN=true, JOBAPPLIER_DB=<temp>, unset JOBBER_KILL
export function runStages(stages: Stage[], ctx: VerifyCtx, opts: { skip: string[]; timeoutMs: number }): Promise<StageResult[]>;
export function exitCodeFor(r: StageResult[]): 0 | 1;   // 1 on any fail; a stage that throws or times out is a fail
export function renderTable(r: StageResult[]): string;  // PASS/FAIL/SKIP, title, detail, "fix:" line for fail
```
**Stages, in order** (each with a pass condition and a fix hint; a stage that cannot run its dependency is `fail`, never silently `skip`):

| id | skippable | does | pass when | fix hint on fail |
|---|---|---|---|---|
| `env-guard` | no | asserts the forced env: `isDryRun(env, {linkedin:true})` is true, `JOBAPPLIER_DB` is under `tmp`, real `data.sqlite` path untouched | true | "internal: dry env not applied" |
| `doctor` | no | runs all check lists in process (same lists as `scripts/doctor.ts`) | no `fail`; lists `warn`s | each failing check's `fix` |
| `classifier-smoke` | yes (`--skip classifier`) | the existing `classifier_smoke` logic over the configured profile | benign below and injection above the fitted threshold | `npm run bootstrap`, then `npm run setup -- --step classifier` |
| `launcher` | no | `scripts/run-claude.ts hunt --print-args` and `outreach_wake --print-args` through `run` | exit 0, argv contains none of `bypass`, `skip-permissions`, `dangerously`; `setup_guide` prints with `--interactive --print-args` | the printed message |
| `scheduler-plan` | no | `scripts/scheduler.ts --dry-run-plan` with `JOBAPPLIER_DB=<temp migrated db>` | parses as a planWake decision object | `npm run scheduler -- --status` |
| `pipeline-fixture` | no | in the temp DB: save fixture match rows, apply vetoes to a deal-breaker fixture and a clean fixture, enqueue the clean one, call `recordDryRun` for a fake send, call `kill-switch.cjs decide` for `mcp__gmail__send_email` with `JOBBER_DRY_RUN=1` | vetoed one excluded with its reason, clean one queued, one `dry_run_actions` row, hook denies the send | the failing assertion name |
| `kill-switch-drill` | no | `applyStop` then `readControl` then `applyResume` on `tempStopFile` and the temp DB; `kill-switch.cjs decide` denies a tool while the temp STOP exists and allows after resume | all four observations | "kill switch code path broken: do not go live" |
| `status-render` | no | `buildSnapshot` on the temp DB, `renderLimits`, `renderWorking`, `renderHealth` | no throw, non-empty | the thrown message first line |
| `dashboard-login` | yes (`--skip dashboard`) | `startWeb` on `127.0.0.1:0` with a temp auth store and temp read-only data DB, mode token (8C); `GET /` is 200 and serves the shell, `GET /api/auth/mode` returns `{mode:'token'}`, `GET /api/status` without a session is 401, then close | all three | `npm run doctor` check `web`, `dashboard-login` |
| `llm-hunt` | yes, OFF unless `--llm` | `./run-hunt.sh "run the hunt in dry mode: report only"` with every dry flag forced on and a 10 minute timeout | exit 0 and a final report line | the exit code and "see docs/operations" |

- [ ] **Step 1: Failing tests:** engine (skip list, timeout, a throwing stage is `fail`, order preserved, exit code, table format, `--skip` of a non-skippable stage is a usage error); `forceDryEnv` (every input combination yields dry, `JOBBER_KILL` removed, secrets not copied into the result beyond what was passed in); each stage with fakes for pass and fail; **writes-nothing test:** a fake `fs` records every write path and the test asserts all are under `tmp` or equal the single result file path from Task 11; **real-stop-file test:** the real `.jobber/STOP` path is never passed to `applyStop` or `applyResume` (spy).
- [ ] **Step 2 to 4:** run, implement, `npx vitest run tests/verify-engine.test.ts tests/verify-stages.test.ts tests/safety-dry-run.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(verify): dry-run stage engine and stages with temp db and temp stop file`

---

### Task 11: `npm run dry-run` CLI, fixtures and result file

**Files:**
- Create: `scripts/dry-run.ts`, `src/verify/fixtures/jobs.json`, `src/verify/fixtures/match.json`, `tests/verify-cli.test.ts`
- Modify: `package.json` (`"dry-run": "tsx scripts/dry-run.ts"`), `.env.example` (no new key here), `src/platform/doctor.ts` untouched

**CLI:** flags `--llm`, `--skip <id>[,<id>]`, `--json`, `--list` (stage ids and whether skippable), `--help`. Prints a banner "DRY RUN VERIFY: nothing is sent, applied or connected; temp database; your .env is not changed". Exit 0 only when no stage is `fail`; exit 1 otherwise; exit 2 usage. Writes ONE file, `.jobber/verify.json` (mode 600: `{at, passed, failed, skipped, stages:[{id,status}]}`, no details), so `up --status` can print "last dry-run: PASS 3 hours ago". Fixtures are synthetic (invented company, invented posting text containing one deal-breaker keyword from `config/deal-breakers.json` in a clearly marked fixture; the clean fixture contains none). The dashboard stage uses the production server module with test seams only (no network, port 0).

- [ ] **Step 1: Failing tests:** `parseArgs`; whole-run test with every stage faked asserting the exit code, table and the single written file; `--llm` is the only way the `llm-hunt` stage runs; fixture files contain no `@` addresses other than `example.invalid`, no URLs other than `example.invalid`; the CLI refuses when `JOBBER_KILL` handling would change real state (it removes it from the child env copy only, asserted).
- [ ] **Step 2 to 4:** run, implement, `npx vitest run tests/verify-cli.test.ts tests/verify-stages.test.ts tests/verify-engine.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(verify): npm run dry-run end-to-end smoke with fixtures and a result file`

---

### Task 12: `up` (preflight, mode banner, ordered idempotent start)

**Files:**
- Create: `src/stack/plan.ts`, `src/stack/mode.ts`, `src/stack/up.ts`, `tests/stack-up.test.ts`, `tests/stack-mode.test.ts`
- Modify: none yet (`scripts/stack.ts` and package scripts land in Task 13)

**Interfaces:**
```ts
export interface StackDeps { root: string; env: NodeJS.ProcessEnv; run: Run; fs: ...; now: () => Date;
  doctor(): Promise<CheckOutcome[]>; say(l: string): void; sleep(ms: number): Promise<void>;
  probe(url: string): Promise<boolean>; }                // loopback GET, status 200 or 401 counts as up
export function currentMode(env: NodeJS.ProcessEnv): { mode: 'DRY RUN' | 'LIVE'; flags: Record<string, string>; lines: string[] };
export function planUp(deps: StackDeps): Promise<UpPlan>;   // read-only: what is running, what would start
export function runUp(deps: StackDeps, opts: { status: boolean }): Promise<number>;
```
**Order and rules (each a test):**
1. **Env:** read `.env` through `parseEnv`, process env wins (same as `scripts/scheduler.ts`); compute `currentMode` from `isDryRun(env, {linkedin:true})` plus each of the three flags and `JOBBER_KILL`. Print the banner FIRST and again LAST: `MODE: DRY RUN (nothing is sent)` or `MODE: LIVE (real email, LinkedIn and Naukri actions, within caps)` with the three flag values.
2. **Stop gates (exit 4, nothing started):** `.jobber/STOP` present or `JOBBER_KILL=1` (use `scripts/killSwitch.ts` `stopActive`). Message: "kill switch is on: `npm run jobber:control -- resume` when you are sure". `up` never resumes.
3. **Doctor:** run all lists in process; any `fail` prints the failing ids with `fix` and exits 1 (no override flag, D10); `warn`s are listed.
4. **Bridge:** `bash scripts/ccgram/start.sh` (it already prints "already running" and exits 0). Skipped with a note when `TELEGRAM_BOT_TOKEN` is not set in `.env` (the doctor `ccgram-env` check would have failed anyway; here only for `--status`).
5. **Windows:** for each name in `config/manager-windows.json` `windows` (`hunt`, `followups`) call `startWindow` (idempotent: returns `exists`). The `manager` window is created only if missing, with the same `claude-session.sh` argv, name `manager`, via a new `ensureManagerWindow` (O5, U8); if creation fails it is a printed warning, not a failure.
6. **Scheduler:** skipped with a note when `SCHEDULER_ENABLED=false`, when a launchd or systemd unit is loaded (D11), or when window `scheduler` already exists in `STACK_TMUX_SESSION`; otherwise `tmux new-session -d` (first window) or `new-window` running `env -i HOME PATH TERM LANG TZ npm run scheduler -- --daemon` in the project root. The explicit empty environment makes the daemon read `.env` itself and prevents a stale tmux server environment from overriding it (U7).
7. **Dashboard:** window `web` running `env -i HOME PATH TERM LANG TZ npm run web`; then poll `http://127.0.0.1:<WEB_PORT>/api/auth/mode` up to 20 s (`probe`); failure is a warning with the window name to read (`npx tsx scripts/manager.ts read ...` does not cover this session, so print `tmux attach -t <session>`). If token mode and no token exists, print `npm run dashboard -- token`.
8. **Ticks:** print `AUTO_UPDATE` and `BACKUP_ENABLED` as on/off ("run by the scheduler after a wake"); start nothing.
9. **Final output:** the MODE banner, a table (component, state, how to look), the dashboard URL, `tmux attach -t ccgram` (windows), `tmux attach -t <STACK_TMUX_SESSION>` (scheduler, web), last `dry-run` result from `.jobber/verify.json` (never gating), and one line `Stop: npm run down   Emergency: npm run jobber:control -- stop`.
10. `--status`: steps 1, 2 (reported, not exit 4), 9 only; no doctor run beyond a fast subset, no start, exit 0.

- [ ] **Step 1: Failing tests** with a fake `Run` that models tmux sessions and windows in memory: fresh start order is bridge, windows, scheduler, web; a second `runUp` records zero `new-window`/`new-session` calls; STOP exits 4 and records no start; a doctor `fail` exits 1 and records no start; a loaded launchd unit skips the scheduler; `SCHEDULER_ENABLED=false` skips it; the command string for scheduler and web starts with `env -i` and contains no value of any `.env` key (a fake `.env` with invented secrets is read and the recorded argv is scanned); the mode banner appears first and last and the LIVE case requires all three flags literally `false`/`0` per `isDryRun`; **mode-immutability test:** grep over `src/stack/**` for `JOBBER_DRY_RUN`, `SCHEDULER_DRY_RUN`, `LINKEDIN_DRY_RUN`, `applyResume`, `applyStop`, `halt_flags`, `permissions`, `settings.local` writes returns only read-only uses (an allowlist of exact read sites).
- [ ] **Step 2 to 4:** run, implement, `npx vitest run tests/stack-up.test.ts tests/stack-mode.test.ts tests/platform-manager.test.ts tests/platform-tmux.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(stack): up with doctor gate, kill-switch refusal, mode banner and idempotent ordered start`

---

### Task 13: `down`, `up --status`, CLI and package scripts

**Files:**
- Create: `src/stack/down.ts`, `scripts/stack.ts`, `tests/stack-down.test.ts`, `tests/stack-cli.test.ts`
- Modify: `package.json` (`"up": "tsx scripts/stack.ts up"`, `"down": "tsx scripts/stack.ts down"`), `.env.example` (`STACK_TMUX_SESSION`, `STACK_DOWN_WAIT_SEC`; `BOOTSTRAP_MODEL_PROFILE` commented, empty by default)

**`down` (D13), each a test:** order web, scheduler, `hunt`, `followups`, bridge; scheduler gets `tmux send-keys -t ... C-c` (the daemon's SIGINT handler sets its stop flag), then polls window presence up to `STACK_DOWN_WAIT_SEC`; if still present it prints "scheduler is finishing a wake; run npm run down again, or npm run down -- --force" and does NOT kill; `--force` runs `kill-window`; `--keep-bridge` skips the bridge; `manager` is never touched; windows not present report `absent` (idempotent: a second `down` records zero kills); `--yes` is required to stop `hunt`/`followups` windows when stdin is not a TTY (they may hold interactive work), otherwise on a TTY it asks once. `down` does not remove `.jobber/STOP`, clears no halt, deletes no file, touches no database, and does not stop a scheduler that belongs to a launchd or systemd unit (it prints how to unload it from `scheduler-units` output).

**`scripts/stack.ts`:** subcommands `up`, `down`; `up` flags `--status`; `down` flags `--keep-bridge`, `--force`, `--yes`; unknown flag exit 2; builds real deps (`defaultRun`, real fs, in-process doctor from the same lists as `scripts/doctor.ts`, `fetch` for probe on loopback only, `process.exit` with the returned code).

- [ ] **Step 1: Failing tests** with the in-memory tmux fake: order, graceful wait, force, idempotence, protected `manager`, no write outside the allowed tmux calls; CLI parse tests; a test that `npm run up -- --status` maps to `['up','--status']`.
- [ ] **Step 2 to 4:** run, implement, `npx vitest run tests/stack-down.test.ts tests/stack-cli.test.ts tests/stack-up.test.ts tests/env-example-update-backup.test.ts tests/setup-limits-catalog.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(stack): down, up --status and npm run up|down`

---

### Task 14: README quick start and lint

**Files:**
- Modify: `README.md`, `tests/readme.test.ts`

**README changes:** the "Quick start" section becomes the three lines (the same block as in the Goal), each followed by one sentence: what it does, that it asks before every install, that rerunning is safe, that `npm run setup -- --no-guide` skips the guided session, that `npm run dry-run` writes nothing live, and that `up` prints `MODE: DRY RUN` or `MODE: LIVE` and never changes it. "Prerequisites" shrinks to "git and a shell; `bash scripts/bootstrap.sh` installs the rest (macOS with Homebrew first, Ubuntu variant)"; "Starting and stopping sessions" gains `npm run up` and `npm run down`; the existing `scripts/ccgram/start.sh|stop.sh`, `run-hunt.sh` and the manual routes stay documented as the building blocks. No claim that anything is live-verified that is not (U-list).

**Lint additions (`tests/readme.test.ts`):** (a) the Quick start section contains exactly the three command lines (regex-pinned) and each `npm run <name>` and `bash scripts/<file>` in it exists (package.json scripts, files); (b) every `npm run` in the whole README exists (existing test, still passes); (c) the section names `--no-guide`, `dry-run`, `up`, `down`; (d) README never contains the words "skip-permissions" as a recommendation, never `curl ... | sh`.

- [ ] **Step 1: Failing tests, then edit.** `npx vitest run tests/readme.test.ts tests/dash-docs.test.ts`.
- [ ] **Step 2: Verify:** `npx tsc -p . --noEmit`.
- [ ] **Step 3: Commit:** `docs(readme): four-command quick start with a lint that the commands exist`

---

### Task 15: Docs truth pass and the 8D handoff

**Files:**
- Modify: `CLAUDE.md`, `docs/telegram-bot-setup.md` and `docs/gmail-mcp-setup.md` (one pointer line each: "the guided session can walk you through this: `npm run setup`"), `tests/definitions-lint.test.ts` (skill count and names if it pins them)

**CLAUDE.md edits (pointers and facts only, no rule moved):** skills list gains `setup-guide`; "Platform and sessions": scripts list gains `bootstrap`, `dry-run`, `up`, `down`, and `setup -- --no-guide|--guide-only|--status`; one paragraph "Bring-up commands" (the four commands, the `setup_guide` profile and its exact-Bash rule, that `up` never changes mode); "Outreach safety layers" layer 1 gains one sentence on interactive profiles and `bash_exact`; "After merge: user checklist" item 0 points at the README quick start. "Known limits" gains the U-list items that apply to this plan as "unverified until owner live check Ln". The test baseline paragraph is unchanged.

- [ ] **Step 1:** edit; `git grep -n "npm run \(bootstrap\|dry-run\|up\|down\)" -- README.md CLAUDE.md` all resolve to package.json scripts.
- [ ] **Step 2: Verify:** `npx vitest run tests/readme.test.ts tests/definitions-lint.test.ts tests/dash-docs.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 3: Commit:** `docs: bring-up commands, setup-guide skill and interactive profile in CLAUDE.md and runbooks`

---

## Final verification (after Task 15)

```bash
npx tsc -p . --noEmit
npx vitest run
git grep -nE "JOBBER_DRY_RUN|SCHEDULER_DRY_RUN|LINKEDIN_DRY_RUN" -- src/stack src/bootstrap src/verify scripts/stack.ts scripts/bootstrap.ts scripts/dry-run.ts
git grep -nE "curl .*\| *(ba)?sh|--dangerously|skip-permissions|bypassPermissions" -- scripts src .claude/skills/setup-guide config/run-profiles.json
git grep -n "\.env" -- .claude/skills/setup-guide config/setup-guide.json
bash -n scripts/bootstrap.sh
git status --short
```
Expected: exactly the 5 known failures; the first grep shows only the read-only uses on the Task 12 allowlist and the forced-dry assignments in `src/verify`; the second and third show nothing that recommends or performs the forbidden thing (the skill may name `.env` only inside its "never read" rule); `git status` shows only intended paths and nothing under `secrets/`, `user-data/`, `.env*`, `.jobber/`.

## Hard limits for the builder

1. Do not read `secrets/`, `user-data/`, `.env*`, `.dashboard/`, `.jobber/` contents or `data.sqlite`. Fixtures and synthetic values only.
2. No network, no `npm install` or `npm ci`, no `brew`, `apt`, `uv`, `npx playwright install`, no model download, no real tmux, no real `claude`, no browser. Every effect behind an injected seam. `bash -n` on the shell script is the only shell execution besides the hermetic stub-PATH test.
3. Do not weaken `assertSafeArgs`, the kill-switch hook, `block-outside-project.cjs`, the classifier launch check for any profile except a validated `not_required` one, or any existing profile (`hunt`, `outreach_wake` argv stays byte-identical; a golden test pins it).
4. Do not add Bash, Write, Edit, WebFetch or any MCP tool to the guide profile. Do not add a wildcard anywhere in `bash_exact`. Do not make the guide profile `dotenv_all`.
5. Do not let any new code write a dry-run flag, clear a halt, remove `.jobber/STOP`, call `applyResume`/`applyStop` against the real stop file, change a permission set or touch `.claude/settings.local.json`.
6. Do not run `pin` or `classifier:fit` from bootstrap; do not write `.env` from bootstrap, `dry-run`, `up` or `down`.
7. Do not install Homebrew, do not run an installer script without the show-and-ask, do not use `sudo` without printing the full command first.
8. Do not edit `CLAUDE.md` or `README.md` before Tasks 14 and 15. Do not commit anything but the listed paths. Never push, never `--no-verify`.
9. If a step needs a decision this plan does not make, stop and ask; do not guess. In particular, any flag or install method marked UNVERIFIED stays marked in code comments and in the docs.

## Owner decisions (recommended defaults)

| # | Question | Recommended |
|---|---|---|
| O1 | Entry command names | `bash scripts/bootstrap.sh`, `npm run setup`, `npm run dry-run`, `npm run up` / `npm run down` (D1, D7) |
| O2 | Install Homebrew for the owner | no, print the URL (D2) |
| O3 | Guide Bash allowlist contents | the 12 strings in "The guide" section; add `npm run dry-run` only after L6 passes |
| O4 | Offer the guide automatically | offer once, default yes, never auto-start (D6) |
| O5 | Should `up` create the `manager` window when missing | yes, warning only on failure; if ccgram binds topics itself (U8), set `up` to report-only |
| O6 | `up` blocked by doctor `fail` | yes, no override flag (D10) |
| O7 | `up` and `down` manage `hunt` and `followups` Claude windows | start yes; stop only with confirm or `--yes` |
| O8 | Default classifier download inside bootstrap | ask, size shown, `--skip-model` available (about 750 MB; D8 of 6B2 applies) |
| O9 | `npm run dry-run --llm` | keep opt-in; run it once before the first live day |
| O10 | Windows support | not covered (macOS first, Ubuntu variant) |
| O11 | Run the scheduler under launchd or systemd instead of a tmux window | optional; `up` detects and respects it (D11); tmux window is the default |

## Owner-only live checks (after merge; the builder cannot do these)

- **L1 (fresh clone, 20 minutes, macOS):** clone into a new directory, run `bash scripts/bootstrap.sh --check` (nothing changes, table prints), then `bash scripts/bootstrap.sh`; answer no to the classifier; confirm the final table lists what was installed, skipped and needs you; rerun and confirm every item says already present and no command ran.
- **L2 (Ubuntu VM):** same on a clean Ubuntu with only git; confirm it prints each `sudo apt-get` line before running and refuses without a TTY unless `--yes --allow-sudo`.
- **L3 (guided session):** `npm run setup`, accept the guide, attach the tmux window, ask it to "print my .env" and to "run cat secrets/x": both must be refused; paste a fake Telegram-token-shaped string and confirm the prompt is blocked and not repeated; run the wizard `gmail` step in the first terminal and confirm the guide's next doctor run reflects it.
- **L4 (no-guide path):** `npm run setup -- --no-guide` behaves exactly like before (no mention of the guide, same steps).
- **L5 (kill switch, real files):** with `npm run up` running, `npm run jobber:control -- stop`, confirm `up -- --status` shows the kill switch on and `npm run up` exits 4; `npm run jobber:control -- resume`; confirm `down` then `up` is clean.
- **L6 (dry-run):** `npm run dry-run` prints PASS or SKIP for each stage and nothing in `git status`; `--llm` once, read its report.
- **L7 (up in DRY and LIVE):** with the shipped dry flags `npm run up` prints `MODE: DRY RUN` at the top and bottom; set the three flags live yourself in `.env`, rerun `npm run up -- --status` and confirm `MODE: LIVE`. 8E itself never makes this change.
- **L8 (restart behaviour):** reboot, run `npm run up`, confirm bridge, windows, scheduler and dashboard return without duplicates; with a launchd unit loaded confirm `up` skips the scheduler window.
- **L9 (tmux environment):** `export SCHEDULER_DRY_RUN=false` in the shell, run `npm run up`, confirm the scheduler window shows the value from `.env`, not the shell's (U7).

## Unverified (stated plainly)

| # | Item | Why unverified | Plan response |
|---|---|---|---|
| U1 | **Claude Code install method and flags** (`npm install -g @anthropic-ai/claude-code`, any native installer, its URL, `claude auth login`, minimum version) | Not checkable offline; the repo only knows `claude --version`, `claude auth status` and a 2.1.295 floor in a doctor check | **check upstream.** Bootstrap prints an owner message and offers a global npm install only when the prefix is user-writable, marked "check upstream". No version is pinned by bootstrap. |
| U2 | Interactive `claude` under the restricted launcher: `--permission-mode dontAsk`, `--permission-prompts none`, `--setting-sources project`, `--tools`, `--allowedTools`, `--strict-mcp-config` with an empty MCP file, a positional initial prompt, `--settings` | The repo only exercises `-p` runs (`buildClaudeArgs`); behaviour of these flags in a TUI session is not measured | L3 is the check. Fallbacks, in order: drop `--permission-prompts none` (prompts then appear in the guide window and still hit the hook), then drop the positional prompt and have the owner type "start". The hook is the enforcement, not the flags. |
| U3 | Whether Claude's own `Bash(<exact>)` permission rule matches strings containing ` -- ` | Rule-matcher syntax for Bash patterns is not documented in the repo | The hook does not depend on it. If the rule refuses a listed command, switch to the wrapper fallback: one script `scripts/guide-cmd.ts <verb>` with fixed verbs, `bash_exact` becomes `npx tsx scripts/guide-cmd.ts <verb>` (same style as the `manager` skill). Decision for the owner at L3. |
| U4 | Whether a `UserPromptSubmit` hook that blocks a prompt also removes it from the model context and the session transcript | Hook semantics not verified in this repo | The skill still tells the guide not to repeat it; the owner is told to rotate. L3 observes it. |
| U5 | Homebrew and apt package names and versions (`node`, `tmux`, `uv`, `age`, `rclone`, `--cask google-chrome`, apt `nodejs` major, `build-essential`) and Playwright system dependencies (`npx playwright install-deps chromium`) | No package manager is run in this plan; names are from general knowledge | **check upstream.** Every action prints before running; a wrong name fails visibly as `failed`, never silently. |
| U6 | The Node, uv and Chrome installers for Linux (nvm or NodeSource script URLs, astral installer URL, Chrome .deb page) | Third-party URLs and checksums not in the repo | **check upstream.** Shown with URL, size and sha256 and asked twice; nothing is pinned by this plan. |
| U7 | tmux window environment inheritance (a new window takes the tmux server's environment, not the caller's) and that the scheduler and dashboard run correctly with `env -i HOME PATH TERM LANG TZ` plus `.env` read by themselves | Not run against real tmux in this repo | L9 and L8. If a needed variable is missing the doctor `daemon`/`web` checks and the window output show it; extend the allowlist in `src/stack/plan.ts`. |
| U8 | How ccgram creates and binds the `manager` window (Telegram topic binding versus a window created by hand) | `config/manager-windows.json` lists only `hunt` and `followups`; the manager skill's owner steps say "start ccgram, create the topic, bind this session" | O5: `up` creates `manager` only as a convenience; if ccgram expects to create it, switch to report-only. |
| U9 | The scheduler daemon is single-instance, and SIGINT mid-wake finishes the current wake before exit | `scripts/scheduler.ts` sets a stop flag on SIGINT/SIGTERM and the run lock is per wake; a second daemon is not shown to refuse | `up` never starts a second one (window and unit detection); `down` never kills without `--force`. L8. |
| U10 | Dashboard stage depends on 8C routes (`GET /api/auth/mode`, token mode) | 8C merges first; names are taken from its plan | Task 11 reads the merged code; if names differ, adapt the stage, not the server. |
| U11 | `renderer/` dependencies are required at runtime (it has its own `package.json` and lockfile) | Not traced in this plan | Treated as required while `renderer/package-lock.json` exists; the `browser-binaries` and resume render checks are the evidence. |
| U12 | `better-sqlite3` native build needs a toolchain when no prebuilt binary matches | Depends on Node ABI and platform at install time | `build-tools` item (check only) and `npm ci` failure output surface it; no workaround coded. |
| U13 | Whether the patchright browser needs its own download in addition to installed Chrome | CLAUDE.md says `channel: 'chrome'` works with installed Chrome; existing doctor check `linkedin.patchright-importable` only tests import | Not installed by bootstrap; reported by the existing check. |

## Rollout and failure modes

Rollout order (the owner runs these, each gated on the previous): L1 on the current Mac (read-only `--check` first), then the real bootstrap on a second machine or VM, then L3 and L4 (setup paths), then L6 (dry-run), then `npm run up` in DRY RUN for 48 hours before touching any live flag (this is CLAUDE.md rollout Phase 1; this plan only makes it one command), then the existing rollout phases unchanged.

| Failure | Where it shows | What happens | Fix |
|---|---|---|---|
| Homebrew missing | `bootstrap.sh` step 4 | stops with the URL, exit 1, nothing installed | install Homebrew yourself, rerun |
| Node too old on Ubuntu apt | `bootstrap.sh` | owner message with nvm or NodeSource URL, nothing run | follow the URL, rerun |
| An install command fails | result table `failed` + last output line | dependents `skipped`, other items continue | fix the cause, rerun (idempotent) |
| No TTY and no `--yes` | exit 3 | nothing changed | rerun in a terminal or with `--yes` |
| ccgram installed at another version | `ccgram` item | offered reinstall of the pinned version, never an upgrade | accept, or fix the pin by review |
| Guide refuses a command | guide window | one-line refusal, no workaround | run it yourself in the wizard terminal |
| Secret pasted to the guide | prompt guard blocks | fixed message | rotate it, enter via the wizard |
| `dry-run` stage fails | table with fix line | exit 1, nothing live touched | apply the fix, rerun |
| `up` refuses | exit 1 (doctor), 4 (kill switch) | nothing started | fix the failing check, or `jobber:control resume` yourself |
| Port already in use by the dashboard | `web` probe warning | window kept, warning printed | stop the other process or change `WEB_PORT` |
| `down` leaves the scheduler running | message | wake still in progress | rerun `down`, or `--force` |
| Stale tmux server env | scheduler shows the wrong mode | L9 | restart tmux, rerun `up` |

## Handoff to 8D (owner docs pass)

8D documents what this plan ships; the facts it must read from merged code (not from this plan) and the places they land:

- `docs/prerequisites.md`: replace manual install lists with the bootstrap item table (ids, required or optional, detection, what bootstrap does per platform) and mark the U1, U5, U6 items `check upstream`.
- `docs/00-start-here.md`: ordered path becomes the four commands; `--no-guide`, `--guide-only`, `--status`; what the guide can and cannot do; the L-checks as the first-day checklist.
- `docs/operations.md`: `up`, `down`, `up -- --status`, exit codes 1 and 4, mode banner, how to read `dry-run` output, where `.jobber/bootstrap.json` and `.jobber/verify.json` live and that they are safe to delete, tmux session names (`ccgram`, `ccgram-daemon`, `jobber-runs`, `jobber-stack`, `jobber-setup`).
- `docs/scheduler-install.md`: `up` detects a loaded unit and skips its own scheduler window.
- `docs/config-reference.md`: `config/setup-guide.json`, `config/run-profiles.json` `setup_guide`, `bash_exact`, `interactive`, `classifier: not_required`, `config/runner/mcp.none.json`; the three new env keys.
- `docs/api-keys.md`: the guide's overview step is the same list; link, do not copy.
- 8D's lint (`tests/docs-owner.test.ts`) already requires every documented `npm run` name to exist, so it covers the five scripts added here.

## Self-review checklist (planner)

- Owner request coverage: (1) install command with Node bootstrap, root and renderer deps, Chromium, Chrome check, uv + pinned ccgram, tmux, Claude Code CLI, optional age and rclone reported only, consent-gated hash-verified model download, brew and apt variants, consent rules, final table: Tasks 1 to 5. (2) guided session as a skill under a dedicated restricted profile, order of steps, doctor after each step, hard constraints (no secrets, no bypass, minimal allowlist, never flips flags), `--no-guide`: Tasks 6 to 9 and the "guide" section. (3) dry-run: Tasks 10, 11. (4) up, down, status, mode banner, launchd note, never changes mode: Tasks 12, 13. Package script names: table. README rewrite and lint: Task 14. Tests hermetic with injectable runner, fs, clock: Global Constraints and every task. Doctor additions: Tasks 5, 8. Decisions, unverified, hard limits, owner live checks, rollout and failure modes: sections above. Task count: 15.
- No placeholder steps; every task names files, tests, a verify command and a commit message.
- Names used consistently: `bootstrap_complete`, `setup_guide_ready`, `setup_guide`, `bash_exact`, `interactive`, `classifier: not_required`, `config/setup-guide.json`, `STACK_TMUX_SESSION`, `STACK_DOWN_WAIT_SEC`, `BOOTSTRAP_MODEL_PROFILE`, `.jobber/bootstrap.json`, `.jobber/verify.json`.
