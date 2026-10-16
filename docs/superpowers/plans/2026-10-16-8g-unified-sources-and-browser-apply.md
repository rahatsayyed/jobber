# Plan 8G: finishing re-architecture. One platform registry (script first, agent fallback), operator-driven discovery and sending, browser apply for every job, quota-aware search

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per project preference, dispatch subagents with `model: sonnet`, one task at a time, review gate after each task.

**This plan is two sub-plans in one file, built in order.** **8G-1 "Sources and operators" (Tasks 1 to 15)** replaces the batch hunt's discovery and sending with a platform registry, operators and a code-run scheduler pass. **8G-2 "Apply" (Tasks 16 to 25)** replaces scripted Easy Apply and the four hard-coded ATS scripts with a typed browser apply surface. 8G-2 depends on the shared web core built in Tasks 4 to 6 of 8G-1. They may be merged as two PRs (8G-1 first); nothing in 8G-1 needs 8G-2 except the apply fields already in `outreach_queue`.

**Goal (owner re-scope, final):** drop the OLD hunt flow entirely, not keep it alongside. The first reason for the re-architecture was that scripted LinkedIn tools fail, so the burner-account scrapers, scripted Easy Apply and the batch `discoverer`/`sender` stages go. Keep what is still right: shared matcher scoring, vetoes, resume tailoring, fact gate, outreach gates, SQLite state, the layout memory, the typed `linkedin`/`naukri`/`outreach` MCPs and the classifier layers. Add: a platform registry fed from the career-ops provider list with script-first providers and an agent fallback that also writes a (declarative, validated, owner-reviewable) provider; LinkedIn job and hiring-post discovery as a `linkedin-operator` task; agent-driven, owner-approved login and sign-up with a hard "marketing boxes stay unchecked" rule; a `search` abstraction (Serper plus quota-free browser dorking, cache, budget); clean `naukri:login` and `linkedin:login` commands; one per-source status table.

**Plain statement about two similarly named things (the owner conflated them):** `linkedin_find_profiles` is a typed tool of the NEW `linkedin` MCP (`src/mcp/linkedin.ts`, `src/linkedin/findProfiles.ts`, main account, patchright on real Chrome, classifier-screened, registers `people` rows). It is NOT the removed legacy `connect` MCP (`connect.find_linkedin_profile`, deleted in plan 8A). Contact finding for ANY job uses `linkedin_find_profiles`, and it keeps working unchanged.

**Architecture:** SOURCES (where jobs come from) are rows of a platform registry (`config/platforms.json` plus SQLite run state); each row is a deterministic script provider, run by CODE in a zero-LLM scheduler pass. When a script fails its shape check, or a new platform or company site has no script, a `source_tasks` row is queued and the `source-operator` agent takes over in a read-only typed browser (`scout` MCP), finds the jobs, and may propose a declarative provider spec to `generated/providers/` (git-ignored; fixture-replay and schema validated; held until owner approval). LinkedIn and Naukri discovery are operator tasks writing to the same `jobs` table through typed tools that persist in code. CHANNELS (where we act) are `email`, `linkedin_connect`/`linkedin_message`, `naukri_thread` and `apply`. The old hunt orchestrator becomes the wake orchestrator: the scheduler's wake runs the same match/veto/contact/prepare steps (shared agents kept) and then dispatches `mail-operator`, `linkedin-operator`, `naukri-operator` and `apply-operator` with quotas. Apply is a typed `applier` MCP on a shared web core, driven by `apply-operator`, with recipe fast paths.

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffixes), vitest, better-sqlite3, zod, `@modelcontextprotocol/sdk`, patchright (already a dependency, real installed Chrome headless), the dependency-free tokenizer `src/linkedin/htmlVisible.ts` for hermetic fixtures. No new dependency, no `npm install`.

**Builds on:** plans 8A (screen helper, kill switch, typed linkedin tools), 8B (operators, layout memory), 8E/8F (setup, skips), the ADR `docs/superpowers/specs/2026-10-13-adr-agent-driven-browser-runtime.md`. **This plan amends the ADR:** "ATS sites stay scripted" no longer holds for apply (agent-driven with recipes), and "discover scripts on LinkedIn" is gone. Cut the build branch from main after the open docs branches merge; Tasks 14, 15 and 25 touch `CLAUDE.md`, `.env.example`, `config/permission-sets.json`, `config/run-profiles.json`.

---

## What the code does today (verified by reading it)

### A. "Discovery" versus "Boards"
- "Discovery" is hunt step 1: the `discoverer` agent (tools `job-fetch.list_new_jobs`, `board_status`, `discover.linkedin_jobs`, `discover.linkedin_posts`). Boards are one source group inside it. Everything lands in one `jobs` table; `jobs.source` is the only provenance (`adzuna`, `remotive`, `remoteok`, `naukri`, `linkedin-jobs`, `linkedin-posts`, company-board vendor ids, `hackernews`/`himalayas`/`weworkremotely`; see `COMPANY_ATS`, `AGGREGATOR_ATS` in `src/sources/boards/filters.ts`).
- `src/sources/index.ts` `fetchAllJobs` runs Adzuna, Remotive, RemoteOK, Naukri and boards through `safely()` which logs to stderr and returns `[]`. Only boards have structured status (`boardStatusPayload`). LinkedIn scripts return `[]` on several failure paths.
- `board_status` blast radius: `.claude/agents/discoverer.md`, `config/permission-sets.json`, `tests/agents-lint.test.ts`, `tests/hook-tool-allowlist.test.ts`, `tests/fixtures/runner-golden.json` (twice), `tests/boards.test.ts`, `src/mcp/job-fetch.ts`, `CLAUDE.md` (step 6 "Board status", Preferences, After-merge item 7), `docs/architecture.md`, `docs/api-keys.md`.

### B. How LinkedIn and Naukri run today
| Concern | Hunt (batch, being removed) | Scheduled operators (kept and extended) |
|---|---|---|
| Find jobs | `discover.linkedin_jobs/posts` (scripts, BURNER account); Naukri via `fetchNaukri` in `list_new_jobs` | Naukri `search` task: `naukri_search` result is never saved (no `saveJob` in `src/mcp/naukri.ts` or `src/mcp/db.ts`), so found jobs are lost. LinkedIn operators never search jobs. |
| Find people | `contact-finder`: `find_company_emails` plus up to four `linkedin_find_profiles` | none (`next_contacts` reads `people`) |
| Contact | `sender`: email, LinkedIn connect, Naukri thread message | operators: inbox, followups, new_outreach |
| Apply | `sender` calls `apply.linkedin` (burner) / `apply.greenhouse|lever|workday|ashby`; Naukri URLs get `needs_agent` and rows `agent_naukri` that NOTHING consumes | none |

### C. Is every matched job contacted the same way? (verified)
`contact-finder` gets every job past match, vetoes and `MATCH_THRESHOLD` and treats sources alike. `linkedin_find_profiles` runs for every matched job EXCEPT: (1) Hacker News domain mismatch (by design); (2) empty company (`linkedin-posts` jobs ship `company: ''`, `apply_url` = author profile; LinkedIn search skipped unless the matcher gave `extracted_company`; the author is never registered in `people`, G4); (3) the stop rule (first `halted`/`rate_limited`/`session_locked` disables LinkedIn search for the rest of the batch); (4) the daily search cap (4 searches per job against `MAX_LINKEDIN_SEARCHES_PER_DAY` 20 means about 5 jobs a day, G5); (5) classifier results.

Other gaps: **G1** scheduled Naukri search results never saved. **G2** a job with no contact and no profile never reaches `outreach-preparer`, so it is never applied to even when apply-capable. **G3** the email path needs a company domain: `domain ?? findDomain(company)` is a Serper query, the Job has no domain field, so without `SERPER_API_KEY` only Hacker News jobs get email contacts; `findDomain` accepts the first non-social organic host (a Glassdoor or Indeed result can become "the company domain"). **G6** Naukri-source jobs: no cold Naukri message by design. **G7** `agent_naukri` rows are never consumed. **G8** `external.ts` fills the cold email body into the ATS cover letter field. **G9** `external.ts` spends the apply slot before the browser launches. **G10** `user-data.example/easy-apply-answers.json` ships `requires_sponsorship` as `{india, other}`, which `linkedin.ts` types as boolean and fails to `needs_answer`. **G11** the `claude --print` bootstrap sends untrusted page snapshots to a full CLI and learns a FieldMap for ANY host a job URL names. **G12** the Workday FieldMap is single-step (`bottom-navigation-next-button` as submit) for a multi-step account-gated wizard. **G13** `scripts/linkedin-login.ts` requires `LINKEDIN_LOGIN_ACCOUNT=main` in the PROCESS environment (`env.LINKEDIN_LOGIN_ACCOUNT === 'main'`; the script never reads `.env`), so the owner's `.env` entry had no effect; `scripts/save-naukri-session.ts` is a raw stock-playwright headed script with no guard, no real Chrome, no atomic save. **G14** `.mcp.json`/permission sets/run profile `hunt`/`run-hunt.sh`/`/runhunt`/ccgram `hunt` window all assume the batch orchestrator.

### D. Serper
`SERPER_API_KEY` is read only by `serperSearch` in `src/mcp/contacts.ts` (`findDomain`, `searchDomainEmails`). It is not a job source. It is mislabelled in `.env.example`, `src/setup/steps/apikeys.ts`, `src/setup/coach.ts`, `src/setup/skips.ts`, `src/platform/checksApiKeys.ts`, `config/setup-guide.json`, `docs/api-keys.md`, `docs/config-reference.md` (line 206 "Job sources: Adzuna and Serper keys"), `docs/setup-modes.md`, `README.md` (line 52) and `CLAUDE.md`. **Owner decision: KEEP, relabel as contact finding, add quota-free dorking.**

---

## What is removed, kept, renamed (exact)

**Removed** (deleted in Task 14 unless noted):
- Agents: `.claude/agents/discoverer.md`, `.claude/agents/sender.md` (email send and follow-up send move to `mail-operator`; connect/message sends to `linkedin-operator`/`naukri-operator`; apply to `apply-operator`).
- Scripts/MCP: `src/discover/*`, `src/mcp/discover.ts` and the `discover` server, `config/discover-linkedin.json` (its search definitions migrate to `config/linkedin-discovery.json`), the `apply` MCP (`src/mcp/apply.ts`, `src/mcp/applyAutoRouter.ts`: `apply.linkedin`, `apply.greenhouse|lever|workday|ashby|auto`), `src/apply/linkedin.ts`, `src/apply/external.ts`, `src/ats/*`, `src/lib/atsBootstrap.ts`, `src/lib/domSnapshot.ts`, `src/lib/domFallback.ts`, `.claude/commands/ats-bootstrap-fieldmap.md`, `easy-apply-control-fallback.md`, `easy-apply-answer-fallback.md`, `config/learned-ats-platforms.json`, `scripts/save-naukri-session.ts`, `scripts/save-linkedin-session.ts` if superseded by Task 12 (check importers first).
- Env: `EASY_APPLY_HYBRID_FALLBACK`, `EXTERNAL_APPLY_HYBRID_FALLBACK`, `LINKEDIN_LOGIN_ACCOUNT`, `NAUKRI_SEARCH_EVERY_HOURS` (task replaced by Task 11).
- Orchestration: the `hunt` run profile in `config/run-profiles.json`, `./run-hunt.sh` (3-line shim for one release, then delete), the hunt orchestrator text in `CLAUDE.md` "Running the hunt", `outreach_send` entries for `mcp__apply__*`, `mcp__discover__*`.
- Burner session usage for discovery and for scripted Easy Apply. `secrets/linkedin-burner-state.json` is used afterwards ONLY if the owner enables LinkedIn Easy Apply through the applier (D9).

**Kept unchanged:** `matcher`, `contact-finder` (reason codes added), `outreach-preparer` (dispatch rule changed), `reply-watcher`, `followup-drafter` agents; skills (`match-jobs`, `draft-*`, `tailor-resume`, `review-application`, `the-humanizer`, `telegram-format`, `manager`, `setup-guide`); MCPs `resume`, `gates`, `db`, `contacts`, `gmail`, `outreach`, `linkedin` (extended), `naukri` (extended), `job-fetch` (becomes the registry front); `src/sources/boards/*` providers (moved behind the registry), the HN domain gate, discover-only rule for aggregators, layout memory, classifier and screen, kill switch, halts, dry run, scheduler core, fact gate, outreach gates, `people`/`outreach_queue`/`jobs`/`applications` tables.

**Renamed:** `board_status`/`BOARD_STATUS:` -> `source_status`/`SOURCE_STATUS:` (alias for one release); `discover.linkedin_jobs`/`linkedin_posts` -> `linkedin_search_jobs`/`linkedin_search_posts` (typed tools of the `linkedin` MCP, new); `sender` -> `mail-operator` (email only); `apply.*` -> `apply_*` on server `applier`; hunt orchestrator -> wake orchestrator; `/runhunt` -> shim that runs one pipeline wake now (`npm run scheduler -- --once --now`); ccgram window id `hunt` stays as an interactive read-only window (shim, description updated).

