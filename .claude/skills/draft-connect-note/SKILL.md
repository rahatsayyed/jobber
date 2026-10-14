---
name: draft-connect-note
description: Draft, critique-and-rewrite, then humanize a LinkedIn connection-request note for a specific job/company and profile; use whenever a connect note needs to be produced before sending.
---

# draft-connect-note

## Purpose

Produce ONE final, ready-to-send LinkedIn connection-request note for a specific job, company,
and target profile. LinkedIn hard-caps connection notes at **300 characters** (not words) —
this is a real platform limit, not a style preference, and every step below must respect it.
This skill runs a two-pass drafter/reviewer process, then a humanizer pass, before returning
output. It never calls `connect.connect_send` itself — that only happens later, in the
orchestration layer, after explicit human approval.

## Inputs

1. `job` — object with fields `{id, title, company, url}` (at minimum `title` and `company`).
2. `profile` — the target LinkedIn profile candidate, `{profile_url, name, headline}` (from
   `connect.find_linkedin_profile`).
3. `context` — a short summary (a sentence or two) of why this specific role/company is
   relevant to the candidate: e.g. the tailored-resume angle, or the specific job posting
   detail worth mentioning. Must be traceable to real facts (the job posting or base resume) —
   never invented.
4. `profileContext` (optional) — `{about?: string}`, scraped by `connect.check_connection_status`
   from the target's LinkedIn "About" section. When `about` has real content, reference ONE
   concrete detail from it (a technology, project, or focus area they mention) to make the note
   feel personal instead of generic. When `profileContext` is absent or `about` is empty, skip
   this — never invent a detail about the person that isn't in `about`, `job`, or `context`.

## Step A — DRAFT

1. Write a note that:
   - References the specific job/company by name (e.g. "the Full Stack Developer role at
     Acme" — not "a role I saw" or "your company").
   - Uses the profile's first name if available (`profile.name`), kept natural, not forced.
   - States in one short clause why you're reaching out (interest in the specific role/team,
     not a generic "expanding my network").
   - Ends with exactly ONE soft ask — an invitation to connect or briefly chat, e.g. "Would
     love to connect" or "Open to a quick chat if you have time." **Never** ask directly for a
     referral, introduction, or favor (no "could you refer me", "can you put in a good word",
     "please pass my resume along"). The ask is for connection/conversation, not for action on
     the candidate's behalf.
   - Tone: brief, warm, professional — LinkedIn connection notes read informally, so avoid
     stiff corporate phrasing.
   - Do NOT use buzzwords or filler such as "passionate about", "team player",
     "results-driven", "synergy", "leverage", "dynamic", "go-getter", "hit the ground running".
   - Do NOT fabricate any company name, job title, or fact not present in `job`, `context`, or
     `profileContext.about`.
   - If `profileContext.about` has usable content, weave in one specific detail from it — this
     replaces a generic opener, it doesn't get bolted on as an extra clause.
2. This produces a draft `note` string.

## Step B — REVIEWER pass (hard 300-character cap)

1. Critique the Step A draft against this checklist:
   - **Length**: is `note.length > 300`? LinkedIn will reject or truncate anything longer, so
     this is a hard fail, not a style note. If over 300 characters, cut wording (remove filler,
     shorten the opener, tighten the ask) until it is at or under 300 characters. Do not
     abbreviate the job title, company name, or the person's name to make it fit — cut
     surrounding words instead.
   - Is it generic? Could this exact note be sent to anyone at any company? If yes, add a
     specific detail from `job` or `context`.
   - Does it ask for a referral, introduction, or favor rather than a connection/chat? If yes,
     rewrite the ask to be a soft connection ask only.
   - Does it contain a fact not traceable to `job`, `context`, or `profileContext.about`? If
     yes, remove or correct it.
   - Does it contain banned buzzwords? If yes, replace with plain language.
   - Does it have more than one ask, or no ask at all? If yes, collapse to exactly one.
2. Rewrite the draft ONCE, incorporating all fixes. This produces a revised `note` string that
   is verified `<= 300` characters. Do not do more than one rewrite pass.
3. If, after rewriting, the note still exceeds 300 characters (should be rare), truncate at the
   last full word boundary at or before 300 characters and drop the trailing partial clause —
   never truncate mid-sentence with a dangling word fragment, and never cut off the ask itself;
   if truncation would cut the ask, shorten the opening instead and re-check length.

## Step C — Humanize

1. Invoke the `the-humanizer` skill on the final `note` text from Step B (treat it as a
   LinkedIn message; let the skill auto-detect content type if needed).
2. Replace `note` with the humanizer's rewritten output.
3. **Re-verify length after humanizing**: humanizing can change character count. If the
   humanized `note` exceeds 300 characters, re-run the Step B truncation rule (word-boundary
   cut, ask preserved) rather than skipping the recheck.

## Output format

Output ONLY the following STRICT JSON object, with no extra text before or after it, no
markdown code fences, and no commentary:

```
{"note": "<string>"}
```

Rules for the output:
- `note` must be a plain string, `<= 300` characters (this is a hard requirement — verify by
  counting characters, not words, before returning).
- Do not add any keys other than `note`.
- Do not wrap the JSON in ```json fences. Output raw JSON only.
