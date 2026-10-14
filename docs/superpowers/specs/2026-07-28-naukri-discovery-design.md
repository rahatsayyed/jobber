# Naukri.com Discovery + Apply

## Problem

Job discovery currently pulls from Adzuna, Remotive, RemoteOK (API-based) and LinkedIn (Playwright,
burner account). Naukri.com is a major India-market job board with none of this coverage. Unlike
the API sources, Naukri has no public API and requires scraping; unlike LinkedIn, its listings are
publicly browsable without login, but its apply flow is either (a) an external redirect to the
employer's real ATS, or (b) — not yet observed live, but presumed to exist for some postings — a
Naukri-native "Quick Apply" requiring a logged-in session.

## Findings From Live Investigation (2026-07-28)

- Naukri's search-results and job-listing pages are fully public — no login required to browse.
- Real, verified selectors on the search-results page: card = `.srp-jobtuple-wrapper`, title+href =
  `a.title`, company = `.comp-name`, description = `.job-desc`.
- **Naukri sits behind Akamai Bot Manager.** Headless Playwright (`chromium.launch({headless:
  true})`) is blocked with a hard "Access Denied" page served from Akamai's edge
  (`errors.edgesuite.net`) — confirmed on the search-results page, a job-listing page, and with an
  authenticated session. A normal headed browser (`headless: false`) reliably gets through. One
  headless workaround (`channel: 'chrome'`, real installed Chrome) succeeded once then failed
  identically on an immediate repeat — inconsistent enough (and far enough into adversarial
  territory) not to build on. **Decision: both discovery and apply run `headless: false`.** This
  requires a virtual display (e.g. Xvfb) wherever this runs without a physical display — an
  operational/deployment concern, not something this spec's code needs to configure.
- No poster/recruiter contact info (name, email) is exposed on the public listing page — only
  company name. `contacts.find_company_emails` (company-domain-based) is unaffected and needs no
  Naukri-specific changes.
- Naukri's apply button resolves differently depending on auth state and job type:
  - **Logged out:** always a generic "Apply" button that opens a login modal in-page (no external
    redirect visible pre-auth).
  - **Logged in, tested on 2 real full-stack-developer listings:** both revealed an **"Apply on
    company site"** button instead, which — confirmed live — navigates (new tab, no submission) to
    the employer's real ATS. One resolved to `fedex.paradox.ai` (Paradox AI, an ATS unrecognized by
    any of this project's 4 built-in platforms — exactly the case `apply.auto`'s self-extending ATS
    bootstrap already handles).
  - A pure Naukri-native "Quick Apply" (no external site, submits through Naukri itself) was not
    observed in this sample. It may exist for other job types/postings. This spec does not
    implement it — see Out of Scope.

## Goal

1. Add Naukri as a new discovery source, feeding the existing `Job` pipeline exactly like
   Adzuna/Remotive/RemoteOK (match → contact-find → outreach/apply), with no new MCP tool or config
   file.
2. For each discovered job, resolve the *real* apply destination (following "Apply on company
   site" where present) so `apply_url` is the employer's actual ATS URL, not the Naukri listing
   page — this is what lets `apply.auto`'s existing ATS detection/bootstrap pipeline handle Naukri
   jobs with zero Naukri-specific apply code.

## Architecture

`src/sources/naukri.ts` — a new source module, `fetchNaukriJobs({role, location}): Promise<Job[]>`,
registered in `src/sources/index.ts`'s `fetchAllJobs` alongside the existing three sources.

Two-phase fetch, both phases `headless: false`:

1. **Search phase (no auth):** launch → goto the role/location search URL (slugified into the URL
   path, e.g. `https://www.naukri.com/full-stack-developer-jobs-in-india`) → scrape job cards via
   `page.locator('.srp-jobtuple-wrapper').evaluateAll(...)`, with the callback logic inlined
   directly (no nested named function declarations — see the `__name`/esbuild bug fixed in the ATS
   bootstrap work; the same class of bug would silently break this too if not avoided from the
   start). Extract title, company, description, and the listing URL. Extract a stable `id` from the
   listing URL's trailing numeric segment (e.g. `...-1504265` → `naukri:1504265`).
2. **Resolve-apply-url phase (authenticated, `secrets/naukri-state.json`):** for each newly
   discovered job (only new ones — never touch already-seen jobs, keeping this phase cheap), open
   the listing page in an authenticated context, look for `.company-site-button`. If present, click
   it, capture the new tab's URL, close the tab, and use that URL as `apply_url` (falling back to
   the Naukri listing URL itself if the button isn't found or times out, so a slow/atypical posting
   degrades to "Naukri listing as apply_url" rather than failing the whole job). If
   `secrets/naukri-state.json` doesn't exist, skip this phase entirely and use the Naukri listing
   URL as `apply_url` for every job (same graceful-degradation shape as `linkedin-jobs.ts`'s
   missing-burner-state check).