**Migration:**
- `jobs`: no column change. Old `linkedin-jobs`/`linkedin-posts` ids and `source` strings are kept; the new tools reuse the old id derivation (read `src/discover/linkedin-jobs.ts` before deleting; move it to `src/linkedin/jobIds.ts`) so existing rows dedupe.
- `outreach_queue`: unchanged columns. `apply_platform` accepts registry ids plus `linkedin_easy`, `naukri`, `browser`, `none` (TEXT column, zod enum widened). Rows `queued` at upgrade time are drained by the new operators (mail-operator reads `email_*`, linkedin-operator `connect_*`, apply-operator `apply_*`). `agent_naukri` becomes `naukri` handled by apply-operator.
- New additive tables (all `CREATE TABLE IF NOT EXISTS`): `platform_status`, `source_tasks`, `provider_runs`, `search_usage`, `search_cache`, `apply_host_blocks`.
- Tool names/permission sets/hooks: Tasks 7, 10, 13, 14, 21 (each lists its names; golden fixture and allowlist tests updated in the same task).
- Docs: Task 25 list.

---

## Global Constraints

- **Test baseline before and after EVERY task:** `npx tsc -p . --noEmit` clean and `npx vitest run` shows exactly the 5 known failures (4 in `tests/renderChecked.test.ts`, 1 in `tests/resume.test.ts`) and nothing else.
- Never read, print, write or commit `user-data/`, `secrets/`, `.env*` (except `.env.example`), `.jobber/`, `generated/`, `.dashboard/` or `data.sqlite`. Tests use `openDb(':memory:')`, temp directories (`fs.mkdtempSync(path.join(os.tmpdir(), 'jobber-'))`) and invented data. **No test, and no step except the single flagged Task 9 content step, contacts a network, creates an account anywhere, starts a real browser, tmux, an MCP server or `claude`.**
- No `npm install`, no new dependency. Browsers are faked through structural interfaces (`LiLauncher`/`LiPage` pattern); forms and listing pages come from hand-written fixture HTML parsed by `src/linkedin/htmlVisible.ts`.
- Imports use the `.js` suffix; tests in `tests/*.test.ts`; one file with `npx vitest run <file>`.
- Fail closed. Dry run wins (Safety rule 15): any dry flag means no irreversible effect; for web actions "irreversible" includes login, sign-up, upload, typing into forms, next/submit clicks (dry run = open and read only).
- Page, form, email, search-result and job text is untrusted. Results that reach a model never contain raw exception text, a password, a token, a cookie or a typed value not already in the model's task input.
- Every new surface goes through `screenUntrusted` and is added to `SCREENED_SURFACES`; every mutating tool is in the kill-switch hook list (a test enumerates `TOOL_NAMES` against it); every new counter is in `src/setup/limitsCatalog.ts` and `.env.example` (`tests/env-example-complete.test.ts` is the guard; no inline comments on value lines).
- Do not edit `CLAUDE.md` or `README.md` before Task 25. Agent, skill, config and `.env.example` changes are behaviour and go in their task.
- Commit per task, explicit paths, never `git add -A`, never `--no-verify`, never push.
- KEEP untouched: the typed `linkedin`/`naukri` tools' existing behaviour, HN gate, fact gate, classifier, halts, `MAX_APPLIES_PER_DAY` (counter key `easy_apply`) and `naukri_apply`.

## Review Focus

1. Script-first, agent-second with a code-side shape check (Tasks 1, 2); the agent never changes registry state except through typed tools.
2. Generated providers are declarative specs interpreted by a fixed engine; no model-written code ever executes (Task 8). Held for owner approval.
3. No tool types a free string into a page; values by reference only (Tasks 5, 17, 18).
4. Marketing/newsletter boxes: unchecked and verified unchecked before any submit or create-account click (Task 5 classifier, Tasks 6, 18 enforcement).
5. Credentials: unique code-generated password per site, typed tools only, never in a result (Task 6 leak tests).
6. Search budget: Serper is reached only after cache and dorking miss, under a daily budget (Task 3).
7. Removal safety (Task 14): `git grep` proof; queue drain tests; no importer, env key, permission entry or doc command left.
8. Every rename has a shim for one release (table in Task 1 and Task 14).

## Decisions (accepted here, with cost if wrong)

