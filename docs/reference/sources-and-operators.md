<!-- Moved verbatim from CLAUDE.md; the rules in CLAUDE.md "Safety" and "Commands" still apply. -->

## Sources and operators

**Job description (JD) gate** (`src/jdComplete.ts`, `src/jdStore.ts`, `src/jdFetch.ts`). A JD is COMPLETE when the cleaned description is at
least 400 characters (a leading `Location:` line never counts) and does not end in `...`, `…`, `read more` or `show more`; `src/atsJd.ts`
reuses the same rule. The sources whose list pages give only a snippet are `JD_FETCH_SOURCES` (`naukri`, `linkedin-jobs`, and the manual
`manual:naukri` and `manual:linkedin`); API and board sources deliver full text and are never gated. Wellfound has no JD fetch tool: it is
left as it was (most of its jobs carry full text). `db.list_unscored_jobs` (matched list, unscored list and owner requests alike) does not
offer a job of those sources with an incomplete JD: code marks it `jobs.status = 'jd_pending'` (rows are never deleted), `save_match_result`
refuses to score it (`jd_incomplete`, no failed-match count) and `enqueue_outreach` refuses to prepare it. The typed read-only fetch tools
`naukri_fetch_jd` (naukri-operator task `jd_fetch`, planned by code before the pipeline) and `linkedin_fetch_jd` (an item of the LinkedIn drip
lane; a wake task only while the lane is off) take at most a job id: code picks the job, takes its URL from SQLite, loads the page, reads the
description section, runs the field gate and the classifier screen and stores it only when it is complete; the job then returns to unscored
(score and match fields cleared). A page that says the job is closed or removed, a URL that is not a plain job page, an injection-suspect text
or three reads without a complete JD mark it `jd_unavailable` (`excluded_reason`, queue rows skipped; a job already emailed, applied to or
messaged is never excluded). Ceilings `naukri_jd_fetch` (`NAUKRI_MAX_JD_FETCH_PER_DAY`, 60) and `linkedin_jd_fetch`
(`LINKEDIN_MAX_JD_FETCH_PER_DAY`, 20; each LinkedIn fetch is also a `linkedin_profile_view`). Queue rows prepared without a JD get status
`needs_reprep` (`npm run jd:backfill`, see docs/operations.md): not sendable, not applicable, rebuilt in place by `enqueue_outreach`. The page
structure of the real Naukri and LinkedIn job pages is NOT live-verified (selectors and closed-page phrases come from fixtures and known markup).

**Platform registry** (`config/platforms.json`, `src/sources/registry.ts`). One list of every job
source. A row is `{id, kind, label, provider, tier, enabled, stability, attribution?}`: `kind` is
`board`, `aggregator`, `api`, `search`, `linkedin`, `naukri`, `wellfound` or `generated`; `tier` is `script` (a
deterministic provider exists, `provider` is its module under `src/sources`) or `agent`
(operator-only, `provider: null`); `enabled` must be the boolean `true`; `stability` is `unverified`,
`fixture`, `live_ok` or `flaky`. A bad row or file is reported as an error string and the valid rows
still load (`loadRegistry` never throws). Shipped: the eight company-board vendors (Greenhouse,
Lever, Ashby, Workable, Recruitee, Personio, SmartRecruiters, Workday) enabled, the three
aggregators (Hacker News, Himalayas, We Work Remotely) disabled, Remotive and RemoteOK
enabled (`live_ok`), Naukri search enabled, the two LinkedIn operator sources enabled, the Wellfound
row (`id: wellfound`, kind `wellfound`, tier `agent`, `provider: null`, enabled, stability
`unverified`; the `wellfound-operator` runs it, see "Wellfound") and 18
imported career-ops providers disabled. The row being enabled is not what schedules Wellfound: the
planner schedules it only when `secrets/wellfound-state.json` exists and a discovery search is named.
`enabled` in the registry switches the `api`, `naukri`, imported-feed and generated providers on and
off (it is how you enable an imported feed). Company boards and the three aggregators are switched in
`config/portals.json` instead (`tracked_companies[].enabled`, `aggregators.<id>.enabled`, filters;
see "Preferences"); their registry rows list them for `source_status` and record their stability.
An entry with
`ats: "custom"` and an https `url` is an owner-listed site read by the `source-operator`, not a script
board.

**Script first, agent fallback** (`src/sources/runner.ts`). The code pass runs every enabled script
provider and checks the raw response against the provider's shape spec. A thrown error, a shape
mismatch or a drift (the shape changed and nothing was kept after a run that kept jobs) is recorded
for that source with `fallback_used`, and ONE `source_tasks` row per platform and company per day is
queued for the `source-operator`. Repeated failures set a `flaky` marker. Errors are redacted before
they are stored (secret-looking URL parameters first, capped at 300 characters).

**`source_status`** (`job-fetch.source_status`, read-only, never fetches; `npm run status -- sources`
and the `/sources` command show the same table): one row per source with `fetched`, `kept`, `new`,
`error`, `fallback_used`, `note`, `flaky` and `last_run_at`. `board_status` is kept as an alias for the
boards (per-company stats, `errors`, `dropped_duplicates`, `ran: false` if no fetch ran). Surface
errors and zero-kept sources in the run report so a dead slug, a dead provider or a malformed config
is never silent.

