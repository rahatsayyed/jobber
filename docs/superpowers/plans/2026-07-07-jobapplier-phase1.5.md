# Jobber Phase 1.5 — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add time-based follow-up email nudges to Phase 1 — send one polite follow-up to recruiters who haven't replied after N days, never more than once per contact.

**Architecture:** one new skill (`followup-draft`), one new subagent (`followup-sender`), a `CLAUDE.md` "Follow-ups" command, and new `FOLLOWUP_*` env vars.

**Tech Stack:** same as Phase 1, no new dependencies.

## Global Constraints

- Never send more than 1 follow-up per `outreach_id`, enforced by checking `followup_sent_at IS NULL`.
- Only consider sent emails ≥ `FOLLOWUP_DAYS_AFTER` old; never follow-up emails sent less than N days ago.
- Respect `FOLLOWUP_LIMIT_PER_RUN` — if more than this many are eligible, pick the oldest N and mark the rest as "deferred".
- "Follow-ups" is a separate command from "run the hunt" — do not auto-trigger them together.

---

## File Structure (additions to Phase 1)

```
jobber/
├─ .claude/
│   ├─ agents/followup-sender.md       # NEW
│   └─ skills/followup-draft/SKILL.md  # NEW
└─ docs/superpowers/
    ├─ specs/2026-07-07-jobapplier-phase1.5-design.md
    └─ plans/2026-07-07-jobapplier-phase1.5.md
```

---

### Task 0: Add `followup_sent_at` column and env vars

**Files:** `src/db.ts`, `.env.example`, `.env`

- [ ] **Step 1:** Update `src/db.ts` `CREATE TABLE outreach` to add `followup_sent_at TEXT DEFAULT NULL` column.
- [ ] **Step 2:** Add to `.env.example`:
  ```
  FOLLOWUP_DAYS_AFTER=5          # only follow up on emails sent N+ days ago
  FOLLOWUP_LIMIT_PER_RUN=2       # max follow-ups per run
  ```
- [ ] **Step 3:** Add same to `.env`.
- [ ] **Step 4:** commit `chore: followup schema + env vars`.

---

### Task 1: `followup-draft` skill

**Files:** `.claude/skills/followup-draft/SKILL.md`

- [ ] **Step 1:** Write the skill: input = original outreach `{subject, body, to, company, job_title, sent_at}`, output = `{subject, body}` for a follow-up. Keep body under 150 words, reference the original subject line, one soft ask (e.g. "happy to chat further").
- [ ] **Step 2:** Manual test: draft a follow-up for a real Phase 1 email you have in `outreach`; verify tone is friendly, not pushy, and references the original job.
- [ ] **Step 3:** commit `feat: followup-draft skill`.

---

### Task 2: `followup-sender` subagent

**Files:** `.claude/agents/followup-sender.md`

- [ ] **Step 1:** Write the subagent definition: same structure as `sender.md` but (a) calls `gmail.send_email` for follow-ups (not originals), (b) updates `outreach.followup_sent_at` on success, (c) respects `FOLLOWUP_LIMIT_PER_RUN`.
- [ ] **Step 2:** commit `feat: followup-sender subagent`.

---

### Task 3: Add "Follow-ups" command to `CLAUDE.md`

- [ ] **Step 1:** Add to the Commands table:
  ```
  | "send follow-ups", "send reminders" | Scan outreach for old sent emails (≥ FOLLOWUP_DAYS_AFTER) with no follow-up yet; draft + send up to FOLLOWUP_LIMIT_PER_RUN. Report counts. |
  ```
- [ ] **Step 2:** Add a new "## Follow-ups" section (parallel to "Running the hunt") explaining the flow:
  1. Query `outreach` for `sent_at` ≥ N days old AND `followup_sent_at IS NULL`.
  2. Invoke `followup-draft` skill for each.
  3. Dispatch `subagent_type: followup-sender` with the batch + `FOLLOWUP_LIMIT_PER_RUN`.
  4. Report sent, skipped, deferred counts.
- [ ] **Step 3:** commit `feat: CLAUDE.md follow-ups command + section`.

---

### Task 4: End-to-end smoke test

- [ ] **Step 1:** Via Telegram or CLI, send a test cold email to yourself (or create a fake one in SQLite for testing).
- [ ] **Step 2:** Run `claude -p "send follow-ups"` — should pick up the old email and draft a follow-up.
- [ ] **Step 3:** Approve and confirm it sends (or confirm it's queued for approval in Telegram).
- [ ] **Step 4:** Confirm `outreach.followup_sent_at` is updated in the DB.
- [ ] **Step 5:** Run the command again — confirm the same email is NOT eligible a second time (already followed up).
- [ ] **Step 6:** commit `feat: phase 1.5 end-to-end smoke test passing`.

**Phase 1.5 done** — time-based follow-ups active. When Phase 3 ships reply detection, upgrade this to "only follow-up if no reply detected" by adding a reply-check to the eligibility query in step 1.

---

## Self-Review

- **Spec coverage:** time-based eligibility (T0), drafting (T1), sending with rate limit (T2), command + orchestration (T3), smoke test (T4). ✓
- **Simplicity (vs Phase 3):** no reply detection needed, no conversation history, no Telegram approval gate (optional; can add later). Just age + send. Pairs well with cron.
- **Upgrade path:** straightforward to add reply-detection once Phase 3's `threads`/`messages` tables exist — just add an AND clause to the eligibility check.
