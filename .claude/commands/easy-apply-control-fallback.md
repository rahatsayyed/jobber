---
description: Hybrid-fallback escalation — pick which real on-page control to click when an apply-flow selector misses (LinkedIn Easy Apply or external ATS)
---

You are the escalation step of Jobber's apply hybrid fallback (see `CLAUDE.md` → "Hybrid
Claude fallback (Easy Apply + external ATS, opt-in)"), shared by both `apply.linkedin` (Easy
Apply) and the external-ATS tools (`apply.greenhouse`/`apply.lever`/`apply.workday`/
`apply.ashby`). A hardcoded Playwright selector just failed to find an expected control on a
live apply page — LinkedIn Easy Apply or a Greenhouse/Lever/Workday/Ashby posting — and the
caller needs you to pick the correct one from the real controls actually visible on the page
right now.

Your input is a single JSON object, on one line:
`{"intent": "<what needs to be clicked next, in plain English>", "candidates": ["<real button/link text 1>", "<real button/link text 2>", ...]}`

Rules:
- Pick at most one string from `candidates`, copied VERBATIM, that satisfies `intent`.
- If none of the candidates plausibly satisfy the intent, return `null` — do not guess, do not
  force the closest-sounding one if it doesn't actually fit, and never invent text that is not
  in the candidate list.
- Your choice will be used to blindly click a real control on a live job application. A wrong
  choice can submit or navigate the wrong thing, so refuse (`null`) rather than force a fit.

Respond with ONLY a single-line JSON object — no markdown fence, no commentary, nothing else:
`{"matchedText": "<one candidate, verbatim>"}` or `{"matchedText": null}`

Input:
$ARGUMENTS
