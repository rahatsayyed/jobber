<!--
EVAL GENERATOR PROMPT: SYSTEM B = career-ops writing/tailoring rules
Adapted from career-ops-hq/career-ops (MIT, (c) 2026 Santiago Fernandez de Valderrama). See that repo's LICENSE.
Built by .superpowers/eval/build-prompts.ts on 2026-10-07. Rules below are copied VERBATIM (whole lines, in this order, separated by one blank line).
Sources and line ranges copied:
  .superpowers/research/career-ops/modes/_shared.md:28-33  (6 lines, starts: "**RULE: NEVER hardcode metrics from proof points.*")
  .superpowers/research/career-ops/modes/_writing.md:3-14  (12 lines, starts: "## Voice DNA (writing guardrail)")
  .superpowers/research/career-ops/modes/_writing.md:95-122  (28 lines, starts: "## Professional Writing & ATS Compatibility")
  .superpowers/research/career-ops/modes/pdf.md:14-14  (1 lines, starts: "1. Read `cv.md` as the source of truth")
  .superpowers/research/career-ops/modes/pdf.md:16-16  (1 lines, starts: "3. Extract 15-20 keywords from the JD")
  .superpowers/research/career-ops/modes/pdf.md:19-21  (3 lines, starts: "   - `existing` — already a named skill in cv.md's")
  .superpowers/research/career-ops/modes/pdf.md:33-33  (1 lines, starts: "7. Detect role archetype → adapt framing")
  .superpowers/research/career-ops/modes/pdf.md:35-41  (7 lines, starts: "9. Build an internal recruiter-side risk map from ")
  .superpowers/research/career-ops/modes/pdf.md:44-44  (1 lines, starts: "17a. Run the zero-LLM title-consistency check befo")
  .superpowers/research/career-ops/modes/pdf.md:80-90  (11 lines, starts: "## ATS Rules (clean parsing)")
  .superpowers/research/career-ops/modes/pdf.md:100-105  (6 lines, starts: "## Recruiter Review Gates")
  .superpowers/research/career-ops/modes/pdf.md:118-135  (18 lines, starts: "## Section order (optimized \"6-second recruiter sc")
  .superpowers/research/career-ops/modes/heuristics/recruiter-side.md:1-63  (63 lines, starts: "# Recruiter-Side Application Heuristics")
Not copied / trimmed:
  - _writing.md 16-93 (Writing Style Calibration from writing-samples; about cover letters/outreach, not CV text) and _shared.md 1-27, 34+ (paths, spend tier, scoring, evaluation blocks) not copied.
  - pdf.md 15, 17-18, 22-32, 34, 42-43, 45-79, 91-99, 106-117, 136+ not copied: file/tool pipeline (node scripts, HTML builder, PDF generation, Canva, LaTeX, cover letter, tracker), JD archival, reuse similarity, HM audit.
  - pdf.md 19-21 are the existing/supportedByResume/gap buckets (line 17-18 tool invocation omitted); 44 is the title-consistency rule and still names a node tool the generator cannot run.
To use: strip this leading HTML comment, then replace {{BASE_RESUME_JSON}}, {{JOB_TITLE}}, {{COMPANY}}, {{JOB_DESCRIPTION}} (see make-prompt.ts).
The wrapper (everything before the first line that is exactly "---") is byte-identical across system-A/B/C.
-->
You are given a base resume as JSON (schema below), and a job posting. Produce ONLY the tailored resume as one JSON object with EXACTLY the same top-level keys and structure as the base resume (name, jobTitle, email, phone, summary, website, social, experience[{title,company,companyUrl,location,start,end,description}], education, skills[{category,items}], projects, certificates). Follow ONLY the rules below. The resume must fit ONE page when rendered (about 520-700 words total is typical; the renderer measures it). Never fabricate any company, title, date, degree, metric or skill that is not in the base resume. Output nothing but the JSON.

Base resume schema (types only; the actual base resume is given under INPUTS):

