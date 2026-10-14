# Jobber Phase 1.5 — Design (Follow-up Nudges)

- **Date:** 2026-07-07
- **Status:** Design approved — optional, can run in parallel with Phase 1 or defer until Phase 3
- **Location:** repository root
- **Builds on:** Phase 1 (cold emails already sent to verified contacts, logged in `outreach` table).

---

## 1. Goal

Send one polite follow-up email to recruiters who haven't replied after N days (default 5), keeping the outreach warm without being spammy.

## 2. Motivation

In the n8n build, a follow-up workflow already existed and improved response rates noticeably. Without it, old emails just age out of the recruiter's inbox. A simple time-based nudge (not reply-aware yet — that's Phase 3) is low-risk: the agent doesn't need to read/classify replies, just check age and send a canned follow-up.

## 3. Scope

**In (Phase 1.5):**
- Scan `outreach` for emails sent ≥ `FOLLOWUP_DAYS_AFTER` (default 5 days ago).
- Check `followup_sent_at` to ensure we never send more than 1 follow-up per contact/job.
- Draft a short follow-up (referencing the original outreach for context).
- Rate-limited: max `FOLLOWUP_LIMIT_PER_RUN` per run (default 2–3).
- Sent via the same `gmail` MCP as Phase 1, same verified-address rules.

**Out:**
- Reply-detection (that's Phase 3 — Phase 1.5 doesn't know if they replied; only knows if we sent a follow-up before).
- Personalization beyond the original job/company/contact (Phase 1.5 is best-effort friendly, not AI-rewritten per job).

## 4. Components

### 4.1 `followup-draft` (skill)
- Input: the original outreach `{subject, body, to, company, job_title}` (from `outreach` table).
- Output: a short follow-up subject/body pair (~150 words), referencing the original subject/role, e.g.:
  ```
  Subject: Following up — React Developer role at Acme (your original message)
  
  Body: Hi [Name],
  
  I wanted to follow up on my message from 5 days ago about the React Developer position at Acme. 
  I'm still very interested in the role and think my experience aligns well with your team's needs.
  
  Happy to chat if you'd like to learn more.
  
  Best,
  [Your Name]
  ```
- No drafter→reviewer→humanizer complexity for Phase 1.5 (that's a Phase 3 upgrade); the skill is just template-ish, keeping it simple.

### 4.2 `follow_up_send()` (small addition to `sender` subagent or a new one)
- Given a list of `{outreach_id, to, subject, body}`, send each one respecting `FOLLOWUP_LIMIT_PER_RUN`.
- Update `outreach` table with `followup_sent_at` so we never re-send the same one.
- Returns: `{sent: [...], skipped_already_sent: [...], limit_reached: [...]}`.

## 5. Data model additions (SQLite)

Add to `outreach` table:
- `followup_sent_at TEXT` — timestamp of the follow-up send (null if never sent).

No new tables needed; `outreach_id` foreign-keys to `outreach.id`.

## 6. `CLAUDE.md` changes

Add a new "## Follow-ups" section (separate from the main hunt):

```
## Follow-ups (Phase 1.5)

Triggered by: explicit command ("send follow-ups", "send reminders") or cron job (e.g., weekly).
NOT triggered by the main "run the hunt" command (to keep Phase 1 and 1.5 separate).

1. Query `outreach` table for sent emails where `sent_at` is >= FOLLOWUP_DAYS_AFTER old AND 
   `followup_sent_at IS NULL` (never sent a follow-up yet).
2. For each, invoke `followup-draft` skill to draft a follow-up.
3. Dispatch `subagent_type: followup-sender` (new agent) with the batch.
4. Report: "Sent N follow-ups, already-sent M, limit-reached L".
```

Add to `.env`:
```
FOLLOWUP_DAYS_AFTER=5              # only follow up on emails sent N+ days ago
FOLLOWUP_LIMIT_PER_RUN=2           # max follow-ups per run
```

## 7. Subagent definition (new)

**`.claude/agents/followup-sender.md`**: mirrors `sender` but writes `followup_sent_at` instead of `sent_at` and respects `FOLLOWUP_LIMIT_PER_RUN`.

## 8. Decisions log

- **Time-based, not reply-aware.** Phase 1.5 has no visibility into whether a recruiter actually replied (that requires Phase 3's `threads`/`messages` machinery). We just check age. This is simple and safe; Phase 3 will upgrade it to "only follow up if no reply detected" once conversation logging is in place.
- **One follow-up per contact, ever.** `followup_sent_at` prevents double-nudges.
- **Separate command from the main hunt.** "run the hunt" stays pure Phase 1; "send follow-ups" is the separate Phase 1.5 command. This lets the user run them on different schedules (daily hunt, weekly follow-ups) or skip follow-ups entirely if they prefer.
- **Same email sending pipeline.** Uses the same `gmail` MCP and verified-address checks, so safe to run on the same VPS/cron.

## 9. Risks & mitigations

- **Looks too spammy if done weekly.** Mitigation: default `FOLLOWUP_DAYS_AFTER=5` (only ~1/week per contact at most) and `FOLLOWUP_LIMIT_PER_RUN=2` (don't send 10 follow-ups in one go).
- **Reply-detection comes later (Phase 3).** Until then, follow-ups might go out even if the recruiter already replied. Mitigation: user can manually mark jobs as "replied" before Phase 3 ships, or just let it happen (mild redundancy, not terrible).
- **Template-ish follow-up is generic.** By design — if users want personalized follow-ups, that's Phase 3 (where reply intent is classified and drafts are AI-rewritten).

## 10. Open items (confirm at build time)

- Decide `FOLLOWUP_DAYS_AFTER` and `FOLLOWUP_LIMIT_PER_RUN` defaults with the user (suggested: 5 and 2).
- Confirm the one-follow-up-per-contact rule (no escalation, ever, in Phase 1.5).
