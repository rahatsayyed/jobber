---
name: draft-outreach
description: Draft, critique-and-rewrite, then humanize a cold outreach email for a specific job and contact; use whenever an outreach email needs to be produced before sending.
---

# draft-outreach

## Purpose

Produce ONE final, ready-to-send cold outreach email (subject + body) for a specific job, tailored resume, and chosen contact. This skill runs a two-pass drafter/reviewer process, then a humanizer pass, before returning output.

## Inputs

1. `job` — object with fields `{id, source, title, company, url, apply_url, description}`.
2. `tailored_resume_summary` — a short summary (a few sentences or bullets) of the resume that was tailored for this specific job: candidate's current/target title, 2-4 strongest matching skills or achievements relevant to this job.
3. `contact` — the chosen contact object, at minimum `{email, type, verified, source, confidence}`. Only proceed if `contact.verified` is true; if not verified, do not draft — report back that no verified contact exists (this should normally be filtered out before this skill is invoked).
4. `do_not_claim` (optional) — posting requirements the candidate does NOT have (the `gaps` from `tailor-resume`). Never state or imply experience with any of them. If the posting stresses one, you may name it once, honestly, as something the candidate would ramp up on (e.g. "I haven't used Go professionally yet; most of my backend work is TypeScript"), or leave it out. Keep the negation in the same sentence as the term ("haven't", "not yet", "new to"): the email fact gate treats a technology named without a nearby negation as a claim.

## Follow-up mode (when the caller passes `followup`)

In follow-up mode SKIP Steps A, B and D (no 180-word draft, no critique round, no footer or attachment line) and run ONLY Step C (the humanizer pass) on the text below.

Inputs: `followup = {n: 1|2, original_subject, original_body, days_quiet, company, title}`. Produce ONE follow-up email in the same thread.

- Subject: `Re: <original_subject>` exactly, on a single line.
- Body 60-120 words for n=1; 40-80 words and a different angle for n=2 (`db.save_followup_draft` enforces 40-120 for both, counted on the body).
- Structure: greeting with the contact's name if the original had one, else the team; ONE sentence restating interest in the specific role; ONE value reminder taken from `original_body` (a fact or number already in it, phrased differently); ONE simple question about timeline or next step.
- Truthful, no new claims: do not add any number, tool, employer, title or achievement that is not already in `original_body`. The code-side fact gate accepts anything supported by the base resume OR the original email and blocks everything else, so staying inside `original_body` is the rule you follow, and the gate is the backstop, not a licence to add resume facts.
- Never use any of these (code rejects a draft containing them, case-insensitive): "just checking in", "checking in", "following up" or "follow up" in any form, "touching base", "circling back", "bumping this" or "bump my", "any update" or "any updates", "gentle reminder", "per my last email". No guilt, no pressure, no apology for writing.
- No em dashes; no footer (the original already had one).

Output: `{"subject": "...", "body": "..."}` as in the normal mode.

## Step A — DRAFT

1. Write a subject line: short (under 60 characters), specific to the role and company (e.g. mentions the job title or a specific detail from the posting). No generic subjects like "Job Application" or "Following up".
2. Write the email body following these rules:
   - Total body length under 180 words.
   - Open with 1 sentence: who you are and why you're reaching out about THIS specific role at THIS specific company (reference something concrete from `job.title` or `job.description`, not a generic template line).
   - State 2-3 relevant strengths or achievements pulled directly from `tailored_resume_summary` — these must be real facts from the resume, never invented or exaggerated.
   - End with exactly ONE clear ask (e.g. "Could we set up a 15-minute call this week?" or "I've attached my resume — happy to share more detail if useful.").
   - Tone: professional, direct, warm but not effusive.
   - Do NOT use buzzwords or filler phrases such as "passionate about", "team player", "results-driven", "synergy", "leverage", "dynamic", "go-getter", "hit the ground running".
   - Do NOT fabricate any company names, job titles, dates, metrics, or achievements not present in `tailored_resume_summary` or the resume.
   - Do not include a formal letterhead, address block, or attachments list in the body text — the resume PDF is attached separately by the caller.
3. This produces a draft `{subject, body}`.

## Step B — REVIEWER pass

1. Critique the Step A draft against this checklist:
   - Is it generic? Could this exact email be sent to any company for any role? If yes, rewrite to add specifics from `job.description` or `job.title`.
   - Is it over 180 words? If yes, cut filler and tighten sentences.
   - Does it contain any claim, number, company name, or title not traceable to `tailored_resume_summary`? If yes, remove or correct it.
   - Does it contain buzzwords from the banned list above? If yes, replace with plain, concrete language.
   - Does it have more than one clear ask? If yes, collapse to a single ask.
   - Is the subject line generic or vague? If yes, make it specific.
   - Does it state or imply any item in do_not_claim? If yes, remove it or make it an honest gap statement.
2. Rewrite the draft ONCE, incorporating all fixes from the critique. This produces a revised `{subject, body}`. Do not do more than one rewrite pass.

## Step C — Humanize

1. Invoke the `the-humanizer` skill on the final `body` text from Step B (treat it as an email; let the skill auto-detect content type if needed).
2. Replace `body` with the humanizer's rewritten output.
3. Do not run the humanizer on the `subject` line.
4. Never use an em dash (—) anywhere in `body` — rewrite with a comma or period instead. This is enforced by the humanizer's universal rules too, but call it out explicitly here since it's easy to reintroduce one in a later edit pass.
5. **Any edit made to `body` after this step (a caller-requested wording change, an added footer, a corrected fact) is not final until it goes back through the humanizer.** Layering edits on top of an already-humanized draft without re-running Step C is how AI-sounding phrasing or a stray em dash creeps back in — treat every substantive rewrite of `body`, not just the first one, as needing a Step C pass.

## Step D — Contact footer (if the candidate's profile has any of these links)

Append a short footer to `body`, after the closing line, with whichever of these the candidate's profile/config actually has (skip any that are missing — never invent a link):

```
Portfolio: <site>
GitHub: @<handle>
LinkedIn: @<handle>
Resume: <hosted resume link, e.g. FlowCV>
```

- These are plain URLs/handles in the plain-text `body`. When the caller sends the email via an HTML-capable channel (e.g. Gmail's `htmlBody`), render each line's URL as a hyperlink (`<a href="...">`) — the caller building the HTML version is responsible for that, this skill just needs to supply the underlying values in the footer.
- The footer counts toward the 180-word body limit; keep the rest of the body tight enough to leave room for it.

## Output format

Output ONLY the following STRICT JSON object, with no extra text before or after it, no markdown code fences, and no commentary:

```
{"subject": "<string>", "body": "<string>"}
```

Rules for the output:
- `subject` and `body` must be plain strings.
- `body` must contain the final, humanized email text including the Step D footer if applicable (plain text, paragraphs separated by `\n\n`, no HTML).
- Do not add any keys other than `subject` and `body`.
- Do not wrap the JSON in ```json fences. Output raw JSON only.
