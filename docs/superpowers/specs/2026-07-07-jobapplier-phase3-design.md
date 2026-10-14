# Jobber Phase 3 — Design (Conversation Automation + Presence)

- **Date:** 2026-07-07
- **Status:** Design approved — pre-implementation
- **Location:** repository root
- **Builds on:** Phase 1 (cold email) + Phase 2 (LinkedIn apply/connect). Requires both to be live before Phase 3 has anything to converse about.

---

## 1. Goal

Close the loop after outreach: when a recruiter replies to a cold email or accepts a LinkedIn connection and messages back, the agent reads it, classifies intent, drafts a reply, and — for everything except a narrow allowlist of trivial cases — waits for the user's approval before sending. Also handles light LinkedIn "presence" (occasional posts) under the same human-in-the-loop model.

## 2. Motivation

Phase 1/2 generate outbound messages; without Phase 3 the user still has to manually track and answer every reply by hand, which is most of the manual toil this whole project was meant to remove. But replies are also the highest-stakes messages in the whole system (a bad reply to a recruiter can burn a real opportunity, unlike a cold email that simply gets ignored) — so Phase 3 is the most conservative phase: **draft-and-wait is the default; auto-send is an explicit, narrow exception.**

## 3. Scope

**In (Phase 3):**
- Email reply detection + intent classification + drafted replies (human-approved by default).
- LinkedIn message thread detection + drafted replies (human-approved, main account only).
- A narrow, explicit auto-reply allowlist (e.g. simple scheduling confirmations) behind a flag, off by default.
- Light LinkedIn posting (status updates about the job search / project highlights), always human-approved, low frequency.
- Thread/message logging (SQLite) so the agent has conversation memory across turns.

**Out:** anything not already covered by Phase 1/2 (this phase has no new discovery/apply logic) — it is purely "read → understand → draft → (approve) → send".

## 4. Components

### 4.1 `email-inbox` (MCP additions to `gmail`)
- The existing GongRzhe Gmail MCP (Phase 1 §5.6, `docs/gmail-mcp-setup.md`) already supports read/thread operations, or the built-in Claude-connector Gmail tools (`search_threads`, `get_thread`, `create_draft`, `list_drafts`) can be used directly if available in the runtime — **prefer whichever is already authenticated and working** at build time rather than standing up a third Gmail integration.
- New logic (not a new MCP, just orchestration + a small helper): `list_new_replies()` — search threads where `outreach.contact_email` is a participant and `last_message_at` is newer than our last check; cross-reference against `outreach` to know which job/contact/thread this reply belongs to.

### 4.2 `classify-reply` (skill)
- Given a reply's text, classify into one of: `interested` (wants a call/next step), `rejection` (no fit / role filled), `question` (asking for more info), `scheduling` (proposing/confirming a time), `auto-reply/OOO` (out-of-office bounce, not a real reply), `unclear`.
- Output: `{intent, confidence, summary}`.

### 4.3 `draft-reply` (skill)
- Given the thread history + `intent` + the original job/tailored-resume context, draft a reply body appropriate to the intent:
  - `interested` → thank them, confirm availability, offer times or ask them to propose.
  - `question` → answer directly and factually from the resume/job context; never fabricate.
  - `scheduling` → confirm the proposed time, or offer 2-3 alternatives if the proposed time doesn't work (the user pre-configures general availability in `config/availability.json`).
  - `rejection` → short, gracious, no-ask closing reply (or no reply at all — configurable).
  - `auto-reply/OOO` / `unclear` → do not draft; flag for manual read.
- Runs the same drafter→reviewer→humanizer pattern as `draft-outreach`.

### 4.4 `linkedin-messages` (MCP, main account, human-gated)
- `list_new_messages()` — Playwright scrape of the LinkedIn messaging inbox using `secrets/linkedin-main-state.json` (read-only navigation, main account, low frequency — e.g. checked once per scheduled run, not polled continuously).
- `send_message({conversation_id, body})` — only ever called after Telegram approval, same gate pattern as Phase 2's `connect_send`.