**`source-operator`** (tools: the `scout` MCP plus `db.list_jobs` and `outreach.escalate`; counts-only
result). Tasks: `manual_url` (an owner-submitted job page or careers page of a host the scheduler
could not read in code: reason `manual_url`, platform `manual`, the task row carries the URL that code
validated when the request was created; worked FIRST, saved at priority 1 under `manual:other`, the
report goes to the owner from code), `fallback` (read the page of a failed script source and save jobs
under source `gen:<platform>`), `new_site` (owner-listed `custom` sites, source `gen:custom`), `dork`
(find a company's careers page) and `author` (propose a declarative provider). `scout_open` accepts
only a URL returned by `scout_search` in this run, an ATS vendor host, the board of a source task, or
the URL of a `manual_url` task (nothing found on a page ever extends it). A block
(CAPTCHA, bot wall, MFA, phone check, login wall) is never worked around: the task is failed and
escalated. `scout_click` refuses submit, apply, sign-in and sign-up controls.

**Generated providers** (`src/sources/generated/`). A proposed provider is a JSON spec (data, never
code, schema in `src/sources/generated/spec.ts`), stored mode 0600 under the git-ignored
`generated/providers/` with its state in the `generated_providers` table:
`candidate` -> `validated` (fixture replay reproduces at least `GEN_PROVIDER_MIN_JOBS` jobs) ->
`trusted` (`GEN_PROVIDER_PROMOTE_N` clean runs over at least two distinct run ids). Nothing under
`generated/` is ever imported or executed. Jobs from a generated provider (`gen:*` sources) are
discover-only for apply, and their outreach rows stay HELD until the owner approves the provider with
`npm run providers -- approve <id>` (also `list`, `show`, `validate`, `reject`; `approve --promote`
prints a registry row to commit). The owner decides; the agent never approves.

**Imported career-ops providers.** 18 board-wide feeds under `src/sources/providers/` are hand-adapted
from `career-ops-hq/career-ops` (MIT licence; each file's header and the `attribution` field of its
registry row name the source and licence). All ship `enabled: false`, `stability: fixture`
(live-unverified, read from career-ops code only), and their terms of use and robots.txt are
unreviewed: check them before enabling one. `scripts/import-career-ops.ts` is an offline inventory
tool (it never fetches, ports code or enables anything). Report:
`docs/superpowers/specs/2026-10-16-career-ops-import-report.md`.

**Manual sources.** An owner-submitted job is saved at priority 1 under `manual:<kind>`: `manual:greenhouse`,
`manual:lever`, `manual:ashby`, ... for a known ATS vendor host (fetched in code), `manual:linkedin`,
`manual:naukri`, `manual:wellfound` (read by the platform operator's `<platform>_manual_job` tool: it loads
the task's URL from SQLite in the operator's own session, reads the title, first heading and visible text,
runs the input gate and the classifier screen and saves the job; no send, no apply, no ceiling consumed,
and page text never reaches the result) and `manual:other` (the `source-operator`). A `manual:<kind>`
source inherits the discover-only and apply rules of `<kind>` (`manual:workday` is discover-only like
`workday`; `manual:wellfound` follows `wellfound`); the title and company parsed from a platform page are
best-effort rules that no live page has verified.

**Discover-only rule** (`src/lib/discoverOnly.ts`). Jobs from Workable, Recruitee, Personio, Workday,
SmartRecruiters, the aggregators, every imported feed and every `gen:*` source (and their `manual:` twins)
are matched, get contacts and
email and connect outreach, but never an apply attempt: `db.enqueue_outreach` forces
`apply_platform: none`, and `apply_open` refuses them. Wellfound is NOT discover-only (it has the apply
tier `wellfound_agent`, see "Applying"); only `gen:*` and the sources above are. Hacker News company names and text come from
untrusted comment text (names are sanitized, the text never reaches an instruction, the `apply_url` is
the HN item page), and outreach for a Hacker News job is gated in code by the domain check described
under Preferences. The Himalayas and We Work Remotely attribution and terms are unverified.

**Search layer and contact finding** (`src/search/`). The kind `linkedin_people` (people dork for `linkedin_find_profiles`, run one layer at a time through `SearchDeps.skip`) shares these caches and budgets; see "Layered people discovery" in `docs/reference/connecting.md`. Company domain resolution is a ladder: explicit
parameter, a company-site `apply_url` host, the Hacker News posting domain, then search. Search tries the
cache first (`SEARCH_CACHE_TTL_DAYS`), then a browser dork (`DORK_ENABLED`, no daily cap,
cooldown `DORK_BLOCK_COOLDOWN_HOURS` after a block), then Serper under
`SERPER_DAILY_BUDGET` and `SERPER_MONTHLY_BUDGET`. Serper and Hunter are contact-finding tools, not job
sources; Hunter is the last-resort email source and runs only with `HUNTER_ENABLED=true` under
`HUNTER_MONTHLY_CAP`.

**Other operators.** `linkedin-operator` and `naukri-operator` (tasks `manual_url`, `inbox`,
`followups`, `new_outreach`, `discover`; see "Layout memory and platform operators"),
`wellfound-operator` (tasks `manual_url`, `inbox`, `discover`; see "Wellfound"), `mail-operator` (the
only agent that sends email, one item per run in the mail drip lane, or both passes from `/followups`;
cold emails and follow-ups under the shared daily `send_email` counter) and
`apply-operator` (see "Applying"). Each wake gives an operator a list of tasks with a `kind` and a
`quota`; a typed-tool refusal is final for that item.
