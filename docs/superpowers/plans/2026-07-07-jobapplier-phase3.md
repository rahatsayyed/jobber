# Jobber Phase 3 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect replies (email + LinkedIn), classify intent, draft appropriate responses, and send only after human approval (except a narrow, off-by-default auto-reply allowlist) — plus optional, always-human-approved LinkedIn posting.

**Architecture:** No new MCP for email (reuse the Phase 1 Gmail integration); one new MCP (`linkedin-messages`) on the **main** account; two new skills (`classify-reply`, `draft-reply`) plus one for posting (`draft-post`); a `messages`/`threads` log for conversation memory; Telegram remains the approval surface, extending the pattern introduced in Phase 2.

**Tech Stack:** same as Phase 1/2, no new runtime dependencies.

## Global Constraints

- Draft-and-wait is the default for every send in this phase. Auto-send requires `AUTO_REPLY_ENABLED=true` AND the classified intent to be in `AUTO_REPLY_ALLOWLIST` (default: empty) AND `classify-reply` confidence above a configured threshold (default 0.9).
- `publish_post` (LinkedIn posting) has **no** auto-send path at all — always requires a Telegram `send` approval, regardless of any flag.
- `draft-reply` must be given the actual `messages` table history for the thread — never asked to infer or fabricate prior turns.
- `linkedin-messages` uses `secrets/linkedin-main-state.json` only (same file as Phase 2's `connect` MCP) — never the burner session.

---

## File Structure (additions to Phase 1/2)

```
jobber/
├─ config/availability.json          # user's general scheduling availability
├─ src/mcp/linkedin-messages.ts
├─ src/lib/threads.ts                # thread/message persistence helpers
├─ .claude/skills/
│   ├─ classify-reply/SKILL.md
│   ├─ draft-reply/SKILL.md
│   └─ draft-post/SKILL.md
└─ tests/{threads,classify-reply}.test.ts
```

---

### Task 0: Confirm Gmail integration + thread/message schema

- [ ] **Step 1:** Confirm which Gmail integration is authenticated and working at build time (GongRzhe `gmail` MCP from Phase 1, or a built-in Gmail connector) — do not stand up a third option. Document the choice at the top of this file's Task 0 notes in the progress ledger.
- [ ] **Step 2 (test):** `tests/threads.test.ts` — `upsertThread({channel:'email', job_id, contact, external_thread_id})` then `logMessage({thread_id, direction:'inbound', body, intent:null})`; assert `getThreadHistory(thread_id)` returns messages in order.
- [ ] **Step 3:** vitest → FAIL.
- [ ] **Step 4:** add `threads` + `messages` tables to `src/db.ts`; implement `src/lib/threads.ts` (`upsertThread`, `logMessage`, `getThreadHistory`, `markThreadStatus`).
- [ ] **Step 5:** vitest → PASS.
- [ ] **Step 6:** commit `feat: threads/messages schema + helpers`.

---

### Task 1: `classify-reply` skill

**Files:** `.claude/skills/classify-reply/SKILL.md`

- [ ] **Step 1:** Write the skill: input = latest inbound message body + brief thread context; output STRICT JSON `{intent, confidence, summary}` with `intent` constrained to the enum in spec §4.2. Include explicit examples of each intent in the skill doc (few-shot) since intent classification quality directly gates the auto-reply allowlist.
- [ ] **Step 2:** Manual test: feed 6-8 real or realistic sample replies (one per intent) through the skill via a scratch `claude -p` call; confirm each classifies correctly and confidence is sensibly lower on ambiguous ones.
- [ ] **Step 3:** commit `feat: classify-reply skill`.

---

### Task 2: `draft-reply` skill

**Files:** `.claude/skills/draft-reply/SKILL.md`, `config/availability.json` (template)

- [ ] **Step 1:** Create `config/availability.json` template (general weekly availability windows, timezone).
- [ ] **Step 2:** Write the skill: input = thread history (`messages`), classified `intent`, original job/resume context; per-intent drafting rules from spec §4.3 (interested/question/scheduling/rejection); reuse the drafter→reviewer→humanizer structure from `draft-outreach`; refuse to draft (return a `{skip: true, reason}` shape instead) for `auto-reply/OOO` or `unclear` intents.
- [ ] **Step 3:** Manual test: for 3-4 of the sample replies from Task 1, draft a reply and sanity-check tone, factual grounding (no invented claims), and that `scheduling` replies correctly reference `availability.json`.
- [ ] **Step 4:** commit `feat: draft-reply skill + availability config`.

---

### Task 3: `list_new_replies()` orchestration helper (email side)

**Files:** small addition to `src/lib/threads.ts` or a new `src/lib/email-replies.ts`; Test `tests/email-replies.test.ts` (logic only, mocked Gmail responses)

- [ ] **Step 1 (test):** given a mocked list of Gmail threads (some newer than `last_checked_at`, some older, some not matching any `outreach.contact_email`), `filterNewReplies(threads, outreachRows, lastCheckedAt)` returns only the genuinely-new, contact-matched ones.
- [ ] **Step 2:** vitest → FAIL.
- [ ] **Step 3:** implement `filterNewReplies()` (pure function); implement `list_new_replies()` orchestration that calls the chosen Gmail integration's thread-search tool, applies the filter, and calls `upsertThread`/`logMessage` for each new reply.
- [ ] **Step 4:** vitest → PASS.
- [ ] **Step 5:** manual live test: with at least one real reply in the inbox (even a self-sent test reply to a Phase 1 test send), confirm it's detected and logged to `messages`.
- [ ] **Step 6:** commit `feat: email reply detection + thread logging`.

---

### Task 4: `linkedin-messages` MCP (main account)

**Files:** Create `src/mcp/linkedin-messages.ts`; Test `tests/linkedin-messages.test.ts` (selector/parsing logic only)

- [ ] **Step 1 (test):** pure test for the message-list parser: given a captured HTML/DOM-snapshot fixture of the LinkedIn messaging inbox, `parseConversations(html)` extracts `{conversation_id, sender_name, last_message_preview, unread}`.
- [ ] **Step 2:** vitest → FAIL.
- [ ] **Step 3:** implement `parseConversations()`; implement `list_new_messages()` (Playwright, `secrets/linkedin-main-state.json`, navigate to messaging inbox, snapshot, parse, diff against `threads` to find new/unread) and `send_message({conversation_id, body})` (gated — only called after Telegram approval, same as Phase 2's `connect_send`).
- [ ] **Step 4:** vitest → PASS on parser.
- [ ] **Step 5:** manual live test: confirm `list_new_messages()` correctly surfaces a real unread LinkedIn message (e.g. from a Phase 2 accepted connection) without sending anything.
- [ ] **Step 6:** commit `feat: linkedin-messages MCP (main account, read + gated send)`.

---

### Task 5: `draft-post` skill + `post-linkedin` MCP

**Files:** `.claude/skills/draft-post/SKILL.md`, addition to `src/mcp/linkedin-messages.ts` or a new `src/mcp/post-linkedin.ts`

- [ ] **Step 1:** Write `draft-post` skill: input = a topic/prompt ("job search update", "shipped X"), output a short humanized post body, on-brand, no spammy engagement-bait phrasing.
- [ ] **Step 2:** implement `publish_post({body})` (Playwright, main account) — no rate-limit bypass, no auto-send path; only ever invoked immediately after a Telegram `send` approval.
- [ ] **Step 3:** add a `posts` table + weekly-cap check (reuse `rateLimit.ts` from Phase 2 with key `'post'`, max 1/week) so the agent doesn't even *offer* a draft more than once a week.
- [ ] **Step 4:** manual test: draft one post, approve via Telegram, confirm it publishes; confirm a second draft attempt within the same week is refused with a clear "already posted this week" message.
- [ ] **Step 5:** commit `feat: draft-post skill + gated publish_post`.

---

### Task 6: `CLAUDE.md` — Conversations + Presence sections

- [ ] **Step 1:** Add "## Conversations": on each scheduled run or on-demand "check replies", call `list_new_replies()` + `linkedin-messages.list_new_messages()`; for each new inbound message, `classify-reply` then (unless `auto-reply/OOO`/`unclear`) `draft-reply`; post every draft to Telegram and **stop** — do not send in the same turn unless `AUTO_REPLY_ENABLED=true` AND the intent is in `AUTO_REPLY_ALLOWLIST` AND confidence ≥ threshold, in which case send immediately and still report it to Telegram as "auto-sent" (never silent).
- [ ] **Step 2:** Add "## Presence": at most once a week, may propose a post draft via `draft-post`; **always** wait for a Telegram `send` approval before `publish_post`, no flag overrides this.
- [ ] **Step 3:** Extend "## Safety" with the Phase 3 rules from spec §6 verbatim.
- [ ] **Step 4:** commit `feat: CLAUDE.md orchestration for conversations + presence`.

---

### Task 7: End-to-end smoke test

- [ ] **Step 1:** Send yourself a test "reply" (email) to a prior Phase 1 outreach thread; run "check replies"; confirm it's detected, classified, drafted, and posted to Telegram for approval; approve; confirm it sends and `messages`/`threads` update correctly.
- [ ] **Step 2:** Repeat for a LinkedIn message on a Phase 2 connection.
- [ ] **Step 3:** Enable `AUTO_REPLY_ENABLED=true` with allowlist `["scheduling"]`; send a clear scheduling-confirmation test reply; confirm it auto-sends AND still reports to Telegram (never silent).
- [ ] **Step 4:** Draft and approve one LinkedIn post; confirm the weekly cap blocks a second draft offer.
- [ ] **Step 5:** commit `feat: phase 3 end-to-end smoke test passing`.

**Phase 3 done** → full conversation loop (detect → classify → draft → approve → send) plus capped, always-approved posting. This completes the originally-scoped three-phase Jobber system.

---

## Self-Review

- **Spec coverage:** reply detection (T3/T4), classification (T1), drafting (T2), gated send + narrow auto-send (T6), posting with hard weekly cap and no auto-send path (T5), thread memory (T0), smoke test (T7). ✓
- **Consistency with Phase 2 pattern:** reuses the exact Telegram draft→approve→send gate introduced for `connect_send`, rather than inventing a second approval mechanism.
- **Placeholders:** none — every "unclear" or low-confidence case has an explicit fallback (skip drafting, route to manual) rather than best-effort guessing.
