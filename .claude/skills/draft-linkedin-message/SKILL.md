---
name: draft-linkedin-message
description: Draft, critique-and-rewrite, then humanize a LinkedIn direct message for a specific job/company and an EXISTING 1st-degree connection; use whenever connect.connect_send returns status "already_connected" instead of draft-connect-note.
---

# draft-linkedin-message

## Purpose

Produce ONE final, ready-to-send LinkedIn direct message for a specific job, company, and
target profile who is **already a 1st-degree connection** — the counterpart to
`draft-connect-note` for profiles that are not yet connected. This is a real DM sent via
`connect.send_linkedin_message`, not a connection-request note: it has no LinkedIn-imposed
character cap and must read as a message to someone you already know, not as an invitation to
connect. This skill runs a two-pass drafter/reviewer process, then a humanizer pass, before
returning output. It never calls `connect.send_linkedin_message` itself — that only happens
later, in the orchestration layer, after explicit human approval, same as
`draft-connect-note`.

## When to use this instead of draft-connect-note

Only when `connect.connect_send` (or a prior check) returned `status: "already_connected"` for
this profile. If the profile is not yet a connection, use `draft-connect-note` and
`connect.connect_send` instead — never draft a message for a profile you haven't verified is
already connected.

## Inputs

1. `job` — object with fields `{id, title, company, url}` (at minimum `title` and `company`).
2. `profile` — the target LinkedIn profile, `{profile_url, name, headline}`.
3. `context` — a short summary (a sentence or two) of why this specific role/company is
   relevant to the candidate right now — the tailored-resume angle, or a specific posting
   detail worth mentioning. Must be traceable to real facts (the job posting or base resume) —
   never invented.
4. `profileContext` (optional) — `{about?: string}`, scraped by `connect.check_connection_status`
   from the target's LinkedIn "About" section. When `about` has real content, reference ONE
   concrete detail from it to make the message feel personal instead of generic. When
   `profileContext` is absent or `about` is empty, skip this — never invent a detail about the
   person that isn't in `about`, `job`, or `context`.

## Step A — DRAFT

1. Write a message that:
   - Opens as a message to someone already connected — never re-introduces yourself as if this
     were a first contact, and never says "would love to connect" (you already are).
   - References the specific job/company by name (e.g. "the Full Stack Developer role at
     Acme" — not "a role I saw" or "your company").
   - Uses the profile's first name if available (`profile.name`), kept natural.
   - States in one or two short sentences why you're reaching out about this specific
     role/team — genuine, not generic networking filler.
   - Ends with exactly ONE soft, specific ask relevant to a message (e.g. "Happy to share more
     about my background if useful" or "Would you be the right person to speak with about
     this role?"). **Never** ask directly for a referral, introduction, or favor (no "could you
     refer me", "can you put in a good word", "please pass my resume along").
   - Tone: brief, warm, professional — a LinkedIn DM to someone you know reads informally, not
     like a cover letter.
   - Do NOT use buzzwords or filler such as "passionate about", "team player",
     "results-driven", "synergy", "leverage", "dynamic", "go-getter", "hit the ground running".
   - Do NOT fabricate any company name, job title, or fact not present in `job`, `context`, or
     `profileContext.about`.
   - If `profileContext.about` has usable content, weave in one specific detail from it instead
     of a generic opener.
   - No hard character cap (unlike connect notes), but keep it to 2-4 short sentences — a wall
     of text in a DM reads as a mail-merge blast, not a real message.
2. This produces a draft `message` string.

## Step B — REVIEWER pass

1. Critique the Step A draft against this checklist:
   - Does it wrongly treat the recipient as a stranger ("would love to connect", a
     self-introduction as if for the first time)? If yes, rewrite as a message to an existing
     contact.
   - Is it generic? Could this exact message be sent to anyone at any company? If yes, add a
     specific detail from `job` or `context`.
   - Does it ask for a referral, introduction, or favor rather than a soft, specific ask? If
     yes, rewrite the ask.
   - Does it contain a fact not traceable to `job`, `context`, or `profileContext.about`? If
     yes, remove or correct it.
   - Does it contain banned buzzwords? If yes, replace with plain language.
   - Does it have more than one ask, or no ask at all? If yes, collapse to exactly one.
   - Is it needlessly long (more than ~4 short sentences)? If yes, tighten it.
2. Rewrite the draft ONCE, incorporating all fixes. Do not do more than one rewrite pass.

## Step C — Humanize

1. Invoke the `the-humanizer` skill on the final `message` text from Step B (treat it as a
   LinkedIn message; let the skill auto-detect content type if needed).
2. Replace `message` with the humanizer's rewritten output.

## Output format

Output ONLY the following STRICT JSON object, with no extra text before or after it, no
markdown code fences, and no commentary:

```
{"message": "<string>"}
```

Rules for the output:
- `message` must be a plain string.
- Do not add any keys other than `message`.
- Do not wrap the JSON in ```json fences. Output raw JSON only.
