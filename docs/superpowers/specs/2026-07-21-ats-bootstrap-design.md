# Self-Extending ATS Bootstrapping ("Plan B")

## Problem

`src/apply/external.ts` recognizes exactly four ATS platforms (Greenhouse, Lever, Workday,
Ashby) via `ATS_MODULES`, each a static `{detect(url), fieldMap}` module. When `apply_url`'s
domain doesn't match any of them, the application dead-ends at `manual_review` — even though
the underlying page might be a perfectly ordinary application form that a one-time look would
resolve. This was deliberately deferred during the Autonomous Outreach Pipeline work
(2026-07-20) as a separate piece of work ("Plan B").

## Goal

When `apply.auto`/`apply.<platform>` hits an apply_url whose domain matches none of the 4 known
`ATS_MODULES`, attempt to learn a `FieldMap` for that domain from a live look at the page, persist
it, and use it immediately for the current application — so the very next application to that
same domain (this run or any future run) already has a working, reusable module, no code change
or reconnect required.

## Scope

- Applies only to `external.ts`'s 4-platform ATS detection. LinkedIn Easy Apply (`linkedin.ts`)
  is out of scope — it already has its own per-posting dynamic-question hybrid fallback, and
  isn't a "which platform" detection problem (there's only one LinkedIn).
- Always on — no opt-in env flag. The trigger (unrecognized domain) has no existing safe
  behavior to regress; today it's unconditionally `manual_review`.

## Architecture

Flow inside `external.ts`, replacing today's "no `ATS_MODULES` match → `manual_review`" branch:

1. Navigate to `apply_url` (unchanged).
2. `detectPlatform(url)`: check the 4 static `ATS_MODULES` first (unchanged — a hardcoded module
   always wins if it matches). On a miss, check the learned registry via `detectLearned(url)`.
3. If the learned registry also misses: capture a structured snapshot of the live page's form
   controls via `snapshotFormControls(page)`.
4. Shell out to the `claude` CLI in headless print mode via a new project slash command,
   `.claude/commands/ats-bootstrap-fieldmap.md` — same subscription-based, single-turn,
   non-agentic invocation style as the existing `easy-apply-control-fallback.md` /
   `easy-apply-answer-fallback.md` (no separate API key/billing; uses the user's Claude
   subscription session). Pass it the snapshot, the required-field list
   (`name`/`email`/`resumeUpload`), and the optional-field list (`phone`/`coverLetter`/
   `submitButton`).
5. Claude selects selectors **only from what's actually present in the snapshot** — the same
   "never invent" contract as the existing control-click fallback — and returns either a
   complete `FieldMap` or an explicit "could not find: `<field>`" for any required field it
   can't confidently match.
6. `bootstrapFieldMap` independently validates every selector in Claude's response actually
   appears in the snapshot (defense in depth — don't just trust the CLI's output).
7. On success: `saveLearnedPlatform(domain, fieldMap)` persists it to
   `config/learned-ats-platforms.json`, and the current application continues through the
   existing fill/submit path using this FieldMap — with the same required-field and
   confirmation-text safety nets the 4 built-in platforms already use (no special leniency for
   a learned platform).
8. On failure (any required field unresolved, or the CLI shell-out itself fails/times
   out/returns non-JSON): `manual_review`, nothing written — identical to today's behavior for
   an unrecognized domain, with a more specific reason string naming the unresolved field(s).

## Components

- **`src/ats/learned.ts`** (new)
  - `loadLearnedPlatforms(): Record<string, FieldMap>` — `readFileSync` on
    `config/learned-ats-platforms.json`, returns `{}` if the file doesn't exist yet. Read fresh
    on every call (same reload semantics as `config/easy-apply-answers.json` — no MCP reconnect
    needed for a newly learned platform to take effect).
  - `saveLearnedPlatform(domain: string, fieldMap: FieldMap): void` — merges into the existing
    registry and writes back.
  - `detectLearned(url: string): string | null` — hostname lookup against the loaded registry,
    mirroring each `AtsModule.detect`'s shape.

- **`src/lib/domSnapshot.ts`** (new)
  - `snapshotFormControls(page): FormControlSnapshot` — Playwright extraction returning
    `{inputs: [{selector, type, id, name, ariaLabel, placeholder}], buttons: [{selector, text}]}`.
    `selector` is a synthesized, verifiable CSS selector (prefer `#id` → `[name="..."]` →
    structural `nth-of-type` fallback) so every entry Claude sees is guaranteed fillable/
    clickable, not just descriptive text.

- **`src/lib/atsBootstrap.ts`** (new)
  - `bootstrapFieldMap(snapshot, requiredFields): FieldMap | {missing: string[]}` — shells out to
    `claude --print` with the new slash command, parses the JSON response, validates every
    returned selector appears in the snapshot, and returns the failure shape if any required
    field is unresolved or the CLI call itself fails.

- **`.claude/commands/ats-bootstrap-fieldmap.md`** (new) — the task/output-contract prompt for
  the headless Claude call, parallel to the existing `easy-apply-control-fallback.md`: given a
  form-control snapshot and the required/optional field lists, return a JSON FieldMap using only
  selectors present in the snapshot, or name which required field(s) could not be found. Never
  invent a selector not in the input.

- **`external.ts`**: platform-detection branch updated per the Architecture flow above.

## Error Handling

- A learned FieldMap gets zero special treatment once selected — the same required-field check
  before submit and best-effort confirmation-text check after submit (both already in
  `external.ts`) apply identically, `manual_review` on either failing.
- The `claude` CLI shell-out failing for any reason (timeout, missing binary, non-JSON output) is
  treated identically to "could not find a required field" — falls to `manual_review`, never
  throws/crashes the apply flow.
- Nothing is written to `learned-ats-platforms.json` unless every required field was resolved.

## Testing

Unit tests (pure functions, no live browser or live Claude call):
- `snapshotFormControls`'s selector-synthesis logic — given a fake DOM shape, prefers `#id` >
  `[name]` > structural fallback.
- `bootstrapFieldMap`'s validation step — rejects a Claude response that references a selector
  not present in the snapshot (the concrete enforcement point for "never invent").
- `bootstrapFieldMap`'s failure shape — missing required field(s) named correctly; CLI
  failure/timeout/non-JSON output all normalize to the same failure shape.
- `loadLearnedPlatforms`/`saveLearnedPlatform` round-trip, including first-run (file doesn't
  exist yet).
- `detectLearned` domain matching — mirrors the existing `AtsModule.detect` test pattern.

Live verification: not part of this spec's implementation — like the rest of Phase 2's
untested-live gaps (`external.ts`'s confirmation-check heuristic, hybrid fallbacks), this needs
a real unrecognized-ATS posting to confirm end-to-end. Flag as untested-live in CLAUDE.md once
merged, consistent with existing documentation practice for this codebase.

## Out of Scope

- LinkedIn Easy Apply (`linkedin.ts`) — separate, already has its own dynamic-question fallback.
- An opt-in toggle — always on, per explicit decision above.
- Human-approval gate on learned FieldMaps before use — explicitly rejected in favor of using
  the same safety nets (required-field check, confirmation-text check) that already gate the 4
  built-in platforms.
- Screenshot-based or full-HTML-based inspection — accessibility/DOM snapshot only, per explicit
  decision above.
