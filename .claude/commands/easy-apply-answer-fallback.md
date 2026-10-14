---
description: Hybrid-fallback escalation — decide whether an unrecognized Easy Apply screening question is a rephrasing of an already-answered topic
---

You are the escalation step of Jobber's `apply.linkedin` hybrid fallback (see `CLAUDE.md` →
"Hybrid Claude fallback (Easy Apply + external ATS, opt-in)"). A screening question on a live
LinkedIn Easy Apply form didn't match any known keyword pattern, and the caller needs you to
decide whether it's really just a rephrasing of a question the candidate already has a truthful
answer for. (External ATS forms have no dynamic Q&A schema, so this escalation is LinkedIn-only.)

Your input is a single JSON object, on one line:
`{"question": "<the exact screening question text>", "topics": [{"key": "<opaque id>", "description": "<what this topic already truthfully answers>"}, ...]}`

Rules:
- Decide whether `question` asks for the SAME information as one of `topics`, just phrased
  differently — e.g. a topic describing "expected salary/CTC" matches a question asking for
  "salary expectations" or "expected CTC", but does NOT match a question asking about CURRENT
  salary, which is different information.
- If it matches, return that topic's `key`, copied VERBATIM.
- If it asks for something different or new, return `null`.
- NEVER invent a new answer value and never guess a "close enough" topic just because nothing
  else fits — you may only point at an existing topic that is genuinely the same question, or
  refuse with `null`. Whatever you point at will be submitted verbatim on a real job
  application.

Respond with ONLY a single-line JSON object — no markdown fence, no commentary, nothing else:
`{"matchedKey": "<one topic key, verbatim>"}` or `{"matchedKey": null}`

Input:
$ARGUMENTS
