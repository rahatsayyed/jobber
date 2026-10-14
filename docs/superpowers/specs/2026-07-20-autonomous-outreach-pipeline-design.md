# Jobber — Autonomous Outreach Pipeline — Design

- **Date:** 2026-07-20
- **Status:** Design approved — pre-implementation
- **Location:** repository root
- **Builds on:** Phase 1 (email hunt), Phase 2 (LinkedIn Easy Apply / external ATS apply / human-gated connect), and the LinkedIn Discovery feature (`docs/superpowers/specs/2026-07-17-linkedin-discovery-design.md`). This spec redesigns the hunt pipeline's contact/outreach/send stages to remove two existing human-gates (per explicit user decision, see §9) and decouple preparation from sending via a persistent queue.
- **Split from this design:** self-extending external-apply platform bootstrapping (Claude+Playwright driving an unknown ATS live, logging a trace, generating a reusable script from it) is explicitly OUT of scope here — it's a separate subsystem with its own open design questions and gets its own spec/plan later.

---

## 1. Goal

Turn the hunt pipeline from "find jobs → email a shortlist for the human to act on" into a genuinely autonomous outreach pipeline: find jobs, find both an email contact and LinkedIn people to connect with, prepare everything in parallel, then execute sends/connects/applies from a persistent queue — with rate caps enforced atomically and a Telegram-based path to raise a cap for a specific run when it's hit, instead of either silently stopping or silently blowing past it.

## 2. Scope

