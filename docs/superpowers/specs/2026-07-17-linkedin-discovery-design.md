# Jobber — LinkedIn Job & Hiring-Post Discovery — Design

- **Date:** 2026-07-17
- **Status:** Design approved — pre-implementation
- **Location:** repository root
- **Builds on:** Phase 1 discovery (`docs/superpowers/specs/2026-07-06-jobapplier-phase1-design.md`), which introduced `job-fetch` (Adzuna/Remotive/RemoteOK APIs + Serper Google-dork hiring-post search). This spec adds LinkedIn as a discovery source alongside those, unchanged.

---

## 1. Goal

Discovery today is limited to what public job-board APIs return (Adzuna, Remotive, RemoteOK) plus whatever LinkedIn hiring posts Google has indexed (via Serper dorks). This misses the large volume of postings and hiring posts that live natively on LinkedIn and never get indexed. This spec adds two new, logged-in LinkedIn discovery sources — job search results and hiring-post search — as part of a larger effort that will later add Naukri.com and X.com as additional sources (each gets its own spec; this one is scoped to LinkedIn only).

## 2. Motivation

LinkedIn is the largest single source of both job postings and informal "we're hiring" posts, and Google's index only covers a fraction of either. A logged-in, in-app search sees everything, not just what's indexed. The existing Serper dork search stays as a cheap, no-login supplement; this adds a richer, more complete source on top of it.

## 3. Scope

**In:**
- `discover.linkedin_jobs()` — scrapes LinkedIn's job search results page.
- `discover.linkedin_posts({role, geo})` — scrapes LinkedIn's content search for hiring-intent posts.
- Both burner-account only, both feed into the same `jobs` table via the existing `isSeen`/`saveJob` dedup contract every other source already uses.
- Per-run result caps and a partial-scraping-tolerance parsing contract (a malformed card is skipped, not fatal).

