# Jobber Phase 2 — Design (LinkedIn Apply + External Apply + Connect)

- **Date:** 2026-07-07
- **Status:** Design approved — pre-implementation
- **Location:** repository root
- **Builds on:** Phase 1 (`docs/superpowers/specs/2026-07-06-jobapplier-phase1-design.md`) — discovery, matching, resume tailoring, contacts, cold email are all in place and unaffected by this phase.

---

## 1. Goal

Extend the agent from "find + email" to "find + **apply**" — automatically submit LinkedIn Easy Apply applications, fill external (non-LinkedIn) ATS application forms, and send LinkedIn connection requests with personalized notes to recruiters/hiring managers — all without putting the user's real LinkedIn account at ban risk.

## 2. Motivation

LinkedIn is the largest single source of postings and the only channel with a native "connect with a note" mechanic that meaningfully raises response rates over cold email alone. But LinkedIn actively detects and bans automated sessions (Phase 1 spec §11 already flagged this risk). Phase 2 exists specifically to get the upside of LinkedIn automation while containing the downside to an account the user does not care about losing.

## 3. Scope

**In (Phase 2):**
- LinkedIn Easy Apply automation, **burner account only**.
- External (non-LinkedIn) application-form automation for common ATS platforms (Greenhouse, Lever, Workday, Ashby).
- LinkedIn profile discovery (recruiter / hiring manager) + connection-request note drafting.
- Human-approved sending of connection requests from the user's **real** LinkedIn account.
- Per-day rate limits and an explicit opt-in gate (`AUTO_APPLY_ENABLED`) so Phase 2 never fires silently as a side effect of the Phase 1 cron.

**Out (Phase 2, deferred to Phase 3):** reading/answering LinkedIn messages, reading/answering email replies, LinkedIn posting/content, any fully unattended "send" action from the main account.

## 4. The core risk and the containment strategy

Recap from Phase 1 §11/decisions: LinkedIn's 2025–2026 enforcement is aggressive — datacenter IPs, headless browser fingerprints, and burst-y interaction patterns get flagged within ~48h; roughly 23% of accounts using any automation tool get restricted within 90 days. A restriction on the user's **real** account (existing network, real job-search reputation) is much more costly than losing a throwaway account.

**Hybrid containment (locked in Phase 1, operationalized here):**

