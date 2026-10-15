# Plan 8F: setup modes (agent-supported or terminal-only) and optional steps (Telegram and dashboard skippable)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per project preference, dispatch every subagent with `model: sonnet`, one task at a time, review gate after each task.

**Goal:** `npm run setup` offers the owner two ways through the same wizard, chosen once and remembered, and lets the owner skip the two recommended-but-not-required integrations (Telegram and the web dashboard) without anything downstream breaking:

```
npm run setup                       # first run: asks "agent-supported or terminal-only?", remembers it
npm run setup -- --mode terminal    # switch (and remember) the mode
npm run setup -- --step telegram    # offered again, and still works later
```

- **Agent-supported** is the plan 8E guide: a second window with a coach that reads the doctor and explains each step; the wizard in the owner's terminal stays terse.
- **Terminal-only** is a walkthrough where the terminal itself explains every value, says where to get it, asks "done? [y/N]" after each manual action outside the terminal, re-explains on no, hides every secret, and verifies the result (test message, doctor check) before moving on.
- **Skipping** Telegram or the dashboard shows a RECOMMENDED label and one or two plain lines on what is lost, records the skip in the setup state, makes the doctor report `skip` (never `fail`), and makes `up`, `dry-run` and the doctor gate cope (no bridge when Telegram is skipped, no web window when the dashboard is skipped).

None of this changes a dry-run flag, a permission set, the allow list, a halt, the kill switch, or any limit. Safety-critical steps (classifier before live, permission set) stay non-skippable for live.

**Architecture:** one new pure module `src/setup/skips.ts` (the skippable catalog, the "is it configured" rule, the doctor wrapper) shared by the wizard, the doctor list, `up` and `dry-run`, so there is exactly one definition of "skipped"; one new helper module `src/setup/coach.ts` (skip offer, done-confirm loop, coaching text catalog) used by steps; a small additive state field `mode`; a rewritten `telegram` step; skip offers and walkthroughs added to `gmail` and `dashboard`; a new optional `apikeys` step (today nothing in the wizard asks for the Adzuna, Serper or Hunter keys). No new dependency, no new env key.

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffixes), vitest, the existing `scriptedIO` and `redactingIO` test doubles.

**Builds on:** `2026-10-15-8c-dashboard-simple-login.md` (merged: token default, `WEB_AUTH_MODE`, `scripts/dashboard.ts token`) and **`2026-10-15-8e-bootstrap-guided-setup-run-all.md` (this plan is cut from main AFTER 8E merges; it extends 8E and must not duplicate it)**. Plan 8D (owner docs pass) merges after this plan: see "Docs hooks for 8D".

**Spec:** `docs/superpowers/specs/2026-10-14-platform-sessions-dashboard-setup-requirements.md` (setup, sessions, one credentials file stay binding). Format follows `2026-10-15-8c-dashboard-simple-login.md` and `2026-10-15-8e-bootstrap-guided-setup-run-all.md`.

## Exact 8E artifacts this plan depends on (read from the merged code, not from this plan)

Read from the 8E branch `bootstrap-8e` as committed at planning time; names are the ones to verify after merge, and a rename means adapt this plan's tasks, not 8E.

| 8E artifact | What this plan uses | Task |
|---|---|---|
| `src/setup/guide.ts` | `offerGuide(d: GuideDeps)` (offer, `guide_offered`, tmux spawn), `GUIDE_CHECK_IDS`, `GUIDE_LAUNCHER`, `runGuideOnly`, `formatStatus(stepIds, state)` | 3 |
| `src/setup/cli.ts` | `parseArgs` fields `noGuide`, `guideOnly`, `status`, the `--guide-only` with `--no-guide` usage error, `USAGE` | 3 |
| `src/setup/state.ts` | `SetupState.guide_offered?` (the pattern for an additive optional field) | 1 |
| `scripts/setup.ts` | the `--status` early exit, the `--guide-only` early exit, the `offerGuide` block before `runSetup`, `args.redo` resetting `guide_offered` | 3 |
| `config/setup-guide.json`, `.claude/skills/setup-guide/SKILL.md` | step list and `keys`, `fixes`, `doctor_checks` per step; the skill's order and hard rules | 7, 9 |
| `src/platform/checkLists.ts` | `allDoctorChecks()`, the one list used by `scripts/doctor.ts`, the dry-run `doctor` stage and `up` | 2 |
| `src/platform/checksGuide.ts` | `setupGuideChecks()` / `setup_guide_ready` (must stay passing when `config/setup-guide.json` gains a step) | 7 |
| `src/stack/up.ts` | step 4 (bridge skipped when `TELEGRAM_BOT_TOKEN` is empty), step 5 (windows), step 7 (`web` window and probe), the doctor gate (refuses on any `fail`) | 9 |
| `src/verify/stages.ts` | the `dashboard-login` stage (skippable, skips when `/api/auth/mode` is absent) | 9 |
| `tests/setup-guide-offer.test.ts`, `tests/setup-guide.test.ts` | extended, not replaced | 3, 7 |

## What exists today (read from the repo, not assumed)