```
{
  "name": string, "jobTitle": string|null, "email": string, "phone": string,
  "website": {"url": string, "label": string},
  "social": {"<network>": {"url": string, "label": string}},
  "summary": string,
  "experience": [{"title": string, "company": string, "companyUrl": string, "location": string|null,
                  "start": string, "end": string, "description": [string]}],
  "projects": [],
  "education": [{"degree": string, "school": string, "location": string, "year": string}],
  "skills": [{"category": string, "items": [string]}],
  "certificates": []
}
```

INPUTS

BASE RESUME JSON:
{{BASE_RESUME_JSON}}

JOB TITLE: {{JOB_TITLE}}
COMPANY: {{COMPANY}}
JOB POSTING:
{{JOB_DESCRIPTION}}

---

**RULE: NEVER hardcode metrics from proof points.** Read them from cv.md + article-digest.md at evaluation time.
**RULE: For article/project metrics, article-digest.md takes precedence over cv.md.**
**RULE: Read _profile.md AFTER this file. User customizations in _profile.md override defaults here.**
**RULE: Read _custom.md (if it exists) AFTER _profile.md and honor its house rules in every mode.** It is where the user's persistent instructions live ("use this date format", "never reorder section X", "always include Y in summaries") — an instruction recorded there is NOT optional and does not expire between sessions or between items in a batch. It can override workflow/style/procedural defaults, but it never introduces factual claims about the candidate. When the user states a lasting preference in conversation, write it to `modes/_custom.md` so it survives the session.
**RULE: NEVER claim the user authored a project, repo, library, tool, framework, or open-source artefact unless explicitly attributed to them in cv.md or article-digest.md.** Tool-of-trade conflation (user uses X → user built X) is the most common fabrication pattern and is forbidden.
**RULE: Keywords get reformulated, never fabricated.** Reorder, reframe, emphasise — but never invent. If a claim isn't backed by an in-scope file, ask the user. If no answer, omit. Silence on a topic beats manufactured detail.

## Voice DNA (writing guardrail)

If `voice-dna.md` exists in the project root, it is a writing guardrail for generated prose. It is user-layer and optional — never assume it exists, and skip this block silently if it doesn't. It layers **under** the user's personal style: it catches AI-slop and fills gaps, but it always defers to the user's own voice rules in `_profile.md` (see Precedence below).

**Two-tier scope (this is what keeps CVs accurate):**

- **Tier 1 — anti-AI-slop guardrail** (voice-dna §3 Banned List, §4 Patterns to Avoid: banned words, dead phrases, no em-dashes, no negative parallelisms, formatting rules). These are HARD RULES. They apply to **all** generated text, including CV bullets and the Professional Summary.
- **Tier 2 — conversational voice** (voice-dna §1-2: contractions, And/But sentence openers, hedging like "I think"/"maybe", parenthetical asides, direct "I"/"you"). Apply **only** to conversational candidate-facing prose: cover letters, LinkedIn outreach, follow-up emails. **Do NOT apply Tier 2 to CV/ATS text** (PDF bullets, Professional Summary) — those keep the formal, keyword-dense register in the ATS Rules below.

**Accuracy always wins over style.** Facts from `cv.md` and `article-digest.md` are never overridden by voice-dna. Never drop, soften, or hedge a real metric to improve rhythm. Never invent detail to sound more human. Voice-dna shapes wording; it never changes content.

**Precedence with personal style (`_profile.md` always wins):** The user's `## Writing Style` in `_profile.md` is the authority on voice and tone. Where `voice-dna.md` and `_profile.md` conflict, `_profile.md` wins — voice-dna never overrides a rule the user set for themselves. Example: if the user's `_profile.md` style uses em-dashes, keep them, even though voice-dna discourages them. voice-dna's anti-AI-slop rules apply only where `_profile.md` is silent. (`voice-dna.md` is itself a user file, so a user who wants the strict guardrail to win can simply leave that preference out of `_profile.md`.)

## Professional Writing & ATS Compatibility

These rules apply to ALL generated text that ends up in candidate-facing documents: PDF summaries, bullets, cover letters, form answers, LinkedIn messages. They do NOT apply to internal evaluation reports.

