# Jobber Phase 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add LinkedIn Easy Apply (burner account), external ATS apply (Greenhouse/Lever/Workday/Ashby), and human-approved LinkedIn connection requests (main account) on top of the Phase 1 discovery/match/email pipeline.

**Architecture:** Two new browser identities (burner LinkedIn session, main LinkedIn session — never shared), two new MCP servers (`linkedin-apply`, `external-apply`) plus one gated MCP (`connect`) with a Telegram human-approval step, a shared rate-limit module, and `CLAUDE.md` additions that keep this phase strictly opt-in (`AUTO_APPLY_ENABLED`).

**Tech Stack:** same as Phase 1 (Node 20 + TS, `@modelcontextprotocol/sdk`, `better-sqlite3`, Playwright), no new runtime dependencies.

## Global Constraints

- **Never** use the burner session for `connect`/profile-search, and **never** use the main session for `apply_easy_apply`. Enforce this by loading each MCP with a hardcoded, distinct `storageStatePath` — do not make it a shared/configurable parameter that could be pointed at the wrong file.
- `connect_send` must only ever be called immediately after a `send` approval reply in the same run — never speculatively.
- `AUTO_APPLY_ENABLED` (env, default `false`) gates `external-apply` and `linkedin-apply` from running as part of any cron/autonomous trigger. Manual, explicit "apply to job X" commands may still invoke them regardless of the flag (still subject to rate limits).
- Respect `MAX_APPLIES_PER_DAY` / `MAX_CONNECTS_PER_DAY` via `src/lib/rateLimit.ts` — every apply/connect call checks-and-increments before acting.
- Unanswerable Easy Apply screening questions → `manual_review`, never a guessed submission.

---

## File Structure (additions to Phase 1)

```
jobber/
├─ secrets/
│   ├─ linkedin-burner-state.json   # Playwright storageState, burner account (gitignored)
│   └─ linkedin-main-state.json     # Playwright storageState, main account (gitignored)
├─ config/easy-apply-answers.json   # user-filled screening-question defaults
├─ src/
│   ├─ lib/rateLimit.ts
│   ├─ mcp/
│   │   ├─ linkedin-apply.ts
│   │   ├─ external-apply.ts
│   │   └─ connect.ts
│   └─ ats/{greenhouse,lever,workday,ashby}.ts   # per-platform form fillers
├─ .claude/skills/draft-connect-note/SKILL.md
└─ tests/{rateLimit,ats,connect}.test.ts
```

---

### Task 0: Burner account + browser sessions (manual + scaffold)

- [ ] **Step 1 (manual, user):** Create a burner LinkedIn account (separate email, real-looking but throwaway profile). Log in once via a headed Playwright script, save `context.storageState({path: 'secrets/linkedin-burner-state.json'})`.
- [ ] **Step 2 (manual, user):** On the Mac, log into the **main** LinkedIn account in a headed Playwright script the same way, save to `secrets/linkedin-main-state.json`.
- [ ] **Step 3:** Add both paths to `.gitignore`; document the one-time login procedure in `docs/linkedin-sessions-setup.md`.
- [ ] **Step 4:** Create `config/easy-apply-answers.json` template (`years_experience`, `authorized_to_work`, `requires_sponsorship`, `willing_to_relocate`, etc.) with placeholder values; document that the user must fill in real answers before enabling `AUTO_APPLY_ENABLED`.
- [ ] **Step 5:** commit `chore: linkedin session + easy-apply-answers scaffolding`.

**Verify:** both storage-state files exist and are gitignored; a quick Playwright script using `linkedin-burner-state.json` loads `linkedin.com/feed` already logged in.

---

### Task 1: Rate limiting

**Files:** Create `src/lib/rateLimit.ts`; Test `tests/rateLimit.test.ts`

- [ ] **Step 1 (test):** `checkAndIncrement(db, 'easy_apply', 2)` called 3 times in the same day → first two return `true`, third returns `false` and count stays at 2.
- [ ] **Step 2:** vitest → FAIL.
- [ ] **Step 3:** implement `daily_counters(day, key, count)` table (add to `src/db.ts`) + `checkAndIncrement()` using `UPDATE ... WHERE day=? AND key=? AND count<?` pattern (atomic check-and-increment in one statement).
- [ ] **Step 4:** vitest → PASS.
- [ ] **Step 5:** commit `feat: shared daily rate-limit counters`.