| Piece | Today (main, plus 8E where marked) | Gap this plan closes |
|---|---|---|
| Skip in the wizard | A step may return `'skipped'`; the runner records `state.steps[id] = {status:'skipped', at}`, shows it as skipped in the totals, and asks again next run (a skipped step never gates; `src/setup/runner.ts`). A failed step offers "Retry?" then "Skip this step?" | No step offers a skip up front with a reason; the record is not read by anything outside the wizard |
| Doctor | `ccgram-env` and `telegram-api` FAIL without a token; `daemon` WARNs; `dashboard-login` already PASSes with "not configured (off)"; `web` passes. Check status `skip` exists and never affects the exit code | A user who deliberately skipped Telegram gets FAILs, and 8E `up` refuses on any `fail` |
| `up` (8E) | Skips the bridge when `TELEGRAM_BOT_TOKEN` is empty, but the doctor gate has already refused on `ccgram-env`; always starts windows and `web` | Cannot start with Telegram skipped; starts a web window with no login configured |
| Telegram step (`src/setup/steps/telegram.ts`) | Prints "open @BotFather, /newbot, copy the token" and one line "enable Topics and turn Group Privacy off"; `askSecret` for the token (validated with `getMe`, URL never logged); existing token reuse; numeric ID by `@userinfobot` or `getUpdates`; extra allowed users behind two confirms; writes `.env`; sends a test message and asks "Did the message arrive?" | No skip, no RECOMMENDED text, no Threaded Mode instruction with a done-confirm and re-explanation, no re-explain when the test message does not arrive |
| Gmail step | Five numbered Cloud Console lines then `pause`; spawns the auth helper after one confirm; no skip; returns `done` even when the consent screen was declined | Not skippable, no done-confirm loop, the declined case is recorded as done |
| API keys | `.env.example` lists `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `SERPER_API_KEY`, `HUNTER_API_KEY`, `HUNTER_ENABLED`; **no wizard step asks for them** (8E's guide facts file files them under `profile`, but the `profile` step does not collect them) | A new owner must hand-edit `.env` for the job source and contact search |
| Dashboard step | Local web keys, one confirm for a token (child prints the URL), existing OIDC kept, Google option; returns `skipped` when the owner declines everything | No RECOMMENDED label or consequence text up front; skip is implicit |
| Sessions step | Per-account confirm "Capture the X session now?", records `answers.session_<name> = 'skipped'` | Already skippable per account: unchanged (coaching text only) |
| Classifier step | Choose a profile, size shown, "Download N MB now?" default no, returns `skipped` when declined; launcher and doctor fail closed in live | Already skippable only in effect for dry; unchanged (a REQUIRED-before-live line only) |
| Access step | Explains the three sets, default `read_only` | Unchanged; stays non-skippable |
| Modes | None. 8E adds `--no-guide` (no offer), `--guide-only`, `--status`, a once-only offer remembered as `guide_offered` | Nothing remembers "terminal-only", nothing makes the terminal prompts self-sufficient, no `--mode` |
| IO | `SetupIO` (`say`, `ask`, `askSecret`, `confirm`, `choose`, `pause`), `redactingIO` (registered secrets and Telegram-token shapes replaced with `[hidden]`), `scriptedIO` (transcript never records a secret answer) | Reused as is; no new IO method |

## Global Constraints

- **Branch:** `plan-8f` (worktree plan); the build branch is cut from main after 8E is merged and rebased. Commit per task with explicit paths, never `git add -A`, never `--no-verify`, never push.
- Never read, print, write or commit `user-data/`, `secrets/`, `.env*` (except `.env.example`), `.dashboard/`, `.jobber/` contents, `data.sqlite`. Tests use temp directories, in-memory fakes (`memFs` as in `tests/setup-steps-basic.test.ts`) and invented values (`1234567890:AAExampleTokenValue_abcdef` style).
- **No test, and no step in this plan, installs a package, downloads a file, opens a browser, calls the network, starts tmux or an MCP server, or runs a real `claude`.** Every external effect goes through the injected `ctx.fetch`, `ctx.run`, `ctx.spawnInteractive`, `ctx.fs`, `ctx.now`.
- **Test baseline before and after EVERY task:** `npx tsc -p . --noEmit` clean; `npx vitest run` shows exactly the 5 known failures (4 in `tests/renderChecked.test.ts`, 1 in `tests/resume.test.ts`) and nothing else.
- **Secrets:** every secret is entered only with `io.askSecret` (hidden, never echoed), written once through `updateEnvText`/`writeEnvFile`, and never reaches `say`, a transcript, state, argv, the child environment or an error string. Any new URL that carries a key (Telegram, Adzuna, Hunter) is never logged and a thrown network error is replaced by a fixed message (the pattern in `scripts/setup.ts` `realFetch` and `telegram.ts` `getMeOk`).
- A skip never edits `.env` to delete a value, never clears a halt, never flips a dry flag, never changes a permission set. Skipping is recorded in `user-data/.setup-state.json` only.
- No new env key and no new daily counter. `HUNTER_ENABLED` stays `false` unless the owner says yes at an explicit prompt.
- State schema stays `version: 1`; new fields are optional and ignored by older readers (8E `loadState` copies only known fields: an older binary that rewrites the file drops `mode`, which only re-asks the question).
- Do not edit `CLAUDE.md`, `README.md` or `docs/*.md` before Task 10 (project preference: batch doc edits). Config, skill and `.env.example` changes ARE behaviour and go in the task that changes behaviour.
- Match surrounding style: file header comment `// src/...`, `.js` import suffixes, tests in `tests/*.test.ts`, one file with `npx vitest run <file>`. All user-facing text is ASCII with no em or en dashes.

## Review Focus

1. **One definition of skipped (Tasks 1, 2, 9):** wizard, doctor, `up` and `dry-run` all call `src/setup/skips.ts`; a grep test proves `src/stack` and `src/verify` do not re-derive it.
2. **A skip never hides a real fault (Tasks 1, 2):** the doctor wrapper converts `fail`/`warn` to `skip` only while the feature is unconfigured. A configured-but-broken Telegram token still FAILs even if the owner once skipped.
3. **The wrapper cannot touch a safety check (Task 2):** it works on a closed allowlist of check ids; a test asserts the classifier, permission, hooks, gitignore, limits, kill-switch and resume check ids are never in it.
4. **Secrets in the new prompts (Tasks 4 to 7):** transcript tests over every new flow with an invented token, an Adzuna key and a Serper key assert none appears in any `say`, prompt, `invalid:` line or state file.
5. **Modes are verbosity, not behaviour (Task 3):** the same steps, same writes, same verification in both modes; only the amount of text differs. A test runs a step in both modes and compares the `.env` result.
6. **Backward compatibility (Tasks 1, 3):** a state file written by 8E (no `mode`) loads; `--no-guide`, `--guide-only`, `--status` behave as 8E specified.
7. **Re-offer (Tasks 5, 6):** a skipped step is asked again on the next plain `npm run setup`, and `--step telegram` runs the full flow regardless of the record.

## Decisions (accepted here, with cost if wrong)

| # | Decision | Cost if wrong |
|---|---|---|
| D1 | Two modes are verbosity and entry-point only. **Agent**: after the choice, run 8E's guide launch and keep the wizard prompts terse (today's text). **Terminal**: no guide, and every step prints a coaching block (what it is, where to get the value, what to do outside the terminal) before it asks. The set of prompts that change state is identical. | Two text paths to keep in step; a lint test pins that every coached step id exists in `ALL_STEPS`. Low. |
| D2 | The choice is asked once at the start of a plain `npm run setup` (no `--step`, TTY) when `state.mode` is unset, stored as `state.mode` with a timestamp, and changed only by `--mode agent|terminal` (which also persists). `--no-guide` (8E) means "terminal text and no guide this run" and is NOT persisted. `--guide-only` never touches the mode. | An owner who passed `--no-guide` forever is asked once; answering terminal ends it. Low. |
| D3 | An owner whose 8E state has `guide_offered: true` and no `mode` is asked the mode question once (default terminal when they declined the guide, which we cannot tell apart, so default is `terminal` always). | One extra question after upgrade. Low. |
| D4 | The agent choice is the consent for the guide: 8E's confirm inside `offerGuide` is not asked a second time. `offerGuide` is split into the checks-and-confirm part and a `launchGuide(d)` part (8E file, small change); the existing confirm path and `--no-guide` behaviour are unchanged for callers that do not pass the mode. | A refactor of an 8E file; covered by the 8E tests staying green and by new tests. Low. |
| D5 | A "skip" is recorded as the existing `state.steps[id] = {status:'skipped', at}` (no new field). The doctor honours it only while the feature is unconfigured (D6). Error-skips and owner-skips look the same; both mean "not set up". | The doctor line says "skipped in setup" for an error-skip too; acceptable and still true. Low. |
| D6 | "Configured" per skippable (Task 1 table): Telegram when `TELEGRAM_BOT_TOKEN` is non-empty in the process env or `.env`; dashboard when any of `WEB_AUTH_MODE`, `WEB_OIDC_CLIENT_ID`, `DASHBOARD_ALLOWED_EMAIL` is set; Gmail when the OAuth keys file exists; API keys per key. A configured feature is judged by its normal checks regardless of the record. | A half-configured Telegram (token typed, ID missing) is judged as configured and FAILs honestly. Intended. |
| D7 | Telegram skipped means: no bridge start, and no `hunt`/`followups`/`manager` windows from `up` (those windows exist to be driven from Telegram topics; the owner starts a hunt with `./run-hunt.sh`). Dashboard skipped means: no `web` window. Both are printed as `skipped (setup)` rows in the `up` table, not warnings. | Someone who wanted local tmux windows without Telegram gets none; one line in the table says how (`npx tsx scripts/manager.ts start hunt`). Low to medium (open decision O4). |
| D8 | Telegram setup order in terminal mode: skip offer, BotFather bot creation (done-confirm), token (hidden, `getMe`), Threaded Mode (done-confirm, optional automatic check), numeric ID, test message and "did it arrive?" (re-explain, up to 3 tries, then offer skip). | The old order was token, ID, test; the new Threaded Mode gate sits between token and ID. Low. |
| D9 | The Threaded Mode check is advisory: if `getMe` returns a topics flag, a `false` re-explains; an absent field is trusted to the owner's "done". Whether the field exists is unverified (U2); the code treats it as optional and never fails on it. | A wrong flag name means the automatic check never triggers; the confirm still gates. Low. |
| D10 | Skippability (owner list): see the table below. Skippable with a RECOMMENDED or OPTIONAL label: `telegram`, `dashboard`, `gmail`, and each key in `apikeys`. Never offered a skip: `prereqs`, `claude`, `access`, `profile`, `limits`, `final`. `classifier` and `resume`: skippable as today, shown as REQUIRED BEFORE LIVE, and never wrapped by the doctor. | An owner who wants to skip `resume` still can (it returns `skipped` today); the doctor keeps its FAIL. Intended. |
| D11 | The new `apikeys` step validates each key with one cheap live call through `ctx.fetch`, best effort: a network failure keeps the key with a warning, an explicit 401/403 rejects it with a re-prompt. The endpoints are unverified (U4) and isolated in one table in the step. | A wrong endpoint rejects a good key; "keep it anyway" confirm after a rejection mitigates. Medium (stated plainly). |
| D12 | New doctor check `api-keys` (warn only, never fail): names unset optional keys by variable name, never a value. Wrapped to `skip` when the `apikeys` step is skipped and the keys are unset. | A new line in the doctor; warn never blocks `up`. Low. |
| D13 | `--status` (8E) gains one header line `mode: agent|terminal|unset` and prints `skipped (recommended)` next to a recommended skip. Step ids and statuses only, no values. | The 8E snapshot test changes. Low. |

### Skippability table (owner request: list each step with its default)

| step | skippable | label at the prompt | default answer | what you lose if skipped | doctor when skipped |
|---|---|---|---|---|---|
| `prereqs` | no (it only prints; never blocks) | none | n/a | n/a | unchanged |
| `claude` | no | none | n/a | nothing can run without Claude Code | unchanged |
| `telegram` | yes | RECOMMENDED | set up now | no phone control (no `/runhunt`, `/status`, `/checkreplies` from Telegram), no Telegram alerts or cap-overrun prompts, legacy-mode follow-ups cannot be approved so none are sent | `ccgram-env`, `telegram-api`, `daemon`: `skip` |
| `gmail` | yes | NEEDED FOR EMAIL OUTREACH | set up now | no cold email or email follow-ups and no reply watching; LinkedIn and Naukri outreach still run | `gmail-oauth`: `skip` |
| `apikeys` (per key) | yes | OPTIONAL | Adzuna and Serper: set up now; Hunter: skip | Adzuna: one job source off (boards, Remotive and Naukri remain); Serper: fewer verified contacts; Hunter: last-resort email lookup stays off | `api-keys`: `skip` |
| `sessions` (per account) | yes (existing) | per account | capture now | that account's channel is off | `sessions`: warn as today |
| `resume`, `profile` | `resume` as today, `profile` no | REQUIRED for matching | n/a | no matching without a base resume | unchanged (fail) |
| `limits` | yes by "keep defaults" (existing) | none | review nothing | defaults apply | unchanged |
| `access` | no | none | `read_only` | n/a | unchanged |
| `classifier` | as today (decline download) | REQUIRED BEFORE LIVE | not now | live LinkedIn and Naukri reads and sends are refused (fail closed); dry runs continue unscreened | unchanged (existing live/dry logic) |
| `dashboard` | yes | RECOMMENDED | set up now | no status page in a browser; `/limits`, `/working`, `/health` and `npm run status` still work | `web`, `dashboard-login`: `skip` when unconfigured |
| `final` | no | none | n/a | n/a | n/a |

Safety-critical, non-skippable for live (enforced by structure, not prose): the doctor wrapper's allowlist has no check of `classifier_*`, `permission-set`, `project-hooks`, `gitignore`, `env-limits`, `env-inline-comments`, `resume-valid`, `profile-valid`, any `scheduler-*`, kill-switch or halt check; the existing launcher and doctor logic (classifier not ready: exit 3; live needs `classifier_wired` pass) is untouched.

## State schema change (additive, backward compatible)

```ts
// src/setup/state.ts (after 8E)
export type SetupMode = 'agent' | 'terminal';
export interface SetupState {
  version: 1;                       // unchanged
  steps: Record<string, { status: 'done' | 'skipped'; at: string }>;   // unchanged
  answers: Record<string, string | number | boolean>;                  // unchanged, non-secret only
  guide_offered?: boolean;          // 8E
  mode?: SetupMode;                 // NEW: chosen once; set by the chooser or --mode
  mode_at?: string;                 // NEW: ISO time of the choice
}
```
`loadState` accepts `mode` only when it is exactly `'agent'` or `'terminal'` and `mode_at` only when a string; anything else is dropped (never throws). `saveState` is unchanged (`assertNoSecretKeys` still runs on `answers`). No migration step: a file without the fields means "unset". Round-trip, corrupt-file and 8E-file tests are in Task 1.

## Doctor output for skipped steps

| Situation | Doctor line |
|---|---|
| Telegram skipped, no token | `SKIP  bridge credentials in the project .env: skipped in setup (Telegram, RECOMMENDED). No phone control until set up.` + `fix: npm run setup -- --step telegram` (same for `telegram-api`, `daemon`) |
| Telegram skipped but a token was added by hand | normal results (pass or fail): the record is ignored (D6) |
| Dashboard skipped, nothing configured | `SKIP  dashboard login: skipped in setup (dashboard, RECOMMENDED). No status page.` + fix |
| Gmail skipped, no keys file | `SKIP  Gmail OAuth files present: skipped in setup (email outreach is off)` + fix |
| No API keys, step skipped | `SKIP  optional API keys: skipped in setup (Adzuna, Serper)`; not skipped: `WARN ... not set: ADZUNA_APP_ID, ADZUNA_APP_KEY` (names only) |
| Summary line (new, last line of `npm run doctor` text output only; not in `--json`) | `Skipped by choice: telegram, dashboard. Re-enable: npm run setup -- --step <id>` |

`--json` keeps the existing shape (`id, title, status, detail`); skipped checks appear with `status: "skip"`, so the 8E guide and the secrecy corpus see no new field. The exit code is unchanged (`skip` never fails).

## Mode flag set

| Flag | Meaning | Persists | Notes |
|---|---|---|---|
| `--mode agent` | agent-supported: offer or launch the 8E guide, terse prompts | yes (`state.mode`) | needs `claude-cli`, `claude-login`, `setup_guide_ready` to pass for the guide to start; otherwise prints why and runs the wizard in terse mode |
| `--mode terminal` | terminal-only walkthrough, no guide | yes | the default suggestion when the guide is not ready or tmux is missing |
| (none, mode unset, plain run) | chooser prompt once | yes | `choose` with the two options and a one-line description each |
| (none, mode set) | uses the stored mode, prints `mode: <m> (change with --mode)` once | n/a | |
| `--no-guide` (8E) | terminal text this run, no guide | no | combined with `--mode agent` is a usage error |
| `--guide-only` (8E) | start only the guide | no | combined with `--mode terminal` is a usage error |
| `--status` (8E) | adds the `mode:` header line | n/a | works without a TTY |
| `--step <id>` | runs one step in the stored mode (terminal text when unset), no chooser, no guide offer | n/a | `--step telegram` ignores a stored skip |
| `--mode x --list`, `--mode x --status` | usage error (a mode change must run the wizard) | n/a | |

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/setup/state.ts` (modify) | `mode`, `mode_at`, `SetupMode` | 1 |
| `src/setup/skips.ts` (new) | skippable catalog, `isConfigured`, `skippedFeatures`, `withSkips` doctor wrapper, `skipSummary` | 1, 2 |
| `src/platform/checkLists.ts` (modify, 8E file), `scripts/doctor.ts` (modify) | wrap the list; summary line; `api-keys` check | 2 |
| `src/platform/checksApiKeys.ts` (new) | doctor `api-keys` (warn only) | 2 |
| `src/setup/cli.ts` (modify, 8E file), `scripts/setup.ts` (modify, 8E file), `src/setup/guide.ts` (modify, 8E file), `src/setup/mode.ts` (new) | `--mode`, chooser, `launchGuide`, `mode` in `--status` | 3 |
| `src/setup/coach.ts` (new) | `offerSkip`, `confirmDone` loop, coaching text catalog | 4 |
| `src/setup/runner.ts` (modify) | `SetupContext.mode?` | 3 |
| `src/setup/steps/telegram.ts` (modify) | the walkthrough | 5 |
| `src/setup/steps/gmail.ts`, `src/setup/steps/dashboard.ts` (modify) | skip offer, done-confirm, labels | 6 |
| `src/setup/steps/apikeys.ts` (new), `src/setup/steps/index.ts` (modify) | API keys step, step order | 7 |
| `config/setup-guide.json`, `.claude/skills/setup-guide/SKILL.md` (modify, 8E files) | new `apikeys` step, skip facts, mode awareness | 7, 9 |
| `src/setup/steps/{classifier,sessions,access,limits,final,prereqs}.ts` (modify) | terminal-mode coaching text, required-before-live line, skip summary in `final` | 8 |
| `src/stack/up.ts`, `src/verify/stages.ts` (modify, 8E files) | cope with skips | 9 |
| `README.md`, `CLAUDE.md`, `docs/telegram-bot-setup.md`, `docs/gmail-mcp-setup.md` | docs pass (pointers) | 10 |

---

### Task 1: State field and the skip catalog (pure)

**Why:** one place defines what is skippable, what "configured" means, and which doctor checks belong to it.

**Files:**
- Create: `src/setup/skips.ts`, `tests/setup-skips.test.ts`
- Modify: `src/setup/state.ts`, `tests/setup-runner.test.ts` (state round trip cases only)

**Interfaces:**
```ts
export type SkippableId = 'telegram' | 'dashboard' | 'gmail' | 'apikeys';
export interface SkipSpec {
  id: SkippableId;
  stepId: string;                      // key in state.steps
  title: string;
  label: 'RECOMMENDED' | 'NEEDED FOR EMAIL OUTREACH' | 'OPTIONAL';
  lose: string[];                      // one or two plain lines, ASCII, no secrets
  checkIds: string[];                  // doctor ids the wrapper may turn into skip
  configured(env: Record<string, string | undefined>, fs: { exists(p: string): boolean }, root: string): boolean;
}
export const SKIP_SPECS: readonly SkipSpec[];
export function skippedFeatures(input: { state: SetupState; env: Record<string, string | undefined>; fs; root: string }): SkippableId[];
```
Rules (each one `it`):
- `telegram`: `checkIds` `['telegram-api','ccgram-env','daemon']`; configured when `TELEGRAM_BOT_TOKEN` is non-empty.
- `dashboard`: `['web','dashboard-login']`; configured when any of `WEB_AUTH_MODE`, `WEB_OIDC_CLIENT_ID`, `DASHBOARD_ALLOWED_EMAIL` is non-empty.
- `gmail`: `['gmail-oauth']`; configured when the keys file exists (same path resolution as the doctor check: `GMAIL_OAUTH_PATH`, default `./secrets/gcp-oauth.keys.json`).
- `apikeys`: `['api-keys']`; configured when ANY of the three providers is complete (`ADZUNA_APP_ID` and `ADZUNA_APP_KEY`, `SERPER_API_KEY`, `HUNTER_API_KEY`).
- `skippedFeatures` returns an id only when `state.steps[stepId]?.status === 'skipped'` AND `!configured(...)` (D5, D6).
- `lose` lines match the Skippability table text verbatim (a test pins each one: at most two lines, each at most 110 characters, ASCII only, no em or en dash).

State: add `mode`, `mode_at`, `SetupMode` as above.

- [ ] **Step 1: Failing tests:** every rule above with a fake `fs`; telegram skipped plus a token present returns nothing; `state` with an unknown `mode` value loads without it; a file from 8E (no `mode`) loads unchanged; `saveState` writes `mode` and `mode_at` and a secret-looking `answers` key still throws; a state with `mode: 'agent'` round-trips; `lose` lines pass the ASCII/length test.
- [ ] **Step 2: Run, confirm failure:** `npx vitest run tests/setup-skips.test.ts tests/setup-runner.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** `npx vitest run tests/setup-skips.test.ts tests/setup-runner.test.ts tests/setup-suspend.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(setup): additive mode field and a single skippable-feature catalog`

---

### Task 2: Doctor wrapper, `api-keys` check and the summary line

**Files:**
- Create: `src/platform/checksApiKeys.ts`, `tests/platform-checks-skips.test.ts`
- Modify: `src/platform/checkLists.ts` (8E), `scripts/doctor.ts`, `src/setup/skips.ts` (add `withSkips`, `skipSummary`)

**`withSkips(checks, skipped)`:** returns checks of the same ids and titles; for a check whose id is in the allowlist of a skipped feature, `run` calls the real check first and only a `fail` or `warn` result is replaced by `skip(detail, fix)` where detail is `skipped in setup (<title>, <label>). <lose[0]>` and fix is `npm run setup -- --step <stepId>`. A `pass` is kept; a crash stays a crash (the real `runChecks` handles it). The skipped set is computed once per doctor run from `ctx` (state file path `join(userDataDir(ctx.env, ctx.root), '.setup-state.json')`, read through `ctx.fs`, merged env as the existing `mergedEnv` helpers do), never from process globals.

**`api-keys` check:** warn only, never fail; names unset optional keys by variable name; pass when all three providers are complete; detail never contains a value or a length.

**`scripts/doctor.ts`:** wraps `allDoctorChecks()` through `withSkips`; the text output (not `--json`) ends with `Skipped by choice: ...` when any feature is skipped; exit code logic unchanged.

- [ ] **Step 1: Failing tests:** table in "Doctor output for skipped steps" with a fake `DoctorContext`; token present plus skip record keeps the real FAIL; each wrapped id converted only from `fail`/`warn`; **allowlist test:** assert none of `classifier_model`, `classifier_smoke`, `classifier_wired`, `permission-set`, `project-hooks`, `gitignore`, `env-limits`, `env-inline-comments`, `resume-valid`, `profile-valid`, `scheduler-dry-run`, `scheduler-stop-file` appears in any spec's `checkIds`; `--json` shape unchanged; exit code stays 0 when the only non-pass results are skips; `api-keys` output corpus test with invented keys (no value or substring of 8+ chars appears).
- [ ] **Step 2: Run, confirm failure:** `npx vitest run tests/platform-checks-skips.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** `npx vitest run tests/platform-checks-skips.test.ts tests/platform-doctor.test.ts tests/doctor-json.test.ts tests/platform-checks-setup.test.ts tests/setup-guide.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(doctor): report setup skips as skip, add api-keys warn check and a skipped summary`

---

### Task 3: Mode chooser, `--mode`, and the guide launch split

**Files:**
- Create: `src/setup/mode.ts`, `tests/setup-mode.test.ts`
- Modify: `src/setup/cli.ts` (8E), `scripts/setup.ts` (8E), `src/setup/guide.ts` (8E), `src/setup/runner.ts`, `tests/setup-final-and-cli.test.ts`, `tests/setup-guide-offer.test.ts` (8E)

**`src/setup/mode.ts` (pure over deps):**
```ts
export interface ModeDeps {
  io: Pick<SetupIO, 'say' | 'choose' | 'confirm'>;
  state: SetupState; now: () => Date; save(): void;
  flagMode?: SetupMode; noGuide: boolean; interactive: boolean;   // interactive: TTY and no --step
  guideReady(): Promise<{ ready: boolean; why?: string }>;         // 8E GUIDE_CHECK_IDS outcomes + tmux -V
}
export function resolveMode(d: ModeDeps): Promise<SetupMode>;
```
Behaviour: `flagMode` wins, is stored, and prints one line; else stored `state.mode` is used; else `noGuide` or not `interactive` gives `terminal` without storing; else one `choose`: "How do you want to be guided?" with `agent` ("Agent-supported: a Claude coach in a second window explains each step and reads your doctor results; it never sees your keys.") and `terminal` ("Terminal-only: this window explains every value and asks you to confirm each step."), default `agent` only when `guideReady().ready`, else `terminal` with the `why` printed. The answer is stored with `mode_at`.

**`guide.ts` (8E file) split:** extract the tmux part of `offerGuide` into `launchGuide(d)`; `offerGuide` keeps its checks, confirm, `guide_offered` handling and calls `launchGuide`. `scripts/setup.ts`: after the chooser, mode `agent` calls `launchGuide` directly (no second confirm, D4) when not yet launched this machine session (`launchGuide` already returns `already-running`); mode `terminal` skips the 8E offer entirely; `SetupContext.mode` is set for steps. `--redo` still clears `guide_offered` (8E) and does not clear `mode`.

**`cli.ts`:** `--mode agent|terminal` (bad or missing value: `--mode needs agent or terminal`); usage errors listed in the flag table; `USAGE` text updated.

**`--status` (8E):** adds the `mode:` header line and `skipped (recommended)` for a recommended skip (D13).

- [ ] **Step 1: Failing tests:** `resolveMode` table (flag wins and persists; stored wins; no TTY gives terminal and stores nothing; `noGuide` gives terminal and stores nothing; chooser default agent only when ready; default terminal prints the reason; answer stored with `mode_at`; 8E file with `guide_offered: true` and no `mode` asks once); `parseArgs` table (valid values, bad arity, `--mode agent --no-guide`, `--mode terminal --guide-only`, `--mode x --list`, `--mode x --status` all errors); agent mode calls the injected `run('tmux', ['new-session', ...])` once and never `send-keys`, terminal mode records zero tmux calls; both modes yield identical `.env` writes when the `claude` step is stubbed (verbosity-only property, Review Focus 5); 8E tests for `--no-guide`, `--guide-only`, `--status` still pass unmodified except the new header line.
- [ ] **Step 2: Run, confirm failure:** `npx vitest run tests/setup-mode.test.ts tests/setup-guide-offer.test.ts tests/setup-final-and-cli.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** `npx vitest run tests/setup-mode.test.ts tests/setup-guide-offer.test.ts tests/setup-final-and-cli.test.ts tests/setup-runner.test.ts tests/setup-suspend.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(setup): remembered agent or terminal mode with --mode and a launchGuide split`

---

### Task 4: Coach helpers (skip offer, done-confirm loop, text catalog)

**Files:**
- Create: `src/setup/coach.ts`, `tests/setup-coach.test.ts`

**Interfaces:**
```ts
export function coachOn(ctx: { mode?: SetupMode }): boolean;     // true only for 'terminal'
export function say(ctx, id: string): void;                       // prints coach text id when coachOn, nothing otherwise
export function offerSkip(ctx: SetupContext, spec: SkipSpec): Promise<'now' | 'later'>;
export function confirmDone(ctx: SetupContext, o: {
  id: string;                    // text catalog id
  action: string;                // "Create the bot in BotFather"
  explain: string[];             // numbered instruction lines, short
  again: string[];               // the re-explanation, different wording and more detail
  maxRounds?: number;            // default 3
  allowSkip?: boolean;           // after maxRounds offer "skip this step for now?" instead of failing
}): Promise<'done' | 'skip'>;
export const COACH_TEXT: Record<string, string[]>;
```
- `offerSkip`: prints `[<label>] <title>`, the `lose` lines, then `io.choose('Set this up now?', [{now: 'Set it up now'}, {later: 'Skip for now (you can run this step again any time)'}], default per spec)`. The default is `now` for RECOMMENDED and NEEDED; for per-key OPTIONAL items the default comes from the call site (Hunter: `later`). The label text and `lose` lines are printed in BOTH modes.
- `confirmDone`: prints `explain`, then `io.confirm('<action>: done?', false)`. On no, prints `again` (the re-explanation) and asks again; after `maxRounds` no's returns `'skip'` when `allowSkip` else throws a fixed error `step not confirmed` (the runner's existing retry/skip prompt takes over).
- `COACH_TEXT`: the terminal-mode coaching blocks per step id (Task 5 to 8 fill in their entries); a lint test asserts every entry is ASCII, has no em or en dash, no line over 110 characters, and none contains a token shape, `GOCSPX-`, `sk-`, or `=` followed by a value.

- [ ] **Step 1: Failing tests:** `offerSkip` shows label and lines in both modes and returns each choice; `confirmDone` yes first time, no then yes (re-explain printed once), three no's with and without `allowSkip`; the secret transcript lint over `COACH_TEXT`; `say` prints nothing in agent mode.
- [ ] **Step 2: Run, confirm failure:** `npx vitest run tests/setup-coach.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** `npx vitest run tests/setup-coach.test.ts tests/setup-io.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(setup): coach helpers for skip offers, done-confirm loops and walkthrough text`

---

### Task 5: Telegram walkthrough (skip, BotFather, token, Threaded Mode, ID, test message)

**Files:**
- Modify: `src/setup/steps/telegram.ts`, `src/setup/coach.ts` (text entries `telegram.*`), `tests/setup-steps-basic.test.ts` (telegram cases rewritten), `docs/telegram-bot-setup.md` is NOT touched here (Task 10)
- Create: `tests/setup-telegram-walkthrough.test.ts`

**Flow (this is the test script; one `it` per row; "T" means terminal-mode text is printed, other prompts appear in both modes):**

| # | Prompt or text | Behaviour |
|---|---|---|
| 1 | Only when no `TELEGRAM_BOT_TOKEN` is in `.env`: `offerSkip` with label RECOMMENDED and the two `lose` lines ("No phone control: you cannot start a hunt or ask for status from Telegram." / "No Telegram alerts, and email follow-ups cannot be approved, so none are sent.") | `later` returns `'skipped'` before any other prompt; no `.env` write; state records skipped via the runner |
| 2 | T: what Telegram is used for and that the token is a password. Then `confirmDone` "Create the bot in BotFather": (1) open @BotFather and check the verified badge, (2) send `/newbot`, (3) choose a display name and a username ending in `bot`, (4) BotFather replies with a token like `123456789:AA...` | on no: re-explanation (same steps with what to look for, "the reply contains a long token with a colon"); after 3 no's offer skip |
| 3 | `askSecret` "Paste the bot token (input is hidden)" | existing validation (`TOKEN_RE`) and `getMe`; token registered as a secret; "Telegram rejected that token" re-prompts once, then the runner's retry/skip |
| 4 | T and both modes: `confirmDone` "Enable Threaded Mode for the bot": open @BotFather, press its Open button (Mini App), pick your bot, Bot Settings, switch Threaded Mode (may be labelled Topics or Threads) on; Route B for older clients: `/mybots`, your bot, Bot Settings, enable Topics. Re-explanation names both routes and says "the label may differ in your app version". When `getMe` returned a topics flag (U2) and it is `false`, say so and re-ask | on 3 no's: `allowSkip` offers "continue without topics (the bridge needs them for windows)" and records an answer `telegram_topics: 'unconfirmed'` |
| 5 | Existing: keep or enter the allowed numeric user ID (T text: "Message @userinfobot with any text; it replies with your numeric ID. It is 5 to 15 digits."); extra users behind the two existing confirms | unchanged logic and validation |
| 6 | Write `.env` (existing `updateEnvText`) | unchanged; token and IDs never in `say` |
| 7 | Send the test message through `ctx.fetch` then `confirm('Did the message arrive in Telegram?')` | on no or send failure: print "Open your bot and press Start (a bot cannot message you before you start it), then check the ID", retry the send up to 3 times; after that `allowSkip` offers to keep the settings and finish with a warning. Existing hard failure remains only for the non-interactive path |
| 8 | `Next:` line: `bash scripts/ccgram/start.sh` plus, T only, "then send /health to your bot" | unchanged otherwise |

Never-echo/never-log properties (tests): the token is only passed to `askSecret`, `getMe`, `sendMessage` URLs via `ctx.fetch`, `updateEnvText`; the transcript has no token; a validator that throws or a rejected token message has the candidate stripped (existing `redactingIO` behaviour, asserted for the new paths); the thrown network error is the fixed `network request failed`.

- [ ] **Step 1: Failing tests:** every row above in terminal mode and the prompts that remain in agent mode (rows 1, 3, 4, 5 prompts, 7); skip at row 1; re-explain loops (2 and 4); `getMe` topics flag false then true; test message failing twice then arriving; secret-transcript test with the invented token; `.env` content identical in both modes for the same answers; the two existing tests (reuse of a working token, extra user warning) updated for the new prompts only.
- [ ] **Step 2: Run, confirm failure:** `npx vitest run tests/setup-telegram-walkthrough.test.ts tests/setup-steps-basic.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** `npx vitest run tests/setup-telegram-walkthrough.test.ts tests/setup-steps-basic.test.ts tests/setup-coach.test.ts tests/setup-io.test.ts tests/setup-env-writer.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(setup): telegram walkthrough with skip, threaded mode confirm and a verified test message`

---

### Task 6: Gmail and dashboard steps: skip offers and done-confirms

**Files:**
- Modify: `src/setup/steps/gmail.ts`, `src/setup/steps/dashboard.ts`, `src/setup/coach.ts` (`gmail.*`, `dashboard.*`), `tests/setup-steps-accounts.test.ts`, existing dashboard step tests (find with `git grep -l dashboardStep tests`)
- Create: `tests/setup-steps-skip.test.ts`

**Gmail flow (terminal text where marked T):**
1. `offerSkip` (label NEEDED FOR EMAIL OUTREACH; lines "No cold email, email follow-ups or reply watching." / "LinkedIn and Naukri outreach still run."). `later` returns `skipped`.
2. T: where the files go and why (the OAuth client JSON stays on this machine in `secrets/`, the token file is created by the consent screen). Then `confirmDone` per sub-step group: (a) project plus Gmail API enabled, (b) consent screen with yourself as a test user, (c) Desktop-app OAuth client downloaded and saved at the printed path. The existing `pause` becomes the last confirm. Each no re-explains with the console path wording and "the file must be named exactly ...".
3. Existing: chmod, consent screen helper spawn (exact argv and two env keys unchanged).
4. **Verify:** after the helper exits, run the doctor `gmail-oauth` check (keys present and credentials hold a refresh token). A pass prints "Gmail is authorised on this machine". A warn re-explains ("the consent screen did not finish; run this step again") and returns `skipped` instead of `done` (today it returns `done` even then). The wizard still never reads the key or credentials files. A real send test is deliberately not done here (owner live check L5).

**Dashboard flow:** after the existing "existing OIDC kept" detection (so an owner with a working login is not asked): `offerSkip` (label RECOMMENDED; lines "No status page in your browser." / "/limits, /working, /health and npm run status still work."); `later` returns `skipped` (no `.env` write of `WEB_AUTH_MODE`). T text explains what the token is, that the URL is shown once by the child process, and that nothing is stored but its hash. The Google option text is unchanged. The local `WEB_PORT`, `WEB_TMUX_*` keys are written only when the owner continues (today they are written first: move the write after the skip offer so a skip leaves `.env` untouched).

- [ ] **Step 1: Failing tests:** gmail skip; done-confirm re-explain; verify pass, verify warn returns `skipped`; helper argv and env keys unchanged (existing assertions); dashboard skip writes no `.env` key; dashboard with existing OIDC asks nothing; token path unchanged in both modes; transcript tests (no token URL in any `say`, which the child prints itself).
- [ ] **Step 2: Run, confirm failure:** `npx vitest run tests/setup-steps-skip.test.ts tests/setup-steps-accounts.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** `npx vitest run tests/setup-steps-skip.test.ts tests/setup-steps-accounts.test.ts tests/setup-steps-basic.test.ts tests/setup-steps-limits-access.test.ts tests/platform-checks-setup.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(setup): skip offers and done-confirms for gmail and dashboard`

---

### Task 7: API keys step (new) and the guide facts

**Files:**
- Create: `src/setup/steps/apikeys.ts`, `tests/setup-apikeys.test.ts`
- Modify: `src/setup/steps/index.ts` (insert `apikeysStep` after `gmailStep`), `config/setup-guide.json` (8E: new step `apikeys`, move the four key entries out of `profile`, add `skip` facts to `telegram`, `dashboard`, `gmail`), `tests/setup-guide.test.ts` (8E, ids and ALL_STEPS count), `tests/setup-final-and-cli.test.ts` (step count)

**Per provider (a table in the step; one prompt group each):**

| provider | what it does (printed, T gets the long form) | where to get it | keys written | default | verification (U4, best effort) |
|---|---|---|---|---|---|
| Adzuna | a job-search API; one of the job sources | developer.adzuna.com (free developer account; check the site for current limits) | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` | set up now | one search request through `ctx.fetch` with `results_per_page=1`; 200 ok; 401/403 rejected |
| Serper | Google search API used to find company contact pages and emails | serper.dev (free credits on signup; check the site) | `SERPER_API_KEY` | set up now | one search with `num: 1` (uses one credit); 200 ok; 401/403 rejected |
| Hunter | last-resort email finder with a monthly credit cap | hunter.io | `HUNTER_API_KEY`, optionally `HUNTER_ENABLED=true` (explicit confirm, default no, mention `HUNTER_MONTHLY_CAP`) | skip | account endpoint (no credit use, unverified) |

Rules: `offerSkip` per provider with label OPTIONAL and its `lose` line; keys entered with `askSecret` (Adzuna ID too, it is cheap to hide); a rejected key re-prompts once and then asks "Keep it anyway? [y/N]" (a network error keeps it with a warning "could not verify, the doctor will say"); existing values in `.env` are reused after one "Keep the existing X?" confirm (value never shown); writes through `updateEnvText` only for changed keys; returns `skipped` when every provider was skipped, else `done`.

- [ ] **Step 1: Failing tests:** each provider skip, set, reuse, rejected-then-kept, network failure kept; `HUNTER_ENABLED` stays unchanged unless the explicit confirm is yes; URLs with keys never logged (transcript and thrown error); `.env` result; the guide facts lint (every `.env.example` key still appears under some step; `apikeys` id exists in `ALL_STEPS`); `setup_guide_ready` still passes.
- [ ] **Step 2: Run, confirm failure:** `npx vitest run tests/setup-apikeys.test.ts tests/setup-guide.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** `npx vitest run tests/setup-apikeys.test.ts tests/setup-guide.test.ts tests/setup-final-and-cli.test.ts tests/platform-checks-skips.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(setup): optional API keys step for Adzuna, Serper and Hunter with skip and verification`

---

### Task 8: Terminal-mode coaching for the remaining steps, and the final summary

**Files:**
- Modify: `src/setup/steps/classifier.ts`, `sessions.ts`, `access.ts`, `limits.ts`, `final.ts`, `claude.ts`, `prereqs.ts`, `src/setup/coach.ts`; tests: `tests/setup-steps-classifier.test.ts`, `tests/setup-steps-limits-access.test.ts`, `tests/setup-final-and-cli.test.ts`, `tests/setup-final-db-mode.test.ts`
- Create: `tests/setup-final-skips.test.ts`

**Per step (terminal mode adds text only; no new state-changing prompt; each already asks everything it needs):**

| step | Coaching text added | Also |
|---|---|---|
| `prereqs` | what each check means, the exact fix verbatim, "or run bash scripts/bootstrap.sh" (8E wording kept) | none |
| `claude` | what "logged in" means and how to log in | none |
| `sessions` | why three separate accounts, what the browser window does, "press Enter when logged in", how long a session lasts (stated as unmeasured) | existing per-account skip text gains the `lose` line |
| `classifier` | what it protects against, size, "REQUIRED BEFORE LIVE: until fetched and pinned, live LinkedIn and Naukri actions are refused", the three follow-up commands | the skip (decline download) message names the consequence |
| `access` | `read_only` recommended and why, no skip | none |
| `limits` | where each cap lives and that defaults are safe | none |
| `final` | after the doctor run: a `Skipped by choice` list (from `skippedFeatures`), the exact re-enable command per item, and a `Not ready for live` list naming open non-skippable items (classifier model or fit, permission set, resume, profile) derived from the same doctor results; the "Next, yourself" lines adapt: no `bash scripts/ccgram/start.sh` or `/health` when Telegram is skipped, no dashboard token line when skipped, and `npm run up` / `npm run dry-run` pointers (8E) | `final` stays `always` and never fails |

- [ ] **Step 1: Failing tests:** each coaching entry prints only in terminal mode (agent transcript is byte-identical to today for these steps); `final` output with telegram and dashboard skipped (no bridge or health line, lists both with commands), with nothing skipped (identical to today plus the pointers), and with classifier open (appears under `Not ready for live`); `final` contains no secret; the exit code is unchanged.
- [ ] **Step 2: Run, confirm failure:** `npx vitest run tests/setup-final-skips.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** `npx vitest run tests/setup-final-skips.test.ts tests/setup-steps-classifier.test.ts tests/setup-steps-limits-access.test.ts tests/setup-final-and-cli.test.ts tests/setup-final-db-mode.test.ts tests/setup-coach.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(setup): terminal-mode coaching for every step and a skip-aware final summary`

---

### Task 9: `up`, `dry-run` and the guide cope with skips

**Files:**
- Modify: `src/stack/up.ts` (8E), `src/verify/stages.ts` (8E), `.claude/skills/setup-guide/SKILL.md` and `config/setup-guide.json` (8E), `tests/stack-up.test.ts`, `tests/verify-stages.test.ts`, `tests/setup-guide.test.ts`
- Create: `tests/stack-skips.test.ts`

**Behaviour (each a test):**
- `up`: both consult `skippedFeatures` (the same module, Review Focus 1). The doctor gate already sees `skip` (Task 2). Telegram skipped: no bridge start, no `hunt`/`followups`/`manager` window creation (D7), table rows `bridge: skipped (setup)` and `windows: skipped (setup)` with `npm run setup -- --step telegram`; configured Telegram: unchanged. Dashboard skipped: no `web` window, no probe, row `web: skipped (setup)`; `STACK` end line lists skipped features once. `up -- --status` prints the same rows and stays read-only. The mode banner and kill-switch refusal are untouched.
- `dry-run`: the `doctor` stage already gets wrapped checks (the list is `allDoctorChecks`). The `dashboard-login` stage returns `skip` with "dashboard skipped in setup" when the feature is skipped and unconfigured, before starting a server. No other stage changes (Telegram is not exercised by dry-run).
- **Mode-immutability grep test (8E's, extended):** `src/setup/skips.ts` and the new `up`/`stages` code contain no write to a dry flag, halt API or permission file.
- **Guide facts:** the skill and `config/setup-guide.json` tell the guide that Telegram, dashboard, Gmail and API keys may be skipped by the owner, that a `skip` doctor line for them is expected and not a problem, to say the `lose` text, to name `npm run setup -- --step <id>`, and that the guide never skips anything for the owner (the guide cannot run the wizard). The `allowed-tools` list is unchanged (`setup_guide_ready` equality check stays true); `npm run setup -- --status` is already in `bash_exact` and now shows the mode.

- [ ] **Step 1: Failing tests:** `up` with each of {both configured, telegram skipped, dashboard skipped, both skipped, telegram skipped but token present} against the in-memory tmux fake: exact calls recorded; `--status` read-only; verify stage skip; grep test; guide lint.
- [ ] **Step 2: Run, confirm failure:** `npx vitest run tests/stack-skips.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** `npx vitest run tests/stack-skips.test.ts tests/stack-up.test.ts tests/stack-mode.test.ts tests/verify-stages.test.ts tests/verify-engine.test.ts tests/setup-guide.test.ts tests/definitions-lint.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(stack): up and dry-run honour setup skips; guide facts know about optional steps`

---

### Task 10: Docs truth pass (pointers) and the 8D handoff

**Files:**
- Modify: `README.md`, `tests/readme.test.ts`, `CLAUDE.md`, `docs/telegram-bot-setup.md`, `docs/gmail-mcp-setup.md`

**README:** the "Quick start" keeps 8E's four commands; add one sentence each for the two modes and `npm run setup -- --mode agent|terminal`, and one sentence that Telegram and the dashboard may be skipped (RECOMMENDED) and re-run with `--step`. "What setup does" gains `apikeys` between `gmail` and `sessions` and the skip notes on `telegram`, `gmail`, `dashboard`. Lint (extends 8E's): the README names `--mode`, `apikeys`, `RECOMMENDED`; every `--step` id mentioned exists in `ALL_STEPS`.

**CLAUDE.md (facts only, no rule moved):** "Platform and sessions" scripts line gains `setup -- --mode agent|terminal`; one paragraph "Setup modes and optional steps" (modes, the skip record, the doctor `skip` rule and its configured-wins exception, what `up` does when skipped); the wizard step count (12 becomes 13 with `apikeys`) wherever it is stated. No change to Safety rules. Known limits gains the U items below that apply, as "unverified until owner live check Ln".

**docs/telegram-bot-setup.md:** rewrite the "quickest route" paragraph to the terminal-mode flow, state that Threaded Mode is now an explicit confirm, keep the unverified notes on BotFather labels. **docs/gmail-mcp-setup.md:** one pointer line plus the skip consequence.

- [ ] **Step 1: Failing tests, then edit.** `npx vitest run tests/readme.test.ts tests/definitions-lint.test.ts`.
- [ ] **Step 2: Verify:** `npx vitest run tests/readme.test.ts tests/definitions-lint.test.ts tests/dash-docs.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 3: Commit:** `docs: setup modes, optional steps and skip behaviour in README, CLAUDE.md and runbooks`

---

## Final verification (after Task 10)

```bash
npx tsc -p . --noEmit
npx vitest run
git grep -nE "JOBBER_DRY_RUN|SCHEDULER_DRY_RUN|LINKEDIN_DRY_RUN|applyResume|applyStop" -- src/setup/skips.ts src/setup/coach.ts src/setup/mode.ts src/setup/steps/apikeys.ts
git grep -nE "TELEGRAM_BOT_TOKEN|api_key|app_key" -- src/setup/coach.ts config/setup-guide.json
git status --short
```
Expected: exactly the 5 known failures; the first grep shows nothing (the setup code never touches a mode flag); the second shows only variable NAMES, never values; `git status` shows only intended paths and nothing under `secrets/`, `user-data/`, `.env*`, `.jobber/`.

## Hard limits for the builder

1. Do not read `secrets/`, `user-data/`, `.env*`, `.dashboard/`, `.jobber/` contents or `data.sqlite`. Fixtures and invented values only.
2. No network, no install, no download, no real tmux, no real `claude`, no browser; every effect behind an injected seam. Never call a real Telegram, Adzuna, Serper or Hunter endpoint, even to "check" it.
3. Do not weaken or reorder any safety gate: classifier launch check, permission sets, kill switch, halts, dry-run precedence. The doctor wrapper's allowlist (Task 2) is closed; do not add a check id to a spec without an owner decision.
4. A skip never deletes or blanks an `.env` value, never writes a dry flag, never calls `jobber:control`, never changes a permission set.
5. Do not add a new `SetupIO` method; compose `say`, `ask`, `askSecret`, `confirm`, `choose`, `pause`.
6. Do not change the shape of `doctor --json` or the exit code rules.
7. Do not edit 8E files beyond the changes named in the tasks (`launchGuide` split, `--mode`, status header, `up` and `stages` skip handling, guide facts); keep every 8E test green.
8. Do not edit `CLAUDE.md` or `README.md` before Task 10. Commit only the listed paths. Never push, never `--no-verify`.
9. If a step needs a decision this plan does not make, stop and ask. Anything marked UNVERIFIED stays marked in code comments and docs.

## Owner decisions (recommended defaults)

| # | Question | Recommended |
|---|---|---|
| O1 | Default mode when the guide is ready | `agent` in the chooser, `terminal` otherwise (D2) |
| O2 | Is `--no-guide` persisted | no, per run (D2) |
| O3 | Skippable set | Telegram, dashboard, Gmail, each API key; nothing safety-critical (D10) |
| O4 | `up` creates ccgram windows when Telegram is skipped | no (D7); set yes only if you want local-only windows |
| O5 | Hunter default in the keys step | skip, and `HUNTER_ENABLED` stays false (D11) |
| O6 | Treat Gmail as RECOMMENDED instead of NEEDED | keep NEEDED FOR EMAIL OUTREACH; email is the only channel for cold email |
| O7 | Ask the mode question again after upgrading from 8E | yes, once (D3) |
| O8 | Re-offer skipped steps on every plain `npm run setup` | yes (existing runner behaviour); `--status` shows what is skipped |

## Owner-only live checks (after merge; the builder cannot do these)

- **L1 (terminal Telegram):** `npm run setup -- --mode terminal --step telegram`: answer no to "done?" once at BotFather and once at Threaded Mode and read the re-explanations; paste the token (confirm nothing is echoed and the screen never shows it); confirm the test message arrives; try a wrong ID and confirm the retry text.
- **L2 (skip Telegram, then run everything):** choose skip at Telegram, finish setup; `npm run doctor` shows `SKIP` (not `FAIL`) for the three Telegram lines and the summary line; `npm run dry-run` has no Telegram failure; `npm run up` prints the bridge and windows as skipped and starts the scheduler and web.
- **L3 (re-enable):** `npm run setup -- --step telegram` after L2 runs the full flow; `npm run doctor` goes back to normal results; `npm run up` starts the bridge.
- **L4 (skip dashboard):** skip it; `npm run up` starts no `web` window; `/limits` and `npm run status -- health` still work.
- **L5 (Gmail verify):** after the consent screen the verify line passes; then send one real test email yourself with the system still dry/live per your own decision (this plan sends nothing).
- **L6 (mode switch):** `npm run setup -- --mode agent` then `--mode terminal`; `npm run setup -- --status` shows the mode; confirm `--no-guide` does not change it.
- **L7 (API keys):** enter one real Adzuna key and one deliberately wrong Serper key; confirm the wrong one is rejected with the keep-anyway confirm, and that `npm run doctor` `api-keys` names only variable names.
- **L8 (8E regression):** `npm run setup -- --guide-only` and `--status` behave as 8E specified.

## Unverified (stated plainly)

| # | Item | Why unverified | Plan response |
|---|---|---|---|
| U1 | BotFather's current Threaded Mode / Topics label and path (Mini App versus `/mybots`) | Not checkable offline; the repo's runbook already marks it unverified | Both routes printed, "use the label BotFather currently shows"; never gates on a label |
| U2 | Whether `getMe` returns a topics or threaded-mode flag for a bot, and its name | Not checkable offline | Read optionally (several plausible names are NOT guessed in the plan: the builder reads upstream Bot API docs and keeps the field name in one constant, or drops the automatic check); absence never fails |
| U3 | Whether ccgram needs Threaded Mode in a private chat or a forum supergroup | The runbook says check upstream ccgram docs | Telegram step text says "topics enabled"; `docs/telegram-bot-setup.md` keeps its caveat |
| U4 | Adzuna, Serper and Hunter verification endpoints, the credit cost of one check, and free-tier limits | Not checkable offline | Isolated table in `apikeys.ts`; best effort; a rejection offers keep-anyway; limits are "check the site", never stated as numbers |
| U5 | Hidden input (`askSecret`) behaviour in a real terminal on this machine | Covered by `ttyIO` unit tests with streams, not by a live TTY run | L1 |
| U6 | That a skipped Telegram is safe for every consumer of `TELEGRAM_BOT_TOKEN` (`src/platform/notify.ts` returns `telegram not configured`; `run.sh`, `claude-session.sh`, `start.sh` read it) | Traced by reading, not by running | `up` never starts the bridge when skipped; owner check L2 |
| U7 | Hunter credit use of its account endpoint | Not checkable offline | The check may be dropped by the builder; Hunter has no live verification in that case (documented) |
| U8 | The 8E names in "Exact 8E artifacts" after the 8E rebase onto the 8C-merged main (the 8E branch `dashboard.ts` predates 8C) | 8E was in progress at planning time | The builder re-reads the merged files; a rename changes this plan's text, not 8E |

## Docs hooks for 8D (owner docs pass; 8D merges after this plan)

8D documents what this plan ships. Facts it must read from merged code, and where they land:

| Doc | Change |
|---|---|
| `docs/00-start-here.md` | the ordered path adds "pick agent-supported or terminal-only"; `--mode`; what RECOMMENDED means; "you can skip Telegram and the dashboard and add them later" with the exact `--step` commands; the L-checks as day-one items |
| `docs/prerequisites.md` | a Telegram account and a Google Cloud project are needed only if you do not skip those steps |
| `docs/api-keys.md` | the `apikeys` step per provider (what it does, where to get it, what you lose without it, default); links, no copied numbers (limits are "check the site") |
| `docs/operations.md` | doctor `skip` lines and the `Skipped by choice` summary; `up` table rows for skipped features; `npm run setup -- --status` mode and skip display; how to re-enable |
| `docs/config-reference.md` | `user-data/.setup-state.json` fields `mode`, `mode_at`, `steps.<id>.status`; no new env key |
| `docs/dashboard-login.md` | "skipped" is a valid state; `up` starts no web window then; `npm run setup -- --step dashboard` to add |
| `docs/telegram-bot-setup.md`, `docs/gmail-mcp-setup.md` | updated in Task 10 here; 8D reads them, does not rewrite them |
| `docs/index.md`, `docs/rollout.md` | pointers only |
| 8D's lint (`tests/docs-owner.test.ts`) | already requires documented `npm run` names to exist: `--mode` is a flag, so also add a flag lint line for `setup -- --mode` |

## Self-review checklist (planner)

- Owner request coverage: (1) skip Telegram and dashboard with RECOMMENDED label and plain consequence lines, skip recorded in state, doctor `skip` not `fail`, `up`/dry-run/doctor cope, re-offered on rerun, `--step telegram` still works, other steps listed with default and safety-critical ones non-skippable for live: Skippability table, D5 to D7, D10, Tasks 1, 2, 5, 6, 9. (2) two modes chosen once, remembered, switchable by flag, terminal walkthrough for Telegram (BotFather, hidden token, Threaded Mode with done-confirm and re-explain, numeric ID, test message and arrival confirm), Gmail, API keys, classifier, sessions, dashboard token, permission set, limits, with what exists versus new stated precisely: "What exists today", Tasks 3 to 8. Mode flag set, state schema, doctor output, docs hooks, hermetic tests, decisions, live checks, unverified, hard limits, 10 tasks with files, steps, tests and commits: sections above.
- No placeholder steps; every task names files, tests, a verify command and a commit message.
- Names used consistently: `SkippableId`, `SKIP_SPECS`, `skippedFeatures`, `withSkips`, `offerSkip`, `confirmDone`, `COACH_TEXT`, `resolveMode`, `launchGuide`, `SetupMode`, `state.mode`, `api-keys`, `apikeysStep`, `--mode agent|terminal`.
