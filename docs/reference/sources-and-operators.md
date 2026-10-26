<!-- Moved verbatim from CLAUDE.md; the rules in CLAUDE.md "Safety" and "Commands" still apply. -->

## Sources and operators

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

**Search layer and contact finding** (`src/search/`). Company domain resolution is a ladder: explicit
parameter, a company-site `apply_url` host, the Hacker News posting domain, then search. Search tries the
cache first (`SEARCH_CACHE_TTL_DAYS`), then a browser dork (`DORK_ENABLED`, daily budget
`DORK_DAILY_BUDGET`, cooldown `DORK_BLOCK_COOLDOWN_HOURS` after a block), then Serper under
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