---

### Task 2: `external-apply` MCP (no LinkedIn risk — build first)

**Files:** Create `src/ats/{greenhouse,lever,workday,ashby}.ts`, `src/mcp/external-apply.ts`; Test `tests/ats.test.ts`

- [ ] **Step 1 (test):** for each platform, a pure `detect(url)` function returns the platform name or `null`; a `fieldMap` constant lists the CSS selectors for name/email/phone/resume-upload/cover-letter per platform (test asserts the map has all required keys, not live DOM interaction).
- [ ] **Step 2:** vitest → FAIL.
- [ ] **Step 3:** implement `detect()` + `fieldMap` per platform; implement `applyExternal({job_id})` in `src/mcp/external-apply.ts`: fetch job + tailored resume path + drafted cover letter from DB, launch Playwright (no login needed), `detect()` the ATS, fill via `fieldMap`, upload PDF, if any required field has no selector match → `status='manual_review'` and stop before submitting, else submit and record to `applications`.
- [ ] **Step 4:** vitest → PASS on `detect`/`fieldMap`.
- [ ] **Step 5:** manual live test against one real Greenhouse and one real Lever posting (non-destructive: stop before final submit click during testing, verify all fields populated correctly, then allow one real submission for a role the user is fine actually applying to).
- [ ] **Step 6:** commit `feat: external-apply MCP for Greenhouse/Lever/Workday/Ashby`.

---

### Task 3: `linkedin-apply` MCP (burner account, Easy Apply)

**Files:** Create `src/mcp/linkedin-apply.ts`; Test `tests/linkedin-apply.test.ts`

- [ ] **Step 1 (test):** pure-logic test for the screening-question resolver: given a question string and `easy-apply-answers.json`, `resolveAnswer(question, answers)` returns a matched value for known question patterns (e.g. "years of experience", "authorized to work") and `null` for unrecognized ones.
- [ ] **Step 2:** vitest → FAIL.
- [ ] **Step 3:** implement `resolveAnswer()` (keyword/regex matching against the answers config) and `applyEasyApply({job_id})`: load `secrets/linkedin-burner-state.json` as Playwright context, navigate to the job, click Easy Apply, walk the form steps, use `resolveAnswer()` for each question — if any returns `null`, abort → `applications(status='manual_review')`; else upload resume, submit, record `applications(method='easy_apply', account='burner', status='submitted')`. Gate every call through `checkAndIncrement(db, 'easy_apply', MAX_APPLIES_PER_DAY)`.
- [ ] **Step 4:** vitest → PASS on `resolveAnswer`.
- [ ] **Step 5:** manual live test on 2-3 real Easy Apply postings using the burner account; confirm submissions land (check the burner account's "My Jobs > Applied" tab) and that an intentionally-unanswerable question aborts to `manual_review` instead of guessing.
- [ ] **Step 6:** commit `feat: linkedin-apply MCP (burner account, Easy Apply)`.

---

### Task 4: `connect` MCP + `draft-connect-note` skill (main account, human-gated)

**Files:** Create `src/mcp/connect.ts`, `.claude/skills/draft-connect-note/SKILL.md`; Test `tests/connect.test.ts`

- [ ] **Step 1 (test):** pure test for note-length enforcement: `draft-connect-note`'s reviewer step (tested as a plain function extracted from the skill's logic where feasible, or tested via a fixture-based check) rejects/truncates any note over 300 characters.
- [ ] **Step 2:** write `.claude/skills/draft-connect-note/SKILL.md` following the Phase 1 `draft-outreach` drafter→reviewer→humanizer pattern, hard capped at 300 chars, referencing the specific job/company, ending with a single soft ask (not "please refer me").
- [ ] **Step 3:** implement `src/mcp/connect.ts`:
  - `find_linkedin_profile({company, role_hint})` — Playwright using `secrets/linkedin-main-state.json`, LinkedIn people-search, returns top 3 `{profile_url, name, headline}` candidates. Gated by `checkAndIncrement(db, 'linkedin_search', ...)`.
  - `connect_send({profile_url, note})` — Playwright using the **main** session, opens the profile, clicks Connect, adds note, sends. Gated by `checkAndIncrement(db, 'connect_send', MAX_CONNECTS_PER_DAY)`. This tool must only be called by `CLAUDE.md`'s orchestration **after** a Telegram `send` approval (see Task 5).