Dedup via the existing `isSeen`/`saveJob` pair, unchanged — `job-fetch.list_new_jobs` and
`job-fetch.search_jobs` pick up Naukri jobs automatically, no orchestration changes needed
elsewhere.

## Components

- **`src/sources/naukri.ts`** (new)
  - `buildNaukriSearchUrl(role: string, location?: string): string` — pure, slugifies role/location
    into the URL path.
  - `extractNaukriJobId(url: string): string | null` — pure, extracts the trailing numeric segment.
  - `export interface RawNaukriCard { titleText: string | null; companyText: string | null; hrefRaw: string | null; descriptionText: string | null }`
  - `export function parseNaukriCards(rawCards: RawNaukriCard[]): { jobs: Job[]; found: number; parsed: number; skipped: number }` —
    pure, mirrors `parseLinkedInJobCards`'s shape (malformed cards skipped and logged, not thrown).
  - `export async function resolveApplyUrl(page: Page): Promise<string | null>` — clicks
    `.company-site-button` if present, returns the new tab's URL or `null` if the button doesn't
    exist/times out. Navigation only, never a submission — this function must never click anything
    else on the page.
  - `export async function fetchNaukriJobs(deps: NaukriDeps = {}): Promise<Job[]>` — orchestrates
    both phases, `headless: false` for both browser launches, injectable `chromium`/`db`/
    `sessionStatePath` for testing (mirrors `LinkedInJobsDeps`).

## Error Handling

- A malformed job card (missing title or href) is skipped and logged, not thrown — matches
  `parseLinkedInJobCards`'s existing convention.
- `resolveApplyUrl` failing (button not found, new-tab timeout) falls back to the Naukri listing
  URL as `apply_url` — the job is still captured, just routed through `apply.auto`'s existing
  `manual_review`-on-unresolved-domain path (or the ATS-bootstrap attempt, if the fallback URL
  somehow still resolves to something) rather than being dropped.
- Missing `secrets/naukri-state.json` degrades to "listing URL as apply_url for every job," not a
  failure — mirrors `linkedin-jobs.ts`'s missing-burner-state handling exactly.
- The whole fetch is wrapped in try/catch returning `[]` on unexpected failure, matching every
  other source in `src/sources/`.

## Testing

Unit tests (pure functions only — no live browser, no live Naukri):

- `buildNaukriSearchUrl`: role/location slugification, special characters, missing location.
- `extractNaukriJobId`: real URL formats extract the correct numeric ID; malformed URLs return
  `null`.
- `parseNaukriCards`: valid cards parsed correctly; a card missing title/href is skipped and
  counted, not thrown; the returned `Job.id` is `naukri:<id>`.
- `resolveApplyUrl` and `fetchNaukriJobs` are Playwright-touching wrappers — not unit-tested
  beyond dependency injection allowing a fake `page`/`context`/`chromium` in a possible future
  integration-style test, matching this codebase's existing convention for browser-touching code
  (`snapshotFormControls` in the ATS-bootstrap work took the same approach).

Live verification: real live testing already happened DURING this design (not deferred) —
`.srp-jobtuple-wrapper`/`a.title`/`.comp-name`/`.job-desc` selectors, the Akamai headless block,
and the `.company-site-button` → `fedex.paradox.ai` resolution were all confirmed against real
Naukri pages before this spec was written. What remains untested-live is the full
`fetchNaukriJobs` orchestration function itself (the two-phase flow end-to-end) and — see Out of
Scope — the native "Quick Apply" case, since no example of it was found in this investigation.

## Out of Scope

- **Naukri-native "Quick Apply."** Not observed live in this investigation (both sampled listings
  used "Apply on company site"). If a future discovery run surfaces a job with no
  `.company-site-button`, it falls back to using the Naukri listing URL as `apply_url` — which will
  correctly land in `manual_review` via `apply.auto` (Naukri's own domain matches none of the known
  ATS platforms, and bootstrapping against a login-walled Naukri page would fail closed the same
  way Cutshort did in the ATS-bootstrap live-verification earlier). A dedicated `apply.naukri` tool
  (mirroring `apply.linkedin`'s shape) is a natural follow-up once a real native-apply flow is
  observed to design against — not before, per this project's practice of never speccing an
  automation flow it hasn't seen live.
- **Pagination / multi-page fetch.** Single search-results page per role/location, matching
  Adzuna's single-page-per-call convention (`results_per_page: 50`) — consistent with this
  project's existing scale, not a hard technical limit.
- **A `discover-naukri.json` config file.** Role/location come from the same `fetchAllJobs({role,
  location})` params Adzuna/Remotive already use — no new config surface needed.