**In:**
- Drop Serper from `job-fetch` (LinkedIn Discovery's logged-in search supersedes what the Google-dork search covered).
- `matcher` extracts structured fields (`company`, `title`, `apply_method`) from raw LinkedIn-post-sourced jobs while scoring them.
- `contact-finder` expanded to find BOTH a verified company email AND LinkedIn profiles to connect with — two categories: a recruiter/HR/TA contact, and a peer already in a similar role at the company.
- `outreach-preparer` expanded to draft everything (resume, email, connect note) and persist it to a new `outreach_queue` table — no sends.
- `sender` expanded to read the queue backlog and execute email sends, connect sends, and applies, each behind an atomic per-day cap, with a Telegram prompt-and-wait when a cap is hit mid-run.
- `connect_send`'s per-note human-approval gate is removed.
- `AUTO_APPLY_ENABLED`'s opt-in gate is removed (flags to be reintroduced later, per explicit user instruction — not designed here).
- The `sqlite` MCP is renamed `db` and extended with write-capable tools so subagents can enqueue/update outreach items without needing raw SQL access.
- `MATCH_THRESHOLD` default changes from 70 to 60 (env var, unchanged mechanism).
- Connect notes: hard 300-character cap (already established for `draft-connect-note`, reaffirmed here as binding), and must reference the specific job/role being connected about.

**Out (this spec):**
- Self-extending ATS platform bootstrapping (point 5 from the brainstorm) — separate spec/plan.
- Reintroducing `AUTO_APPLY_ENABLED`-style flags — deferred, per explicit user instruction.
- Naukri.com / X.com discovery — separate specs (from the LinkedIn Discovery spec's own deferred list, still deferred).

## 3. What's explicitly changing vs. today (on the record)

| Behavior | Today | This spec |
|---|---|---|
| `connect_send` approval | Requires a Telegram "send" reply per note before sending | Sends automatically, no per-note approval |
| Applying | Opt-in via `/apply`/`/applyall` command, or `AUTO_APPLY_ENABLED=true` for autonomous runs | Unconditionally part of every hunt run, no flag |
| `SEND_LIMIT_PER_RUN` enforcement | Single `sender` dispatch counts sends in-memory during one call | Atomic `daily_counters` check (`checkAndIncrement`), same mechanism already used for `MAX_APPLIES_PER_DAY`/`MAX_CONNECTS_PER_DAY` — semantically becomes a **daily** cap, not a strict per-invocation cap, since the counter is date-keyed. If the hunt runs more than once a day, the cap applies across all runs combined that day, not per individual run. |
| Prep → send timing | One `outreach-preparer` dispatch per job produces a ready-to-send item that `sender` receives directly, same run | `outreach-preparer` writes to a persistent `outreach_queue` table; `sender` processes the **entire backlog** of queued rows (including anything left over from a previous run that hit a cap), not just this run's fresh items |
| Cap-reached behavior | `sender` reports `queued — send limit reached` in the final summary, nothing further happens until next run | `sender` pauses that action type, posts to Telegram with counts and an explicit prompt to raise the cap for this run or leave the rest queued, and waits for a reply before continuing |
| `MATCH_THRESHOLD` default | `70` | `60` |

This table exists so nobody re-discovers these as "bugs" later — they're deliberate, user-approved changes to the existing safety posture, made with full awareness of the incident that originally motivated the `connect_send` approval gate (a wrong-recipient send, since fixed at the selector/verification level — see `connect.ts`'s `verifyRecipientName`/`verifyProfileUrl`/`pickNearestToNameIndex` fixes).

## 4. Architecture — pipeline stages

1. **Discover** (unchanged code) — `job-fetch.list_new_jobs` (Adzuna/Remotive/RemoteOK only — Serper's `fetchSerper`/`search_hiring_posts` tool removed from `job-fetch.ts` and `src/sources/index.ts`; `src/sources/serper.ts` deleted) + `discover.linkedin_jobs` + `discover.linkedin_posts`.

2. **Match** (`matcher`, extended) — scores every job as today. For jobs where `source` is `linkedin-posts` (i.e. `id` starts with `li-post:`), additionally extracts from the raw `description` text and returns as extra fields on that job's match result: `extracted_company` (best-effort company name, or `null` if not confidently extractable), `extracted_title` (best-effort role title, or `null`), `apply_method` (one of `'email'` if an email address is found in the text, `'link'` if a URL other than the author's own profile is found, `'linkedin'` if the text implies applying via LinkedIn/DM, or `null` if none of these are confidently detected). These are best-effort extras — never fabricated, `null` when not confidently extractable — and don't change the existing `{job_id, score, reasons, missing_keywords}` contract, they're added alongside it.

3. **Filter** (orchestrator, unchanged) — drop `job_id`s with `score < MATCH_THRESHOLD` (now defaulting to `60`).

4. **Contact + Profile finding** (`contact-finder`, expanded) — one dispatch per matched job. Calls:
   - `contacts.find_company_emails({company})` (unchanged).
   - `connect.find_linkedin_profile({company, role_hint: "Recruiter"})`, `connect.find_linkedin_profile({company, role_hint: "Talent Acquisition"})`, `connect.find_linkedin_profile({company, role_hint: "HR"})` — searched as a recruiter/HR category, results merged and filtered to exclude titles containing `Intern`/`Associate` (too junior) or `Chief`/`VP`/`Director`/`Head of` (too senior) — the "slight seniority" band, preferring titles containing `Senior`/`Lead`/`Manager`.
   - `connect.find_linkedin_profile({company, role_hint: <job's own title>})` — a second category: people already working in a similar role at the company (peers), same company filter, no seniority filtering (any peer is useful signal/context, not a hiring-authority target).
   
   Returns `{job_id, contact: {...}|null, linkedin_profiles: [{profile, category: 'recruiter'|'peer'}, ...]}` — zero, one, or two profiles (one per category, whichever categories found a match; never more than one per category).

5. **Prepare** (`outreach-preparer`, expanded, dispatched in parallel across jobs — no shared state touched, so this is safe to parallelize) — for each job with a contact and/or at least one LinkedIn profile:
   - Tailor resume (`tailor-resume` skill, unchanged), render PDF (`resume.render_resume`, unchanged).
   - If `contact` present: draft cold email (`draft-outreach` skill — drafter → critique/rewrite → humanizer, unchanged pipeline).
   - For each LinkedIn profile found (recruiter and/or peer, up to 2): draft a connect note via `draft-connect-note` skill (drafter → critique/rewrite → humanizer). Binding constraints on this draft, enforced by the skill (already true today, reaffirmed as a hard requirement for this pipeline): **never exceeds 300 characters**, and **must reference the specific job/role** being connected about (not a generic "let's connect" — e.g. "Saw the [Role] opening at [Company]..."). The "attention grabber" framing means a stronger, more specific opening line grounded in real facts about the job/company — never fabricated urgency, never invented claims about the candidate.
   - Determine apply eligibility from the job's `apply_url`: `'linkedin'` if it's a LinkedIn Easy Apply posting, one of `'greenhouse'|'lever'|'workday'|'ashby'` if it matches a known external ATS pattern, or `'none'` otherwise (per §5 of this spec, an unrecognized platform is NOT attempted here — that's Plan B's scope).
   - Write ONE row to `outreach_queue` via the new `db.enqueue_outreach` tool (§7) — no sends, no external calls to `gmail`/`connect`/`apply` from this stage. Fully parallel-safe: every write is an independent new row.

6. **Execute queue** (`sender`, expanded) — one dispatch per hunt run (not parallelized — this stage is the single execution point, avoiding any send-side race). Steps:
   1. Call `db.list_queued_outreach()` to get the full backlog of `status='queued'` rows — this includes rows from the current run AND any rows left `queued` by a previous run that hit a cap and wasn't overridden.
   2. For each row, in order:
      - If `email_to` is set and email hasn't been sent for this row: `checkAndIncrement(db, 'send_email', SEND_LIMIT_PER_RUN)` — if it returns `false` (cap reached), **pause all further email sends this dispatch**, remember how many email rows remain unsent, and proceed to step 3's cap-reached handling for the `email` action type. If it returns `true`, call `gmail.send_email`, then `db.update_outreach_status(row.id, 'email', 'sent'|'failed')`.
      - If `connect_profile_url` is set and not yet connected for this row: call `connect.connect_send({profile_url, note, job_id, company})` directly (no approval wait) — **do not pre-check a rate limit here**: `connect_send` already internally calls `checkAndIncrement(db, 'connect_send', MAX_CONNECTS_PER_DAY)` itself and returns `{status: 'sent'|'rate_limited'|'failed'}`. A second check in `sender` would double-increment the same counter (once from `sender`'s own check, once inside the tool), silently halving the real daily budget. On `status: 'rate_limited'`, treat it as this run's cap-reached event for the `connect` action type (step 3). Otherwise `db.update_outreach_status(row.id, 'connect', status)`.
      - If `apply_platform` is set and not `'none'` and not yet applied for this row: call `apply.<platform>({job_id})` directly, same reasoning — `apply.linkedin`/`apply.greenhouse`/etc. already call `checkAndIncrement(db, 'easy_apply', MAX_APPLIES_PER_DAY)` internally (the shared counter key across all five apply tools) and return `rate_limited` themselves; `sender` must not pre-check this. On `status: 'rate_limited'`, treat it as this run's cap-reached event for the `apply` action type. Otherwise `db.update_outreach_status(row.id, 'apply', status)`.
   3. **Cap-reached handling**: the first time email hits its own `checkAndIncrement('send_email', ...)` returning `false`, OR `connect_send`/`apply.*` returns `status: 'rate_limited'`, during this dispatch, post to Telegram: `"Reached daily cap for <emails/connects/applies> (N/limit). M more queued. Reply 'more <type>' to raise today's cap by M and continue this run, or anything else to leave them queued for next time."` Wait for the user's reply (same wait-for-Telegram-reply pattern already established for the old Connecting flow, just repurposed here). On `'more <type>'`: update the env-configured limit for that type for today only (a runtime override — implementation detail for the plan to work out, e.g. a temporary raised-limit row) and resume processing that action type's remaining queued rows. On any other reply: leave the remaining rows `queued` (untouched) and continue with other action types.
   4. Each row's overall `status` becomes `'done'` once all three of its applicable actions (whichever were set) have been attempted (sent/failed/submitted/etc. — "attempted" not "succeeded"; a `failed` or `manual_review` outcome still marks the row processed, it doesn't retry automatically).

7. **Report** — orchestrator posts one Telegram summary: counts of jobs discovered/matched, emails sent/failed/queued, connects sent/failed/queued, applies submitted/manual_review/needs_answer/failed/queued, and how any cap-overrun prompts were resolved.

## 5. `outreach_queue` table

New table in `src/db.ts`:

```sql
CREATE TABLE IF NOT EXISTS outreach_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  resume_pdf_path TEXT,
  email_subject TEXT,
  email_body TEXT,
  email_to TEXT,
  email_status TEXT,           -- NULL | 'sent' | 'failed'
  connect_note TEXT,
  connect_profile_url TEXT,
  connect_category TEXT,       -- 'recruiter' | 'peer'
  connect_status TEXT,         -- NULL | 'sent' | 'failed'
  apply_platform TEXT,         -- 'linkedin' | 'greenhouse' | 'lever' | 'workday' | 'ashby' | 'none'
  apply_url TEXT,
  apply_status TEXT,           -- NULL | 'submitted' | 'manual_review' | 'needs_answer' | 'failed'
  status TEXT DEFAULT 'queued', -- 'queued' | 'done'
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

A job with both a recruiter AND a peer profile produces TWO rows (one per connect target), sharing the same `job_id`/`resume_pdf_path`/email fields but differing `connect_*` fields — simpler than packing two connect attempts into one row, and each row's `status` still independently tracks whether ITS actions are done.

## 6. `db` MCP (renamed from `sqlite`, extended)

Rename: `src/mcp/sqlite.ts` → `src/mcp/db.ts`, `McpServer({name: 'sqlite', ...})` → `McpServer({name: 'db', ...})`, `.mcp.json`'s `"sqlite"` key → `"db"`, `package.json`'s `"mcp:sqlite"` script → `"mcp:db"`. Every existing tool (`list_jobs`, `get_job_stats`, `list_outreach`, `get_outreach_stats`, `list_threads`, `raw_query`) keeps its exact name/behavior — only the server's own name changes. `CLAUDE.md`'s two `sqlite.get_job_stats()`/`sqlite.get_outreach_stats()` references become `db.get_job_stats()`/`db.get_outreach_stats()`.

New tools added to the same file:
- `db.enqueue_outreach(job_id, resume_pdf_path?, email_subject?, email_body?, email_to?, connect_note?, connect_profile_url?, connect_category?, apply_platform?, apply_url?)` → inserts one `outreach_queue` row, returns the new row's `id`.
- `db.list_queued_outreach()` → returns every row where `status = 'queued'`, ordered by `created_at`.
- `db.update_outreach_status(id, field, value)` where `field` is one of `'email_status'|'connect_status'|'apply_status'|'status'` — updates that column (and `updated_at`) on the given row. A single narrow tool rather than one per field, so `sender` isn't juggling four near-identical tool names.

## 7. `MATCH_THRESHOLD` default change

`.env.example`'s `MATCH_THRESHOLD=70` → `MATCH_THRESHOLD=60`. `CLAUDE.md`'s three references to `70` (Preferences section, and the two inline mentions in "Running the hunt" step 2) → `60`. This only changes the *documented default* — if a real `.env` already sets a value (the project's actual `.env` already has `MATCH_THRESHOLD=60`), that value is unaffected; this just makes the documented default consistent with what's actually configured.

## 8. Safety notes carried forward unchanged

- Burner-account-only rule for `discover`/`linkedin-apply` unchanged.
- Main-account-only rule for `connect` unchanged.
- `apply`'s platform-mismatch fail-safe (refuses if `apply_url` doesn't match the called tool) unchanged.
- `connect_send`'s recipient-verification safety net (`verifyRecipientName`, `verifyProfileUrl`, fail-closed) unchanged — removing the *human approval* gate does NOT remove the *automated* wrong-recipient defenses fixed earlier this project; those still run on every `connect_send` call regardless of who triggered it.
- `MAX_CONNECTS_PER_DAY`/`MAX_APPLIES_PER_DAY` numeric caps unchanged in mechanism, just now also gate `SEND_LIMIT_PER_RUN` the same way (§3 table).

## 9. Explicit user risk acknowledgment (recorded, not re-litigated)

The `connect_send` approval-gate removal and the `AUTO_APPLY_ENABLED` gate removal were both flagged with their concrete risk (a wrong-recipient send could reach a real stranger with zero review; a bad match could cascade into a real application with no opt-out) before this design was written. The user's explicit response: acceptable, given the reliability fixes already made to `connect.ts` this session (2D-proximity matching, fail-closed name/URL verification), and flags to reintroduce more granular control will come later as a separate piece of work. This section exists so that decision is traceable back to an explicit, informed choice rather than looking like an oversight.

## 10. Testing

- `matcher`'s post-structuring extraction: unit-testable pure functions (extract email/URL/company-name heuristics from raw text), fixture-based, no live calls.
- `contact-finder`'s seniority-band filtering: unit-testable pure function (`filterBySeniorityBand(profiles, band)` or similar), fixture-based.
- `outreach_queue` table + `db.enqueue_outreach`/`db.list_queued_outreach`/`db.update_outreach_status`: unit-testable against an in-memory SQLite db, same pattern as every other `db.ts` table.
- `sender`'s cap-reached-pause-and-prompt logic: unit-testable at the "decide what to do next" level (given a `checkAndIncrement` result of `false`, does it correctly stop that action type and continue others) using an injectable rate-limit check, without needing a live Telegram round-trip in the test.
- End-to-end live verification (a real hunt run with real caps, real Telegram prompt-and-reply) is a manual verification step, not a CI test — same precedent as `external-apply.ts` and LinkedIn Discovery's own "not yet live-tested" gaps.