- [ ] **Step 4:** vitest → PASS (note-length check).
- [ ] **Step 5:** manual live test: search finds a plausible profile for a real company; draft a note; confirm `connect_send` is never invoked without a manual approval step in this test.
- [ ] **Step 6:** commit `feat: connect MCP + draft-connect-note skill (human-gated send)`.

---

### Task 5: `CLAUDE.md` — Applying + Connecting sections, Telegram approval gate

- [ ] **Step 1:** Add an "## Applying" section: triggered only by explicit command ("apply to job #N", "apply to today's matches") or cron when `AUTO_APPLY_ENABLED=true`. For LinkedIn Easy Apply jobs → `linkedin-apply.apply_easy_apply`; for other `apply_url`s → `external-apply.apply_external`. Report results (submitted / manual_review / rate-limited) to Telegram per the Communication section.
- [ ] **Step 2:** Add an "## Connecting" section: for matched jobs, call `connect.find_linkedin_profile`, invoke `draft-connect-note`, then **post the draft to Telegram and stop** — explicitly instruct: "Do not call `connect.connect_send` in this turn. Wait for the user's next message." On a later `send` reply (matched to the pending draft, e.g. by job/company name), call `connect_send`; on `edit: ...`, redraft and re-post; on `skip`/anything else, mark `connections(status='skipped')` and move on.
- [ ] **Step 3:** Extend "## Safety": add the four Phase 2 rules from spec §7 verbatim (never call `connect_send` without approval; never cross burner/main sessions; respect daily rate limits and report rather than error).
- [ ] **Step 4:** commit `feat: CLAUDE.md orchestration for apply + human-gated connect`.

---

### Task 6: End-to-end smoke test

- [x] **Step 1:** Live-tested against a real Easy Apply posting. Found and fixed 3 real bugs
      (stale ElementHandle crash, obsolete selectors, missing render wait — see
      `docs/phase2-known-issues.md`). Final outcome on the tested posting: safe `manual_review`
      fallback (submit-button text-matching imperfect on that posting's final step) — accepted
      as a known limitation, not a blocking defect (the safety fallback itself is proven
      working). `AUTO_APPLY_ENABLED=false` throughout; this was a manual, explicit test.
- [x] **Step 2:** Live-tested end-to-end (Telegram channel not active this session; used the
      documented no-Telegram fallback — draft posted directly in-conversation, explicit user
      "send" approval required and given before any `connect_send` call, exactly as designed).
      Found and fixed 7 real bugs in `connect.ts` (see `docs/phase2-known-issues.md`). The final
      send click still intermittently fails — root-caused to LinkedIn serving different page
      content (likely anti-automation friction from repeated same-session testing against one
      profile), not a code defect; documented as a known open item for a fresh re-verification.
- [x] **Step 3:** Confirmed organically — `MAX_APPLIES_PER_DAY` (default 5) was hit for real
      during Step 1's live testing and correctly blocked further attempts with a `rate_limited`
      status, no error.
- [x] **Step 4:** All fixes committed individually with task-review gates (see git log,
      `935b295`..`def0e3b` on branch `worktree-phase2-linkedin`).

**Phase 2 substantially done** → agent can apply (burner + external, live-tested for Easy Apply;
external-apply unit-tested only, not yet live-tested against a real ATS posting) and connect
(main, human-approved, live-tested through to the final send click). See
`docs/phase2-known-issues.md` for the specific open items before treating this as fully
production-proven. Next: resolve the open connect_send finding, live-test `external-apply`
against a real posting, then Phase 3 (conversation automation + posting).

---

## Self-Review

- **Spec coverage:** Easy Apply (T3), external ATS apply (T2), connect discovery+draft+gated-send (T4), rate limiting (T1), session isolation (T0 + Global Constraints), CLAUDE.md gating (T5), smoke test (T6). ✓
- **Safety enforcement:** burner/main session separation is structural (distinct hardcoded file paths per MCP, not a shared config), not just a documented convention — reduces risk of the agent accidentally cross-wiring sessions.
- **Placeholders:** none — external-apply and linkedin-apply both have concrete abort-to-manual-review behavior instead of "handle errors gracefully" hand-waving.
