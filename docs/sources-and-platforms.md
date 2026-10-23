# Sources and platforms

Audience: owner
Last verified against: 50917c8
Source files: config/platforms.json, config/portals.json, config/wellfound-discovery.json, config/naukri-discovery.json, src/manual/url.ts, src/manual/ingest.ts, src/manual/platformJob.ts, src/wellfound/discover.ts, src/sources/registry.ts, src/sources/runner.ts, src/sources/status.ts, src/sources/providers/index.ts, src/sources/generated/store.ts, src/sources/generated/spec.ts, src/sources/generated/validate.ts, src/lib/discoverOnly.ts, src/search/index.ts, src/scheduler/pipeline.ts, scripts/providers.ts, scripts/import-career-ops.ts, scripts/check-portal.ts, scripts/status.ts, src/platform/checksSources.ts, .claude/agents/source-operator.md

This page explains where Jobber's jobs come from, how to switch a source on, what happens when a
source breaks, and how generated providers are approved. It does not restate safety rules: those live
in [CLAUDE.md](../CLAUDE.md) under "Sources and operators" and "Safety".

## The platform registry

`config/platforms.json` lists every job source in one place. A row is `id`, `kind`, `label`,
`provider`, `tier`, `enabled`, `stability` and, for imported feeds, `attribution`.

| Field | Values | Meaning |
|---|---|---|
| `kind` | `board`, `aggregator`, `api`, `search`, `linkedin`, `naukri`, `wellfound`, `generated` | what sort of source it is |
| `tier` | `script`, `agent` | `script`: a deterministic provider module exists. `agent`: only an operator reads it (`provider` is `null`) |
| `enabled` | `true` or `false` | must be the boolean `true` to count as on |
| `stability` | `unverified`, `fixture`, `live_ok`, `flaky` | how far the source has been checked (see "What is verified") |

A bad row or a bad file is reported as an error string and the valid rows still load, so one typo
does not switch the other sources off. The registry is read on every code pass (the scheduler step
that runs the script providers), so an edit needs no restart.

What ships:

| Group | Sources | Shipped state |
|---|---|---|
| Company boards (tenants in `config/portals.json`) | Greenhouse, Lever, Ashby, Workable, Recruitee, Personio, SmartRecruiters, Workday | rows enabled; each company is switched on in `config/portals.json` |
| Aggregators | Hacker News Who is hiring, Himalayas, We Work Remotely | off |
| API sources | Remotive, RemoteOK | on (`live_ok`) |
| Naukri | Naukri search (four named searches in `config/naukri-discovery.json`, a random 2 to 5 second pause between searches) | on (`unverified`) |
| LinkedIn (agent tier, run by the `linkedin-operator`) | job search, hiring posts | on (`unverified`) |
| Wellfound (agent tier, run by the `wellfound-operator`) | named searches from `config/wellfound-discovery.json` | row on (`unverified`), but only planned once you have run `npm run wellfound:login` |
| Imported feeds | 18 board-wide feeds adapted from career-ops (below) | off |

Wellfound is the third platform next to LinkedIn and Naukri: a logged-in, headless session on your account
(`secrets/wellfound-state.json`), one named search, discovery every `WELLFOUND_DISCOVER_EVERY_HOURS` hours (default 6), an
inbox sweep, and the native Apply through the `apply-operator`. It never messages anyone cold. Nothing about it
has been checked against the real site yet (URL shapes, selectors, labels, the login cookie name, the promoted marker).
The wake plans it only when the session file exists and the discovery file names a search, so with no login nothing
is dispatched.

Serper and Hunter are not job sources. They are contact-finding services (see
[api-keys.md](api-keys.md)).

## Enabling a source

1. Company boards and aggregators: edit `config/portals.json` (`tracked_companies[].enabled`,
   `aggregators.<id>.enabled`; both must be exactly `true`). Check a new slug first:
   `npx tsx scripts/check-portal.ts <ats> <slug>`. Details and the filters are in
   [config-reference.md](config-reference.md).
2. API sources, Naukri and imported feeds: set `"enabled": true` on the row in
   `config/platforms.json`. For an imported feed, read its terms of use and robots.txt first (they
   are unreviewed, see below) and enable one feed at a time.
3. Sites with no provider: add a `tracked_companies` entry with `"ats": "custom"`, a `name`, an
   https `url` and `"enabled": true`. The `source-operator` reads such a site through the `scout`
   tools and saves what it finds under the source `gen:custom`.
4. Wellfound: run `npm run wellfound:login` (a headed Chrome window for a manual login; it saves
   `secrets/wellfound-state.json`), edit the search in `config/wellfound-discovery.json` if you want a different role or
   location, then `npm run doctor` (check `wellfound-session`). Remove the session file to switch Wellfound off.
5. After the next wake run `npm run status -- sources` and read the row for the source. `npm run doctor` has the checks `source_status`, `search_providers` and `generated_providers`.

## Reading the source table

`npm run status -- sources` (also the `/sources` command and the `job-fetch` tool `source_status`)
prints one row per source: `fetched`, `kept` (passed your filters), `new` (not seen before),
`error`, `fallback_used`, `note`, `flaky` and `last_run_at`. It never fetches. The older
`board_status` tool is kept as an alias that returns the board-only part. Errors are redacted before
they are stored. A source marked `flaky` has failed on repeated runs.