| # | Decision | Cost if wrong |
|---|---|---|
| D1 | Terminology: "Discovery" is a pipeline phase; "sources" are registry rows; boards are one `kind`. One `source_status` tool/`SOURCE_STATUS:` line replace `board_status`/`BOARD_STATUS:`; old names alias for one release. | Stale prompts see the old name one release. Low. |
| D2 | Platform registry = `config/platforms.json` (committed catalog: id, kind, provider path, tier script|agent, attribution, stability, default enabled) + `config/portals.json` (tenants, unchanged) + SQLite `platform_status` (last run, status, counts, shape hash, fallback used). `jobs.source` unchanged. | A history over time needs a table later. Low. |
| D3 | Discovery by script runs in CODE (zero LLM) at the start of a wake, not in an agent. Agents only get `source_tasks` for failures, new sites and LinkedIn/Naukri tasks. | Script sources are not "agentic"; that is the point (cost). Low. |
| D4 | The old batch hunt is replaced by a wake pipeline: the scheduler wake session runs sweep, match, vetoes, contact-finder, preparers (same shared agents, same direct db/gates calls the old orchestrator made) and then dispatches `mail-operator`, `linkedin-operator`, `naukri-operator`, `apply-operator` with quotas. Rejected alternative: one agent per job end to end (too many model turns against subscription limits). | The wake session still orchestrates batches; "operators instead of batch" applies to discovery and acting, not to scoring. Medium; stated plainly. |
| D5 | `sender` is deleted. `mail-operator` = email sends + email follow-ups (autonomous guards and claim unchanged, moved). LinkedIn connects/messages = `linkedin-operator` `new_outreach` reading queued rows; Naukri thread messages = `naukri-operator`. | Sends happen on scheduler cadence, not inside the same minute as preparation. Low to medium; pacing is a feature. |
| D6 | LinkedIn job and hiring-post discovery are NEW typed tools `linkedin_search_jobs` and `linkedin_search_posts` on the `linkedin` MCP (main account), invoked by `linkedin-operator` task `discover`; the tool persists new jobs in code (fixes the G1 pattern) and returns counts and ids only. Search definitions in `config/linkedin-discovery.json`. | The main account does more searches: ban risk (existing owner risk); mitigated by `MAX_LINKEDIN_SEARCHES_PER_DAY`, a new `linkedin_discover` counter, pacing, layout memory. Medium-high. |
| D7 | Providers: script first (deterministic provider with zod shape spec); agent fallback on shape failure or new site. Generated providers are DECLARATIVE JSON specs (list locator, field locators, pagination, host allowlist) interpreted by a fixed engine; never model-written code. State machine `candidate -> validated -> trusted`; `trusted` needs `GEN_PROVIDER_PROMOTE_N` clean runs over 2 run ids AND owner `approve`; until approved their jobs are matched and listed but outreach rows are created `held_review` and never sent. | Declarative specs are less expressive than code. Alternative (TS files written by the agent) rejected: unreviewed code in an MCP process. Low. |
| D8 | Imported providers (career-ops) are ported as data-driven rows, `enabled:false` by default, one fixture test each, MIT header with attribution. The 50+ count is UNVERIFIED. | Some providers may not port cleanly; they stay disabled. Low. |
| D9 | Apply: new `applier` MCP on a shared `webcore`; `apply-operator` agent; scripted `apply.linkedin` Easy Apply REMOVED. LinkedIn Easy Apply is an `agent` tier job through the applier using the burner session, OFF by default (`APPLY_LINKEDIN_EASY=false`). | No LinkedIn Easy Apply until the owner enables it after supervised checks. Medium, deliberate (it was the most failure-prone path and the burner-account ban risk). |
| D10 | Values by reference only (`AnswerRef`); the only free text ever typed is a prepared cover letter, and only when D12 allows. Unknown question -> `needs_owner`. | More owner questions early; they accumulate into the answer book. Intended. |
| D11 | Owner approves agent-driven login AND sign-up. Sign-up needs `APPLY_ALLOW_ACCOUNT_CREATION=true` (apply) or `SCOUT_ALLOW_SIGNUP=true` (discovery sites), live, ceilings, no block. Both ship `false` but are the supported path (owner-approved), turned on per supervised check. | Until enabled, account walls end `needs_owner`. Low. |
| D12 | Checkbox rule (hard): any marketing/promotional/newsletter/job-alert/"partner offers"/"receive emails" checkbox is left UNCHECKED (pre-checked ones are unchecked by code) and verified unchecked before create-account or submit; a form that will not allow it -> `needs_owner`. Consent boxes are checked only when `required` AND classified `legal_required` (privacy notice/terms needed to submit; `APPLY_ACCEPT_LEGAL_REQUIRED=true` default). Attestations, background-check, data-sale or third-party-sharing consents -> `needs_owner`. Self-ID: the explicit decline option, else `needs_owner`. Cold email body is never used as a cover letter; optional cover letters stay empty, required ones -> `needs_owner: cover_letter`. | Some forms need a manual step. Low. |
| D13 | Credentials: `secrets/site-accounts.json` (0600 in 0700 dir), per registrable host/tenant, unique `crypto`-generated password per site, read only by typed tools inside the MCP process, never returned. Email verification: `SITE_MAIL_VERIFY=gmail` reads ONE message via the `gmail` read tools with a REQUIRED non-empty `SITE_MAIL_SENDERS` allowlist enforced by hook and by code link extraction (host must be in the site's allowed set); with an empty allowlist the mode falls to `owner_assist`. Treated as an injection channel (mail body is not classifier-screened by this plan). CAPTCHA, MFA, phone/SMS verification -> stop, escalate to Telegram, never solve. | Mail body is third-party text read by a model; bounded by the host rule and by the tool surface. Medium, owner-accepted. |
| D14 | `search` abstraction with providers `browser-dork` (quota-free) and `serper` (credits), order: cache -> browser-dork -> serper; Serper only under `SERPER_DAILY_BUDGET` and `SERPER_MONTHLY_BUDGET`; counters in SQLite (`search_usage`); doctor shows both. Google blocking: on any block/CAPTCHA the provider is marked `blocked` for `DORK_BLOCK_COOLDOWN_HOURS`, falls back to DuckDuckGo/Bing HTML result pages, then to Serper. | Dork results are lower quality and fragile; Serper stays the safety net. Medium. |
| D15 | Unknown hosts: refused for apply by default (`APPLY_ALLOW_UNKNOWN_HOSTS=false`); scout may READ unknown company sites only via a search result or a registry host and never submits anything. | Custom company sites need the flag. Medium. |
| D16 | Default `APPLY_SUBMIT_MODE=hold` and `APPLY_DRY_RUN=true` until the owner flips them. | Two settings for the first real submit. Intended. |
| D17 | Recipes separate from layout memory (selectors live only in recipes; layout memory stays selector-free) but reuse its classifier/store; learned only from confirmed submits (`APPLY_RECIPE_PROMOTE_N`). Agent-written recipes follow the same declarative + validated rule as D7. | A wrong mapping could repeat once; drift/reset bound it. Low to medium. |
| D18 | Naukri fits the same model: script provider `naukri` in the registry (search), operator `naukri-operator` for inbox/replies/followups, agent fallback via scout when the script shape fails; the `search` task is replaced by `discover` that persists cards in code. | Naukri's Akamai sensitivity limits fallback exploration (layout memory note stays: no probe pages). Medium. |
| D19 | Login commands: `npm run linkedin:login` and `npm run naukri:login` both use real Chrome via patchright (headed), atomic save, and take `--account main` OR an interactive `y/N` confirmation; the env gate `LINKEDIN_LOGIN_ACCOUNT` is removed. | None. |
| D20 | `/runhunt` and `run-hunt.sh` stay one release as shims that run one pipeline wake now; the `hunt` run profile is deleted. | Anything scripted against them keeps working one release. Low. |
| D21 | One applier/scout browser session at a time per MCP (lock files), serial queue, per-host min gap, call and wall budgets in code. | Serial applications. Low. |
| D22 | Serper is NOT removed. Trade-off table in Task 3. | If dropped later, email coverage falls to jobs whose domain the ladder resolves alone. |

## Unverified (stated plainly; nothing here ran against a real site)
- The career-ops repository: its licence text, provider list, the "50+" count, and how portable each provider is. This plan had no network. Task 9 verifies and may find fewer.
- Real ATS/listing behaviour: selectors, labels, step order, confirmation text, upload mechanics, autocomplete widgets, iframes. Fixtures are INVENTED simplified pages, not captured HTML.
- Bot protection against patchright headless Chrome on LinkedIn jobs/posts search, Workday and other tenants, and on Google/DuckDuckGo/Bing result pages; CAPTCHA frequency. The design stops on any block and never solves one.
- Terms of service, robots.txt and automation policies of every site touched (job boards, ATS, company sites, Google). **Owner-accepted risk (O3):** the plan limits exposure with per-host politeness (min gap, per-host daily caps, cooldown after blocks, one session, no parallel tabs, no CAPTCHA solving, no mass applications) but cannot remove it. Automating Google results in particular is against Google's terms.
- Whether shape/drift checks catch every silent provider failure; whether a generated declarative spec generalizes beyond the sampled page.
- LinkedIn job and post search selectors for the new typed tools (as with every typed linkedin tool: unverified until a supervised run).
- Mail verification link shapes and sender names per vendor; whether the Gmail MCP query syntax supports the `from:` allowlist rule as assumed.
- Model behaviour on unfamiliar forms and sites.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `config/platforms.json` (new), `src/sources/registry.ts`, `src/sources/status.ts` (new) | Platform registry, `platform_status`, `source_status` | 1 |
| `src/sources/runner.ts`, `src/sources/providers/*.ts`, `src/sources/shape.ts` (new/moved) | Script-first runner, shape checks, fallback queue | 2 |
| `src/search/*` (new), `src/mcp/contacts.ts` (modify) | `search` abstraction, quota, cache, Serper relabel | 3 |
| `src/webcore/config.ts`, `session.ts`, `runtime.ts` | Shared locked patchright session, serial queue, politeness, budgets | 4 |
| `src/webcore/formModel.ts`, `state.ts`, `blocks.ts`, `checkboxes.ts` | Form extraction, compact state, block detection, marketing/consent classification | 5 |
| `src/webcore/accounts.ts`, `login.ts`, `signup.ts`, `mailLink.ts` | Credentials, login, sign-up, verification handoff | 6 |
| `src/scout/*`, `src/mcp/scout.ts`, `.claude/agents/source-operator.md` | Read-only typed browser, dork engine, source-operator | 7 |
| `src/sources/generated/*`, `scripts/providers.ts`, `generated/` (git-ignored) | Declarative generated providers, validation, promotion, owner CLI | 8 |
| `scripts/import-career-ops.ts`, `src/sources/providers/*` | Importer (network step), per-provider fixtures | 9 |
| `src/linkedin/search*.ts`, `src/mcp/linkedin.ts`, `.claude/agents/linkedin-operator.md`, `config/linkedin-discovery.json` | LinkedIn discovery tools and task | 10 |
| `src/naukri/discover.ts`, `src/mcp/naukri.ts`, `.claude/agents/naukri-operator.md` | Naukri discover persistence and task | 11 |
| `scripts/linkedin-login.ts`, `scripts/naukri-login.ts`, `package.json` | Login commands | 12 |
| `src/scheduler/*`, `.claude/agents/mail-operator.md`, `config/run-profiles.json`, `config/worker-tools.json` | Wake pipeline, task kinds, mail-operator | 13 |
| deletions listed above, `run-hunt.sh`, `.mcp.json`, `config/permission-sets.json`, hooks | Retire the old hunt | 14 |
| `src/status/sources.ts`, `scripts/status.ts` | Source table, report, shim | 15 |
| `src/apply/registry.ts`, `src/lib/discoverOnly.ts`, `src/mcp/db.ts` | ATS registry, classification | 16 |
| `src/apply/answers.ts` | Answer book | 17 |
| `src/applier/*`, tests | Typed apply tools | 18 |
| `src/applier/recipes/*`, `config/ats-recipes/*.json` | Recipes | 19 |
| `src/mcp/applier.ts`, `.claude/agents/apply-operator.md` | Wiring | 20, 21 |
| `src/webcore/mailLink.ts` (tests) | Mail verification | 22 |
| deletions | Legacy apply removal | 23 |
| `src/platform/checks*.ts`, `scripts/dry-run.ts` | Doctor, dry run | 24 |
| docs | Docs pass | 25 |

---

# Sub-plan 8G-1: Sources and operators (Tasks 1 to 15)

### Task 1: Platform registry and one per-source status (`source_status`)

**Files:** Create `config/platforms.json`, `src/sources/registry.ts`, `src/sources/status.ts`, `tests/sources-registry.test.ts`, `tests/source-status.test.ts`. Modify `src/db.ts` (additive `platform_status (id TEXT PRIMARY KEY, last_run_at, last_status, fetched, kept, new_count, error, fallback_used INTEGER, streak_fail INTEGER, shape_hash)`), `src/mcp/job-fetch.ts`, `src/sources/index.ts`, `tests/boards.test.ts` (alias assertions only).

**Interfaces:**
```ts
export type PlatformKind = 'board' | 'aggregator' | 'api' | 'search' | 'linkedin' | 'naukri' | 'generated';
export interface PlatformDef {
  id: string; kind: PlatformKind; label: string;
  provider: string | null;            // module path under src/sources/providers, or null for operator-only (LinkedIn)
  tier: 'script' | 'agent';           // script: deterministic provider exists; agent: operator-only
  enabled: boolean; stability: 'unverified' | 'fixture' | 'live_ok' | 'flaky';
  attribution?: { source: string; license: string; url: string };
}
export interface SourceStatusRow {
  source: string; kind: 'script' | 'agent'; group: PlatformKind;
  fetched: number; kept: number; new: number; error?: string; fallback_used: boolean; note?: string;
}
export function loadRegistry(path?: string): { platforms: PlatformDef[]; errors: string[] };
export function recordRun(db, id: string, r: {...}): void;
export function sourceStatusPayload(db): { ran: boolean; at?: string; rows: SourceStatusRow[]; dropped_duplicates?: {count: number; ids: string[]}; note?: string };
```
`config/platforms.json` seeds every provider already ported (greenhouse, lever, ashby, workable, recruitee, personio, smartrecruiters, workday, hackernews, himalayas, weworkremotely) plus `adzuna`, `remotive`, `remoteok`, `naukri` (script), `linkedin-jobs`, `linkedin-posts` (agent tier, operator-only). Tenants and company entries stay in `config/portals.json`. `enabled` for tenant boards is still decided per company in `portals.json` (exactly `true`).

Rename table (blast radius from section A): `board_status` stays registered and returns the old payload plus `deprecated: "use source_status"`; `BOARD_STATUS:` line is emitted alongside `SOURCE_STATUS:` for one release; `jobs.source` unchanged; `DISCOVER_ONLY_SOURCES` unchanged here.

- [ ] **Step 1: Failing tests.** Registry: ids unique; every `COMPANY_ATS`/`AGGREGATOR_ATS` id present; invalid row reported in `errors` and others still load; kind/tier validation. Status: a throwing provider yields a row with a redacted `error` (use `src/platform/redact.ts`; an `app_key=SECRET` URL is redacted) and others still return; `new` counts only jobs saved in this call; `board_status` returns `deprecated`.
- [ ] **Step 2: Run, confirm failure:** `npx vitest run tests/sources-registry.test.ts tests/source-status.test.ts`.
- [ ] **Step 3: Implement.** **Step 4: Verify:** those tests plus `tests/boards.test.ts`, `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(sources): platform registry and one per-source status; board_status kept as alias`

---

### Task 2: Script-first provider runner, shape checks, agent fallback queue

**Files:** Create `src/sources/runner.ts`, `src/sources/shape.ts`, `tests/sources-runner.test.ts`, `tests/sources-shape.test.ts`. Modify `src/sources/index.ts` (`fetchAllJobs` becomes a thin wrapper), `src/sources/boards/*` and `adzuna|remotive|remoteok|naukri` (each exports `provider: Provider` and a `shapeSpec`), `src/db.ts` (additive `source_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT, company TEXT, reason TEXT, state TEXT DEFAULT 'queued', created_at, updated_at)`).

**Interfaces:**
```ts
export interface Provider { id: string; fetch(ctx: FetchCtx): Promise<{ jobs: Job[]; sample: unknown[] }>; shapeSpec: z.ZodTypeAny }
export interface ShapeReport { ok: boolean; hash: string; problems: string[] }
export function checkShape(spec: z.ZodTypeAny, sample: unknown[]): ShapeReport;      // parses up to 5 raw items; hash = sha256 of sorted key paths
export async function runScriptSources(db, opts): Promise<{ jobs: Job[]; rows: SourceStatusRow[] }>;
```
Failure/drift rules (code, not model): a provider is `failed` when it throws, times out, `checkShape` is not ok, or it returns 0 jobs after returning >0 for the previous 3 runs with the same shape hash replaced (hash change + zero kept). On `failed` the runner records the row with `fallback_used: true` and inserts ONE `source_tasks` row (`reason`: `shape`, `error`, `drift`) per platform/company per day. A platform with `streak_fail >= 3` is marked `flaky`. Jobs from a failed provider are not discarded if some were fetched and valid. The runner is called by the scheduler (Task 13), not by any agent. Existing per-company limits, caps and the 120 s budget stay.

- [ ] **Step 1: Failing tests:** shape ok on fixture JSON for each ported provider (use existing board fixtures); renamed key breaks shape and queues exactly one `source_tasks` row; same failure the same day does not queue a second; hash-change-with-zero-kept is `drift`; a throwing provider does not affect others; description cap and location line behaviour unchanged (existing `tests/boards.test.ts` stays green).
- [ ] **Step 2 to 4:** run, implement, verify (`npx vitest run tests/sources-runner.test.ts tests/sources-shape.test.ts tests/boards.test.ts` and tsc).
- [ ] **Step 5: Commit:** `feat(sources): script-first runner with shape/drift checks and an agent fallback queue`

---

### Task 3: `search` abstraction, quota, cache, Serper relabelled as contact finding

**Files:** Create `src/search/index.ts`, `src/search/serper.ts`, `src/search/dork.ts` (builders only here), `src/search/budget.ts`, `src/search/ladder.ts`, `src/search/denylist.ts`, `tests/search-*.test.ts`. Modify `src/db.ts` (additive `search_usage (day TEXT, provider TEXT, count INTEGER, PRIMARY KEY(day, provider))`, `search_cache (qhash TEXT PRIMARY KEY, provider TEXT, kind TEXT, result TEXT, at TEXT)`), `src/mcp/contacts.ts`, `.env.example`, `src/setup/steps/apikeys.ts`, `src/setup/coach.ts`, `src/setup/skips.ts`, `src/platform/checksApiKeys.ts`, `config/setup-guide.json`, `src/setup/limitsCatalog.ts`, tests `tests/setup-apikeys.test.ts`, `setup-skips`, `platform-checks-skips`, `setup-guide`, `env-example-complete`, `setup-env-empty-comment`.

**Interfaces:**
```ts
export type SearchKind = 'company_domain' | 'domain_emails' | 'careers_page' | 'hiring_posts' | 'jobs_site';
export interface SearchResult { title: string; snippet: string; url: string }
export interface SearchProvider { id: 'browser-dork' | 'serper'; search(q: string, o: { kind: SearchKind }): Promise<{ results: SearchResult[]; blocked?: boolean }> }
export async function searchWithBudget(db, kind: SearchKind, params: DorkParams, deps): Promise<{ results: SearchResult[]; provider: string | 'cache' | 'none'; reason?: string }>;
/** Pure query builders. Parameters are validated tokens, never raw model strings. */
export function buildDork(kind: SearchKind, p: DorkParams): string;
```
Order: `search_cache` (TTL `SEARCH_CACHE_TTL_DAYS`, default 14) -> `browser-dork` (if `DORK_ENABLED` and provider not in block cooldown) -> `serper` (if `SERPER_API_KEY` set AND today's `search_usage` < `SERPER_DAILY_BUDGET` AND month < `SERPER_MONTHLY_BUDGET`). Every provider call increments `search_usage`. Dork builders: `company_domain` -> `"<company>" official website -site:linkedin.com -site:glassdoor.com ...`; `domain_emails` -> `"@<domain>" (careers OR hr OR recruiting OR jobs)`; `careers_page` -> `site:<domain> (careers OR jobs)`; `hiring_posts` -> `site:linkedin.com/posts "hiring" "<role>"` style (executed via the browser, never the LinkedIn session); `jobs_site` -> `intitle:"<role>" "<company>" careers` with `filetype`/`inurl` variants; all parameters pass `^[\p{L}\p{N} .&'\-]{1,80}$` or are rejected. Result hosts pass `isDeniedDomainHost` (job boards, review sites, social, ATS vendor hosts, shorteners) before a domain is accepted. Domain ladder `resolveCompanyDomain`: explicit param -> company-site `apply_url` host (not denied, not ATS) -> HN posting domain -> `searchWithBudget('company_domain')`. `contacts.find_company_emails` returns `domain_source`.

Block handling is specified in Task 7 (the engine). Here the provider interface returns `blocked:true` and the budget layer records the cooldown.

Serper trade-off (kept per owner; table retained for the record):

| Option | Cost | Coverage | Risk |
|---|---|---|---|
| Serper only (today) | credits, quota | high | quota exhaustion kills email channel |
| Dork only | free | medium, fragile (Google blocks automation, against its terms) | blocking, ToS |
| **Cache -> dork -> Serper under budget (chosen, D14)** | credits only on misses | highest | complexity; dork block handled by cooldown and fallback |

Relabel (done in this task): `.env.example` groups `SERPER_API_KEY` and `HUNTER_API_KEY` under a "Contact finding" heading (Adzuna stays under job sources); apikeys step title "Optional API keys (Adzuna for jobs; Serper and Hunter for contact finding)"; coach, skips, setup-guide, doctor `api-keys` labels say contact finding; new keys: `DORK_ENABLED` (true), `DORK_BLOCK_COOLDOWN_HOURS` (24), `SEARCH_CACHE_TTL_DAYS` (14), `SERPER_DAILY_BUDGET` (20, catalog), `SERPER_MONTHLY_BUDGET` (200, catalog), `DORK_DAILY_BUDGET` (30, catalog). Docs files are relabelled in Task 25 (list there).

- [ ] **Step 1: Failing tests:** builder output per kind; hostile parameter rejected; cache hit calls no provider; dork success never calls Serper; dork blocked falls to Serper and starts cooldown; Serper skipped at daily budget (usage row asserted); no key -> `provider:'none'` without throw; denylist rows (`glassdoor.com`, `boards.greenhouse.io`, `acme.myworkdayjobs.com`, `linkedin.com`, shortener denied; `acme.io` allowed); ladder order; doctor-visible numbers via `searchStatus(db)`; relabel assertions on every file listed; `env-example-complete` green.
- [ ] **Step 2 to 4:** run, implement, verify (all tests named above, tsc).
- [ ] **Step 5: Commit:** `feat(search): search abstraction with cache, dork budget and Serper budget; Serper is contact finding`

---

### Task 4: Web core runtime, config, ceilings, dry-run flag

**Files:** Create `src/webcore/config.ts`, `session.ts`, `runtime.ts`, `tests/webcore-config.test.ts`, `tests/webcore-runtime.test.ts`. Modify `src/safety/dryRun.ts` (`isDryRun(env, {linkedin?, web?})`: web requires `WEB_DRY_RUN === 'false'`; `APPLY_DRY_RUN` and `SCOUT_DRY_RUN` are both honoured: either not exactly `false` is dry), `src/outreach/limits.ts` (`LimitKey` gains `apply_attempt`, `site_account`, `linkedin_discover`), `src/outreach/config.ts`, `src/setup/limitsCatalog.ts`, `.env.example`.

Reuses `src/linkedin/session.ts` lock/atomic helpers (parametrized: `secrets/webcore.lock`, `secrets/site-sessions/<host>.json`) and `launchRealChrome`. Runtime mirrors `src/linkedin/runtime.ts`: one browser, serial queue, idle auto-close, halt check (`haltReason(db,'web')` and `'apply'`), navigation guard (final host stays inside the allowed host set given by the caller, else `refused: host_change`), per-host min gap `WEB_MIN_GAP_SEC` plus code-drawn jitter, per-job call budget `WEB_MAX_CALLS_PER_JOB`, wall budget `WEB_MAX_JOB_MIN`, user agent via shared headless context options.

Env keys: `WEB_DRY_RUN` (ships `true`), `APPLY_DRY_RUN` (`true`), `SCOUT_DRY_RUN` (`true`), `WEB_MIN_GAP_SEC` (20), `WEB_MAX_CALLS_PER_JOB` (80), `WEB_MAX_JOB_MIN` (15), `WEB_IDLE_MS`, `WEB_SETTLE_MS`, `APPLY_MAX_ATTEMPTS_PER_DAY` (10), `APPLY_MAX_PER_PLATFORM_PER_DAY` (3), `APPLY_MAX_PER_HOST_PER_DAY` (2), `SITE_MAX_ACCOUNTS_PER_DAY` (2), `LINKEDIN_MAX_DISCOVER_PER_DAY` (12, catalog). All counters in `limitsCatalog`.

- [ ] **Step 1: Failing tests:** config defaults/fallbacks never throw; dry-run table (`WEB_DRY_RUN` unset or any of the three not `false` is dry; `JOBBER_DRY_RUN=1` and unset `SCHEDULER_DRY_RUN` still win); catalog drift test with new keys; runtime with fake launcher: serial order, idle close, `session_locked`, halt refusal, host-change refusal, per-host gap, call budget cut-off, session file permission refusal.
- [ ] **Step 2 to 4:** run, implement, verify (`npx vitest run tests/webcore-*.test.ts tests/env-example-complete.test.ts` + limits tests, tsc).
- [ ] **Step 5: Commit:** `feat(webcore): shared locked browser runtime, budgets, web dry-run flags and new ceilings`

---

### Task 5: Form model, compact state, block detection, checkbox classification, fixtures

**Files:** Create `src/webcore/formModel.ts`, `state.ts`, `blocks.ts`, `checkboxes.ts`, `tests/helpers/fixtureSite.ts`, `tests/webcore-form-model.test.ts`, `tests/webcore-blocks.test.ts`, `tests/webcore-checkboxes.test.ts`, and invented fixtures under `tests/fixtures/web/` (header comment on each: invented, real structure unverified): `ats-a-form.html` (Greenhouse-like), `ats-a-confirmation.html`, `ats-b-form.html` (Lever-like), `ats-b-confirmation.html`, `wd-landing.html`, `wd-account.html` (email, password, verify password, a required privacy checkbox, a PRE-CHECKED "send me promotional emails" checkbox, "Create account"), `wd-signin.html`, `wd-step1-personal.html`, `wd-step2-questions.html` (custom questions, EEO select, newsletter checkbox), `wd-step3-review.html`, `wd-confirmation.html`, `captcha-wall.html`, `mfa-code.html`, `phone-verify.html`, `form-hostile.html`, `drifted-ats-a-form.html`, `listing-a.html` (job list page for the generated-provider tests), `serp-ok.html`, `serp-blocked.html`.

**Interfaces:** `FieldRole` closed vocabulary (name.first, name.last, name.full, email, phone, resume, cover_letter, linkedin_url, location, question, eeo, consent, marketing, password, password_confirm, otp, unknown); `FormField {id:'f1'.., role, label, type, required, filled, checked?, options?, hidden}`; `FormControl {id, kind:'next'|'submit'|'back'|'save'|'apply'|'sign_in'|'create_account'|'other', label}`; `FormModel {url, host, stepKind, stepIndex, stepCount, fields, controls, notices, block}`; `extractFormModel(raw)` pure; `formatState(m, extra?)`. `RawFormSnapshot` comes from an in-page script constant (no nested named function declarations: the `__name` note in the old `domSnapshot.ts` applies); the fixture site produces the same raw shape via `htmlVisible.ts`. `classifyCheckbox(label, required): 'marketing' | 'legal_required' | 'attestation' | 'third_party_sharing' | 'other'` closed-rule table: marketing matches /promot|newsletter|marketing|offers|updates and news|job alerts?|stay in touch|receive (emails|messages|communications)|partners?/i; legal_required matches /privacy (notice|policy)|terms (of (use|service))?|acknowledge|agree to the processing/ AND `required`; attestation matches /certify|true and complete|background check|authori[sz]e .* verify/i; sharing matches /share .* (partners|third part)/i. `marketing` always wins over `legal_required` when both words appear and the box is not `required`. Block detection as before (captcha, mfa, phone_verification, bot_wall, login_required, consent_required); never solves, clicks through or waits out a block.

- [ ] **Step 1: Failing tests:** extraction on every fixture; honeypot listed `hidden:true`; controls classified (Submit Application = submit, Save and Continue = next, Create Account = create_account); `formatState` never contains password values, caps lengths, strips invisible characters; the pre-checked newsletter box is reported `checked:true, role:'marketing'`; checkbox table rows (each regex branch, required vs not); each block fixture gives the right `block` including `phone_verification`; hostile label is wrapped as data; drifted fixture yields a different role set.
- [ ] **Step 2 to 4:** run, implement, verify (`npx vitest run tests/webcore-form-model.test.ts tests/webcore-blocks.test.ts tests/webcore-checkboxes.test.ts tests/linkedin-html-visible.test.ts`, tsc).
- [ ] **Step 5: Commit:** `feat(webcore): form model, block detection, checkbox classification and hermetic fixtures`

---

### Task 6: Accounts, login and sign-up (owner-approved), marketing-box enforcement, verification handoff

**Files:** Create `src/webcore/accounts.ts`, `login.ts`, `signup.ts`, `mailLink.ts`, `scripts/site-account.ts` (owner CLI: `add <host>` hidden prompt, `list`, `remove <host>`, `status`), `tests/webcore-accounts.test.ts`, `tests/webcore-signup.test.ts`, `tests/webcore-mail-link.test.ts`. Modify `package.json` (`site:account`), `src/safety/redact.ts` (account email and any stored password are literal secrets), `src/safety/outputGate.ts` (account email allowlisted only inside webcore), `.claude/hooks/tool-allowlist.cjs` (gmail read argument rule, see below).

**Design:** file `secrets/site-accounts.json` (0600, dir 0700, validated on every read like `checkSessionFile`), keyed by registrable host or tenant host: `{email, password, created_at, source:'owner'|'agent', verified}`. Unique password per site generated in code (`crypto.randomBytes`, length 20, mixed classes, stricter retry once on a policy notice) and written atomically BEFORE the create click. The account email is the profile email; the owner's main passwords are never read. Typed functions (exposed as tools by the `scout` and `applier` MCPs in Tasks 7 and 20): `site_login`, `site_signup`. `site_signup` runs only when the relevant flag (D11) is true, live, `site_account` ceiling has room, the page is an `account` step, no block, and passes the checkbox gate: every `marketing` checkbox is unchecked (code unchecks a pre-checked one, then re-reads and VERIFIES unchecked; failure -> `needs_owner: marketing_checkbox`), each `legal_required` box is checked only when `required`, any `attestation`/`third_party_sharing` -> `needs_owner: consent`. The same gate runs again before any `apply_submit`/`apply_next` that leaves a form step. CAPTCHA, MFA, phone/SMS verification: stop, escalate (Task 20 writes the Telegram escalation), never solve, never retry in the same run, host cooldown after two blocks.
Verification mail (`SITE_MAIL_VERIFY`: `gmail` | `owner_assist` | `off`, default `owner_assist` unless `SITE_MAIL_SENDERS` is non-empty, then `gmail`): `extractVerificationLinks(text, {senders, hosts})` is pure: https only, no credentials, host equal to or under the site's allowed host set, path /verify|confirm|activate|validate/ or a token parameter, From header in the allowlist. Tool `site_open_link({url_or_message_text})` is the single tool with a URL-ish input and applies the same host rule. The hook rejects a `mcp__gmail__search_emails` call from the operators whose query lacks `from:` with an allowlisted address, and denies every other gmail tool for them (`send_email`, etc.). Mail text is flagged in docs as an injection channel and is not screened by the classifier in this plan.

- [ ] **Step 1: Failing tests:** accounts file wrong mode/symlink refused; atomic write; per-host lookup; credential written before the create click (event-order assertion on the fixture site); **leak tests**: run `wd-landing -> wd-account -> verify stop` with a canary password and assert it appears in no tool result, state, console output, escalation row, `dry_run_actions` payload or thrown message; marketing box: pre-checked newsletter is unchecked and verified before create click, and a fixture where it re-checks itself ends `needs_owner: marketing_checkbox` with no click; legal-required box checked only when required; attestation box -> `needs_owner`; flags off/dry/ceiling refusals; mail-link table (off-host, http, creds, no verify-path, non-allowlisted sender, multi-host mail yields one link); hook rejects unrestricted gmail query.
- [ ] **Step 2 to 4:** run, implement, verify (`npx vitest run tests/webcore-accounts.test.ts tests/webcore-signup.test.ts tests/webcore-mail-link.test.ts tests/hook-tool-allowlist.test.ts`, tsc).
- [ ] **Step 5: Commit:** `feat(webcore): site accounts, login and sign-up with unchecked marketing boxes and a gmail sender allowlist`

---

### Task 7: `scout` MCP, dork engine, `source-operator`

**Files:** Create `src/scout/engine.ts` (dork execution + SERP parsing for Google, DuckDuckGo HTML, Bing HTML; parse is code), `src/scout/tools/*.ts`, `src/mcp/scout.ts`, `.claude/agents/source-operator.md`, `tests/scout-*.test.ts`. Modify `src/search/dork.ts` (browser-dork provider uses the engine), `.mcp.json`, `config/permission-sets.json`, `config/run-profiles.json`, `config/worker-tools.json`, hooks lists, `SCREENED_SURFACES`, golden fixtures.

**Tools (`TOOL_NAMES`):** `scout_search({kind, params})` (query built in code, never a raw model query; runs through `searchWithBudget`; returns result titles/snippets/urls inside an untrusted block), `scout_open({url})` (ONLY a URL returned by a prior `scout_search` in this run, a registry host, or the platform's own host given by a `source_tasks` row; navigation guard), `scout_state`, `scout_scroll`, `scout_click` (refuses submit-like words, same pattern as `linkedin_click`), `scout_extract_jobs({task_id})` (code extracts job-like cards from the current page via the closed extractor; saves nothing), `scout_save_jobs({task_id, source})` (persists extracted jobs through the same `saveJob` + dedupe as `list_new_jobs`, in code, with source `gen:<platform>` or the registry id), `scout_capture_fixture({task_id})` (stores the current page's raw snapshot under `generated/fixtures/<platform>/` for Task 8), `site_login`, `site_signup` (Task 6), `scout_layout`, `scout_close`. No typing of free text into pages; no apply; read-only apart from login/sign-up.
**Engine blocks:** any CAPTCHA/unusual-traffic page -> `blocked` -> provider cooldown (`DORK_BLOCK_COOLDOWN_HOURS`), fall through engines Google -> DuckDuckGo HTML -> Bing HTML, then `blocked` to the caller (Serper is the caller's next step). Politeness: shared `WEB_MIN_GAP_SEC`, `DORK_DAILY_BUDGET`.
**source-operator tasks:** (a) `fallback`: for each queued `source_tasks` row, read the platform's board page via `scout_open` (host from the row), `scout_extract_jobs`, `scout_save_jobs`, mark the task `done` or `failed`; (b) `new_site`: for a company named in the owner's `portals.json` with `ats: "custom"` (new `custom` entry kind, `url` required, no script), same loop; (c) `dork`: refresh careers pages for companies without a registry entry; (d) `author`: propose a generated provider (Task 8). Tools: `Skill` NOT included; the `scout_*` list above; `mcp__db__list_jobs`; `mcp__outreach__escalate`. Result JSON counts only.

- [ ] **Step 1: Failing tests (fixture engine, no network):** `serp-ok.html` parses three results; `serp-blocked.html` returns `blocked` and the next engine is tried then Serper-side signal; `scout_open` refuses a URL not from a prior search or registry host; `scout_click` refuses submit-like words; injection fixture blocked by the screen; `scout_save_jobs` dedupes against existing ids and writes `jobs` rows; dry run saves nothing (records); operator definition lint (exact tool list, no Write/Bash/gmail).
- [ ] **Step 2 to 4:** run, implement, verify (`npx vitest run tests/scout-*.test.ts` + agent/hook/golden/permission tests, tsc).
- [ ] **Step 5: Commit:** `feat(scout): read-only typed browser, dork engine with engine fallback, and source-operator`

---

### Task 8: Generated providers (declarative), validation, promotion, owner review

**Files:** Create `src/sources/generated/spec.ts`, `engine.ts`, `validate.ts`, `store.ts`, `scripts/providers.ts` (`npm run providers -- list|show <id>|validate <id>|approve <id>|reject <id>`), `tests/generated-*.test.ts`. Modify `.gitignore` (verify `generated/` is ignored; add it if not, with a test line), `src/mcp/scout.ts` (tool `scout_propose_provider`), `src/mcp/db.ts` (`enqueue_outreach` marks rows `held_review` for sources `gen:*` until approved), `src/lib/discoverOnly.ts` (`isHeldSource`).

**Spec (zod strict):** `{schema:1, id, label, hosts:string[], kind:'html_list'|'json_api', start_urls:string[], item:{selector|jsonPath}, fields:{title, url, company?, location?, description?, posted_at?}, pagination?:{next_selector|param, max_pages<=5}, job_id_from:'url'|'field'}`. Selectors/JSON paths pass the strict selector regex used by recipes (id/name/data-attr/aria/class tokens, no `:has`, no combinators beyond one descendant, <=160 chars). All `start_urls` and extracted job URLs must stay inside `hosts`.
**Pipeline:** the agent proposes via `scout_propose_provider({task_id, spec})` -> `candidate`; validation (code) = (1) schema; (2) fixture-replay: the engine runs the spec over the captured fixture(s) in `generated/fixtures/<id>/` and must reproduce >= `GEN_PROVIDER_MIN_JOBS` (3) items passing the `Job` schema with absolute URLs inside `hosts` and unique ids; (3) no field extracts from a hidden element; -> `validated`. A validated provider runs in the NEXT script pass like any provider (rows labelled kind `script`, source `gen:<id>`, fallback flag `generated`). After `GEN_PROVIDER_PROMOTE_N` clean runs (default 3, >= 2 run ids; clean = shape ok, kept>0, schema ok) it becomes `trusted` and is listed in `npm run providers -- list` as ready for review. `approve <id>` (owner) is required before its jobs' outreach rows are sendable (D7); `reject` deletes. Nothing is ever auto-promoted into `config/platforms.json`; `approve` offers `--promote` which prints the registry row for the owner to commit (a committed row is the "promoted to the registry" step).

- [ ] **Step 1: Failing tests:** valid spec replays `listing-a.html` and yields the expected jobs; hostile selector rejected; extracted URL outside `hosts` rejected; fewer than N jobs -> stays `candidate`; two clean runs over one run id do not promote; promotion needs 3 and 2 run ids; `enqueue_outreach` for a `gen:` source row is `held_review` and `list_queued_outreach` never returns it; approval releases it; spec file written under the git-ignored dir with mode 0600; no code path evals or requires a generated file.
- [ ] **Step 2 to 4:** run, implement, verify (`npx vitest run tests/generated-*.test.ts tests/db-mcp*.test.ts`, tsc).
- [ ] **Step 5: Commit:** `feat(sources): declarative generated providers with fixture-replay validation, promotion and owner approval`

---

### Task 9: career-ops importer (CONTENT TASK, needs network, separate builder)

**This is the only task allowed network, and only to read the career-ops repository (`career-ops-hq/career-ops`) through `git clone`/`gh api` into a temp directory. No job site, ATS or company site is contacted. The 50+ count is UNVERIFIED.**

**Files:** Create `scripts/import-career-ops.ts` (offline once the source is on disk: `--src <dir>`), `docs/superpowers/specs/2026-10-16-career-ops-import-report.md` (generated by the task: license text found, list, port status), `src/sources/providers/<id>.ts` + `tests/providers/<id>.test.ts` + `tests/fixtures/providers/<id>.json|html` per ported provider; modify `config/platforms.json` (each new row `enabled:false`, `stability:'fixture'`, `attribution`).

- [ ] **Step 1: Licence check first.** Read the repository LICENSE and each source file header. If the licence is not MIT (or compatible permissive), STOP and report to the owner; port nothing. Record the licence text, commit hash and URL in the import report. Already-ported providers keep their existing headers.
- [ ] **Step 2: Inventory.** List providers in the repo; classify each as `json_api`, `html_list`, `rss`, `needs_login`, `needs_js`, `unclear`. Report the real count (replace the unverified "50+").
- [ ] **Step 3: Port in batches of <= 10 per commit.** Each provider: MIT attribution header (`Adapted from career-ops-hq/career-ops <path> (MIT, (c) <holder>), commit <hash>`), exports `provider: Provider` with `shapeSpec`, uses `settleBoard`/`FetchCtx` conventions, fixture trimmed to the minimum invented-or-minimal structure (no bulk copy of real posting text), fixture-replay test asserting jobs and a shape-break test asserting `checkShape` fails when a key is renamed. Providers needing login or JS stay `tier:'agent'` rows without a script.
- [ ] **Step 4: Verify:** `npx vitest run tests/providers tests/sources-registry.test.ts` and tsc.
- [ ] **Step 5: Commit per batch:** `feat(sources): import career-ops providers batch <n> (MIT, attributed)`
- Owner step after merge: `npx tsx scripts/check-portal.ts <platform> <slug>` per provider from a networked shell; enable only those that return jobs.

---

### Task 10: LinkedIn job and hiring-post discovery as an operator task

**Files:** Create `src/linkedin/searchJobs.ts`, `src/linkedin/searchPosts.ts`, `src/linkedin/jobIds.ts` (moved from `src/discover/linkedin-jobs.ts`, same id derivation), `config/linkedin-discovery.json`, `tests/linkedin-search-jobs.test.ts`, `tests/linkedin-search-posts.test.ts`, fixtures `tests/fixtures/linkedin/jobs-search.html`, `posts-search.html`, `jobs-search-hostile.html`. Modify `src/mcp/linkedin.ts` (`TOOL_NAMES` gains `linkedin_search_jobs`, `linkedin_search_posts`; schemas take only a search NAME from `config/linkedin-discovery.json`, never a URL or free keywords), `src/layout/vocab.ts` (`search` kind landmarks for job/post cards: `results.cards` reused; add `jobs` kind `MIN_SET`/`CRITICAL` only after learning, see checklist), `.claude/agents/linkedin-operator.md` (new task `discover` with a quota; tool list gains the two tools), `config/worker-tools.json`, kill-switch/allowlist lists, `SCREENED_SURFACES`, `src/scheduler/plan.ts` (task kind `discover` for linkedin, counter `linkedin_discover`).

**Behaviour:** both tools use the locked main-account session, build the search URL in code from the named definition (keyword, location, posted-within, remote), halt/dry-run/ceiling aware (`MAX_LINKEDIN_SEARCHES_PER_DAY` shared with people search plus `linkedin_discover`), classifier-screened (`read`), layout-observed. They PERSIST new jobs in code (`saveJob`; `source` `linkedin-jobs` / `linkedin-posts`; posts keep `company ''` and the author profile as `url`, additionally the author is registered in `people` with category `hiring_post_author` ONLY when the profile URL verifies via `verifyProfileUrl` and the post text mentions hiring for the role: closes G4; if `people` category enum rejects it, use `peer` and note it) and return `{status, code, fetched, new, skipped}` plus new job ids; never page text. `linkedin_find_profiles` is unchanged and remains the contact-finding tool for every job.

- [ ] **Step 1: Failing tests:** fixture jobs page yields N jobs saved once (second call new=0, ids identical to the old derivation test vectors); hostile fixture blocked by fake classifier with nothing saved; live env + classifier error -> `classifier_unavailable`, no saves, no counter; dry run saves nothing and records; ceiling exhausted -> `rate_limited`; halted -> `halted`; layout drift in enforce mode refuses; tool schemas have no URL/keyword input; operator definition lists exactly the tools and states stop rules.
- [ ] **Step 2 to 4:** run, implement, verify (`npx vitest run tests/linkedin-search-*.test.ts tests/linkedin-mcp.test.ts tests/agents-lint.test.ts tests/layout-*.test.ts`, tsc).
- [ ] **Step 5: Commit:** `feat(linkedin): typed job and hiring-post discovery tools and the operator discover task`

---

### Task 11: Naukri: persist search, `discover` task, agent fallback

**Files:** Create `src/naukri/discover.ts`, `tests/naukri-discover.test.ts`. Modify `src/mcp/naukri.ts` (new typed `naukri_discover({search})` or extend `naukri_search` with `persist:true` default for the operator path: choose the new tool name to keep `naukri_search` read-only), `src/sources/naukri.ts` (becomes the registry `naukri` script provider, behaviour unchanged), `.claude/agents/naukri-operator.md` (`search` task replaced by `discover`; description-less cards are saved with `description` fetched by the existing detail-open step capped by `quota`), `src/scheduler/plan.ts`, `config/worker-tools.json`, `.env.example` (`NAUKRI_SEARCH_EVERY_HOURS` renamed `NAUKRI_DISCOVER_EVERY_HOURS`; shim: old name read as fallback for one release is NOT added because `env-example-complete` would require listing it; remove cleanly). Naukri stays: script search provider first; if its shape check fails, a `source_tasks` row sends the `source-operator` to the search page via `scout` ONLY if the Naukri layout memory allows (no probe pages, per the existing Akamai note), else it just reports.

- [ ] **Step 1: Failing tests:** fixture cards saved by code once, deduped against the script provider's ids; description fetch capped by quota; injection fixture blocked; dry run records; halted -> `halted`; operator lint; planner emits `discover` with the renamed interval.
- [ ] **Step 2 to 4:** run, implement, verify (`npx vitest run tests/naukri-*.test.ts tests/scheduler-plan*.test.ts tests/agents-lint.test.ts`, tsc).
- [ ] **Step 5: Commit:** `feat(naukri): discover task persists jobs in code; search script is a registry provider`

---

### Task 12: Clean login commands (`linkedin:login`, `naukri:login`)

**Why (G13):** `scripts/linkedin-login.ts` reads `LINKEDIN_LOGIN_ACCOUNT` from the process environment only (never `.env`), so the owner's `.env` line did nothing; `scripts/save-naukri-session.ts` is raw.

**Files:** Create `scripts/naukri-login.ts`, `src/platform/loginConfirm.ts`, `tests/platform-login-confirm.test.ts`, `tests/naukri-login.test.ts`. Modify `scripts/linkedin-login.ts`, `package.json` (`naukri:login`; remove `save-naukri-session` if present), `.env.example` (remove `LINKEDIN_LOGIN_ACCOUNT`), `docs` later (Task 25). Delete `scripts/save-naukri-session.ts` after confirming nothing imports it.

**Interfaces:** `confirmAccount(args: string[], io: {isTTY: boolean; ask(q: string): Promise<string>}, expect: 'main'): Promise<{ok: boolean; reason?: string}>`: ok when `--account main` is in argv, OR on a TTY the owner answers `y`/`yes` to "Log in the MAIN <platform> account? (y/N)"; non-TTY without the flag refuses with exit code 2 and a one-line message. No environment variable is consulted. Both scripts: headed real Chrome via `launchRealChrome({headed:true})`, same `*_CONTEXT_OPTIONS` as the headless runtime (the saved session must match the fingerprint), navigate to the login URL, wait for Enter, `storageState` -> atomic save 0600 to `secrets/linkedin-main-state.json` / `secrets/naukri-state.json`, print only `Saved session (N cookies)`; Naukri login refuses to save a state with no recognizable auth cookie (cookie NAME check only, never printed values).

- [ ] **Step 1: Failing tests:** `--account main` passes without TTY; TTY `y` passes, `n`/empty refuses; no flag and no TTY refuses with exit 2; the process environment value `LINKEDIN_LOGIN_ACCOUNT=main` has NO effect; scripts import no secrets reader; file mode 0600 (fake launcher); `git grep LINKEDIN_LOGIN_ACCOUNT -- src scripts .env.example` empty.
- [ ] **Step 2 to 4:** run, implement, verify (`npx vitest run tests/platform-login-confirm.test.ts tests/naukri-login.test.ts tests/env-example-complete.test.ts`, tsc).
- [ ] **Step 5: Commit:** `feat(platform): naukri:login and linkedin:login confirm with --account main or y/N; drop the env gate`

---

### Task 13: Wake pipeline, `mail-operator`, task kinds

**Files:** Create `.claude/agents/mail-operator.md`, `src/scheduler/pipeline.ts`, `tests/scheduler-pipeline.test.ts`, `tests/mail-operator-lint.test.ts`, `src/lib/channels.ts`, `tests/channels.test.ts`. Modify `src/scheduler/plan.ts` (`TaskKind`: `discover_scripts` (code, no agent), `discover_agent` (source-operator), `discover` (linkedin/naukri), `pipeline` (match..prepare), `mail`, `inbox`, `followups`, `new_outreach`, `apply`), `config/run-profiles.json` (`outreach_wake` gains the direct pipeline tools `db.sweep_deadlines`, `db.save_match_result`, `gates.apply_vetoes`, `db.mark_excluded`, `gates.check_liveness`, Agent dispatch of `matcher`, `contact-finder`, `outreach-preparer`, `reply-watcher`, `followup-drafter`, plus the four operators), `config/worker-tools.json`, `.claude/agents/contact-finder.md` (reason codes, `domain` param from the ladder), `.claude/agents/outreach-preparer.md` (dispatch rule: contact OR profile OR apply-capable `apply_url`, G2), hook/allowlist lists, runner-golden.

**Wake order (code decides which tasks exist from due counts and ceilings, as `planWake` does today):** 1. code pass `runScriptSources` (zero LLM; failures queue `source_tasks`); 2. `source-operator` for queued tasks; 3. linkedin/naukri `discover`; 4. `pipeline` steps (same logic as the old hunt steps 0, 0b, 2, 3, 4: sweep, reply check, match batches of 5, `save_match_result`, `apply_vetoes`, `mark_excluded`, threshold filter, contact-finder, preparers); 5. `mail-operator` (email send with `db.check_and_increment`, follow-ups with the unchanged claim guards; the sender's dedupe-by-job_id rule moves here); 6. `linkedin-operator` `new_outreach` (reads queued `connect_*` rows: `linkedin_check_connection_status` then `linkedin_connect_send`; `connected` -> flag as before) and `naukri-operator`; 7. `apply-operator` (Task 21). `channelsFor(job)` (pure) lists eligible channels per job with closed reason codes (`hn_gate_pending`, `no_company`, `no_cold_naukri`, `discover_only_source`, `held_review`, `apply_tier:<...>`); a table test iterates the registry so a new source without a row fails.

- [ ] **Step 1: Failing tests:** planner emits tasks in this order for a fixture due-state; script pass runs with no agent tasks; `mail-operator` definition lists exactly Gmail send, db queue/claim tools and nothing LinkedIn/apply; sender dedupe rule text present; sender follow-up guard text moved verbatim (lint compares key sentences); wake profile tool list equals the committed list; `channelsFor` rows per source; contact reason codes present in `contact-finder.md`; preparer dispatch sentence present.
- [ ] **Step 2 to 4:** run, implement, verify (`npx vitest run tests/scheduler-*.test.ts tests/mail-operator-lint.test.ts tests/channels.test.ts tests/agents-lint.test.ts tests/definitions-lint.test.ts` + golden/permission tests, tsc).
- [ ] **Step 5: Commit:** `feat(scheduler): wake pipeline orchestrated by code and operators; mail-operator replaces sender email duties`

---

### Task 14: Retire the old hunt

**Files:** Delete everything under "Removed" except the 8G-2 apply items (Task 23). Here: `.claude/agents/discoverer.md`, `.claude/agents/sender.md`, `src/discover/*`, `src/mcp/discover.ts`, `config/discover-linkedin.json` (after its entries migrated into `config/linkedin-discovery.json`), `config/run-profiles.json` profile `hunt`, `run-hunt.sh` -> 3-line shim (`exec npm run scheduler -- --once --now`), `/runhunt` handling documented as shim, ccgram window `hunt` description updated in `config/manager-windows.json`, `.mcp.json` `discover` server removed, `config/permission-sets.json` (`mcp__discover__*`, discoverer/sender-only entries removed), `package.json` (`mcp:discover`), hooks lists, tests for deleted code, `tests/fixtures/runner-golden.json`.

- [ ] **Step 1: Failing guard test first** `tests/old-hunt-removed.test.ts`: deleted paths do not exist; `.mcp.json` has no `discover`; no `mcp__discover__` or `discoverer`/`sender` string in `config/`, `.claude/`, `tests/fixtures/`; `run-hunt.sh` is <= 6 lines and execs the scheduler; queue-drain test: a pre-upgrade `outreach_queue` row with `email_*`, `connect_*` and `apply_*` set is picked up by `mail-operator`/`linkedin-operator` reads (`list_queued_outreach`) with unchanged semantics; `linkedin-jobs` ids from the old derivation still dedupe.
- [ ] **Step 2: Run, confirm failure. Step 3: Delete and adjust. Step 4: Verify:** `git grep -n "mcp__discover__\|discover.linkedin\|discoverer\|\bsender\b" -- src scripts config .claude tests .env.example` (explain each remaining hit in the commit body; `sender` as an English word in comments is fine), `npx vitest run` (5 known failures), tsc.
- [ ] **Step 5: Commit:** `refactor: remove the batch hunt (discoverer, sender, scripted LinkedIn discovery); run-hunt.sh is a shim`

---

### Task 15: The report: one source table

**Files:** Create `src/status/sources.ts`, `tests/status-sources.test.ts`. Modify `scripts/status.ts` (`npm run status -- sources`), `src/scheduler/*` (end-of-wake summary written to `.jobber/notify.jsonl` and to the Telegram notifier: counts per source row, `fallback_used`, errors), `src/mcp/job-fetch.ts` (`source_status` tool reads `platform_status`), `.claude/commands/` (new `sources.md` = exactly `npx tsx scripts/status.ts sources`; add `/sources` to the BotFather list in Task 25), `src/web` status panel only if a panel already lists boards (check `git grep -n "board" -- src/web`).

**Table columns (exactly):** `source id | kind (script|agent) | fetched | kept | new | errors | fallback used`. Rows come from `platform_status` plus generated-provider rows; a source that did not run is shown with `ran:no`. The legacy `Board status` report bullet disappears with the hunt text (Task 25); the shim: `board_status` and the `BOARD_STATUS:` line remain until the one-release removal noted in Task 1.

- [ ] **Step 1: Failing tests:** table rendering from a fixture DB (script row, agent row, fallback row with error); `status -- sources` output stable; notify summary contains the same numbers; the old tool alias still answers.
- [ ] **Step 2 to 4:** run, implement, verify, tsc.
- [ ] **Step 5: Commit:** `feat(status): one per-source status table in the wake summary and npm run status -- sources`

---

# Sub-plan 8G-2: Apply (Tasks 16 to 25)

### Task 16: ATS registry and authoritative apply classification
**Files:** Create `src/apply/registry.ts`, `tests/apply-registry.test.ts`. Modify `src/lib/discoverOnly.ts`, `src/mcp/db.ts` (`enqueue_outreach` computes `apply_platform` and `apply_tier` from `classifyApplyUrl(apply_url, source)`; the model value is ignored unless `none`; zod enum widened), `.claude/agents/outreach-preparer.md` step 6.
**Interfaces:** `AtsDef {id, label, apexes, tier:'fast'|'agent'|'never', accountRequired: boolean|'maybe', recipeId}`; `ATS_REGISTRY` (greenhouse, lever, ashby: fast; workable, smartrecruiters: fast once recipes ship in Task 19, else agent; workday: agent + account required; recruitee, personio: agent); `classifyApplyUrl(url, source): {platform, tier, reason?}`.
Rules (one test row each): `linkedin.com` -> `linkedin_easy` (agent tier, only if `APPLY_LINKEDIN_EASY=true`, else `none` reason `easy_apply_off`); `naukri.com` -> `naukri`; aggregator and `gen:*`-unapproved sources -> `none` (`discover_only_source`/`held_review`); look-alike host -> `none`; non-http(s) -> `none`; registry host -> its id/tier; any other https host -> `browser`/agent ONLY with `APPLY_ALLOW_UNKNOWN_HOSTS=true` else `none` (`host_unknown`). Hosts compared with `hostMatches`.
- [ ] Steps: failing table test, implement, verify (`npx vitest run tests/apply-registry.test.ts tests/applyVeto.test.ts tests/db-mcp*.test.ts`, tsc), commit `feat(apply): ATS registry and code-authoritative apply classification`.

### Task 17: Answer book and value references
**Files:** Create `src/apply/answers.ts`, `tests/apply-answers.test.ts`, `tests/fixtures/web/answers.json`, `tests/fixtures/web/resume.json` (invented). The matching logic is MOVED (copied then the old file is deleted in Task 23) from `src/apply/linkedin.ts` (`ANSWER_PATTERNS`, `loadAnswers`, topic descriptions).
**Interfaces:** `AnswerRef` (`profile` fields, `answer` key incl. `custom:<verbatim question>`, `resume_pdf`, `cover_letter`), `AnswerBook {has, resolve(ref, {jobLocation}), suggest(question)}`, `QuestionClass`. Object-form `requires_sponsorship {india, other}` resolves by job location (contains india -> `india`; other non-empty -> `other`; empty/ambiguous -> null -> `needs_owner`) (G10). `consent`, `legal_attestation`, `free_text` never resolve; salary resolves only to `expected_salary` verbatim.
- [ ] Steps: failing tests (fixed keys, custom verbatim, object-form sponsorship three cases, null for missing, never logs a value), implement, verify, commit `feat(apply): answer book with value references; resolve object-form sponsorship`.

### Task 18: Typed apply tools: open, fill by reference, upload, next, submit with confirmation
**Files:** Create `src/applier/refs.ts`, `confirm.ts`, `tools/{open,fill,upload,next,submit,state,common}.ts`, `tests/applier-{open,fill,submit,refs,screen}.test.ts`.
| Tool | Behaviour |
|---|---|
| `apply_open({job_id})` | URL read from the job row (no URL input). Refuses: unknown job, veto, hard stop, class `none`, look-alike/non-http(s), no prepared resume, halt, kill switch, host cooldown, per-host gap, `apply_attempt`/daily cap exhausted. Consumes `apply_attempt` only after pre-flight passes (G9: submit counters are NOT consumed here). |
| `apply_state` | Form model, screened (`read`), compact text; blocked screen returns no page text. |
| `apply_fill({field, ref})` | Resolves ref in code; refuses hidden fields, password roles (use login/sign-up), role/ref mismatch, `eeo`/`consent`/`marketing` fields, unresolved ref (`needs_owner: question`). |
| `apply_choose({field, option, ref})` | select/radio/checkbox; option must be listed; boolean->Yes/No mapping; EEO decline option only; `marketing` never checked (code unchecks pre-checked ones and verifies); `legal_required` checkbox per D12; others `needs_owner`. |
| `apply_upload({field})` | Prepared PDF from `outreach_queue.resume_pdf_path`, inside the project output dir, `.pdf`. |
| `apply_next({control})` | next/back/save only, enforces `APPLY_MAX_STEPS`, re-runs the marketing-box gate before leaving a step. |
| `apply_submit({})` | Order: halt -> kill switch -> dry run (`dry_run`) -> `APPLY_SUBMIT_MODE=hold` (`held` at review) -> classifier -> required fields filled, no block, all marketing boxes verified unchecked -> consume `MAX_APPLIES_PER_DAY` (key `easy_apply`) + per-platform + per-host counters in one transaction -> click -> confirmation. |
Confirmation layers: recipe signals, then URL path plus form gone, then conservative generic text plus form gone plus no error; otherwise `unconfirmed` -> `manual_review`, never `submitted`. Only `submitted` writes `applications.status='submitted'`, `method='browser'`. `apply_screenshot` only if `APPLY_SCREENSHOT=true` (unscreened pixels).
- [ ] **Step 1: Failing tests (fixture site, fake classifier):** schemas contain no free `value`/`text` property; role/ref mismatch refused; full fill of `ats-a-form.html` and `ats-b-form.html`; honeypot refused; unresolved question -> `needs_owner` with the question text and nothing typed; EEO decline chosen; marketing box pre-checked is unchecked and verified, a re-checking fixture blocks submit; submit table one `it` per row (dry, hold, captcha, missing required, halted, STOP, cap, happy path with counters once, no confirmation -> `unconfirmed`, duplicate submit); open refusal reasons; host change refused.
- [ ] **Steps 2 to 4:** run, implement, verify (`npx vitest run tests/applier-*.test.ts`, tsc). **Step 5:** commit `feat(applier): typed open, fill-by-reference, upload, next and gated submit`.

### Task 19: Recipes: fast path, drift, learning (generalized FieldMap)
**Files:** Create `src/applier/recipes/{schema,store,autofill,learn}.ts`, `config/ats-recipes/{greenhouse,lever,ashby,workable,smartrecruiters}.json` (first three derived from the existing `src/ats/*.ts` FieldMaps before Task 23 deletes them; the last two INVENTED, `verified:false`), `scripts/migrate-learned-ats.ts`, tests. Modify `src/layout/{types,vocab,fingerprint,store,config,summary}.ts` (`Platform` becomes `'linkedin'|'naukri'|` template `ats_${string}`; `observeAts(model)` reduction to vocabulary ids only), `scripts/layout.ts`.
**Recipe schema:** closed `FieldRole`, per step `{id, kind, match:{roles,minFields}, fields:[{role, selector, type, ref?}], next?, submit?}`, `confirmation:{urlPath?, roles_absent}`; selectors pass the strict regex shared with Task 8 (`isSafeSelector`).
**Behaviour:** `apply_autofill` (new tool) runs a recipe when the layout verdict for that `ats_<id>` step is `match`/`partial` with all required fields, fills refs, uses next (never submit), stops at review, returns `unresolved` ids; on `drift`/`unknown`/no recipe returns `recipe_miss` with state and the operator continues by hand. Learning: while the operator fills by hand, code records `(step kind, role, selector, type)` from extractor handles into `.jobber/ats-recipes/<platform>.candidate.json`, promoted only after `APPLY_RECIPE_PROMOTE_N` CONFIRMED submitted applications over `APPLY_RECIPE_PROMOTE_RUNS` run ids; held/unconfirmed never promote. The agent can also supply a recipe through the same declarative `proposeProvider`-style tool, subject to the same validation (D17). Drift under `LAYOUT_ENFORCE=enforce` refuses `apply_autofill`/`apply_submit` with `layout_drift`; escalation via `addEscalation(platform:'apply')`.
- [ ] Failing tests: shipped recipes validate; hostile selectors rejected; autofill on both ATS fixtures fills exactly the expected fields and stops before submit; `drifted-ats-a-form.html` -> `recipe_miss`; Workday-like three-step fixture without recipe completes by hand through `apply_next` to review; promotion rules; `observeAts` output has only vocabulary ids (property test over all fixtures); layout CLI lists `ats_*`; migration rejects a hostile entry. Verify with `npx vitest run tests/applier-recipes.test.ts tests/applier-autofill.test.ts tests/applier-recipe-learning.test.ts tests/layout-*.test.ts`, tsc. Commit `feat(applier): declarative ATS recipes, autofill fast path, drift detection and confirmed-only learning`.

### Task 20: Escalation, host cooldown, `applier` MCP wiring
**Files:** Create `src/applier/escalate.ts`, `cooldown.ts`, `src/mcp/applier.ts` (exports `TOOL_NAMES`: `apply_open|state|autofill|fill|choose|upload|next|submit|escalate|recipe|limits|close|screenshot`, plus `site_login`, `site_signup`, `site_open_link` shared from webcore), `tests/applier-{escalate,cooldown,mcp}.test.ts`. Modify `.mcp.json` (`applier`), `package.json` (`mcp:applier`), `config/permission-sets.json` (`read_only`: state/recipe/limits; `outreach_send`: all), `config/run-profiles.json`, hooks lists (every mutating tool in the kill-switch matcher; a test enumerates `TOOL_NAMES` against it), `SCREENED_SURFACES`, `src/db.ts` (additive `apply_host_blocks (host, kind, at)`), `tests/env-example-complete.test.ts` (`APPLIER_NO_MAIN`, `SCOUT_NO_MAIN` in INTERNAL), golden fixtures.
**Escalation:** `apply_escalate({job_id, reason, detail?})` with closed reasons (`captcha, mfa, phone_verification, email_verification, account_needed, question, consent, marketing_checkbox, host_unknown, drift, blocked, cover_letter, login_failed, other`); detail is code-built from the form model (screened, capped) plus an optional 100-char note passing the style gate; writes `addEscalation({platform:'apply'})` and `.jobber/notify.jsonl`, sets `apply_status='needs_owner'`. Blocks always stop: never solved, never waited out, never retried in the same run; two blocks on a host in 7 days start `APPLY_HOST_COOLDOWN_DAYS` (7) cooldown; a `bot_wall` streak of 3 across 2 run ids sets halt `apply` (owner clears with the existing halt-clearing path; read `src/scheduler/control.ts` first and extend `jobber:control` accordingly).
- [ ] Failing tests: each reason writes exactly one escalation; captcha fixture ends `needs_owner` with nothing typed after; cooldown rule; halt rule needs two run ids; no canary secret or answer value in any result; mutating tools all STOP-gated; permission sets exact. Verify and commit `feat(applier): escalation, cooldown, MCP server and kill-switch coverage`.

### Task 21: `apply-operator` and the wake `apply` task
**Files:** Create `.claude/agents/apply-operator.md`, `tests/apply-operator-lint.test.ts`. Modify `config/worker-tools.json`, `src/scheduler/plan.ts` (`apply` task with quota = `MAX_APPLIES_PER_DAY` remaining and `APPLY_MAX_ATTEMPTS_PER_DAY`), `.claude/agents/outreach-preparer.md` (unchanged apply fields), golden fixtures.
**Tools (exact):** `mcp__db__list_queued_outreach`, `mcp__db__update_outreach_status`, `mcp__applier__apply_open|state|autofill|fill|choose|upload|next|submit|escalate|recipe|limits|close`, `mcp__applier__site_login`, `site_signup`, `site_open_link`, and for `naukri` rows `mcp__naukri__naukri_open|state|click|type|layout`; Gmail read tools only when the profile enables `SITE_MAIL_VERIFY=gmail` (default lint: absent). No Skill/Write/Edit/Bash. Routing per row by `apply_platform`: `linkedin_easy` (only with `APPLY_LINKEDIN_EASY=true`; burner session through the applier for host `linkedin.com`), `naukri` (existing 2a answering rules and `naukri_apply` counter), registry ids and `browser` via `apply_open`. Never type a value (refs only), never navigate by URL, stop at `needs_owner`/`halted`/`rate_limited`/kill switch, one application at a time; unknown question -> returns `needs_owner` with the exact question to the wake session, which asks the owner on Telegram and (existing "Applying" step 2a) writes `custom` and re-dispatches. Result JSON: `{operator, applied:{submitted,held,manual_review,needs_owner,failed,rate_limited,queued}, needs_owner:[{job_id, reason, question?}], recipe:{matches,misses}}`.
- [ ] Failing tests: exact tool list; no Write/Bash/Skill; states the stop rules and the checkbox rule; planner emits `apply` only when rows exist and quota remains. Verify and commit `feat(agents): apply-operator and the wake apply task`.

### Task 22: Verification-link end to end (owner-assist and gmail modes)
Already unit-built in Task 6; this task wires the operator behaviour and hook rules and tests the full Workday-like flow with account creation on the fixture site: landing -> `site_signup` (marketing unchecked and verified, legal-required box checked) -> `needs_owner: email_verification` in `owner_assist`; in `gmail` mode with an allowlist: one allowlisted message text -> `site_open_link` -> `wd-signin` -> `site_login` -> step 1..3 by hand with `apply_next` -> review -> `held`. **Files:** `tests/applier-workday-flow.test.ts`, hook test additions, `apply-operator.md` section "Verification". 
- [ ] Failing flow test, implement glue, verify (`npx vitest run tests/applier-workday-flow.test.ts tests/hook-tool-allowlist.test.ts`), commit `test(applier): Workday-like multi-step flow with account creation and verification handoff`.

### Task 23: Remove scripted apply and the bootstrap
**Files:** Delete `src/mcp/apply.ts`, `src/mcp/applyAutoRouter.ts`, `src/apply/linkedin.ts`, `src/apply/external.ts`, `src/ats/*`, `src/lib/atsBootstrap.ts`, `src/lib/domSnapshot.ts`, `src/lib/domFallback.ts`, the three `.claude/commands` fallback files, `config/learned-ats-platforms.json`; modify `.mcp.json` (`apply` server removed), `package.json` (`mcp:apply`), permission sets, hooks lists, `.env.example` (remove `EASY_APPLY_HYBRID_FALLBACK`, `EXTERNAL_APPLY_HYBRID_FALLBACK`), golden fixtures, `tests/` for deleted code (resolve with `git grep -ln "apply/linkedin\|apply/external\|ats/\|atsBootstrap\|domSnapshot\|domFallback" -- tests`; `tests/linkedin-apply.test.ts` logic that tested the answer matcher moves to Task 17; `tests/hermetic-sessions.test.ts` lists must be updated).
- [ ] **Step 1: Failing guard test** `tests/legacy-apply-removed.test.ts` (deleted paths absent, no `mcp__apply__` string in `config/`, `.claude/`, fixtures; `.mcp.json` has no `apply`). **Step 2 to 4:** delete, `git grep -n "applyEasyApply\|applyExternal\|bootstrapFieldMap\|detectAts\|learned-ats\|mcp__apply__" -- src scripts config .claude tests .env.example` empty, `npx vitest run` (5 known failures), tsc. **Step 5:** commit `refactor(apply): remove scripted Easy Apply, hard-coded ATS scripts and the claude --print bootstrap`.

### Task 24: Doctor checks and dry-run stage
**Files:** Create `src/platform/checksSources.ts`, `src/platform/checksWeb.ts`, `tests/platform-checks-sources.test.ts`, `tests/platform-checks-web.test.ts`. Modify `src/platform/doctor.ts`, `scripts/dry-run.ts`.
| Id | Pass | Warn | Fail |
|---|---|---|---|
| `source_status` | registry loads; every enabled tenant vendor has a provider | enabled platform `flaky` or stale | registry invalid |
| `search_providers` | shows dork enabled/blocked-until, Serper key present, today's and month's usage vs budget | Serper over 80% of budget; dork in cooldown | both providers unavailable while email channel is on |
| `generated_providers` | none, or all validated/approved | candidates waiting review | a trusted provider with failing validation |
| `web_flags` | dry or `hold` | live with `submit` | `submit` + live while classifier not ready |
| `site_accounts` | file absent or 0600 in 0700 dir | account creation allowed with no accounts | wrong mode, symlink, or a password string in `.env` |
| `web_wired` | every web surface in `SCREENED_SURFACES`; every mutating tool in kill-switch list; agent tool lists match committed | | any mismatch |
| `apply_recipes` | shipped recipes validate | a learned recipe fails | |
| `legacy_removed` | no `mcp__apply__`, `mcp__discover__`, `discoverer`, `sender` in config or agents | | any present |
| `login_commands` | `naukri:login` and `linkedin:login` scripts exist and no `LINKEDIN_LOGIN_ACCOUNT` env read | | env read found |
`npm run dry-run`: add stages that run (a) the script pass over provider fixtures with one forced shape break (asserts a `source_tasks` row), (b) the scout dork engine over `serp-ok`/`serp-blocked` fixtures, (c) the applier against the fixture site in dry mode and in `hold` mode (asserts only `apply_attempt` moved). `--llm` never drives scout or applier.
- [ ] Steps: failing tests, implement, verify (`npx vitest run tests/platform-checks-*.test.ts tests/dry-run*.test.ts tests/platform-doctor*.test.ts`, tsc), commit `feat(doctor): sources, search, generated providers, web flags, accounts and legacy-removed checks; dry-run stages`.

### Task 25: Docs truth pass (single batch edit)
**Files:** `CLAUDE.md`, `README.md`, `.env.example` (comments only), `docs/architecture.md`, `docs/config-reference.md`, `docs/api-keys.md`, `docs/setup-modes.md`, `docs/layout-memory.md`, `docs/operations.md`, `docs/rollout.md`, `docs/phase2-known-issues.md`, `docs/telegram-slash-commands.md` (add `/sources`, `/runhunt` shim, `/apply`), `docs/linkedin-sessions-setup.md`, `docs/naukri-session-setup.md` (new login commands), `config/setup-guide.json`, new `docs/sources-and-providers.md`, new `docs/web-apply.md`, `docs/index.md`, ADR addendum `docs/superpowers/specs/2026-10-16-adr-addendum-sources-and-browser-apply.md`, doc lint tests. No code. Each item is a claim verified by command (same method as plan 8A Task 15); the commit body carries the table.
- [ ] Step 1 table; Step 2 edit; Step 3 verify (doc lint tests, tsc, full vitest: 5 known failures); Step 4 commit `docs: one source model, operators instead of the batch hunt, browser apply, Serper as contact finding`.

---

## Docs impacts (full list for Task 25)
- `CLAUDE.md`: "What this project is" (apply MCP gone; `applier`, `scout`, registry, operators, `linkedin_find_profiles` vs removed `connect` MCP clarification); Preferences "Target companies" (registry, `source_status`, generated providers, `custom` entries); "Running the hunt" REWRITTEN as "Running a wake" (script pass, pipeline steps, operators; `/runhunt` shim); step 6 report (source table, contact coverage, applies); "Applying" rewritten (browser, typed, refs, checkbox rule, escalation; hybrid fallback and bootstrap sections deleted); "Connecting" pointers; "Platform and sessions" (scripts `naukri:login`, `site:account`, `providers`, `mcp:applier`, `mcp:scout`; permission sets; run profiles without `hunt`); "Layout memory" (`ats_*`); "Outreach safety layers" (new surfaces, kill-switch list, `WEB_DRY_RUN`/`APPLY_DRY_RUN`/`SCOUT_DRY_RUN`); "Scheduler" (new task kinds, script pass); "Naukri" (login command, discover task, apply by apply-operator); "Known limits" (unverified lists, mail channel unscreened, Google dork terms); "Safety" rules 3, 6, 7 and a new rule for web agents (no free text, no CAPTCHA solving, marketing boxes unchecked, accounts only by typed tools); Commands table (`/runhunt` shim, `/apply`, `/applyall`, `/sources`).
- `README.md` (line 52 apikeys wording; commands; safety bullets), `docs/api-keys.md`, `docs/config-reference.md` (line 206), `docs/setup-modes.md` (row 5, skip table), `config/setup-guide.json`: Serper as contact finding, dork keys.
- `docs/architecture.md` (line 153 `board_status` row, source/channel diagram), `docs/operations.md`, `docs/rollout.md` (new phases for providers, discover tasks, applier), `docs/layout-memory.md`, `docs/phase2-known-issues.md`, `docs/telegram-slash-commands.md`, `docs/linkedin-sessions-setup.md`, `docs/naukri-session-setup.md`.

## Final verification (after Task 25)
```bash
npx tsc -p . --noEmit
npx vitest run
git grep -n "board_status" -- src .claude config
git grep -nE "mcp__apply__|mcp__discover__|applyExternal|applyEasyApply|bootstrapFieldMap|LINKEDIN_LOGIN_ACCOUNT|EXTERNAL_APPLY_HYBRID|EASY_APPLY_HYBRID" -- src scripts config .claude .env.example
git grep -nE "password" -- src/webcore src/applier | grep -v "role\|redact\|test\|type: 'password'"
git status --short
```
Expected: exactly the 5 known failures; `board_status` appears only in the alias handler, fixtures and shim notes; second and third commands empty; password only in `accounts.ts` and the typing call; no file under `secrets/`, `user-data/`, `.env*`, `.jobber/`, `generated/` committed.

## Hard limits for the builder
1. Never read `secrets/`, `user-data/`, `.env*`, `.jobber/`, `generated/`, `.dashboard/`, `data.sqlite`. Fixtures only; use `user-data.example/`.
2. No live site, no network, no `npm install`, no new dependency, no real browser, no real `claude`, no tmux. **Sole exception: Task 9 Step 1 to 2 may read the career-ops repository (clone/API) into a temp directory, nothing else.** No account is created anywhere, ever; sign-up runs only against fixtures.
3. Do not paste captured real vendor or job-site HTML into fixtures; write invented simplified pages with the header comment.
4. No tool may type a model-supplied string into a page, navigate to a model-supplied URL (exceptions: `scout_open` constrained to search-result/registry/task hosts, `site_open_link` constrained by the host rule), return a credential, solve or wait out a CAPTCHA/MFA/phone verification, check a marketing box, or execute model-written code.
5. Do not weaken `src/safety/*`, `src/linkedin/*`, `src/naukri/*`, hooks, `halt_flags`, dry-run rules. Additive only except the explicit deletions.
6. Do not flip dry-run flags, halts, permission sets, `APPLY_*`/`WEB_*`/`SCOUT_*` live flags or the kill-switch file. `.env.example` ships `WEB_DRY_RUN=true`, `APPLY_DRY_RUN=true`, `SCOUT_DRY_RUN=true`, `APPLY_SUBMIT_MODE=hold`, `APPLY_ALLOW_ACCOUNT_CREATION=false`, `SCOUT_ALLOW_SIGNUP=false`, `APPLY_ALLOW_UNKNOWN_HOSTS=false`, `APPLY_LINKEDIN_EASY=false`, `SITE_MAIL_VERIFY=owner_assist`, `DORK_ENABLED=true`.
7. Do not remove Serper, Hunter, the HN gate, the fact gate or the classifier. Do not change `MATCH_THRESHOLD`, `SEND_LIMIT_PER_RUN` or existing default caps.
8. Do not edit `CLAUDE.md`/`README.md` before Task 25. Commit only listed paths. Never push, never `--no-verify`.
9. If a step needs a decision this plan does not make, stop and ask.

## Owner decisions (recommended defaults)
| # | Question | Recommended |
|---|---|---|
| O1 | Accept the amended ADR and the wake-pipeline replacement of the batch hunt | yes (D4, D5) |
| O2 | Move all sends to operators (`mail-operator`, linkedin, naukri) on scheduler cadence | yes (D5) |
| O3 | Accept the ToS/robots/automation risk on job boards, ATS and company sites, and on automating Google results | your call; start with Greenhouse/Lever/Ashby and script providers, per-host cap 2/day, dork budget 30/day |
| O4 | Enable LinkedIn discovery with the main account (D6) at 12 discover runs/day | yes, supervised first (L2) |
| O5 | LinkedIn Easy Apply via the applier with the burner account | off (D9); decide after L5 |
| O6 | Account creation on apply sites (`APPLY_ALLOW_ACCOUNT_CREATION`) and on discovery sites (`SCOUT_ALLOW_SIGNUP`) | approved in principle (D11); turn on per supervised check, Workday last |
| O7 | Email verification mode | `gmail` with a short `SITE_MAIL_SENDERS` allowlist, accepting the injection channel (D13); otherwise `owner_assist` |
| O8 | Consent policy (D12) incl. `APPLY_ACCEPT_LEGAL_REQUIRED=true` | yes; marketing boxes always unchecked |
| O9 | Unknown company-site hosts for apply | no (D15) |
| O10 | Generated providers: matched but outreach held until you approve | yes (D7); `GEN_PROVIDER_PROMOTE_N=3` |
| O11 | career-ops import: proceed only if licence is MIT-compatible, ports `enabled:false` | yes (D8); expect fewer than 50 portable |
| O12 | Serper budgets (20/day, 200/month) and dork budget (30/day) | keep defaults; raise Serper only if dork blocks often |
| O13 | Use LinkedIn post authors as contacts (in Task 10) | yes when the profile verifies |
| O14 | Cover letters: omit when optional; build a drafting skill before required ones | yes (D12) |
| O15 | Keep `run-hunt.sh` and `/runhunt` as one-release shims | yes (D20) |
| O16 | Split into two PRs (8G-1, then 8G-2) | yes |

## Owner-only live checks (after merge; the builder cannot do these)
- **L1 Status table:** run one wake in dry mode; confirm the per-source table, a forced failure (unset `ADZUNA_APP_KEY`) shows an error row, and the old `BOARD_STATUS:` alias still answers once.
- **L2 LinkedIn discovery:** `LINKEDIN_DRY_RUN=false` for ONE supervised wake with the classifier fitted; confirm `jobs` rows appear with `source linkedin-jobs`/`linkedin-posts`, ids dedupe against old rows, `layout=` verdicts learned (use the 8B learning checklist for the `jobs`/`search` kinds), no checkpoint halt.
- **L3 Logins:** `npm run linkedin:login -- --account main` and `npm run naukri:login` (try without the flag on a TTY: y/N prompt; try with `LINKEDIN_LOGIN_ACCOUNT=main` set and no flag in a non-TTY: refused).
- **L4 Registry and fallback:** break a provider fixture slug on a copy of `portals.json`; confirm a `source_tasks` row, the `source-operator` fallback run, and a generated provider reaching `validated`; `npm run providers -- list`, review, `approve`.
- **L5 Hold mode:** one Greenhouse job, `APPLY_DRY_RUN=false`, `APPLY_SUBMIT_MODE=hold`: it fills by reference, uploads the PDF, stops at review (`held`); compare with the posting in your browser; verify every marketing box unchecked. Repeat for Lever, Ashby.
- **L6 First submit:** `APPLY_SUBMIT_MODE=submit` for ONE job; confirm `submitted` and the vendor confirmation email.
- **L7 Account walls:** create the account yourself first (`npm run site:account -- add <host>`), then one Workday application in hold mode; check no password appears anywhere. Only then try `APPLY_ALLOW_ACCOUNT_CREATION=true` on ONE tenant.
- **L8 Blocks:** note which sites show CAPTCHA/MFA/phone verification; confirm stop plus Telegram escalation, and the cooldown after two blocks.
- **L9 Search:** confirm dork results on 5 companies, force a block (disable network briefly) and confirm fallback to Serper under budget; `npm run doctor` shows usage.
- **L10 Kill switch:** during an apply and a scout run, `npm run jobber:control -- stop test`; the next mutating call must be denied.
- Before any of this: back up `data.sqlite` (additive tables), fully restart Claude Code and the ccgram windows (servers added/removed, agents, hooks, tool lists changed).

## Open risks
- Terms of service of every touched site, and Google's terms for automated queries (O3).
- Bot protection may stop headless Chrome on LinkedIn discovery, Workday and result pages; realistic "ANY ATS" coverage is unknown until L4 to L8.
- LinkedIn main-account search volume rises (D6); ban risk is the dominant cost (ADR).
- Agent cost: fallback and non-recipe applications are multi-step conversations; subscription limits apply.
- Declarative generated providers may overfit one sampled page; the clean-run rule and approval bound it.
- Mail verification (gmail mode) is an injection channel not classifier-screened.
- The wake session still orchestrates batch steps (D4); a very long wake can hit run budgets (`RUN_MAX_*`), in which case tasks resume next wake from the queue.
- Removing the old hunt before the new flow is live in dry run would leave no pipeline: Task 14 must merge only after Tasks 10, 11, 13 pass their dry-run stage.

## Self-review
- **Re-scope coverage:** 1 (remove old flow; exact removed/kept/renamed/migration) -> top sections, Tasks 14, 23; 2 (LinkedIn discovery by operator on the `linkedin` MCP; `linkedin_find_profiles` vs legacy `connect` stated) -> intro, Task 10; 3 (platform registry, career-ops import, script first with agent fallback that writes a validated generated provider; agent handles login and sign-up) -> Tasks 1, 2, 7, 8, 9, 6; 4 (owner-approved accounts, unchecked marketing boxes verified, unique code-generated passwords, typed tools only, gmail allowlist, CAPTCHA/MFA/phone stop, ToS risk stated) -> Tasks 5, 6, 18, 20, D11 to D13, Unverified; 5 (Serper kept and relabelled, dorking, search abstraction, quota counter, doctor) -> Tasks 3, 7, 24; 6 (Naukri model, `naukri:login`, login gate fix) -> Tasks 11, 12; 7 (one source table, shim) -> Tasks 1, 15. Retained: dry run, halts, kill switch, ceilings, classifier on every surface, `MAX_APPLIES_PER_DAY`, per-platform counters, discover-only, hermetic fixtures, decisions D1..D22, UNVERIFIED list, hard limits, 25 tasks in two sub-plans.
- **Ordering:** 1 -> 2; 3 independent; 4 -> 5 -> 6 -> 7 -> 8; 9 after 2; 10 and 11 after 1 and 4 (use registry/runtime); 12 independent; 13 after 2, 7, 10, 11; 14 after 13 (and 10, 11 live in dry run); 15 after 1, 13; 16, 17 independent of each other; 18 after 4, 5, 16, 17; 19 after 18 and 8 (selector rules); 20 after 18; 21 after 20 and 13; 22 after 6, 18, 21; 23 after 21 and 17 (answer matcher moved); 24 after 20; 25 last.
- **Names used consistently:** `PlatformDef`, `SourceStatusRow`, `source_status`, `source_tasks`, `platform_status`, `Provider`, `checkShape`, `searchWithBudget`, `SearchProvider`, `webcore`, `scout`, `source-operator`, `mail-operator`, `apply-operator`, `applier`, `AnswerRef`, `FormModel`, `FieldRole`, `site_login`, `site_signup`, `site_open_link`, `apply_*` tools, counters `apply_attempt`, `site_account`, `linkedin_discover`, global counter key `easy_apply`, layout platforms `ats_<id>`.
- **Placeholder scan:** test names marked "resolve with ls/git grep" must be resolved by the implementer with the stated command. Tasks 16 to 22 are written more compactly than 1 to 15; each still names files, behaviour, failing tests, verify and commit message, and the implementer expands steps in the same 5-step pattern.