### 4.5 Approval flow (Telegram) — reused and extended from Phase 2
- For every drafted reply (email or LinkedIn), post to Telegram: who it's from, the classified intent, the draft body, and ask for `send` / `edit: <text>` / `skip`.
- **Auto-reply allowlist** (`AUTO_REPLY_ENABLED`, default `false`, plus a category allowlist e.g. `["scheduling-confirmation"]`): only when explicitly enabled does a narrow category of low-risk, unambiguous replies (e.g. "Yes, Tuesday 3pm works") get sent without waiting for approval — everything else always waits.

### 4.6 `post-linkedin` (skill + MCP, main account, always human-approved)
- `draft-post({topic})` — drafts a short LinkedIn status update (e.g. "actively exploring new roles", a project highlight) — humanized, on-brand, never auto-generated spam cadence.
- `publish_post({body})` — main account, Playwright, **always** requires a Telegram `send` approval; there is no auto-post allowlist for this one, ever (reputational risk is highest here — it's public and permanent).
- Frequency capped hard (e.g. max 1 draft offered per week) regardless of how often the agent runs, to avoid pestering the user with post suggestions.

## 5. Data model additions (SQLite)

- `threads(id, channel [email|linkedin], job_id, contact, external_thread_id, last_message_at, status [needs_reply|replied|closed|auto_replied], created_at)`
- `messages(id, thread_id, direction [inbound|outbound], body, intent, sent_at, created_at)` — full conversation log, used as context for future drafts in the same thread.
- `posts(id, body, status [drafted|approved|posted|skipped], posted_at, created_at)`

## 6. `CLAUDE.md` changes

- New "## Conversations" section: on each scheduled run (or on-demand "check replies"), call `list_new_replies()` and `linkedin-messages.list_new_messages()`, classify each with `classify-reply`, draft with `draft-reply` for anything not `auto-reply/OOO`/`unclear`, post each draft to Telegram, and stop — same wait-for-approval pattern as Phase 2's Connecting section. Only auto-send if `AUTO_REPLY_ENABLED=true` AND the classified category is in the allowlist AND confidence is high; otherwise always wait.
- New "## Presence" section: at most once a week, may propose a LinkedIn post draft via Telegram; never posts without a `send` approval, no exceptions.
- Extend "## Safety": auto-send (email or LinkedIn) is opt-in and allowlist-scoped; `publish_post` NEVER auto-sends regardless of flags; thread context must come from `messages` (real history), never fabricated prior context.

## 7. Decisions log

- Draft-and-wait is the Phase 3 default for every conversational action; auto-send is a narrow, explicit, off-by-default exception — the opposite default from Phase 1/2's apply automation, because reply mistakes are higher-stakes than a skipped cold email.
- Posting is never auto-sent, under any flag — highest-visibility, hardest-to-undo action in the whole system.
- Reuse whichever Gmail integration is already authenticated (GongRzhe MCP or the built-in connector) rather than adding a third email integration.
- LinkedIn messages are read at scheduled-run cadence, not polled continuously, to keep the main account's automated-looking activity minimal.

## 8. Risks & mitigations

- **Misclassified intent → wrong-toned reply** → draft-and-wait default catches this before send; `classify-reply` returns a confidence score, low-confidence always routes to manual regardless of allowlist settings.
- **Auto-reply allowlist accidentally too broad** → keep the allowlist to one category (scheduling confirmations) at launch; expand only after observing real drafts for a while.
- **LinkedIn message scraping trips detection** → low-frequency checks (per scheduled run, not real-time), main account only, read-heavy not write-heavy.
- **Fabricated context in multi-turn threads** → `messages` table is the single source of truth for thread history; `draft-reply` must be given the actual stored history, not asked to "recall" it.

## 9. Open items (confirm at build time)

- Decide which Gmail integration is authenticated and stable at Phase 3 build time (GongRzhe MCP vs built-in connector) and standardize on it.
- Fill in `config/availability.json` (the user's general scheduling availability) before enabling `scheduling` auto-drafts.
- Confirm whether `rejection` replies should get an auto-acknowledgment or simply be logged/closed with no reply at all (user preference, currently unset).