| Account | Actions | Where it runs | Trigger |
|---|---|---|---|
| **Burner** (disposable, separate LinkedIn account + separate email) | Easy Apply submissions | Anywhere, including the **VPS** — it's disposable, a ban costs nothing | Cron/autonomous, rate-limited |
| **Main** (user's real account) | Connection requests only, **never** applications | User's **Mac**, real residential IP, real browser profile | **Always interactive** — the agent drafts, the user reviews and clicks "send" (via Telegram approval), never auto-fired by cron |

This means Phase 2 has **two separate browser identities** and they must never share a Playwright storage-state file or cookie jar.

## 5. Components

### 5.1 `linkedin-apply` (MCP, burner account)
- `list_applicable_jobs()` → matched jobs (`status='matched'`, score ≥ threshold) whose `apply_url` is a `linkedin.com/jobs/view/...` Easy Apply listing.
- `apply_easy_apply({job_id})` → Playwright, using the burner's persisted `storage_state.json`:
  1. Navigate to the job's LinkedIn URL.
  2. Click "Easy Apply".
  3. Walk the multi-step form: upload the tailored resume PDF (from `resume.render_resume`), fill contact fields from `input/resume.json`, answer simple yes/no / numeric screening questions using conservative defaults (documented in a small `easy-apply-answers.json` config the user fills in once — e.g. "years of experience", "authorized to work", "require sponsorship").
  4. If a question isn't answerable from that config (free-text, unexpected), **abort this application**, mark it `status='manual_review'` in `applications`, and do not submit.
  5. Submit; record `applications(job_id, method='easy_apply', account='burner', status, applied_at)`.
- Rate-limited by `MAX_APPLIES_PER_DAY` (shared counter with 5.2).

### 5.2 `external-apply` (MCP, burner-or-neutral — no LinkedIn login needed)
- `apply_external({job_id})` — for `apply_url` not on `linkedin.com`:
  1. Detect ATS by URL/DOM signature: `greenhouse.io` / `boards.greenhouse.io`, `jobs.lever.co`, `myworkday.com`, `jobs.ashbyhq.com`. Each gets a small dedicated form-filler (selectors differ per platform).
  2. Fill name/email/phone/resume-upload/cover-letter-textarea (cover letter = the drafted outreach body, reused) from the tailored resume + `draft-outreach` output.
  3. If the ATS isn't recognized, or the form has custom required fields, **do not submit** — mark `status='manual_review'`.
  4. Record to `applications(method='external', account=null, ...)`.
- No LinkedIn account risk here at all — this can run anywhere, including the Phase 1 cron path, once `AUTO_APPLY_ENABLED=true`.

### 5.3 `connect` (skill + MCP, main account, human-gated)
- `find_linkedin_profile({company, role_hint})` (MCP, Playwright, **main account** session, read-only search) — searches `site:linkedin.com/in "<company>" (recruiter OR "talent acquisition" OR "hiring manager" OR "engineering manager")`, returns candidate profile URLs + headlines. Search actions are lower-risk than bulk connects but still run under the main account's real session, so this too respects a modest per-day search cap.
- `draft-connect-note` (skill) — same drafter→reviewer→humanizer pattern as Phase 1's `draft-outreach`, but constrained to LinkedIn's **300-character** connection-note limit, referencing the specific job/company.
- `connect_send({profile_url, note})` (MCP, main account) — **only invoked after explicit human approval**. The agent never calls this on its own; it is exposed as a tool the user triggers by replying to a Telegram approval message (see §6).
- Rate-limited by `MAX_CONNECTS_PER_DAY` (LinkedIn's own soft weekly cap is ~100–200 for healthy accounts; we stay well under that, e.g. default 10/day).

### 5.4 Rate limiting (`src/lib/rateLimit.ts`)
- New table `daily_counters(day TEXT, key TEXT, count INTEGER, PRIMARY KEY(day,key))`.
- `checkAndIncrement(key, max)` → returns `false` (and does not increment) once `max` is hit for today; used by both `linkedin-apply` and `connect` before acting.

### 5.5 Approval flow (Telegram, human-in-the-loop)
- When `connect_send` has a drafted note ready, the agent posts to Telegram: profile name/headline, the note text, and asks for `send` / `edit: <new note>` / `skip`. Only on a `send` reply does the agent call `connect_send`.
- This is the same mechanism Phase 3 will reuse for reply approval — see Phase 3 spec §5.4.

## 6. Data model additions (SQLite)

- `applications(id, job_id, method [easy_apply|external], account [burner|null], status [submitted|manual_review|failed], applied_at, created_at)`
- `connections(id, job_id, company, profile_url, headline, note, status [drafted|approved|sent|skipped], sent_at, created_at)`
- `daily_counters(day, key, count)` — shared rate-limit ledger.

## 7. `CLAUDE.md` changes

- New "Applying" section, separate from "Running the hunt", triggered only by an explicit command ("apply to job #3", "apply to today's matches", or the cron running with `AUTO_APPLY_ENABLED=true`) — **never** implicitly bundled into the Phase 1 email-hunt flow.
- New "Connecting" section: for each matched job with no verified email OR alongside a sent email, find a LinkedIn contact, draft a note, **post to Telegram for approval**, and stop — do not send without an explicit approval reply.
- Safety additions to the existing "## Safety" block:
  - Never call `connect_send` without a `send` approval reply logged in the same conversation.
  - Never use the burner account's session for `connect`/`find_linkedin_profile`, and never use the main account's session for `apply_easy_apply`.
  - Respect `MAX_APPLIES_PER_DAY` / `MAX_CONNECTS_PER_DAY` — stop and report "limit reached" rather than erroring.

## 8. External services, credentials, cost

| Item | Use | Cost |
|---|---|---|
| Burner LinkedIn account | Easy Apply | free (throwaway) |
| Burner email (for burner LinkedIn signup) | account recovery | free |
| `jobber` (sentient-engineering) | reference implementation for Easy Apply flow/selectors | free, MIT |
| Playwright (already a dependency) | all browser automation | free |

No new paid services in Phase 2.

## 9. `jobber` integration decision

`jobber` is interactive-CLI, coupled to an OpenAI key + LangSmith, and only 709★/experimental. Rather than shelling out to it as a subprocess (fragile: it expects a real OpenAI endpoint, and swapping in OpenRouter/Grok is unverified), Phase 2 **reimplements the Easy Apply flow directly in `linkedin-apply` using Playwright**, treating `jobber`'s source as a reference for selectors and step sequencing only. This avoids a second, incompatible LLM-provider dependency and keeps the whole system on one model-routing path. Revisit wrapping `jobber` directly only if the reimplementation proves too fragile against LinkedIn's DOM changes.

## 10. Decisions log

- Burner account is fully disposable — runs on the VPS, no residential-IP requirement.
- Main account never runs unattended actions; connect-sends require a human "send" approval via Telegram, every time.
- External-apply (non-LinkedIn ATS) has no account-ban risk and can run fully autonomously once `AUTO_APPLY_ENABLED=true`.
- Unanswerable Easy Apply screening questions abort that application (`manual_review`) rather than guessing — a wrong guess (e.g. sponsorship requirement) can silently disqualify the candidate.
- `jobber` used as reference only, not as a wrapped dependency (avoids OpenAI-key coupling).

## 11. Risks & mitigations

- **Burner detected/banned** → expected and acceptable; monitor `applications` success rate, re-create burner if banned, no impact on main account.
- **Main account still touched (search + connect)** → keep interactions low-frequency and always human-approved; never automate the search+connect loop end-to-end without a human step in between.
- **ATS DOM changes break external-apply selectors** → unrecognized fields fall back to `manual_review` instead of a bad submission; add new ATS platforms incrementally as encountered.
- **Easy Apply screening question misfires** → abort-to-manual-review policy (§5.1 step 4) instead of guessing.

## 12. Open items (confirm at build time)

- Confirm the burner LinkedIn account is created and manually logged in once (captcha/phone-verification is not automatable) before `linkedin-apply` can use it.
- Decide the initial `MAX_APPLIES_PER_DAY` / `MAX_CONNECTS_PER_DAY` defaults (suggested: 10 / 10) with the user before first live run.
- Confirm `easy-apply-answers.json` is filled in with the user's real screening-question defaults before enabling `AUTO_APPLY_ENABLED`.