**Out (this spec):**
- Naukri.com and X.com discovery — separate specs, separate implementation.
- Replacing the Serper dork search — it stays, unchanged, as a parallel source.
- Any daily/session rate limit — discovery is read-only (no messages sent to real people), so the risk profile doesn't need a counter the way `apply`/`connect` do.
- Full job-description scraping (visiting each job's own page) — only the search-result-card snippet is captured, matching the shallow-description quality of the existing sources.

## 4. Architecture

A new MCP server, `discover` (`src/mcp/discover.ts`), following the same "one server, one tool per capability" shape already used by `apply` (`apply.linkedin`, `apply.greenhouse`, etc.). It is kept **separate from `job-fetch`** — `job-fetch`'s existing sources (Adzuna, Remotive, RemoteOK, Serper) are all plain HTTP API calls with no session state and no browser; LinkedIn discovery requires Playwright, a logged-in session, and inherits the same failure modes (selector rot, login expiry, detection/rate-limiting) as `connect.ts`/`linkedin-apply.ts`/`external-apply.ts`. Splitting it into its own server matches that existing precedent and leaves room for `discover.naukri`/`discover.x_posts` as siblings later without touching this code.

```
src/
├─ mcp/
│  └─ discover.ts              # new MCP server: registers linkedin_jobs, linkedin_posts
├─ discover/
│  ├─ linkedin-jobs.ts         # Playwright: load config, navigate, scrape, parse, dedup+save
│  └─ linkedin-posts.ts        # Playwright: build content-search query, scrape, parse, dedup+save
config/
└─ discover-linkedin.json      # jobs.search_url, jobs.limit, posts.role, posts.geo, posts.limit
tests/
└─ discover-linkedin.test.ts   # pure parser tests against fixture HTML, no live LinkedIn hits
```

## 5. Config — `config/discover-linkedin.json`

Committed to the repo (no secrets — same tracked-not-gitignored pattern as `config/easy-apply-answers.json`), single active configuration (not a list — matches how Role/Location work today as one active target in CLAUDE.md's Preferences section):

```json
{
  "jobs": {
    "search_url": "https://www.linkedin.com/jobs/search/?keywords=full+stack+developer&location=India&f_TPR=r86400",
    "limit": 25
  },
  "posts": {
    "role": "full stack developer / react",
    "geo": "in",
    "limit": 25
  }
}
```

- `jobs.search_url` is built by the user directly in a browser (apply whatever LinkedIn filters you want — date posted, remote, experience level, easy-apply-only — then copy the resulting URL). The recommended date-posted filter is "Past 24 hours" to avoid stale postings, but this is not enforced in code — whatever filter is baked into the URL is what gets scraped.
- `jobs.limit` / `posts.limit` are independent caps (not a single shared limit) so job-search volume and post-search volume can be tuned separately.
- `posts.role` / `posts.geo` drive the content-search query the same way `serper.ts`'s `buildQueries(role, geo)` does today (reused hiring-keyword heuristics), sorted by latest — no separate date filter, no repost-exclusion (YAGNI — reshare detection isn't reliably identifiable from the DOM and latest-sort + per-run cap + dedup is enough).

## 6. Tools

### `discover.linkedin_jobs()`

No input params — reads `config/discover-linkedin.json`'s `jobs.search_url`/`jobs.limit` fresh on every call (same `readFileSync`-per-call pattern as `config/easy-apply-answers.json`, so editing the config never needs an MCP reconnect).

1. Load the burner session (`secrets/linkedin-burner-state.json` — **never** `linkedin-main-state.json`, same hard rule as `linkedin-apply.ts`).
2. Navigate to `jobs.search_url`.
3. Scrape job cards up to `jobs.limit`, extracting: title, company, url, apply_url, easy-apply flag, description snippet.
4. Parse via `parseLinkedInJobCards(html)` (pure function — see §8).
5. Extract each job's own numeric ID from its URL (`/jobs/view/<id>`) → `id: li-job:<id>`.
6. Filter via the existing `isSeen`/`saveJob` against `data.sqlite` (identical contract to `job-fetch.list_new_jobs`).
7. Return only new jobs as `Job[]`.

### `discover.linkedin_posts({role, geo})`

Params optional — falls back to `config/discover-linkedin.json`'s `posts.role`/`posts.geo` if omitted.

1. Load the burner session (same file, same rule).
2. Build a LinkedIn content-search query from `role`/`geo` (reusing the hiring-keyword phrasing already in `serper.ts`'s `buildQueries`), sorted by latest.
3. Scrape post cards up to `posts.limit`.
4. Parse via `parseLinkedInPostCards(html)` (pure function — see §8).
5. Derive each post's ID from a content-based hash (`buildSyntheticPostId(profileUrl, text)`, sha256 of the author's profile URL + first 100 chars of post text, truncated) → `id: li-post:<hash>`. This is a fallback from the originally-planned activity-URN extraction: live testing confirmed LinkedIn's content-search results page exposes no anchor containing `urn:li:activity` (or any other post permalink) anywhere in the card DOM — every anchor in a real card is a profile link, company link, hashtag link, or safety-redirect link. `url`/`apply_url` on the produced `Job` point to the author's profile URL instead of a post permalink, since none exists.
6. Filter via `isSeen`/`saveJob`.
7. Return only new jobs as `Job[]`.

## 7. Uniqueness / dedup

Both tools reuse the exact `isSeen`/`saveJob` mechanism every existing source already relies on — no new dedup logic. The only new thing is the ID scheme:

- LinkedIn jobs → `li-job:<linkedin-job-id>` (extracted from the job's own URL).
- LinkedIn posts → `li-post:<content-hash>` (sha256 of the author's profile URL + post text, truncated to 16 hex chars) — not an activity URN, since LinkedIn's content-search results expose no post permalink in the DOM (discovered via live testing; see §6).

No cross-source dedup is needed: IDs are prefixed per source (`li-job:`, `li-post:`, vs. existing `dork:`, `adzuna:`, etc.), so occasional overlap between LinkedIn's own jobs and posts search (or with the Serper dork results) is a tolerated duplicate — the same situation that already exists across Adzuna/Remotive/RemoteOK today.

## 8. Partial scraping tolerance

Scraping is inherently brittle — LinkedIn's DOM changes, and any individual card can be malformed relative to what the parser expects. Neither parser fails the whole page over one bad card:

- `parseLinkedInJobCards(html)` and `parseLinkedInPostCards(html)` iterate cards individually, each wrapped in its own try/catch.
- A card that throws during parsing is skipped and counted, not fatal — the function returns whatever it successfully parsed.
- Skipped counts are logged server-side: `[discover] linkedin_jobs: 23/25 parsed, 2 skipped (malformed)` — matching the existing pattern in `serper.ts`, where a failed dork query is caught, logged, and treated as an empty result rather than failing the whole fetch.
- This doesn't change the `Job[]` return contract — it's resilience plus visibility into how much silent loss is happening over time, nothing more.

## 9. Auth / safety

- Burner account only (`secrets/linkedin-burner-state.json`) — same file `apply.linkedin` already uses. `discover.ts` must never load `linkedin-main-state.json`.
- **Not ToS-safe** — LinkedIn's terms prohibit automated scraping. Real account risk exists: rate-limiting, "unusual activity" checkpoints, temporary restriction, or a ban. This is the same risk category already accepted for Easy Apply and connect automation elsewhere in this project; using the burner account contains the blast radius to a throwaway account, it does not eliminate the risk.
- Mitigation: modest per-run caps (`jobs.limit`/`posts.limit`, default 25 each), no rapid-fire requests, normal hunt cadence (not run excessively often).
- **No daily rate limit** — unlike `apply`/`connect`, this is read-only and sends nothing to real people, so a `MAX_*_PER_DAY`-style counter isn't warranted; the per-run caps above are the only volume control.

## 10. Pipeline integration

The `discoverer` subagent (`.claude/agents/discoverer.md`) gets `discover.linkedin_jobs` and `discover.linkedin_posts` added to its tool allowlist. It now calls three sources instead of one:
1. `job-fetch.list_new_jobs({role, location})` (unchanged — Adzuna/Remotive/RemoteOK/Serper).
2. `discover.linkedin_jobs()`.
3. `discover.linkedin_posts({role, geo})`.

It concatenates all three arrays and returns the combined list — no merge/dedup logic needed at this layer (handled per-tool as described in §7). `CLAUDE.md`'s "Running the hunt" step 1 (Discover) needs a one-line update noting the additional sources; step 2 (Match) onward are unaffected since they already operate on the generic `Job` shape regardless of source.

## 11. Testing

- `tests/discover-linkedin.test.ts`: pure-function tests for `parseLinkedInJobCards(html)` and `parseLinkedInPostCards(html)` against fixture HTML (captured/hand-built card markup, including at least one deliberately malformed card per test to verify §8's partial-tolerance behavior) — no live LinkedIn hits in the suite, same style as `connect.test.ts`.
- No live-scrape test is required before merge (matching the project's existing precedent of a documented "not yet live-tested" gap for `external-apply.ts` — this will need its own live verification pass after implementation, tracked the same way).

## 12. Open items / explicitly deferred

- Naukri.com discovery — separate spec.
- X.com hiring-post discovery — separate spec.
- Full job-description fetching (visiting each posting's own page) — deferred; snippet-only for now.
- Any daily cap on `discover` calls — deferred until real-world usage shows it's needed.