## When a script provider breaks

A script provider checks the raw response against the shape it expects. A thrown error, a shape
mismatch or a drift (the shape changed and nothing was kept after a run that kept jobs) is recorded
with `fallback_used`, and one `source_tasks` row per platform and company per day is queued. In the
next wake the `source-operator` opens the page through the read-only `scout` tools, extracts the jobs
and saves them as `gen:<platform>`. It never applies, never types free text into a page and stops at
any CAPTCHA, bot wall, MFA or login wall (the task is failed and an escalation is written).

## Generated providers (held for your approval)

The `source-operator` may propose a provider for a platform whose page it captured. A proposal is a
JSON spec (selectors or JSON paths and a few field names), never code: nothing under `generated/` is
imported or executed. States:

1. `candidate`: stored, not yet checked.
2. `validated`: replaying the captured fixture reproduces at least `GEN_PROVIDER_MIN_JOBS` jobs.
3. `trusted`: `GEN_PROVIDER_PROMOTE_N` clean runs over at least two distinct run ids.

Jobs from a generated provider (sources named `gen:<id>`) are never applied to, and their outreach
rows stay held until you approve the provider. You decide:

```bash
npm run providers -- list
npm run providers -- show <id>
npm run providers -- validate <id>
npm run providers -- approve <id>
npm run providers -- reject <id>
```

`approve` releases the provider's held outreach rows (it refuses a provider that is not yet trusted
unless you pass `--force`, which prints a warning); `approve <id> --promote` also prints a registry
row to commit. `reject` deletes the spec and skips its held rows. `list` marks a trusted provider
that waits for you as `READY FOR REVIEW`. The agent never approves a provider.

## Imported career-ops providers

Eighteen board-wide feeds are hand-adapted from the MIT-licensed repository
`career-ops-hq/career-ops` (copyright 2026 Santiago Fernandez de Valderrama). Each file under
`src/sources/providers/` names its source file and commit on line 1, each registry row carries an
`attribution` with the source, the licence (MIT) and the project URL, and the licence text is quoted
in `docs/superpowers/specs/2026-10-16-career-ops-import-report.md`.

The ids: `4dayweek`, `arbeitnow`, `jobicy`, `workingnomads`, `themuse`, `landingjobs`, `thehub`,
`flowxtra`, `yourator`, `getonbrd`, `justjoin`, `manfred`, `cryptocurrencyjobs`, `jobspresso`,
`larajobs`, `nodesk`, `pythonorg`, `startup-jobs`.

All ship disabled with `stability: fixture`: their response shapes were read from career-ops code
only and have not been checked against the live sites, and the terms of use and robots.txt of each
site are unreviewed. `scripts/import-career-ops.ts` is an offline inventory tool for a local
checkout; it never fetches, ports code or enables anything.

## Owner-submitted pages (manual requests)

You can hand Jobber one job page or one company careers page at any time, from Telegram (`/apply <https url> [--force]`),
from a shell (`npm run apply:request -- <https url> [--force]`) or from the dashboard Apply tab. The URL is checked in code
(https only, no credentials or port, no look-alike ATS host, at most 500 characters; a LinkedIn, Naukri or Wellfound URL must
be a job page). The scheduler wakes within about 30 seconds outside quiet hours and ingests the request: a known ATS vendor
URL is fetched in code (the whole board, capped at 25 jobs, for a careers URL), a LinkedIn, Naukri or Wellfound job page is read
by that platform's operator (`linkedin_manual_job`, `naukri_manual_job`, `wellfound_manual_job`), any other page by the
`source-operator` (task `manual_url`). The jobs are saved at priority under `manual:<kind>` (for example `manual:greenhouse`,
`manual:other`), go through the whole pipeline FIRST (at most 10 per wake, outside the 24-hour window and the duplicate rule),
and you get a per-request report on Telegram written by code. The apply and discover-only rules of a `manual:<kind>`
source are those of `<kind>`. Every gate, cap and veto still applies; `--force` also prepares a score below the match
threshold and lifts the 90-day repeat-contact guard.

## Discover-only sources

Jobs from Workable, Recruitee, Personio, Workday, SmartRecruiters, the three aggregators, every
imported feed and every `gen:*` source (and their `manual:` twins) are matched and get email and LinkedIn outreach, but are never
applied to: `db.enqueue_outreach` stores `apply_platform: none` and `apply_open` refuses them. Hacker
News text is untrusted comment text, and outreach for a Hacker News job is held back unless the
company domain found in the posting matches the resolved company domain. Wellfound is not discover-only.

## What is verified

Everything here is covered by unit tests with fakes and fixtures only. The `stability` column says
the same thing per source: only Remotive and RemoteOK are marked `live_ok`; the vendor boards
and Hacker News, Himalayas and We Work Remotely are `fixture` or `unverified`, and so are LinkedIn, Naukri and
Wellfound (Wellfound, the manual page readers and the promoted markers have never seen a live page). The terms of the
search engine used by the browser dork, and of every site a scout may read, are unreviewed.
`CLAUDE.md` "Known limits and not yet live-verified" is the authority.