For recruiter-side risk mapping, six-second clarity, business-value bullets, and ATS reality checks, read `modes/heuristics/recruiter-side.md`.

### Avoid cliché phrases
_If `voice-dna.md` exists, its §3 Banned List is the canonical, fuller version of this list and takes precedence. The list below is the fallback for users without that file._
- "passionate about" / "results-oriented" / "proven track record"
- "leveraged" (use "used" or name the tool)
- "spearheaded" (use "led" or "ran")
- "facilitated" (use "ran" or "set up")
- "synergies" / "robust" / "seamless" / "cutting-edge" / "innovative"
- "in today's fast-paced world"
- "demonstrated ability to" / "best practices" (name the practice)

### Unicode normalization for ATS
`generate-pdf.mjs` automatically normalizes em-dashes, smart quotes, and zero-width characters to ASCII equivalents for maximum ATS compatibility. But avoid generating them in the first place.

### Vary sentence structure
- Don't start every bullet with the same verb
- Mix sentence lengths (short. Then longer with context. Short again.)
- Don't always use "X, Y, and Z" — sometimes two items, sometimes four

### Prefer specifics over abstractions
- "Cut p95 latency from 2.1s to 380ms" beats "improved performance"
- "Postgres + pgvector for retrieval over 12k docs" beats "designed scalable RAG architecture"
- Name tools, projects, and customers when allowed

1. Read `cv.md` as the source of truth

3. Extract 15-20 keywords from the JD

   - `existing` — already a named skill in cv.md's Skills section, safe to lead with
   - `supportedByResume` — not a named skill yet, but cv.md's prose already demonstrates it; legitimate candidates for the Skills section in the user's own words (Step 13's competency grid draws from here first)
   - `gap` — cv.md has no trace of it at all. **Tell the user explicitly which skills are gaps before generating the CV.** Never paper over a gap by inventing a claim, and never silently drop it from the conversation — the user decides whether to proceed, address it in the cover letter/interview, or skip the role

7. Detect role archetype → adapt framing

9. Build an internal recruiter-side risk map from the JD using `modes/heuristics/recruiter-side.md`: likely doubts, matching evidence, and which document section should address each doubt
10. Rewrite Professional Summary by injecting JD keywords + exit narrative bridge ("Built and sold a business. Now applying systems thinking to [JD domain].")
11. Select top 3-4 most relevant projects for the job. If `cv.md` carries an Awards / Honors section, populate `awards[]` with the entries that support this role — for an early-career candidate a contest medal or dean's list often outranks a thin project. Omit the key when there is nothing to list and the section disappears entirely; never invent an award to fill it
12. Reorder experience bullets by JD relevance and by the risk map: strongest matching evidence first
13. Build competency grid from JD requirements (6-8 keyword phrases), prioritizing `existing` and `supportedByResume` skills from Step 4 — never a `gap` skill
14. Inject keywords naturally into existing achievements (NEVER invent)
15. Apply the six-second clarity gate from `modes/heuristics/recruiter-side.md`: top third must make target role, strongest fit, and proof obvious

17a. Run the zero-LLM title-consistency check before rendering anything: `node cv-title-check.mjs /tmp/cv-{candidate}-{company}.json --summary`. This pairs each `experience[]` entry in the payload against `cv.md`'s own entry for the same `{company, dates}` and flags any `role` that no longer matches cv.md's canonical title string exactly (case/whitespace normalized only — never a fuzzy or "close enough" match). This is narrower than Step 4's skill-gap check and does not replace it: reordering bullets, reframing the summary, and injecting JD keywords into achievements are legitimate reformulation; a job **title** silently drifting to a more senior-sounding one for the exact same job is not, and is the one thing this check exists to catch.

## ATS Rules (clean parsing)

- Single-column layout (no sidebars, no parallel columns)
- Standard headers: "Professional Summary", "Work Experience", "Education", "Skills", "Certifications", "Projects"
- Optional sections (Core Competencies, Work Experience, Projects, Education, Certifications, Awards & Honors, Skills) are dropped entirely — header included — when their array is empty or absent
- No text in images/SVGs
- No critical info in PDF headers/footers (ATS ignores them)
- UTF-8, selectable text (not rasterized)
- No nested tables
- Distributed JD keywords: Summary (top 5), first bullet of each role, Skills section
- No hidden text, keyword stuffing, or white-font tricks. Optimize for parseability plus human review.

## Recruiter Review Gates

- The summary should answer: "What role is this person targeting, and why this one?"
- The first screen should show 1-2 proof points that map to the JD's highest-risk requirements.
- Bullets should emphasize outcomes, systems, users, or business effects rather than task history.
- Logistics such as location, work authorization, salary, and availability belong in the CV only when appropriate for the market and profile; otherwise handle them in form answers or recruiter scripts.

## Section order (optimized "6-second recruiter scan")

1. Header (large name, gradient, contact, portfolio link)
2. Professional Summary (3-4 lines, keyword-dense)
3. Core Competencies (6-8 keyword phrases in flex-grid)
4. Work Experience (reverse chronological)
5. Projects (top 3-4 most relevant)
6. Education & Certifications
7. Skills (languages + technical)

## Keyword injection strategy (ethical, truth-based)

Examples of legitimate reformulation:
- JD says "RAG pipelines" and CV says "LLM workflows with retrieval" → change to "RAG pipeline design and LLM orchestration workflows"
- JD says "MLOps" and CV says "observability, evals, error handling" → change to "MLOps and observability: evals, error handling, cost monitoring"
- JD says "stakeholder management" and CV says "collaborated with team" → change to "stakeholder management across engineering, operations, and business"

**NEVER add skills that the candidate does not have. Only reword real experience using the exact JD vocabulary.**

# Recruiter-Side Application Heuristics

Use these rules for candidate-facing documents and answers: PDF summaries,
bullets, cover letters, form answers, LinkedIn messages, recruiter scripts, and
interview prep. They do not apply to internal evaluation reports unless a mode
explicitly asks for analysis.

## Recruiter-Side Risk Map

Before generating a CV, cover letter, form answer, recruiter script, or
interview prep, create a small internal risk map:

| Potential doubt | Evidence from CV/report | Candidate-facing fix |
|-----------------|-------------------------|----------------------|
| Can they do this stack? | Matching tools, systems, projects | Put the exact stack in truthful context |
| Are they senior enough? | Ownership, scope, tradeoffs, mentoring | Lead with senior behaviors, not tenure alone |
| Is the domain relevant? | Similar users, workflows, scale, constraints | Translate adjacent proof into the JD's language |
| Is there a logistics blocker? | Location, comp, work-auth, availability | Answer only where the form/recruiter asks |
| Is the application generic? | Weak or broad bullets | Rewrite around this role's concrete problems |

Use the map to reduce review risk. Do not print it unless the mode output
explicitly asks for analysis. Never invent evidence to close a doubt.

## Six-Second Clarity Gate

For every CV/PDF and cover letter, the top third must make the target fit
impossible to miss:

- target role/archetype
- strongest matching stack or domain
- one production or business outcome
- location/remote fit only when appropriate for that document
- portfolio/case-study link when available and relevant

If a recruiter must infer fit from scattered bullets, rewrite the summary and
first experience bullets.

## Business-Value Bullets

Prefer:

`Action + system/scope + tool/approach + outcome + proof`

Good patterns:

- `Resolved [problem] in [system], improving [business/system effect].`
- `Built [capability] with [tools], enabling [user/team outcome].`
- `Migrated [old] to [new], reducing [risk/cost/latency/debt].`
- `Improved [metric] from [before] to [after] by [technical action].`

Avoid weak starts when stronger ownership is true: "helped", "assisted",
"responsible for", "worked on", "participated in".

## ATS Reality Check

Optimize for parseability and human review, not "ATS hacks":

- exact JD keywords only in truthful context
- no hidden text
- no keyword stuffing
- no white-font tricks
- no decorative layouts that break parsing
- no skills or metrics not present in the user's sources of truth
